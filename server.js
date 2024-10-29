import Fastify from "fastify";
import pg from "pg";
import rateLimit from "@fastify/rate-limit";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const fastify = Fastify({ logger: true });
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

await fastify.register(rateLimit, {
  max: 10000,
  timeWindow: "1 minute",
  allowList: ["127.0.0.1"],
});

fastify.get("/burn-block", async (request, reply) => {
  try {
    const burnBlockHeight = await getCurrentBurnBlockHeight();
    reply.send({
      burn_block_height: burnBlockHeight,
    });
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: "Internal Server Error" });
  }
});

// Get all names
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

// Get only valid names
fastify.get("/names/valid", async (request, reply) => {
  const { limit = 50, offset = 0 } = request.query;
  try {
    const currentBurnBlock = await getCurrentBurnBlockHeight();

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM names 
       WHERE renewal_height = 0 OR renewal_height > $1`,
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
       FROM names 
       WHERE renewal_height = 0 OR renewal_height > $3
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

// Get names by owner with valid/invalid separation
fastify.get("/names/owner/:address", async (request, reply) => {
  const { address } = request.params;
  const { limit = 50, offset = 0 } = request.query;
  try {
    const currentBurnBlock = await getCurrentBurnBlockHeight();

    const validCountResult = await pool.query(
      `SELECT COUNT(*) FROM names 
       WHERE owner = $1 
       AND (renewal_height = 0 OR renewal_height > $2)`,
      [address, currentBurnBlock]
    );

    const invalidCountResult = await pool.query(
      `SELECT COUNT(*) FROM names 
       WHERE owner = $1 
       AND renewal_height != 0 
       AND renewal_height <= $2`,
      [address, currentBurnBlock]
    );

    const validNamesResult = await pool.query(
      `SELECT 
        name_string || '.' || namespace_string AS full_name,
        name_string,
        namespace_string,
        owner,
        registered_at,
        renewal_height,
        stx_burn
       FROM names 
       WHERE owner = $1 
       AND (renewal_height = 0 OR renewal_height > $4)
       ORDER BY name_string || '.' || namespace_string ASC
       LIMIT $2 OFFSET $3`,
      [address, limit, offset, currentBurnBlock]
    );

    const invalidNamesResult = await pool.query(
      `SELECT 
        name_string || '.' || namespace_string AS full_name,
        name_string,
        namespace_string,
        owner,
        registered_at,
        renewal_height,
        stx_burn
       FROM names 
       WHERE owner = $1 
       AND renewal_height != 0 
       AND renewal_height <= $4
       ORDER BY name_string || '.' || namespace_string ASC
       LIMIT $2 OFFSET $3`,
      [address, limit, offset, currentBurnBlock]
    );

    reply.send({
      total:
        parseInt(validCountResult.rows[0].count) +
        parseInt(invalidCountResult.rows[0].count),
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      data: {
        valid_names: {
          total: parseInt(validCountResult.rows[0].count),
          names: validNamesResult.rows,
        },
        invalid_names: {
          total: parseInt(invalidCountResult.rows[0].count),
          names: invalidNamesResult.rows,
        },
      },
    });
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: "Internal Server Error" });
  }
});

// Get all namespaces
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
        can_update_price_function
       FROM namespaces 
       ORDER BY namespace_string ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
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

// Get a single namespace
fastify.get("/namespaces/:namespace_string", async (request, reply) => {
  const { namespace_string } = request.params;
  try {
    const currentBurnBlock = await getCurrentBurnBlockHeight();

    const namespaceResult = await pool.query(
      `SELECT *
       FROM namespaces 
       WHERE namespace_string = $1`,
      [namespace_string]
    );

    if (namespaceResult.rows.length === 0) {
      return reply.status(404).send({ error: "Namespace not found" });
    }

    const namesCountResult = await pool.query(
      `SELECT COUNT(*) 
       FROM names 
       WHERE namespace_string = $1`,
      [namespace_string]
    );

    reply.send({
      current_burn_block: currentBurnBlock,
      data: {
        ...namespaceResult.rows[0],
        names_count: parseInt(namesCountResult.rows[0].count),
      },
    });
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: "Internal Server Error" });
  }
});

// Get a names details
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
        imported_at,
        preordered_by
       FROM names 
       WHERE name_string = $1 AND namespace_string = $2`,
      [name_string, namespace_string]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({ error: "Name not found" });
    }

    reply.send({
      current_burn_block: currentBurnBlock,
      data: {
        ...result.rows[0],
        is_valid:
          result.rows[0].renewal_height === 0 ||
          result.rows[0].renewal_height > currentBurnBlock,
      },
    });
  } catch (err) {
    fastify.log.error(err);
    reply.status(500).send({ error: "Internal Server Error" });
  }
});

// Get names by namespace
fastify.get("/names/namespace/:namespace", async (request, reply) => {
  const { namespace } = request.params;
  const { limit = 50, offset = 0 } = request.query;
  try {
    const currentBurnBlock = await getCurrentBurnBlockHeight();

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
        CASE 
          WHEN renewal_height = 0 THEN true
          WHEN renewal_height > $4 THEN true
          ELSE false
        END as is_valid
       FROM names 
       WHERE namespace_string = $1
       ORDER BY name_string || '.' || namespace_string ASC
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
