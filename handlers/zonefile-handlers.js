import { getCurrentBurnBlockHeight } from "../burnblock-service.js";
import { getPool } from "../db.js";
import { decodeZonefile } from "../zonefile-utils.js";
import cache from "../cache.js";

const CACHE_TTL = {
  ZONEFILE_DATA: 300,
};

const VALID_IMAGE_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".svg",
  ".webp",
  ".bmp",
  ".tiff",
];

const VALID_SOCIAL_PLATFORMS = [
  "x",
  "twitter",
  "telegram",
  "discord",
  "instagram",
  "youtube",
  "linkedin",
  "github",
  "facebook",
  "tiktok",
  "snapchat",
  "reddit",
];

const VALID_NETWORKS = [
  "btc",
  "bitcoin",
  "eth",
  "ethereum",
  "stx",
  "stacks",
  "sol",
  "solana",
  "ltc",
  "litecoin",
  "bch",
  "bitcoincash",
  "doge",
  "dogecoin",
];

const VALID_ADDRESS_TYPES = [
  "payment",
  "ordinal",
  "wallet",
  "receiving",
  "change",
];

function isValidImageUrl(url) {
  if (typeof url !== "string" || url.trim() === "") return true;

  try {
    const urlObj = new URL(url);
    if (urlObj.protocol !== "https:") return false;

    const pathname = urlObj.pathname.toLowerCase();
    return VALID_IMAGE_EXTENSIONS.some((ext) => pathname.endsWith(ext));
  } catch {
    return false;
  }
}

function isValidUrl(url) {
  if (typeof url !== "string" || url.trim() === "") return true;

  try {
    const urlObj = new URL(url);
    return urlObj.protocol === "https:" || urlObj.protocol === "http:";
  } catch {
    return false;
  }
}

function validateProfileZonefile(zonefile) {
  if (
    typeof zonefile !== "object" ||
    zonefile === null ||
    Array.isArray(zonefile)
  ) {
    return { valid: false, error: "Zonefile must be an object" };
  }

  if (typeof zonefile.owner !== "string" || zonefile.owner.trim() === "") {
    return {
      valid: false,
      error: "Field 'owner' is required and must be a non-empty string",
    };
  }

  const stringFields = ["btc", "bio", "website", "name", "location"];
  for (const field of stringFields) {
    if (field in zonefile && typeof zonefile[field] !== "string") {
      return { valid: false, error: `Field '${field}' must be a string` };
    }
  }

  if ("pfp" in zonefile) {
    if (typeof zonefile.pfp !== "string") {
      return { valid: false, error: "Field 'pfp' must be a string" };
    }
    if (!isValidImageUrl(zonefile.pfp)) {
      return {
        valid: false,
        error:
          "Field 'pfp' must be a valid HTTPS URL ending with a valid image extension",
      };
    }
  }

  if ("website" in zonefile && !isValidUrl(zonefile.website)) {
    return { valid: false, error: "Field 'website' must be a valid URL" };
  }

  if ("social" in zonefile) {
    if (!Array.isArray(zonefile.social)) {
      return { valid: false, error: "Field 'social' must be an array" };
    }

    for (let i = 0; i < zonefile.social.length; i++) {
      const social = zonefile.social[i];
      if (typeof social !== "object" || social === null) {
        return {
          valid: false,
          error: `Social entry at index ${i} must be an object`,
        };
      }

      if (
        typeof social.platform !== "string" ||
        !VALID_SOCIAL_PLATFORMS.includes(social.platform.toLowerCase())
      ) {
        return {
          valid: false,
          error: `Social entry at index ${i} has invalid platform. Valid platforms: ${VALID_SOCIAL_PLATFORMS.join(
            ", "
          )}`,
        };
      }

      if (
        typeof social.username !== "string" ||
        social.username.trim() === ""
      ) {
        return {
          valid: false,
          error: `Social entry at index ${i} must have a non-empty username`,
        };
      }
    }
  }

  if ("addresses" in zonefile) {
    if (!Array.isArray(zonefile.addresses)) {
      return { valid: false, error: "Field 'addresses' must be an array" };
    }

    for (let i = 0; i < zonefile.addresses.length; i++) {
      const addr = zonefile.addresses[i];
      if (typeof addr !== "object" || addr === null) {
        return {
          valid: false,
          error: `Address entry at index ${i} must be an object`,
        };
      }

      if (
        typeof addr.network !== "string" ||
        !VALID_NETWORKS.includes(addr.network.toLowerCase())
      ) {
        return {
          valid: false,
          error: `Address entry at index ${i} has invalid network. Valid networks: ${VALID_NETWORKS.join(
            ", "
          )}`,
        };
      }

      if (typeof addr.address !== "string" || addr.address.trim() === "") {
        return {
          valid: false,
          error: `Address entry at index ${i} must have a non-empty address`,
        };
      }

      if (
        typeof addr.type !== "string" ||
        !VALID_ADDRESS_TYPES.includes(addr.type.toLowerCase())
      ) {
        return {
          valid: false,
          error: `Address entry at index ${i} has invalid type. Valid types: ${VALID_ADDRESS_TYPES.join(
            ", "
          )}`,
        };
      }
    }
  }

  if ("meta" in zonefile) {
    if (!Array.isArray(zonefile.meta)) {
      return { valid: false, error: "Field 'meta' must be an array" };
    }

    for (let i = 0; i < zonefile.meta.length; i++) {
      const meta = zonefile.meta[i];
      if (typeof meta !== "object" || meta === null) {
        return {
          valid: false,
          error: `Meta entry at index ${i} must be an object`,
        };
      }

      if (typeof meta.name !== "string" || meta.name.trim() === "") {
        return {
          valid: false,
          error: `Meta entry at index ${i} must have a non-empty name`,
        };
      }

      if (typeof meta.value !== "string") {
        return {
          valid: false,
          error: `Meta entry at index ${i} must have a string value`,
        };
      }
    }
  }

  if ("subdomains" in zonefile) {
    if (
      typeof zonefile.subdomains !== "object" ||
      zonefile.subdomains === null ||
      Array.isArray(zonefile.subdomains)
    ) {
      return { valid: false, error: "Field 'subdomains' must be an object" };
    }

    for (const [subName, subData] of Object.entries(zonefile.subdomains)) {
      if (!/^[a-z0-9-_]+$/.test(subName)) {
        return {
          valid: false,
          error: `Subdomain name '${subName}' contains invalid characters. Only lowercase letters, numbers, hyphens, and underscores are allowed`,
        };
      }

      const subValidation = validateProfileZonefile({ ...subData });
      if (!subValidation.valid) {
        return {
          valid: false,
          error: `Subdomain '${subName}': ${subValidation.error}`,
        };
      }
    }
  }

  if ("externalSubdomainsFile" in zonefile) {
    if (typeof zonefile.externalSubdomainsFile !== "string") {
      return {
        valid: false,
        error: "Field 'externalSubdomainsFile' must be a string",
      };
    }
    if (!isValidUrl(zonefile.externalSubdomainsFile)) {
      return {
        valid: false,
        error: "Field 'externalSubdomainsFile' must be a valid URL",
      };
    }
  }

  return { valid: true };
}

