import Ajv from "ajv";
import fetch from "node-fetch";
import { getCurrentBurnBlockHeight } from "../burnblock-service.js";
import cache from "../cache.js";
import { getPool } from "../db.js";
import { getAndValidateZonefile } from "../zonefile-utils.js";

const CACHE_TTL = {
  SUBDOMAIN_LIST: 120,
  EXTERNAL_FILE: 300,
};

const MAX_SIZE = 50 * 1024 * 1024;
const FETCH_TIMEOUT = 5000;

const ajv = new Ajv({ allErrors: true });
const subdomainsSchema = {
  type: "object",
  additionalProperties: false,
  patternProperties: {
    "^[a-z0-9-_]+$": {
      type: "object",
      required: [
        "owner",
        "general",
        "twitter",
        "url",
        "nostr",
        "lightning",
        "btc",
      ],
      properties: {
        owner: { type: "string" },
        general: { type: "string" },
        twitter: { type: "string" },
        url: { type: "string" },
        nostr: { type: "string" },
        lightning: { type: "string" },
        btc: { type: "string" },
      },
      additionalProperties: false,
    },
  },
};

const validateSubdomains = ajv.compile(subdomainsSchema);

function isValidHttpsUrl(urlString) {
  try {
    const url = new URL(urlString);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function hasJsonExtension(urlString) {
  const pathname = new URL(urlString).pathname.toLowerCase();
  return pathname.endsWith(".json");
}

function hasNoQueryOrFragment(urlString) {
  const url = new URL(urlString);
  return !url.search && !url.hash;
}

function isSafeDomain(urlString) {
  const url = new URL(urlString);
  const forbiddenPatterns = [/^localhost$/, /^127\.0\.0\.1$/];
  return !forbiddenPatterns.some((pattern) => pattern.test(url.hostname));
}

function noUserInfo(urlString) {
  const url = new URL(urlString);
  return !url.username && !url.password;
}

function isAllowedS3Domain(urlString) {
  try {
    const url = new URL(urlString);
    const s3DomainPattern =
      /^[a-z0-9.-]+\.s3([.-][a-z0-9-]+)*\.amazonaws\.com$/i;
    return s3DomainPattern.test(url.hostname);
  } catch {
    return false;
  }
}

async function fetchExternalSubdomains(urlString) {
  const cacheKey = `external_subdomain_file_${urlString}`;

  const cachedData = cache.get(cacheKey);
  if (cachedData) {
    return cachedData;
  }

  if (!isValidHttpsUrl(urlString)) {
    throw new Error("External URL must be HTTPS");
  }
  if (!hasJsonExtension(urlString)) {
    throw new Error("External file must end with .json");
  }
  if (!isSafeDomain(urlString)) {
    throw new Error("External URL domain is not safe");
  }
  if (!hasNoQueryOrFragment(urlString)) {
    throw new Error("External URL must not have query or fragment");
  }
  if (!noUserInfo(urlString)) {
    throw new Error("External URL must not contain user info");
  }
  if (!isAllowedS3Domain(urlString)) {
    throw new Error("External URL must be an allowed S3 domain");
  }

  const headResponse = await fetch(urlString, { method: "HEAD" });
  if (!headResponse.ok) {
    throw new Error("Unable to verify external subdomains file");
  }

  const contentType = headResponse.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error("External file is not application/json");
  }

  const reportedSize = headResponse.headers.get("content-length");
  if (reportedSize && parseInt(reportedSize, 10) > MAX_SIZE) {
    throw new Error("External subdomain file too large");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  let response;
  try {
    response = await fetch(urlString, { signal: controller.signal });
  } catch (err) {
    throw new Error(
      "Failed to fetch external subdomains file (timeout or network error)"
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error("Failed to fetch external subdomains file");
  }

  const stream = response.body;
  let totalSize = 0;
  const chunks = [];

  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => {
      totalSize += chunk.length;

      if (totalSize > MAX_SIZE) {
        stream.destroy();
        reject(new Error("External subdomain file too large"));
        return;
      }

      chunks.push(chunk);
    });

    stream.on("error", (err) => {
      reject(
        new Error("Error reading external subdomains file: " + err.message)
      );
    });

    stream.on("end", () => {
      const allBytes = Buffer.concat(chunks);

      let data;
      try {
        const jsonString = allBytes.toString("utf8");
        data = JSON.parse(jsonString);
      } catch (error) {
        reject(new Error("Invalid JSON format in external subdomains file"));
        return;
      }

      if (!("subdomains" in data)) {
        reject(new Error("No 'subdomains' property found in the JSON"));
        return;
      }

      const valid = validateSubdomains(data.subdomains);
      if (!valid) {
        const errors = validateSubdomains.errors
          .map((err) => `${err.instancePath} ${err.message}`)
          .join(", ");
        reject(new Error("Invalid subdomains schema: " + errors));
        return;
      }

      cache.set(cacheKey, data, CACHE_TTL.EXTERNAL_FILE);
      resolve(data);
    });
  });
}

