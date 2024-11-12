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

fastify.addHook("onSend", async (request, reply) => {
  console.log("Final response headers:", reply.getHeaders());
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

function isValidZonefileFormat(zonefile) {
  try {
    console.log("Validating zonefile:", JSON.stringify(zonefile, null, 2));

    const required_fields = [
      "owner",
      "general",
      "twitter",
      "url",
      "nostr",
      "lightning",
      "btc",
      "subdomains",
    ];

    for (const field of required_fields) {
      if (!(field in zonefile)) {
        return false;
      }
    }

    // Validate subdomains array
    if (!Array.isArray(zonefile.subdomains)) {
      return false;
    }

    // If subdomains exist, validate each subdomain's structure
    for (let i = 0; i < zonefile.subdomains.length; i++) {
      const subdomain = zonefile.subdomains[i];

      const required_subdomain_fields = [
        "name",
        "sequence",
        "owner",
        "signature",
        "text",
      ];

      for (const field of required_subdomain_fields) {
        if (!(field in subdomain)) {
          return false;
        }
      }

      // Validate sequence is a number
      if (typeof subdomain.sequence !== "number") {
        return false;
      }
    }

    return true;
  } catch (error) {
    return false;
  }
}

async function getCurrentBurnBlockHeight() {
  try {
    const response = await fetch(
      `https://api.hiro.so/extended/v2/burn-blocks?limit=1`
    );
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return data.results[0].burn_block_height;
  } catch (error) {
    fastify.log.error("Error fetching burn block height:", error);
    throw error;
  }
}

function decodeZonefile(zonefileHex) {
  if (!zonefileHex) return null;
  try {
    const hex = zonefileHex.replace("0x", "");
    // Convert hex to string
    const decoded = Buffer.from(hex, "hex").toString("utf8");

    // Try to parse as JSON
    try {
      return JSON.parse(decoded);
    } catch {
      // If not JSON, return as plain text
      return decoded;
    }
  } catch (error) {
    fastify.log.error("Error decoding zonefile:", error);
    return null;
  }
}

await fastify.register(rateLimit, {
  max: 10000,
  timeWindow: "1 minute",
  allowList: ["127.0.0.1"],
});

// 1. Get all names regardless of status
fastify.get("/names", async (request, reply) => {
  const { limit = 50, offset = 0 } = request.query;
  try {
    const currentBurnBlock = await getCurrentBurnBlockHeight();
    const countResult = await pool.query("SELECT COUNT(*) FROM names");

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
       FROM names 
       ORDER BY name_string || '.' || namespace_string ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset, currentBurnBlock]
    );

    reply.send({
      total: parseInt(countResult.rows[0].count),
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      names: result.rows,
    });
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: "Internal Server Error" });
  }
});

// 2. Get only valid names (not expired, not revoked)
fastify.get("/names/valid", async (request, reply) => {
  const { limit = 50, offset = 0 } = request.query;
  try {
    const currentBurnBlock = await getCurrentBurnBlockHeight();

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM names 
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
       FROM names 
       WHERE revoked = false
       AND (renewal_height = 0 OR renewal_height > $3)
       ORDER BY name_string || '.' || namespace_string ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset, currentBurnBlock]
    );

    reply.send({
      total: parseInt(countResult.rows[0].count),
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      names: result.rows,
    });
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: "Internal Server Error" });
  }
});

// 3. Get expired names
fastify.get("/names/expired", async (request, reply) => {
  const { limit = 50, offset = 0 } = request.query;
  try {
    const currentBurnBlock = await getCurrentBurnBlockHeight();

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM names 
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
        stx_burn,
       FROM names 
       WHERE renewal_height != 0 
       AND renewal_height <= $3
       AND revoked = false
       ORDER BY name_string || '.' || namespace_string ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset, currentBurnBlock]
    );

    reply.send({
      total: parseInt(countResult.rows[0].count),
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      names: result.rows,
    });
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: "Internal Server Error" });
  }
});