const zonefileHandlers = {
  getRawZonefile: async (request, reply, { schema, network }) => {
    const [nameString, namespaceString] = request.params.full_name.split(".");
    const cacheKey = `raw_zonefile_${network}_${nameString}.${namespaceString}`;

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
        .status(404)
        .send({ error: "Name not found, expired or revoked" });
    }

    const { zonefile, owner } = result.rows[0];

    if (!zonefile) {
      return reply
        .status(404)
        .send({ error: "No zonefile found for this name" });
    }

    const decodedZonefile = decodeZonefile(zonefile);

    if (!decodedZonefile) {
      return reply.status(400).send({ error: "Unable to decode zonefile" });
    }

    if (decodedZonefile.owner !== owner) {
      return reply
        .status(400)
        .send({ error: "Zonefile owner does not match name owner" });
    }

    const response = {
      ...(network === "testnet" && { network: "testnet" }),
      full_name: `${nameString}.${namespaceString}`,
      zonefile: decodedZonefile,
    };

    cache.set(cacheKey, response, CACHE_TTL.ZONEFILE_DATA);
    reply.send(response);
  },

  getProfileZonefile: async (request, reply, { schema, network }) => {
    const [nameString, namespaceString] = request.params.full_name.split(".");
    const cacheKey = `profile_zonefile_${network}_${nameString}.${namespaceString}`;

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
        .status(404)
        .send({ error: "Name not found, expired or revoked" });
    }

    const { zonefile, owner } = result.rows[0];

    if (!zonefile) {
      return reply
        .status(404)
        .send({ error: "No zonefile found for this name" });
    }

    const decodedZonefile = decodeZonefile(zonefile);

    if (!decodedZonefile) {
      return reply.status(400).send({ error: "Unable to decode zonefile" });
    }

    const validation = validateProfileZonefile(decodedZonefile);

    if (!validation.valid) {
      return reply.status(400).send({
        error: "Invalid profile zonefile format",
        details: validation.error,
      });
    }

    if (decodedZonefile.owner !== owner) {
      return reply
        .status(400)
        .send({ error: "Zonefile owner does not match name owner" });
    }

    const response = {
      ...(network === "testnet" && { network: "testnet" }),
      full_name: `${nameString}.${namespaceString}`,
      profile: decodedZonefile,
      validation: {
        valid: true,
        format: "profile",
      },
    };

    cache.set(cacheKey, response, CACHE_TTL.ZONEFILE_DATA);
    reply.send(response);
  },
};

export default zonefileHandlers;