const subdomainHandlers = {
  getSubdomains: async (request, reply, { schema, network }) => {
    const [nameString, namespaceString] = request.params.full_name.split(".");
    const cacheKey = `subdomains_${network}_${nameString}.${namespaceString}`;

    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return reply.send(cachedResult);
    }

    const currentBurnBlock = await getCurrentBurnBlockHeight(network);
    const pool = getPool();

    const result = await pool.query(
      `SELECT zonefile, owner
       FROM ${schema}.names 
       WHERE name_string = $1 
       AND namespace_string = $2
       AND owner IS NOT NULL
       AND revoked = false
       AND (renewal_height = 0 OR renewal_height > $3)`,
      [nameString, namespaceString, currentBurnBlock]
    );

    if (result.rows.length === 0) {
      return reply
        .code(404)
        .send({ error: "Name not found, expired or revoked" });
    }

    const { zonefile, owner } = result.rows[0];

    const zonefileResult = getAndValidateZonefile(zonefile, owner);

    if (!zonefileResult.success) {
      return reply
        .code(zonefileResult.code)
        .send({ error: zonefileResult.error });
    }

    const decodedZonefile = zonefileResult.zonefile;

    try {
      if (
        "externalSubdomainFile" in decodedZonefile &&
        typeof decodedZonefile.externalSubdomainFile === "string"
      ) {
        const externalUrl = decodedZonefile.externalSubdomainFile;

        try {
          const externalData = await fetchExternalSubdomains(externalUrl);

          if (!externalData || typeof externalData !== "object") {
            return reply
              .code(400)
              .send({ error: "Invalid external subdomain data" });
          }

          const response = { subdomains: externalData.subdomains };

          cache.set(cacheKey, response, CACHE_TTL.SUBDOMAIN_LIST);

          return reply.send(response);
        } catch (error) {
          request.log.error(error);
          return reply.code(400).send({ error: error.message });
        }
      } else if ("subdomains" in decodedZonefile) {
        const response = { subdomains: decodedZonefile.subdomains };

        cache.set(cacheKey, response, CACHE_TTL.SUBDOMAIN_LIST);

        return reply.send(response);
      } else {
        return reply
          .code(400)
          .send({ error: "No subdomains or external link found" });
      }
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: "Error processing subdomains" });
    }
  },

  getSingleSubdomain: async (request, reply, { schema, network }) => {
    const fullSubdomain = request.params.full_subdomain;
    const cacheKey = `single_subdomain_${network}_${fullSubdomain}`;

    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return reply.send(cachedResult);
    }

    const firstDotIndex = fullSubdomain.indexOf(".");
    if (firstDotIndex < 0) {
      return reply.code(400).send({ error: "Invalid subdomain format" });
    }

    const subLabel = fullSubdomain.slice(0, firstDotIndex);
    const parentName = fullSubdomain.slice(firstDotIndex + 1);

    const [nameString, namespaceString] = parentName.split(".");
    if (!nameString || !namespaceString) {
      return reply.code(400).send({ error: "Invalid parent name format" });
    }

    const currentBurnBlock = await getCurrentBurnBlockHeight(network);
    const pool = getPool();

    const parentResult = await pool.query(
      `SELECT zonefile, owner
     FROM ${schema}.names
     WHERE name_string = $1
       AND namespace_string = $2
       AND owner IS NOT NULL
       AND revoked = false
       AND (renewal_height = 0 OR renewal_height > $3)`,
      [nameString, namespaceString, currentBurnBlock]
    );

    if (parentResult.rows.length === 0) {
      return reply
        .code(404)
        .send({ error: "Parent name not found, expired, or revoked" });
    }

    const { zonefile, owner } = parentResult.rows[0];

    const zonefileResult = getAndValidateZonefile(zonefile, owner);

    if (!zonefileResult.success) {
      return reply
        .code(zonefileResult.code)
        .send({ error: zonefileResult.error });
    }

    const decodedZonefile = zonefileResult.zonefile;

    try {
      let allSubdomains;

      if (
        "externalSubdomainFile" in decodedZonefile &&
        typeof decodedZonefile.externalSubdomainFile === "string"
      ) {
        try {
          const externalData = await fetchExternalSubdomains(
            decodedZonefile.externalSubdomainFile
          );
          allSubdomains = externalData.subdomains;
        } catch (error) {
          request.log.error(error);
          return reply.code(400).send({ error: error.message });
        }
      } else if ("subdomains" in decodedZonefile) {
        allSubdomains = decodedZonefile.subdomains;
      } else {
        return reply
          .code(400)
          .send({ error: "No subdomains or external link found" });
      }

      if (!(subLabel in allSubdomains)) {
        return reply.code(404).send({ error: "Subdomain not found" });
      }

      const subdomainData = allSubdomains[subLabel];

      const response = {
        ...(network === "testnet" && { network: "testnet" }),
        subdomain: fullSubdomain,
        data: subdomainData,
      };

      cache.set(cacheKey, response, CACHE_TTL.SUBDOMAIN_LIST);

      return reply.send(response);
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: "Error processing subdomain" });
    }
  },

  getSingleSubdomainOwner: async (request, reply, { schema, network }) => {
    const fullSubdomain = request.params.full_subdomain;
    const cacheKey = `subdomain_owner_${network}_${fullSubdomain}`;

    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return reply.send(cachedResult);
    }

    const firstDotIndex = fullSubdomain.indexOf(".");
    if (firstDotIndex < 0) {
      return reply.code(400).send({ error: "Invalid subdomain format" });
    }

    const subLabel = fullSubdomain.slice(0, firstDotIndex);
    const parentName = fullSubdomain.slice(firstDotIndex + 1);
    const [nameString, namespaceString] = parentName.split(".");

    if (!nameString || !namespaceString) {
      return reply.code(400).send({ error: "Invalid parent name format" });
    }

    const currentBurnBlock = await getCurrentBurnBlockHeight(network);
    const pool = getPool();

    const parentResult = await pool.query(
      `SELECT zonefile, owner
     FROM ${schema}.names
     WHERE name_string = $1
       AND namespace_string = $2
       AND owner IS NOT NULL
       AND revoked = false
       AND (renewal_height = 0 OR renewal_height > $3)`,
      [nameString, namespaceString, currentBurnBlock]
    );

    if (parentResult.rows.length === 0) {
      return reply
        .code(404)
        .send({ error: "Parent name not found, expired, or revoked" });
    }

    const { zonefile, owner } = parentResult.rows[0];

    const zonefileResult = getAndValidateZonefile(zonefile, owner);

    if (!zonefileResult.success) {
      return reply
        .code(zonefileResult.code)
        .send({ error: zonefileResult.error });
    }

    const decodedZonefile = zonefileResult.zonefile;

    try {
      let allSubdomains;

      if (
        "externalSubdomainFile" in decodedZonefile &&
        typeof decodedZonefile.externalSubdomainFile === "string"
      ) {
        try {
          const externalData = await fetchExternalSubdomains(
            decodedZonefile.externalSubdomainFile
          );
          allSubdomains = externalData.subdomains;
        } catch (error) {
          request.log.error(error);
          return reply.code(400).send({ error: error.message });
        }
      } else if ("subdomains" in decodedZonefile) {
        allSubdomains = decodedZonefile.subdomains;
      } else {
        return reply
          .code(400)
          .send({ error: "No subdomains or external link found" });
      }

      if (!(subLabel in allSubdomains)) {
        return reply.code(404).send({ error: "Subdomain not found" });
      }

      const subdomainData = allSubdomains[subLabel];

      const response = {
        ...(network === "testnet" && { network: "testnet" }),
        subdomain: fullSubdomain,
        owner: subdomainData.owner,
      };

      cache.set(cacheKey, response, CACHE_TTL.SUBDOMAIN_LIST);

      return reply.send(response);
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: "Error processing subdomain" });
    }
  },
};

export default subdomainHandlers;