// 4. Get revoked names
fastify.get("/names/revoked", async (request, reply) => {
  const { limit = 50, offset = 0 } = request.query;
  try {
    const currentBurnBlock = await getCurrentBurnBlockHeight();

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM names WHERE revoked = true`
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
       FROM names 
       WHERE revoked = true
       ORDER BY name_string || '.' || namespace_string ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    reply.send({
      total: parseInt(countResult.rows[0].count),
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      names: result.rows,
    });
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: "Internal Server Error" });
  }
});

// 5. Get valid names for an address
fastify.get("/names/address/:address/valid", async (request, reply) => {
  const { address } = request.params;
  const { limit = 50, offset = 0 } = request.query;
  try {
    const currentBurnBlock = await getCurrentBurnBlockHeight();

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM names 
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
       FROM names 
       WHERE owner = $1 
       AND revoked = false
       AND (renewal_height = 0 OR renewal_height > $4)
       ORDER BY name_string || '.' || namespace_string ASC
       LIMIT $2 OFFSET $3`,
      [address, limit, offset, currentBurnBlock]
    );

    reply.send({
      total: parseInt(countResult.rows[0].count),
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      names: result.rows,
    });
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: "Internal Server Error" });
  }
});

// 6. Get expired names for an address
fastify.get("/names/address/:address/expired", async (request, reply) => {
  const { address } = request.params;
  const { limit = 50, offset = 0 } = request.query;
  try {
    const currentBurnBlock = await getCurrentBurnBlockHeight();

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM names 
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
        stx_burn,
       FROM names 
       WHERE owner = $1 
       AND revoked = false
       AND renewal_height != 0 
       AND renewal_height <= $4
       ORDER BY name_string || '.' || namespace_string ASC
       LIMIT $2 OFFSET $3`,
      [address, limit, offset, currentBurnBlock]
    );

    reply.send({
      total: parseInt(countResult.rows[0].count),
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      names: result.rows,
    });
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: "Internal Server Error" });
  }
});

// 7. Get names about to expire for an address (within 4320 blocks)
fastify.get("/names/address/:address/expiring-soon", async (request, reply) => {
  const { address } = request.params;
  const { limit = 50, offset = 0 } = request.query;
  try {
    const currentBurnBlock = await getCurrentBurnBlockHeight();
    const expirationWindow = 4320;
    const expirationThreshold = currentBurnBlock + expirationWindow;

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM names 
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
       FROM names 
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
      total: parseInt(countResult.rows[0].count),
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      names: result.rows,
    });
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: "Internal Server Error" });
  }
});

// 8. Get revoked names for an address
fastify.get("/names/address/:address/revoked", async (request, reply) => {
  const { address } = request.params;
  const { limit = 50, offset = 0 } = request.query;
  try {
    const currentBurnBlock = await getCurrentBurnBlockHeight();

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM names 
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
        stx_burn,
       FROM names 
       WHERE owner = $1 
       AND revoked = true
       ORDER BY name_string || '.' || namespace_string ASC
       LIMIT $2 OFFSET $3`,
      [address, limit, offset]
    );

    reply.send({
      total: parseInt(countResult.rows[0].count),
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      names: result.rows,
    });
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: "Internal Server Error" });
  }
});

// 9. Get name details (modified to include decoded zonefile for valid names)
fastify.get("/names/:full_name", async (request, reply) => {
  const [name_string, namespace_string] = request.params.full_name.split(".");
  try {
    const currentBurnBlock = await getCurrentBurnBlockHeight();

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
       FROM names 
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
      current_burn_block: currentBurnBlock,
      status: status,
      data: nameData,
    });
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: "Internal Server Error" });
  }
});

// 10. Get all namespaces
fastify.get("/namespaces", async (request, reply) => {
  const { limit = 50, offset = 0 } = request.query;
  try {
    const currentBurnBlock = await getCurrentBurnBlockHeight();
    const countResult = await pool.query("SELECT COUNT(*) FROM namespaces");

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
        (SELECT COUNT(*) FROM names WHERE names.namespace_string = namespaces.namespace_string) as total_names,
        (SELECT COUNT(*) 
         FROM names 
         WHERE names.namespace_string = namespaces.namespace_string 
         AND (renewal_height = 0 OR renewal_height > $3)
         AND revoked = false) as active_names
       FROM namespaces 
       ORDER BY namespace_string ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset, currentBurnBlock]
    );

    reply.send({
      total: parseInt(countResult.rows[0].count),
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      namespaces: result.rows,
    });
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: "Internal Server Error" });
  }
});

