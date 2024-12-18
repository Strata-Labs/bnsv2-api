import Fastify from "fastify";
import pg from "pg";
import rateLimit from "@fastify/rate-limit";
import dotenv from "dotenv";
import fetch from "node-fetch";
import cors from "@fastify/cors";

dotenv.config();

const fastify = Fastify({ logger: true });

await fastify.register(cors, {
  origin: "*",
  methods: ["GET"],
});

await fastify.register(rateLimit, {
  max: 10000,
  timeWindow: "1 minute",
  allowList: ["127.0.0.1"],
});

const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: {
    rejectUnauthorized: false,
  },
});

// Network configurations
const NETWORK_CONFIG = {
  mainnet: {
    schema: "public",
    apiUrl: "https://api.hiro.so",
    contract: "SP2QEZ06AGJ3RKJPBV14SY1V5BBFNAW33D96YPGZF.BNS-V2",
  },
  testnet: {
    schema: "testnet",
    apiUrl: "https://api.testnet.hiro.so",
    contract: "ST2QEZ06AGJ3RKJPBV14SY1V5BBFNAW33D9SZJQ0M.BNS-V2",
  },
};

// Common handler factory
function createNetworkHandler(handler) {
  return async (request, reply) => {
    const network = request.url.startsWith("/testnet/") ? "testnet" : "mainnet";
    const { schema, apiUrl } = NETWORK_CONFIG[network];

    try {
      return await handler(request, reply, { schema, network, apiUrl });
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: "Internal Server Error" });
    }
  };
}

// Helper functions
async function getCurrentBurnBlockHeight(network) {
  const config = NETWORK_CONFIG[network];
  const response = await fetch(
    `${config.apiUrl}/extended/v2/burn-blocks?limit=1`
  );
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  const data = await response.json();
  return data.results[0].burn_block_height;
}

function decodeZonefile(zonefileHex) {
  if (!zonefileHex) return null;
  try {
    const hex = zonefileHex.replace("0x", "");
    const decoded = Buffer.from(hex, "hex").toString("utf8");
    try {
      return JSON.parse(decoded);
    } catch {
      return decoded;
    }
  } catch (error) {
    fastify.log.error("Error decoding zonefile:", error);
    return null;
  }
}

function isValidZonefileFormat(zonefile) {
  try {
    // FIRST: Attempt old format validation
    const oldRequiredFields = [
      "owner",
      "general",
      "twitter",
      "url",
      "nostr",
      "lightning",
      "btc",
      "subdomains",
    ];
    const oldSubdomainFields = [
      "name",
      "sequence",
      "owner",
      "signature",
      "text",
    ];

    function validateOldFormat(zf) {
      for (const field of oldRequiredFields) {
        if (!(field in zf)) {
          return false;
        }
      }

      if (!Array.isArray(zf.subdomains)) {
        return false;
      }

      for (let i = 0; i < zf.subdomains.length; i++) {
        const subdomain = zf.subdomains[i];

        for (const field of oldSubdomainFields) {
          if (!(field in subdomain)) {
            return false;
          }
        }

        if (typeof subdomain.sequence !== "number") {
          return false;
        }
      }

      return true;
    }

    // Check if old format is valid
    if (validateOldFormat(zonefile)) {
      return true;
    }

    // If not old format, attempt new format validation
    const baseFields = [
      "owner",
      "general",
      "twitter",
      "url",
      "nostr",
      "lightning",
      "btc",
    ];

    // Check that all base fields are strings
    for (const field of baseFields) {
      if (typeof zonefile[field] !== "string") {
        return false;
      }
    }

    const hasExternalFile =
      "externalSubdomainFile" in zonefile &&
      typeof zonefile.externalSubdomainFile === "string";
    const hasSubdomains = "subdomains" in zonefile;

    // They can't both be present
    if (hasExternalFile && hasSubdomains) {
      return false;
    }

    // If externalSubdomainFile is present and valid, that's enough for the new format
    if (hasExternalFile) {
      return true;
    }

    // If no external file, we must have subdomains
    if (!hasSubdomains) {
      return false;
    }

    // Check the structure of subdomains in the new format
    const subdomains = zonefile.subdomains;
    if (
      typeof subdomains !== "object" ||
      subdomains === null ||
      Array.isArray(subdomains)
    ) {
      return false;
    }

    // Each subdomain in the new format must be an object with all base fields as strings
    for (const subName in subdomains) {
      const subProps = subdomains[subName];
      if (typeof subProps !== "object" || subProps === null) {
        return false;
      }

      for (const field of baseFields) {
        if (typeof subProps[field] !== "string") {
          return false;
        }
      }
    }

    return true;
  } catch (error) {
    console.error("Error validating zonefile:", error);
    return false;
  }
}

