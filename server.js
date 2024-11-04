import Fastify from "fastify";
import pg from "pg";
import rateLimit from "@fastify/rate-limit";
import dotenv from "dotenv";
import fetch from "node-fetch";
import Fastify from "fastify";
import cors from "@fastify/cors";

dotenv.config();

const fastify = Fastify({ logger: true });

await fastify.register(cors, {
  origin: "*",
  methods: ["GET"],
  allowedHeaders: ["Content-Type"],
  preflight: false,
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

    // Update the required fields check to work with the direct structure
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

    // Check all required fields exist
    for (const field of required_fields) {
      if (!(field in zonefile)) {
        console.log(`❌ Validation failed: Missing required field: ${field}`);
        console.log("Current zonefile fields:", Object.keys(zonefile));
        return false;
      }
    }

    console.log("✅ All required top-level fields present");

    // Validate subdomains array
    if (!Array.isArray(zonefile.subdomains)) {
      console.log("❌ Validation failed: subdomains is not an array");
      console.log("subdomains type:", typeof zonefile.subdomains);
      return false;
    }

    console.log(
      `✅ Subdomains is an array with ${zonefile.subdomains.length} items`
    );

    // If subdomains exist, validate each subdomain's structure
    for (let i = 0; i < zonefile.subdomains.length; i++) {
      const subdomain = zonefile.subdomains[i];
      console.log(`Validating subdomain ${i}:`, subdomain);

      const required_subdomain_fields = [
        "name",
        "sequence",
        "owner",
        "signature",
        "text",
      ];

      for (const field of required_subdomain_fields) {
        if (!(field in subdomain)) {
          console.log(
            `❌ Validation failed: Subdomain ${i} missing required field: ${field}`
          );
          console.log("Current subdomain fields:", Object.keys(subdomain));
          return false;
        }
      }

      // Validate sequence is a number
      if (typeof subdomain.sequence !== "number") {
        console.log(
          `❌ Validation failed: Subdomain ${i} sequence is not a number`
        );
        console.log("sequence type:", typeof subdomain.sequence);
        console.log("sequence value:", subdomain.sequence);
        return false;
      }
    }

    console.log("✅ All validations passed successfully");
    return true;
  } catch (error) {
    console.log("❌ Validation error:", error);
    fastify.log.error("Error validating zonefile format:", error);
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
    // Remove 0x prefix if present
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

    // Query for both zonefile and owner
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
      return reply.status(404).send({ error: "Name not found or invalid" });
    }

    const { zonefile, owner } = result.rows[0];
    const decodedZonefile = decodeZonefile(zonefile);

    if (!decodedZonefile) {
      return reply
        .status(404)
        .send({ error: "No zonefile found or unable to decode" });
    }

    // Validate zonefile structure
    if (!isValidZonefileFormat(decodedZonefile)) {
      return reply.status(400).send({ error: "Invalid zonefile format" });
    }

    // Check if owners match
    if (decodedZonefile.owner !== owner) {
      return reply.status(400).send({ error: "Zonefile needs to be updated" });
    }

    reply.send({
      zonefile: decodedZonefile,
    });
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: "Internal Server Error" });
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