// 11. Get all names in a namespace
fastify.get("/names/namespace/:namespace", async (request, reply) => {
  const { namespace } = request.params;
  const { limit = 50, offset = 0 } = request.query;
  try {
    const currentBurnBlock = await getCurrentBurnBlockHeight();

    // First check if namespace exists
    const namespaceExists = await pool.query(
      "SELECT namespace_string FROM namespaces WHERE namespace_string = $1",
      [namespace]
    );

    if (namespaceExists.rows.length === 0) {
      return reply.status(404).send({ error: "Namespace not found" });
    }

    const countResult = await pool.query(
      "SELECT COUNT(*) FROM names WHERE namespace_string = $1",
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
        stx_burn,
       FROM names 
       WHERE namespace_string = $1
       ORDER BY name_string ASC
       LIMIT $2 OFFSET $3`,
      [namespace, limit, offset, currentBurnBlock]
    );

    reply.send({
      total: parseInt(countResult.rows[0].count),
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      names: result.rows,
    });
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: "Internal Server Error" });
  }
});

// 12. Resolve name
fastify.get("/resolve-name/:full_name", async (request, reply) => {
  const [name_string, namespace_string] = request.params.full_name.split(".");
  try {
    const currentBurnBlock = await getCurrentBurnBlockHeight();

    const result = await pool.query(
      `SELECT zonefile, owner
       FROM names 
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

    // Validate zonefile structure
    if (!isValidZonefileFormat(decodedZonefile)) {
      return reply.code(400).send({ error: "Invalid zonefile format" });
    }

    // Check if owners match
    if (decodedZonefile.owner !== owner) {
      return reply.code(400).send({ error: "Zonefile needs to be updated" });
    }

    return reply.send({
      zonefile: decodedZonefile,
    });
  } catch (err) {
    fastify.log.error(err);
    return reply.code(500).send({ error: "Internal Server Error" });
  }
});

// 13. Get a Namespace
fastify.get("/namespaces/:namespace", async (request, reply) => {
  const { namespace } = request.params;
  try {
    const currentBurnBlock = await getCurrentBurnBlockHeight();

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
        (SELECT COUNT(*) FROM names WHERE names.namespace_string = namespaces.namespace_string) as total_names,
        (SELECT COUNT(*) 
         FROM names 
         WHERE names.namespace_string = namespaces.namespace_string 
         AND (renewal_height = 0 OR renewal_height > $2)
         AND revoked = false) as active_names,
        (SELECT COUNT(*) 
         FROM names 
         WHERE names.namespace_string = namespaces.namespace_string 
         AND renewal_height != 0 
         AND renewal_height <= $2
         AND revoked = false) as expired_names,
        (SELECT COUNT(*) 
         FROM names 
         WHERE names.namespace_string = namespaces.namespace_string 
         AND revoked = true) as revoked_names,
        (SELECT MIN(registered_at) 
         FROM names 
         WHERE names.namespace_string = namespaces.namespace_string) as first_registration,
        (SELECT MAX(registered_at) 
         FROM names 
         WHERE names.namespace_string = namespaces.namespace_string) as last_registration
       FROM namespaces 
       WHERE namespace_string = $1`,
      [namespace, currentBurnBlock]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({ error: "Namespace not found" });
    }

    reply.send({
      current_burn_block: currentBurnBlock,
      namespace: result.rows[0],
    });
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: "Internal Server Error" });
  }
});

// 14. Can name be registered
fastify.get("/names/:namespace/:name/can-register", async (request, reply) => {
  const { namespace, name } = request.params;

  try {
    const currentBurnBlock = await getCurrentBurnBlockHeight();

    // First check if namespace exists and is launched
    const namespaceResult = await pool.query(
      `SELECT 
        launched_at,
        namespace_manager
       FROM namespaces 
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
       FROM names 
       WHERE name_string = $1 AND namespace_string = $2`,
      [name, namespace]
    );

    // If name doesn't exist at all, it can be registered
    if (nameResult.rows.length === 0) {
      return reply.send({
        can_register: true,
        reason: "NAME_AVAILABLE",
      });
    }

    const nameData = nameResult.rows[0];

    // Check if name is imported
    if (nameData.imported_at) {
      return reply.send({
        can_register: false,
        reason: "NAME_IMPORTED",
        current_owner: nameData.owner,
      });
    }

    // Check if name is expired (for non-managed namespaces)
    if (!namespaceData.namespace_manager && nameData.renewal_height > 0) {
      const isExpired = nameData.renewal_height <= currentBurnBlock;
      if (isExpired) {
        return reply.send({
          can_register: true,
          reason: "NAME_EXPIRED",
          previous_owner: nameData.owner,
          expired_at: nameData.renewal_height,
        });
      }
    }

    // If we get here, name exists and is not available
    return reply.send({
      can_register: false,
      reason: "NAME_TAKEN",
      current_owner: nameData.owner,
    });
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: "Internal Server Error" });
  }
});

// 15. Get the last token id
fastify.get("/token/last-id", async (request, reply) => {
  try {
    const result = await pool.query(
      "SELECT COALESCE(MAX(id), 0) as last_token_id FROM names"
    );
    const lastTokenId = result.rows[0].last_token_id;

    reply.send({
      last_token_id: lastTokenId,
    });
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: "Internal Server Error" });
  }
});

// 16. Get name renewal height
fastify.get("/names/:full_name/renewal", async (request, reply) => {
  const [name_string, namespace_string] = request.params.full_name.split(".");
  try {
    const currentBurnBlock = await getCurrentBurnBlockHeight();

    // First get the namespace info to check if it requires renewals
    const namespaceResult = await pool.query(
      `SELECT lifetime::integer, namespace_manager::text FROM namespaces WHERE namespace_string = $1`,
      [namespace_string]
    );

    if (namespaceResult.rows.length === 0) {
      return reply.status(404).send({ error: "Namespace not found" });
    }

    // Parse lifetime as integer and check namespace_manager
    const lifetime = parseInt(namespaceResult.rows[0].lifetime) || 0;
    const namespace_manager = namespaceResult.rows[0].namespace_manager;
    const isManaged =
      namespace_manager !== "none" && namespace_manager !== null;

    // Get the name details
    const nameResult = await pool.query(
      `SELECT 
        name_string,
        namespace_string,
        registered_at,
        renewal_height::integer,
        revoked,
        imported_at
       FROM names 
       WHERE name_string = $1 AND namespace_string = $2`,
      [name_string, namespace_string]
    );

    if (nameResult.rows.length === 0) {
      return reply.status(404).send({ error: "Name not found" });
    }

    const nameData = nameResult.rows[0];

    // If the name is revoked, return appropriate status
    if (nameData.revoked) {
      return reply.send({
        current_burn_block: currentBurnBlock,
        renewal_height: 0,
        blocks_until_expiry: 0,
        status: "revoked",
        needs_renewal: false,
        is_managed: isManaged,
      });
    }

    // Case 1: Managed namespace
    if (isManaged) {
      return reply.send({
        current_burn_block: currentBurnBlock,
        renewal_height: 0,
        blocks_until_expiry: 0,
        status: "active",
        needs_renewal: false,
        is_managed: true,
      });
    }

    // Case 2: Unmanaged namespace with lifetime 0
    if (lifetime === 0) {
      return reply.send({
        current_burn_block: currentBurnBlock,
        renewal_height: 0,
        blocks_until_expiry: 0,
        status: "active",
        needs_renewal: false,
        is_managed: false,
      });
    }

    // Case 3: Unmanaged namespace with lifetime != 0
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
      current_burn_block: currentBurnBlock,
      renewal_height: renewalHeight,
      blocks_until_expiry: blocksUntilExpiry,
      status: status,
      needs_renewal: needsRenewal,
      is_managed: false,
    });
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: "Internal Server Error" });
  }
});

// 17. Check if a name can be resolved
fastify.get("/names/:full_name/can-resolve", async (request, reply) => {
  const [name_string, namespace_string] = request.params.full_name.split(".");
  try {
    const currentBurnBlock = await getCurrentBurnBlockHeight();

    // First check if namespace exists and get its properties
    const namespaceResult = await pool.query(
      `SELECT 
        lifetime::integer, 
        namespace_manager::text,
        launched_at
       FROM namespaces 
       WHERE namespace_string = $1`,
      [namespace_string]
    );

    if (namespaceResult.rows.length === 0) {
      return reply.status(404).send({ error: "Namespace not found" });
    }

    const { lifetime, launched_at } = namespaceResult.rows[0];

    // Check if namespace is launched
    if (!launched_at) {
      return reply.status(400).send({
        can_resolve: false,
        error: "Namespace not launched",
      });
    }

    // Get name details
    const nameResult = await pool.query(
      `SELECT 
        name_string,
        namespace_string,
        owner,
        registered_at,
        renewal_height::integer,
        revoked,
        imported_at
       FROM names 
       WHERE name_string = $1 AND namespace_string = $2`,
      [name_string, namespace_string]
    );

    if (nameResult.rows.length === 0) {
      return reply.status(404).send({ error: "Name not found" });
    }

    const nameData = nameResult.rows[0];

    // If name is revoked, it can't be resolved
    if (nameData.revoked) {
      return reply.send({
        can_resolve: false,
        error: "Name is revoked",
        current_burn_block: currentBurnBlock,
      });
    }

    let renewalHeight = nameData.renewal_height;

    // If lifetime is 0 (managed namespace or no renewals required)
    if (lifetime === 0) {
      return reply.send({
        can_resolve: true,
        renewal_height: 0,
        owner: nameData.owner,
        current_burn_block: currentBurnBlock,
      });
    }

    // For names that require renewals
    // If renewal_height is 0 and name was imported, calculate based on namespace launch
    if (renewalHeight === 0 && nameData.imported_at) {
      renewalHeight = launched_at + lifetime;
    }

    // Check if name is within valid period (including grace period)
    const isWithinValidPeriod =
      renewalHeight === 0 || currentBurnBlock <= renewalHeight + 5000; // 5000 blocks grace period

    return reply.send({
      can_resolve: isWithinValidPeriod,
      renewal_height: renewalHeight,
      owner: nameData.owner,
      current_burn_block: currentBurnBlock,
      ...(isWithinValidPeriod ? {} : { error: "Name expired" }),
    });
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: "Internal Server Error" });
  }
});

// 18. Get owner of a name
fastify.get("/names/:full_name/owner", async (request, reply) => {
  const [name_string, namespace_string] = request.params.full_name.split(".");
  try {
    // Get name details
    const nameResult = await pool.query(
      `SELECT 
        owner,
        revoked,
        renewal_height::integer,
        registered_at,
        imported_at
       FROM names 
       WHERE name_string = $1 AND namespace_string = $2`,
      [name_string, namespace_string]
    );

    if (nameResult.rows.length === 0) {
      return reply.status(404).send({ error: "Name not found" });
    }

    const nameData = nameResult.rows[0];
    const currentBurnBlock = await getCurrentBurnBlockHeight();

    // Get namespace details to check lifetime
    const namespaceResult = await pool.query(
      `SELECT 
        lifetime::integer,
        namespace_manager::text,
        launched_at
       FROM namespaces 
       WHERE namespace_string = $1`,
      [namespace_string]
    );

    if (namespaceResult.rows.length === 0) {
      return reply.status(404).send({ error: "Namespace not found" });
    }

    const { lifetime, launched_at } = namespaceResult.rows[0];

    // Check if namespace is launched
    if (!launched_at) {
      return reply.status(400).send({
        error: "Namespace not launched",
      });
    }

    // If name is revoked
    if (nameData.revoked) {
      return reply.send({
        owner: nameData.owner,
        current_burn_block: currentBurnBlock,
        status: "revoked",
      });
    }

    let renewalHeight = nameData.renewal_height;

    // If renewal_height is 0 and name was imported, calculate based on namespace launch
    if (renewalHeight === 0 && nameData.imported_at && lifetime !== 0) {
      renewalHeight = launched_at + lifetime;
    }

    // For names that don't expire (lifetime = 0 or managed namespaces)
    if (lifetime === 0) {
      return reply.send({
        owner: nameData.owner,
        current_burn_block: currentBurnBlock,
        status: "active",
      });
    }

    // Check if name is within valid period (including grace period)
    const isWithinValidPeriod =
      renewalHeight === 0 || currentBurnBlock <= renewalHeight + 5000; // 5000 blocks grace period

    // Determine status
    let status = "active";
    if (!isWithinValidPeriod) {
      status = "expired";
    } else if (currentBurnBlock > renewalHeight) {
      status = "grace-period";
    } else if (currentBurnBlock > renewalHeight - 4320) {
      status = "expiring-soon";
    }

    return reply.send({
      owner: nameData.owner,
      current_burn_block: currentBurnBlock,
      renewal_height: renewalHeight,
      status: status,
    });
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: "Internal Server Error" });
  }
});

// 19. Get owner of a name by token ID
fastify.get("/tokens/:id/owner", async (request, reply) => {
  const id = request.params.id;
  try {
    // First get the name and namespace for this token ID
    const tokenResult = await pool.query(
      `SELECT 
        n.name_string,
        n.namespace_string,
        n.owner,
        n.revoked,
        n.renewal_height::integer,
        n.registered_at,
        n.imported_at
       FROM names n
       WHERE n.id = $1`,
      [id]
    );

    if (tokenResult.rows.length === 0) {
      return reply.status(404).send({ error: "Token ID not found" });
    }

    const nameData = tokenResult.rows[0];
    const currentBurnBlock = await getCurrentBurnBlockHeight();

    // Get namespace details to check lifetime
    const namespaceResult = await pool.query(
      `SELECT 
        lifetime::integer,
        namespace_manager::text,
        launched_at
       FROM namespaces 
       WHERE namespace_string = $1`,
      [nameData.namespace_string]
    );

    if (namespaceResult.rows.length === 0) {
      return reply.status(404).send({ error: "Namespace not found" });
    }

    const { lifetime, launched_at } = namespaceResult.rows[0];

    // Check if namespace is launched
    if (!launched_at) {
      return reply.status(400).send({
        error: "Namespace not launched",
      });
    }

    // If name is revoked
    if (nameData.revoked) {
      return reply.send({
        owner: nameData.owner,
        name: nameData.name_string,
        namespace: nameData.namespace_string,
        current_burn_block: currentBurnBlock,
        status: "revoked",
      });
    }

    let renewalHeight = nameData.renewal_height;

    // If renewal_height is 0 and name was imported, calculate based on namespace launch
    if (renewalHeight === 0 && nameData.imported_at && lifetime !== 0) {
      renewalHeight = launched_at + lifetime;
    }

    // For names that don't expire (lifetime = 0 or managed namespaces)
    if (lifetime === 0) {
      return reply.send({
        owner: nameData.owner,
        name: nameData.name_string,
        namespace: nameData.namespace_string,
        current_burn_block: currentBurnBlock,
        status: "active",
      });
    }

    // Check if name is within valid period (including grace period)
    const isWithinValidPeriod =
      renewalHeight === 0 || currentBurnBlock <= renewalHeight + 5000; // 5000 blocks grace period

    // Determine status
    let status = "active";
    if (!isWithinValidPeriod) {
      status = "expired";
    } else if (currentBurnBlock > renewalHeight) {
      status = "grace-period";
    } else if (currentBurnBlock > renewalHeight - 4320) {
      status = "expiring-soon";
    }

    return reply.send({
      owner: nameData.owner,
      name: nameData.name_string,
      namespace: nameData.namespace_string,
      current_burn_block: currentBurnBlock,
      renewal_height: renewalHeight,
      status: status,
    });
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: "Internal Server Error" });
  }
});

// 20. Get token ID from name
fastify.get("/names/:full_name/id", async (request, reply) => {
  const [name_string, namespace_string] = request.params.full_name.split(".");
  try {
    // Get the token ID for this name
    const result = await pool.query(
      `SELECT id 
       FROM names 
       WHERE name_string = $1 AND namespace_string = $2`,
      [name_string, namespace_string]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({ error: "Name not found" });
    }

    return reply.send({
      name: name_string,
      namespace: namespace_string,
      id: result.rows[0].id,
    });
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: "Internal Server Error" });
  }
});

// 21. Get name from token ID
fastify.get("/tokens/:id/name", async (request, reply) => {
  const id = request.params.id;
  try {
    // Get the name and namespace for this token ID
    const result = await pool.query(
      `SELECT 
        name_string,
        namespace_string
       FROM names 
       WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({ error: "Token ID not found" });
    }

    const { name_string, namespace_string } = result.rows[0];

    return reply.send({
      id: parseInt(id),
      name: name_string,
      namespace: namespace_string,
      full_name: `${name_string}.${namespace_string}`,
    });
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: "Internal Server Error" });
  }
});