// Route handlers
const handlers = {
  // 1. Get all names
  getAllNames: async (request, reply, { schema, network }) => {
    const { limit = 50, offset = 0 } = request.query;
    const currentBurnBlock = await getCurrentBurnBlockHeight(network);

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM ${schema}.names`
    );

    const result = await pool.query(
      `SELECT 
        name_string || '.' || namespace_string AS full_name,
        name_string,
        namespace_string,
        owner,
        registered_at,
        renewal_height,
        stx_burn,
        CASE 
          WHEN renewal_height = 0 THEN true
          WHEN renewal_height > $3 THEN true
          ELSE false
        END as is_valid
       FROM ${schema}.names 
       ORDER BY name_string || '.' || namespace_string ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset, currentBurnBlock]
    );

    reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      total: parseInt(countResult.rows[0].count),
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      names: result.rows,
    });
  },

  // 2. Get only valid names
  getValidNames: async (request, reply, { schema, network }) => {
    const { limit = 50, offset = 0 } = request.query;
    const currentBurnBlock = await getCurrentBurnBlockHeight(network);

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM ${schema}.names 
       WHERE revoked = false 
       AND (renewal_height = 0 OR renewal_height > $1)`,
      [currentBurnBlock]
    );

    const result = await pool.query(
      `SELECT 
        name_string || '.' || namespace_string AS full_name,
        name_string,
        namespace_string,
        owner,
        registered_at,
        renewal_height,
        stx_burn,
        revoked
       FROM ${schema}.names 
       WHERE revoked = false
       AND (renewal_height = 0 OR renewal_height > $3)
       ORDER BY name_string || '.' || namespace_string ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset, currentBurnBlock]
    );

    reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      total: parseInt(countResult.rows[0].count),
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      names: result.rows,
    });
  },

  // 3. Get expired names
  getExpiredNames: async (request, reply, { schema, network }) => {
    const { limit = 50, offset = 0 } = request.query;
    const currentBurnBlock = await getCurrentBurnBlockHeight(network);

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM ${schema}.names 
       WHERE renewal_height != 0 
       AND renewal_height <= $1 
       AND revoked = false`,
      [currentBurnBlock]
    );

    const result = await pool.query(
      `SELECT 
        name_string || '.' || namespace_string AS full_name,
        name_string,
        namespace_string,
        owner,
        registered_at,
        renewal_height,
        stx_burn
       FROM ${schema}.names 
       WHERE renewal_height != 0 
       AND renewal_height <= $3
       AND revoked = false
       ORDER BY name_string || '.' || namespace_string ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset, currentBurnBlock]
    );

    reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      total: parseInt(countResult.rows[0].count),
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      names: result.rows,
    });
  },

  // 4. Get revoked names
  getRevokedNames: async (request, reply, { schema, network }) => {
    const { limit = 50, offset = 0 } = request.query;
    const currentBurnBlock = await getCurrentBurnBlockHeight(network);

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM ${schema}.names WHERE revoked = true`
    );

    const result = await pool.query(
      `SELECT 
        name_string || '.' || namespace_string AS full_name,
        name_string,
        namespace_string,
        owner,
        registered_at,
        renewal_height,
        stx_burn
       FROM ${schema}.names 
       WHERE revoked = true
       ORDER BY name_string || '.' || namespace_string ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      total: parseInt(countResult.rows[0].count),
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      names: result.rows,
    });
  },

  // 5. Get valid names for an address
  getValidNamesByAddress: async (request, reply, { schema, network }) => {
    const { address } = request.params;
    const { limit = 50, offset = 0 } = request.query;
    const currentBurnBlock = await getCurrentBurnBlockHeight(network);

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM ${schema}.names 
       WHERE owner = $1 
       AND revoked = false
       AND (renewal_height = 0 OR renewal_height > $2)`,
      [address, currentBurnBlock]
    );

    const result = await pool.query(
      `SELECT 
        name_string || '.' || namespace_string AS full_name,
        name_string,
        namespace_string,
        owner,
        registered_at,
        renewal_height,
        stx_burn,
        revoked
       FROM ${schema}.names 
       WHERE owner = $1 
       AND revoked = false
       AND (renewal_height = 0 OR renewal_height > $4)
       ORDER BY name_string || '.' || namespace_string ASC
       LIMIT $2 OFFSET $3`,
      [address, limit, offset, currentBurnBlock]
    );

    reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      total: parseInt(countResult.rows[0].count),
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      names: result.rows,
    });
  },
  // 6. Get expired names for an address
  getExpiredNamesByAddress: async (request, reply, { schema, network }) => {
    const { address } = request.params;
    const { limit = 50, offset = 0 } = request.query;
    const currentBurnBlock = await getCurrentBurnBlockHeight(network);

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM ${schema}.names 
       WHERE owner = $1 
       AND revoked = false
       AND renewal_height != 0 
       AND renewal_height <= $2`,
      [address, currentBurnBlock]
    );

    const result = await pool.query(
      `SELECT 
        name_string || '.' || namespace_string AS full_name,
        name_string,
        namespace_string,
        owner,
        registered_at,
        renewal_height,
        stx_burn
       FROM ${schema}.names 
       WHERE owner = $1 
       AND revoked = false
       AND renewal_height != 0 
       AND renewal_height <= $4
       ORDER BY name_string || '.' || namespace_string ASC
       LIMIT $2 OFFSET $3`,
      [address, limit, offset, currentBurnBlock]
    );

    reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      total: parseInt(countResult.rows[0].count),
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      names: result.rows,
    });
  },

  // 7. Get names about to expire for an address
  getExpiringNamesByAddress: async (request, reply, { schema, network }) => {
    const { address } = request.params;
    const { limit = 50, offset = 0 } = request.query;
    const currentBurnBlock = await getCurrentBurnBlockHeight(network);
    const expirationWindow = 4320;
    const expirationThreshold = currentBurnBlock + expirationWindow;

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM ${schema}.names 
       WHERE owner = $1 
       AND revoked = false
       AND renewal_height != 0 
       AND renewal_height > $2
       AND renewal_height <= $3`,
      [address, currentBurnBlock, expirationThreshold]
    );

    const result = await pool.query(
      `SELECT 
        name_string || '.' || namespace_string AS full_name,
        name_string,
        namespace_string,
        owner,
        registered_at,
        renewal_height,
        stx_burn,
        renewal_height - $4 as blocks_until_expiry
       FROM ${schema}.names 
       WHERE owner = $1 
       AND revoked = false
       AND renewal_height != 0 
       AND renewal_height > $4
       AND renewal_height <= $5
       ORDER BY renewal_height ASC
       LIMIT $2 OFFSET $3`,
      [address, limit, offset, currentBurnBlock, expirationThreshold]
    );

    reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      total: parseInt(countResult.rows[0].count),
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      names: result.rows,
    });
  },

  // 8. Get revoked names for an address
  getRevokedNamesByAddress: async (request, reply, { schema, network }) => {
    const { address } = request.params;
    const { limit = 50, offset = 0 } = request.query;
    const currentBurnBlock = await getCurrentBurnBlockHeight(network);

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM ${schema}.names 
       WHERE owner = $1 
       AND revoked = true`,
      [address]
    );

    const result = await pool.query(
      `SELECT 
        name_string || '.' || namespace_string AS full_name,
        name_string,
        namespace_string,
        owner,
        registered_at,
        renewal_height,
        stx_burn
       FROM ${schema}.names 
       WHERE owner = $1 
       AND revoked = true
       ORDER BY name_string || '.' || namespace_string ASC
       LIMIT $2 OFFSET $3`,
      [address, limit, offset]
    );

    reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      total: parseInt(countResult.rows[0].count),
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      names: result.rows,
    });
  },

  // 9. Get name details
  getNameDetails: async (request, reply, { schema, network }) => {
    const [name_string, namespace_string] = request.params.full_name.split(".");
    const currentBurnBlock = await getCurrentBurnBlockHeight(network);

    const result = await pool.query(
      `SELECT 
        name_string,
        namespace_string,
        name_string || '.' || namespace_string AS full_name,
        owner,
        registered_at,
        renewal_height,
        stx_burn,
        revoked,
        imported_at,
        preordered_by,
        CASE 
          WHEN renewal_height = 0 THEN true
          WHEN renewal_height > $3 THEN true
          ELSE false
        END as is_valid
       FROM ${schema}.names 
       WHERE name_string = $1 AND namespace_string = $2`,
      [name_string, namespace_string, currentBurnBlock]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({ error: "Name not found" });
    }

    const nameData = result.rows[0];
    let status = "active";
    if (nameData.revoked) {
      status = "revoked";
    } else if (!nameData.is_valid) {
      status = "expired";
    }

    reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      current_burn_block: currentBurnBlock,
      status: status,
      data: nameData,
    });
  },

  // 10. Get all namespaces
  getAllNamespaces: async (request, reply, { schema, network }) => {
    const { limit = 50, offset = 0 } = request.query;
    const currentBurnBlock = await getCurrentBurnBlockHeight(network);
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM ${schema}.namespaces`
    );

    const result = await pool.query(
      `SELECT 
        namespace_string,
        launched_at,
        lifetime,
        namespace_manager,
        price_function_base,
        price_function_coeff,
        price_function_buckets,
        price_function_no_vowel_discount,
        price_function_nonalpha_discount,
        manager_transferable,
        can_update_price_function,
        (SELECT COUNT(*) FROM ${schema}.names WHERE names.namespace_string = namespaces.namespace_string) as total_names,
        (SELECT COUNT(*) 
         FROM ${schema}.names 
         WHERE names.namespace_string = namespaces.namespace_string 
         AND (renewal_height = 0 OR renewal_height > $3)
         AND revoked = false) as active_names
       FROM ${schema}.namespaces 
       ORDER BY namespace_string ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset, currentBurnBlock]
    );

    reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      total: parseInt(countResult.rows[0].count),
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      namespaces: result.rows,
    });
  },

  // 11. Get all names in a namespace
  getNamesByNamespace: async (request, reply, { schema, network }) => {
    const { namespace } = request.params;
    const { limit = 50, offset = 0 } = request.query;
    const currentBurnBlock = await getCurrentBurnBlockHeight(network);

    // First check if namespace exists
    const namespaceExists = await pool.query(
      `SELECT namespace_string FROM ${schema}.namespaces WHERE namespace_string = $1`,
      [namespace]
    );

    if (namespaceExists.rows.length === 0) {
      return reply.status(404).send({ error: "Namespace not found" });
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM ${schema}.names WHERE namespace_string = $1`,
      [namespace]
    );

    const result = await pool.query(
      `SELECT 
        name_string || '.' || namespace_string AS full_name,
        name_string,
        namespace_string,
        owner,
        registered_at,
        renewal_height,
        stx_burn
       FROM ${schema}.names 
       WHERE namespace_string = $1
       ORDER BY name_string ASC
       LIMIT $2 OFFSET $3`,
      [namespace, limit, offset]
    );

    reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      total: parseInt(countResult.rows[0].count),
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      names: result.rows,
    });
  },

  // 12. Resolve name
  resolveName: async (request, reply, { schema, network }) => {
    const [name_string, namespace_string] = request.params.full_name.split(".");
    const currentBurnBlock = await getCurrentBurnBlockHeight(network);

    const result = await pool.query(
      `SELECT zonefile, owner
       FROM ${schema}.names 
       WHERE name_string = $1 
       AND namespace_string = $2
       AND owner IS NOT NULL
       AND revoked = false
       AND (renewal_height = 0 OR renewal_height > $3)`,
      [name_string, namespace_string, currentBurnBlock]
    );

    if (result.rows.length === 0) {
      return reply
        .code(404)
        .send({ error: "Name not found, expired or revoked" });
    }

    const { zonefile, owner } = result.rows[0];
    const decodedZonefile = decodeZonefile(zonefile);

    if (!decodedZonefile) {
      return reply.code(404).send({ error: "No zonefile found" });
    }

    if (!isValidZonefileFormat(decodedZonefile)) {
      return reply.code(400).send({ error: "Invalid zonefile format" });
    }

    if (decodedZonefile.owner !== owner) {
      return reply.code(400).send({ error: "Zonefile needs to be updated" });
    }

    return reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      zonefile: decodedZonefile,
    });
  },

  // 13. Get a Namespace
  getNamespace: async (request, reply, { schema, network }) => {
    const { namespace } = request.params;
    const currentBurnBlock = await getCurrentBurnBlockHeight(network);

    const result = await pool.query(
      `SELECT 
        namespace_string,
        launched_at,
        lifetime,
        namespace_manager,
        price_function_base,
        price_function_coeff,
        price_function_buckets,
        price_function_no_vowel_discount,
        price_function_nonalpha_discount,
        manager_transferable,
        can_update_price_function,
        (SELECT COUNT(*) FROM ${schema}.names WHERE names.namespace_string = namespaces.namespace_string) as total_names,
        (SELECT COUNT(*) 
         FROM ${schema}.names 
         WHERE names.namespace_string = namespaces.namespace_string 
         AND (renewal_height = 0 OR renewal_height > $2)
         AND revoked = false) as active_names,
        (SELECT COUNT(*) 
         FROM ${schema}.names 
         WHERE names.namespace_string = namespaces.namespace_string 
         AND renewal_height != 0 
         AND renewal_height <= $2
         AND revoked = false) as expired_names,
        (SELECT COUNT(*) 
         FROM ${schema}.names 
         WHERE names.namespace_string = namespaces.namespace_string 
         AND revoked = true) as revoked_names,
        (SELECT MIN(registered_at) 
         FROM ${schema}.names 
         WHERE names.namespace_string = namespaces.namespace_string) as first_registration,
        (SELECT MAX(registered_at) 
         FROM ${schema}.names 
         WHERE names.namespace_string = namespaces.namespace_string) as last_registration
       FROM ${schema}.namespaces 
       WHERE namespace_string = $1`,
      [namespace, currentBurnBlock]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({ error: "Namespace not found" });
    }

    reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      current_burn_block: currentBurnBlock,
      namespace: result.rows[0],
    });
  },

  // 14. Can name be registered
  canNameBeRegistered: async (request, reply, { schema, network }) => {
    const { namespace, name } = request.params;
    const currentBurnBlock = await getCurrentBurnBlockHeight(network);

    // First check if namespace exists and is launched
    const namespaceResult = await pool.query(
      `SELECT 
        launched_at,
        namespace_manager
       FROM ${schema}.namespaces 
       WHERE namespace_string = $1`,
      [namespace]
    );

    if (namespaceResult.rows.length === 0) {
      return reply.status(404).send({
        error: "Namespace not found",
        can_register: false,
        reason: "NAMESPACE_NOT_FOUND",
      });
    }

    const namespaceData = namespaceResult.rows[0];

    if (!namespaceData.launched_at) {
      return reply.send({
        can_register: false,
        reason: "NAMESPACE_NOT_LAUNCHED",
      });
    }

    // Check if name exists
    const nameResult = await pool.query(
      `SELECT 
        name_string,
        namespace_string,
        registered_at,
        renewal_height,
        revoked,
        imported_at,
        owner
       FROM ${schema}.names 
       WHERE name_string = $1 AND namespace_string = $2`,
      [name, namespace]
    );

    if (nameResult.rows.length === 0) {
      return reply.send({
        ...(network === "testnet" && { network: "testnet" }),
        can_register: true,
        reason: "NAME_AVAILABLE",
      });
    }

    const nameData = nameResult.rows[0];

    if (nameData.imported_at) {
      return reply.send({
        ...(network === "testnet" && { network: "testnet" }),
        can_register: false,
        reason: "NAME_IMPORTED",
        current_owner: nameData.owner,
      });
    }

    if (!namespaceData.namespace_manager && nameData.renewal_height > 0) {
      const isExpired = nameData.renewal_height <= currentBurnBlock;
      if (isExpired) {
        return reply.send({
          ...(network === "testnet" && { network: "testnet" }),
          can_register: true,
          reason: "NAME_EXPIRED",
          previous_owner: nameData.owner,
          expired_at: nameData.renewal_height,
        });
      }
    }

    return reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      can_register: false,
      reason: "NAME_TAKEN",
      current_owner: nameData.owner,
    });
  },

  // 15. Get the last token id
  getLastTokenId: async (request, reply, { schema, network }) => {
    const result = await pool.query(
      `SELECT COALESCE(MAX(id), 0) as last_token_id FROM ${schema}.names`
    );
    const lastTokenId = result.rows[0].last_token_id;

    reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      last_token_id: lastTokenId,
    });
  },

  // 16. Get name renewal height
  getNameRenewal: async (request, reply, { schema, network }) => {
    const [name_string, namespace_string] = request.params.full_name.split(".");
    const currentBurnBlock = await getCurrentBurnBlockHeight(network);

    // First get the namespace info to check if it requires renewals
    const namespaceResult = await pool.query(
      `SELECT lifetime::integer, namespace_manager::text FROM ${schema}.namespaces WHERE namespace_string = $1`,
      [namespace_string]
    );

    if (namespaceResult.rows.length === 0) {
      return reply.status(404).send({ error: "Namespace not found" });
    }

    const lifetime = parseInt(namespaceResult.rows[0].lifetime) || 0;
    const namespace_manager = namespaceResult.rows[0].namespace_manager;
    const isManaged =
      namespace_manager !== "none" && namespace_manager !== null;

    const nameResult = await pool.query(
      `SELECT 
        name_string,
        namespace_string,
        registered_at,
        renewal_height::integer,
        revoked,
        imported_at
       FROM ${schema}.names 
       WHERE name_string = $1 AND namespace_string = $2`,
      [name_string, namespace_string]
    );

    if (nameResult.rows.length === 0) {
      return reply.status(404).send({ error: "Name not found" });
    }

    const nameData = nameResult.rows[0];

    if (nameData.revoked) {
      return reply.send({
        ...(network === "testnet" && { network: "testnet" }),
        current_burn_block: currentBurnBlock,
        renewal_height: 0,
        blocks_until_expiry: 0,
        status: "revoked",
        needs_renewal: false,
        is_managed: isManaged,
      });
    }

    if (isManaged) {
      return reply.send({
        ...(network === "testnet" && { network: "testnet" }),
        current_burn_block: currentBurnBlock,
        renewal_height: 0,
        blocks_until_expiry: 0,
        status: "active",
        needs_renewal: false,
        is_managed: true,
      });
    }

    if (lifetime === 0) {
      return reply.send({
        ...(network === "testnet" && { network: "testnet" }),
        current_burn_block: currentBurnBlock,
        renewal_height: 0,
        blocks_until_expiry: 0,
        status: "active",
        needs_renewal: false,
        is_managed: false,
      });
    }

    const renewalHeight = parseInt(nameData.renewal_height) || 0;
    let status = "active";
    let needsRenewal = false;
    let blocksUntilExpiry =
      renewalHeight > currentBurnBlock ? renewalHeight - currentBurnBlock : 0;

    if (renewalHeight !== 0) {
      const gracePeriod = 5000;
      const expirationBlock = renewalHeight + gracePeriod;

      if (currentBurnBlock > expirationBlock) {
        status = "expired";
        needsRenewal = false;
      } else if (currentBurnBlock > renewalHeight) {
        status = "grace-period";
        needsRenewal = true;
      } else if (currentBurnBlock > renewalHeight - 4320) {
        status = "expiring-soon";
        needsRenewal = true;
      }
    }

    return reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      current_burn_block: currentBurnBlock,
      renewal_height: renewalHeight,
      blocks_until_expiry: blocksUntilExpiry,
      status: status,
      needs_renewal: needsRenewal,
      is_managed: false,
    });
  },

  // 17. Check if a name can be resolved
  canResolve: async (request, reply, { schema, network }) => {
    const [name_string, namespace_string] = request.params.full_name.split(".");
    const currentBurnBlock = await getCurrentBurnBlockHeight(network);

    const namespaceResult = await pool.query(
      `SELECT 
        lifetime::integer, 
        namespace_manager::text,
        launched_at
       FROM ${schema}.namespaces 
       WHERE namespace_string = $1`,
      [namespace_string]
    );

    if (namespaceResult.rows.length === 0) {
      return reply.status(404).send({ error: "Namespace not found" });
    }

    const { lifetime, launched_at } = namespaceResult.rows[0];

    if (!launched_at) {
      return reply.status(400).send({
        can_resolve: false,
        error: "Namespace not launched",
      });
    }

    const nameResult = await pool.query(
      `SELECT 
        name_string,
        namespace_string,
        owner,
        registered_at,
        renewal_height::integer,
        revoked,
        imported_at
       FROM ${schema}.names 
       WHERE name_string = $1 AND namespace_string = $2`,
      [name_string, namespace_string]
    );

    if (nameResult.rows.length === 0) {
      return reply.status(404).send({ error: "Name not found" });
    }

    const nameData = nameResult.rows[0];

    if (nameData.revoked) {
      return reply.send({
        ...(network === "testnet" && { network: "testnet" }),
        can_resolve: false,
        error: "Name is revoked",
        current_burn_block: currentBurnBlock,
      });
    }

    let renewalHeight = nameData.renewal_height;

    if (lifetime === 0) {
      return reply.send({
        ...(network === "testnet" && { network: "testnet" }),
        can_resolve: true,
        renewal_height: 0,
        owner: nameData.owner,
        current_burn_block: currentBurnBlock,
      });
    }

    if (renewalHeight === 0 && nameData.imported_at) {
      renewalHeight = launched_at + lifetime;
    }

    const isWithinValidPeriod =
      renewalHeight === 0 || currentBurnBlock <= renewalHeight + 5000;

    return reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      can_resolve: isWithinValidPeriod,
      renewal_height: renewalHeight,
      owner: nameData.owner,
      current_burn_block: currentBurnBlock,
      ...(isWithinValidPeriod ? {} : { error: "Name expired" }),
    });
  },

  // 18. Get owner of a name
  getNameOwner: async (request, reply, { schema, network }) => {
    const [name_string, namespace_string] = request.params.full_name.split(".");
    const currentBurnBlock = await getCurrentBurnBlockHeight(network);

    const nameResult = await pool.query(
      `SELECT 
        owner,
        revoked,
        renewal_height::integer,
        registered_at,
        imported_at
       FROM ${schema}.names 
       WHERE name_string = $1 AND namespace_string = $2`,
      [name_string, namespace_string]
    );

    if (nameResult.rows.length === 0) {
      return reply.status(404).send({ error: "Name not found" });
    }

    const nameData = nameResult.rows[0];

    const namespaceResult = await pool.query(
      `SELECT 
        lifetime::integer,
        namespace_manager::text,
        launched_at
       FROM ${schema}.namespaces 
       WHERE namespace_string = $1`,
      [namespace_string]
    );

    if (namespaceResult.rows.length === 0) {
      return reply.status(404).send({ error: "Namespace not found" });
    }

    const { lifetime, launched_at } = namespaceResult.rows[0];

    if (!launched_at) {
      return reply.status(400).send({ error: "Namespace not launched" });
    }

    if (nameData.revoked) {
      return reply.send({
        ...(network === "testnet" && { network: "testnet" }),
        owner: nameData.owner,
        current_burn_block: currentBurnBlock,
        status: "revoked",
      });
    }

    let renewalHeight = nameData.renewal_height;
    if (renewalHeight === 0 && nameData.imported_at && lifetime !== 0) {
      renewalHeight = launched_at + lifetime;
    }

    if (lifetime === 0) {
      return reply.send({
        ...(network === "testnet" && { network: "testnet" }),
        owner: nameData.owner,
        current_burn_block: currentBurnBlock,
        status: "active",
      });
    }

    const isWithinValidPeriod =
      renewalHeight === 0 || currentBurnBlock <= renewalHeight + 5000;

    let status = "active";
    if (!isWithinValidPeriod) {
      status = "expired";
    } else if (currentBurnBlock > renewalHeight) {
      status = "grace-period";
    } else if (currentBurnBlock > renewalHeight - 4320) {
      status = "expiring-soon";
    }

    return reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      owner: nameData.owner,
      current_burn_block: currentBurnBlock,
      renewal_height: renewalHeight,
      status: status,
    });
  },

  // 19. Get owner of a name by token ID
  getTokenOwner: async (request, reply, { schema, network }) => {
    const { id } = request.params;
    const currentBurnBlock = await getCurrentBurnBlockHeight(network);

    const tokenResult = await pool.query(
      `SELECT 
        n.name_string,
        n.namespace_string,
        n.owner,
        n.revoked,
        n.renewal_height::integer,
        n.registered_at,
        n.imported_at
       FROM ${schema}.names n
       WHERE n.id = $1`,
      [id]
    );

    if (tokenResult.rows.length === 0) {
      return reply.status(404).send({ error: "Token ID not found" });
    }

    const nameData = tokenResult.rows[0];

    const namespaceResult = await pool.query(
      `SELECT 
        lifetime::integer,
        namespace_manager::text,
        launched_at
       FROM ${schema}.namespaces 
       WHERE namespace_string = $1`,
      [nameData.namespace_string]
    );

    if (namespaceResult.rows.length === 0) {
      return reply.status(404).send({ error: "Namespace not found" });
    }

    const { lifetime, launched_at } = namespaceResult.rows[0];

    if (!launched_at) {
      return reply.status(400).send({ error: "Namespace not launched" });
    }

    if (nameData.revoked) {
      return reply.send({
        ...(network === "testnet" && { network: "testnet" }),
        owner: nameData.owner,
        name: nameData.name_string,
        namespace: nameData.namespace_string,
        current_burn_block: currentBurnBlock,
        status: "revoked",
      });
    }

    let renewalHeight = nameData.renewal_height;
    if (renewalHeight === 0 && nameData.imported_at && lifetime !== 0) {
      renewalHeight = launched_at + lifetime;
    }

    if (lifetime === 0) {
      return reply.send({
        ...(network === "testnet" && { network: "testnet" }),
        owner: nameData.owner,
        name: nameData.name_string,
        namespace: nameData.namespace_string,
        current_burn_block: currentBurnBlock,
        status: "active",
      });
    }

    const isWithinValidPeriod =
      renewalHeight === 0 || currentBurnBlock <= renewalHeight + 5000;

    let status = "active";
    if (!isWithinValidPeriod) {
      status = "expired";
    } else if (currentBurnBlock > renewalHeight) {
      status = "grace-period";
    } else if (currentBurnBlock > renewalHeight - 4320) {
      status = "expiring-soon";
    }

    return reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      owner: nameData.owner,
      name: nameData.name_string,
      namespace: nameData.namespace_string,
      current_burn_block: currentBurnBlock,
      renewal_height: renewalHeight,
      status: status,
    });
  },

  // 20. Get token ID from name
  getNameId: async (request, reply, { schema, network }) => {
    const [name_string, namespace_string] = request.params.full_name.split(".");

    const result = await pool.query(
      `SELECT id 
       FROM ${schema}.names 
       WHERE name_string = $1 AND namespace_string = $2`,
      [name_string, namespace_string]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({ error: "Name not found" });
    }

    return reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      name: name_string,
      namespace: namespace_string,
      id: result.rows[0].id,
    });
  },

  // 21. Get name from token ID
  getTokenName: async (request, reply, { schema, network }) => {
    const { id } = request.params;

    const result = await pool.query(
      `SELECT 
        name_string,
        namespace_string
       FROM ${schema}.names 
       WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({ error: "Token ID not found" });
    }

    const { name_string, namespace_string } = result.rows[0];

    return reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      id: parseInt(id),
      name: name_string,
      namespace: namespace_string,
      full_name: `${name_string}.${namespace_string}`,
    });
  },

  // 22. Get name information by token ID
  getTokenInfo: async (request, reply, { schema, network }) => {
    const { id } = request.params;
    const currentBurnBlock = await getCurrentBurnBlockHeight(network);

    const result = await pool.query(
      `SELECT 
        name_string,
        namespace_string,
        name_string || '.' || namespace_string AS full_name,
        owner,
        registered_at,
        renewal_height,
        stx_burn,
        revoked,
        imported_at,
        preordered_by,
        CASE 
          WHEN renewal_height = 0 THEN true
          WHEN renewal_height > $2 THEN true
          ELSE false
        END as is_valid
       FROM ${schema}.names 
       WHERE id = $1`,
      [id, currentBurnBlock]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({ error: "Token ID not found" });
    }

    const nameData = result.rows[0];
    let status = "active";

    if (nameData.revoked) {
      status = "revoked";
    } else if (!nameData.is_valid) {
      status = "expired";
    }

    reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      current_burn_block: currentBurnBlock,
      status: status,
      data: nameData,
    });
  },

  // 23. Get rarity metrics for a name
  getNameRarity: async (request, reply, { schema, network }) => {
    const [name_string, namespace_string] = request.params.full_name.split(".");
    const currentBurnBlock = await getCurrentBurnBlockHeight(network);

    // First verify the name exists
    const nameExists = await pool.query(
      `SELECT id FROM ${schema}.names WHERE name_string = $1 AND namespace_string = $2`,
      [name_string, namespace_string]
    );

    if (nameExists.rows.length === 0) {
      return reply.status(404).send({ error: "Name not found" });
    }

    // Get total names in namespace for percentile calculations
    const totalNames = await pool.query(
      `SELECT COUNT(*) as total FROM ${schema}.names WHERE namespace_string = $1`,
      [namespace_string]
    );

    // Calculate various rarity metrics
    const metricsResult = await pool.query(
      `
      WITH stats AS (
        SELECT 
          -- Length stats
          (SELECT COUNT(*) FROM ${schema}.names WHERE namespace_string = $2 AND LENGTH(name_string) = LENGTH($1)) as same_length_count,
          
          -- Numeric-only names
          (SELECT COUNT(*) FROM ${schema}.names WHERE namespace_string = $2 
           AND name_string ~ '^[0-9]+$') as numeric_only_count,
          
          -- Letter-only names
          (SELECT COUNT(*) FROM ${schema}.names WHERE namespace_string = $2 
           AND name_string ~ '^[a-z]+$') as letter_only_count,
          
          -- Names with special characters
          (SELECT COUNT(*) FROM ${schema}.names WHERE namespace_string = $2 
           AND name_string ~ '[^a-z0-9]') as special_char_count,
          
          -- Pattern matches for current name
          CASE WHEN $1 ~ '^[0-9]+$' THEN true ELSE false END as is_numeric,
          CASE WHEN $1 ~ '^[a-z]+$' THEN true ELSE false END as is_letters_only,
          CASE WHEN $1 ~ '[^a-z0-9]' THEN true ELSE false END as has_special_chars
      )
      SELECT 
        LENGTH($1) as name_length,
        same_length_count,
        ROUND((same_length_count::numeric / $3::numeric) * 100, 2) as length_percentile,
        is_numeric,
        numeric_only_count,
        ROUND((numeric_only_count::numeric / $3::numeric) * 100, 2) as numeric_percentile,
        is_letters_only,
        letter_only_count,
        ROUND((letter_only_count::numeric / $3::numeric) * 100, 2) as letters_percentile,
        has_special_chars,
        special_char_count,
        ROUND((special_char_count::numeric / $3::numeric) * 100, 2) as special_char_percentile
      FROM stats
    `,
      [name_string, namespace_string, totalNames.rows[0].total]
    );

    const metrics = metricsResult.rows[0];
    const isPalindrome =
      name_string === name_string.split("").reverse().join("");
    const hasRepeatingChars = /(.)\1+/.test(name_string);

    // Calculate rarity score (0-100, where lower is rarer)
    let rarityScore = 0;

    // Length contribution
    if (metrics.name_length <= 3) {
      rarityScore += 10;
    } else if (metrics.name_length <= 5) {
      rarityScore += 30;
    } else if (metrics.name_length <= 7) {
      rarityScore += 50;
    } else if (metrics.name_length <= 10) {
      rarityScore += 70;
    } else {
      rarityScore += 90;
    }

    // Type contribution
    if (metrics.is_numeric) {
      rarityScore += parseFloat(metrics.numeric_percentile) * 0.2;
    }
    if (metrics.is_letters_only) {
      rarityScore += parseFloat(metrics.letters_percentile) * 0.2;
    }
    if (metrics.has_special_chars) {
      rarityScore += parseFloat(metrics.special_char_percentile) * 0.2;
    }

    // Special patterns contribution
    if (isPalindrome) rarityScore -= 10;
    if (hasRepeatingChars) rarityScore += 5;

    // Normalize score
    rarityScore = Math.max(0, Math.min(100, rarityScore));

    reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      name: name_string,
      namespace: namespace_string,
      metrics: {
        length: {
          value: metrics.name_length,
          count_same_length: metrics.same_length_count,
          percentile: metrics.length_percentile,
        },
        type: {
          is_numeric: metrics.is_numeric,
          is_letters_only: metrics.is_letters_only,
          has_special_chars: metrics.has_special_chars,
          numeric_names_count: metrics.numeric_only_count,
          letter_only_names_count: metrics.letter_only_count,
          special_char_names_count: metrics.special_char_count,
          numeric_percentile: metrics.numeric_percentile,
          letters_percentile: metrics.letters_percentile,
          special_char_percentile: metrics.special_char_percentile,
        },
        patterns: {
          is_palindrome: isPalindrome,
          has_repeating_chars: hasRepeatingChars,
        },
        rarity_score: {
          score: parseFloat(rarityScore.toFixed(2)),
          classification:
            rarityScore <= 20
              ? "Ultra Rare"
              : rarityScore <= 40
              ? "Rare"
              : rarityScore <= 60
              ? "Uncommon"
              : rarityScore <= 80
              ? "Common"
              : "Very Common",
        },
      },
    });
  },

  // 24. Get rarest names in a namespace
  getRarestNames: async (request, reply, { schema, network }) => {
    const { namespace } = request.params;
    const { limit = 50, offset = 0 } = request.query;
    const currentBurnBlock = await getCurrentBurnBlockHeight(network);

    const result = await pool.query(
      `
      WITH name_metrics AS (
        SELECT 
          name_string,
          namespace_string,
          owner,
          LENGTH(name_string) as name_length,
          CASE 
            WHEN name_string ~ '^[0-9]+$' THEN true 
            WHEN name_string ~ '^[a-z]+$' THEN true
            WHEN name_string ~ '[^a-z0-9]' THEN true
            ELSE false 
          END as has_pattern,
          name_string = REVERSE(name_string) as is_palindrome
        FROM ${schema}.names 
        WHERE namespace_string = $1
        AND revoked = false
        AND (renewal_height = 0 OR renewal_height > $4)
      )
      SELECT 
        name_string,
        namespace_string,
        owner,
        name_length,
        has_pattern,
        is_palindrome,
        CASE
          WHEN name_length = 1 THEN 10
          WHEN name_length = 2 THEN 20
          WHEN name_length = 3 THEN 30
          WHEN name_length <= 5 THEN 50
          WHEN name_length <= 7 THEN 70
          ELSE 90
        END - 
        CASE WHEN is_palindrome THEN 5 ELSE 0 END -
        CASE WHEN has_pattern THEN 5 ELSE 0 END
        as rarity_score
      FROM name_metrics
      ORDER BY rarity_score ASC, name_length ASC
      LIMIT $2 OFFSET $3
    `,
      [namespace, limit, offset, currentBurnBlock]
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM ${schema}.names WHERE namespace_string = $1`,
      [namespace]
    );

    reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      total: parseInt(countResult.rows[0].count),
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      rare_names: result.rows.map((name) => ({
        ...name,
        rarity_classification:
          name.rarity_score <= 20
            ? "Ultra Rare"
            : name.rarity_score <= 40
            ? "Rare"
            : name.rarity_score <= 60
            ? "Uncommon"
            : name.rarity_score <= 80
            ? "Common"
            : "Very Common",
      })),
    });
  },
};

// Route registration
function registerRoutes() {
  // Mainnet routes
  fastify.get("/names", createNetworkHandler(handlers.getAllNames));
  fastify.get("/names/valid", createNetworkHandler(handlers.getValidNames));
  fastify.get("/names/expired", createNetworkHandler(handlers.getExpiredNames));
  fastify.get("/names/revoked", createNetworkHandler(handlers.getRevokedNames));
  fastify.get(
    "/names/address/:address/valid",
    createNetworkHandler(handlers.getValidNamesByAddress)
  );
  fastify.get(
    "/names/address/:address/expired",
    createNetworkHandler(handlers.getExpiredNamesByAddress)
  );
  fastify.get(
    "/names/address/:address/expiring-soon",
    createNetworkHandler(handlers.getExpiringNamesByAddress)
  );
  fastify.get(
    "/names/address/:address/revoked",
    createNetworkHandler(handlers.getRevokedNamesByAddress)
  );
  fastify.get(
    "/names/:full_name",
    createNetworkHandler(handlers.getNameDetails)
  );
  fastify.get("/namespaces", createNetworkHandler(handlers.getAllNamespaces));
  fastify.get(
    "/names/namespace/:namespace",
    createNetworkHandler(handlers.getNamesByNamespace)
  );
  fastify.get(
    "/resolve-name/:full_name",
    createNetworkHandler(handlers.resolveName)
  );
  fastify.get(
    "/namespaces/:namespace",
    createNetworkHandler(handlers.getNamespace)
  );
  fastify.get(
    "/names/:namespace/:name/can-register",
    createNetworkHandler(handlers.canNameBeRegistered)
  );
  fastify.get("/token/last-id", createNetworkHandler(handlers.getLastTokenId));
  fastify.get(
    "/names/:full_name/renewal",
    createNetworkHandler(handlers.getNameRenewal)
  );
  fastify.get(
    "/names/:full_name/can-resolve",
    createNetworkHandler(handlers.canResolve)
  );
  fastify.get(
    "/names/:full_name/owner",
    createNetworkHandler(handlers.getNameOwner)
  );
  fastify.get(
    "/tokens/:id/owner",
    createNetworkHandler(handlers.getTokenOwner)
  );
  fastify.get("/names/:full_name/id", createNetworkHandler(handlers.getNameId));
  fastify.get("/tokens/:id/name", createNetworkHandler(handlers.getTokenName));
  fastify.get("/tokens/:id/info", createNetworkHandler(handlers.getTokenInfo));
  fastify.get(
    "/names/:full_name/rarity",
    createNetworkHandler(handlers.getNameRarity)
  );
  fastify.get(
    "/namespaces/:namespace/rare-names",
    createNetworkHandler(handlers.getRarestNames)
  );

  // Testnet routes (same endpoints with /testnet prefix)
  fastify.get("/testnet/names", createNetworkHandler(handlers.getAllNames));
  fastify.get(
    "/testnet/names/valid",
    createNetworkHandler(handlers.getValidNames)
  );
  fastify.get(
    "/testnet/names/expired",
    createNetworkHandler(handlers.getExpiredNames)
  );
  fastify.get(
    "/testnet/names/revoked",
    createNetworkHandler(handlers.getRevokedNames)
  );
  fastify.get(
    "/testnet/names/address/:address/valid",
    createNetworkHandler(handlers.getValidNamesByAddress)
  );
  fastify.get(
    "/testnet/names/address/:address/expired",
    createNetworkHandler(handlers.getExpiredNamesByAddress)
  );
  fastify.get(
    "/testnet/names/address/:address/expiring-soon",
    createNetworkHandler(handlers.getExpiringNamesByAddress)
  );
  fastify.get(
    "/testnet/names/address/:address/revoked",
    createNetworkHandler(handlers.getRevokedNamesByAddress)
  );
  fastify.get(
    "/testnet/names/:full_name",
    createNetworkHandler(handlers.getNameDetails)
  );
  fastify.get(
    "/testnet/namespaces",
    createNetworkHandler(handlers.getAllNamespaces)
  );
  fastify.get(
    "/testnet/names/namespace/:namespace",
    createNetworkHandler(handlers.getNamesByNamespace)
  );
  fastify.get(
    "/testnet/resolve-name/:full_name",
    createNetworkHandler(handlers.resolveName)
  );
  fastify.get(
    "/testnet/namespaces/:namespace",
    createNetworkHandler(handlers.getNamespace)
  );
  fastify.get(
    "/testnet/names/:namespace/:name/can-register",
    createNetworkHandler(handlers.canNameBeRegistered)
  );
  fastify.get(
    "/testnet/token/last-id",
    createNetworkHandler(handlers.getLastTokenId)
  );
  fastify.get(
    "/testnet/names/:full_name/renewal",
    createNetworkHandler(handlers.getNameRenewal)
  );
  fastify.get(
    "/testnet/names/:full_name/can-resolve",
    createNetworkHandler(handlers.canResolve)
  );
  fastify.get(
    "/testnet/names/:full_name/owner",
    createNetworkHandler(handlers.getNameOwner)
  );
  fastify.get(
    "/testnet/tokens/:id/owner",
    createNetworkHandler(handlers.getTokenOwner)
  );
  fastify.get(
    "/testnet/names/:full_name/id",
    createNetworkHandler(handlers.getNameId)
  );
  fastify.get(
    "/testnet/tokens/:id/name",
    createNetworkHandler(handlers.getTokenName)
  );
  fastify.get(
    "/testnet/tokens/:id/info",
    createNetworkHandler(handlers.getTokenInfo)
  );
  fastify.get(
    "/testnet/names/:full_name/rarity",
    createNetworkHandler(handlers.getNameRarity)
  );
  fastify.get(
    "/testnet/namespaces/:namespace/rare-names",
    createNetworkHandler
  );
}

// Start the server
const start = async () => {
  try {
    registerRoutes();
    await fastify.listen({ port: 3000 });
    fastify.log.info(`Server is running at http://localhost:3000`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
