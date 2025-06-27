import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

const DB_POOL_CONFIG = {
  min: 2,
  max: parseInt(process.env.DB_MAX_CONNECTIONS || "20", 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  reconnect: true,
};

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: {
    rejectUnauthorized: false,
  },
  ...DB_POOL_CONFIG,
});

pool.on("error", (err) => {
  console.error("DB pool error:", err);
});

export async function checkPoolHealth() {
  try {
    const client = await pool.connect();
    const result = await client.query("SELECT 1");
    client.release();
    return result.rows.length === 1;
  } catch (err) {
    console.error(`Health check failed for pool:`, err);
    return false;
  }
}

export function getPool() {
  return pool;
}

setInterval(() => {
  checkPoolHealth();
}, 5 * 60 * 1000);

export default pool;