// 22. Get name information by token ID
fastify.get("/tokens/:id/info", async (request, reply) => {
  const id = request.params.id;
  try {
    const currentBurnBlock = await getCurrentBurnBlockHeight();

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
       FROM names 
       WHERE id = $1`,
      [id, currentBurnBlock]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({ error: "Token ID not found" });
    }

    const nameData = result.rows[0];

    // Set appropriate status message
    let status = "active";
    if (nameData.revoked) {
      status = "revoked";
    } else if (!nameData.is_valid) {
      status = "expired";
    }

    reply.send({
      current_burn_block: currentBurnBlock,
      status: status,
      data: nameData,
    });
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: "Internal Server Error" });
  }
});

// 23. Get rarity metrics for a name
fastify.get("/names/:full_name/rarity", async (request, reply) => {
  const [name_string, namespace_string] = request.params.full_name.split(".");
  try {
    const currentBurnBlock = await getCurrentBurnBlockHeight();

    // First verify the name exists
    const nameExists = await pool.query(
      `SELECT id FROM names WHERE name_string = $1 AND namespace_string = $2`,
      [name_string, namespace_string]
    );

    if (nameExists.rows.length === 0) {
      return reply.status(404).send({ error: "Name not found" });
    }

    // Get total names in namespace for percentile calculations
    const totalNames = await pool.query(
      `SELECT COUNT(*) as total FROM names WHERE namespace_string = $1`,
      [namespace_string]
    );

    // Calculate various rarity metrics
    const metricsResult = await pool.query(
      `
      WITH stats AS (
        SELECT 
          -- Length stats
          (SELECT COUNT(*) FROM names WHERE namespace_string = $2 AND LENGTH(name_string) = LENGTH($1)) as same_length_count,
          
          -- Numeric-only names
          (SELECT COUNT(*) FROM names WHERE namespace_string = $2 
           AND name_string ~ '^[0-9]+$') as numeric_only_count,
          
          -- Letter-only names
          (SELECT COUNT(*) FROM names WHERE namespace_string = $2 
           AND name_string ~ '^[a-z]+$') as letter_only_count,
          
          -- Names with special characters
          (SELECT COUNT(*) FROM names WHERE namespace_string = $2 
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

    // Get palindrome status
    const isPalindrome =
      name_string === name_string.split("").reverse().join("");

    // Get repeating character patterns
    const hasRepeatingChars = /(.)\1+/.test(name_string);

    // Calculate rarity score (0-100, where lower is rarer)
    let rarityScore = 0;

    // Length contribution (shorter names are rarer)
    // Names length 1-3 are extremely rare
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
      rarityScore += parseFloat(metrics.numeric_percentile) * 0.2; // Weight numeric contribution
    }
    if (metrics.is_letters_only) {
      rarityScore += parseFloat(metrics.letters_percentile) * 0.2; // Weight letters contribution
    }
    if (metrics.has_special_chars) {
      rarityScore += parseFloat(metrics.special_char_percentile) * 0.2; // Weight special chars contribution
    }

    // Special patterns contribution
    if (isPalindrome) rarityScore -= 10; // Palindromes are rarer
    if (hasRepeatingChars) rarityScore += 5; // Repeating chars are more common

    // Normalize score to 0-100 range
    rarityScore = Math.max(0, Math.min(100, rarityScore));

    reply.send({
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
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: "Internal Server Error" });
  }
});

// 24. Get rarest names in a namespace
fastify.get("/namespaces/:namespace/rare-names", async (request, reply) => {
  const { namespace } = request.params;
  const { limit = 50, offset = 0 } = request.query;

  try {
    const currentBurnBlock = await getCurrentBurnBlockHeight();

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
        FROM names 
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
      `SELECT COUNT(*) FROM names WHERE namespace_string = $1`,
      [namespace]
    );

    reply.send({
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
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: "Internal Server Error" });
  }
});

const start = async () => {
  try {
    await fastify.listen({ port: 3000 });
    fastify.log.info(`Server is running at http://localhost:3000`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
