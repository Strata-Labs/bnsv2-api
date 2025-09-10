import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const { Pool } = pg;

const DB_POOL_CONFIG = {
  min: 5,
  max: parseInt(process.env.DB_MAX_CONNECTIONS || "50", 10),
  idleTimeoutMillis: 60000,
  connectionTimeoutMillis: 10000,
  acquireTimeoutMillis: 60000,
  createTimeoutMillis: 30000,
  destroyTimeoutMillis: 5000,
  reapIntervalMillis: 1000,
  createRetryIntervalMillis: 200,
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
  console.error("DB pool error:", err.message);
  console.error("Error details:", {
    code: err.code,
    errno: err.errno,
    syscall: err.syscall,
    hostname: err.hostname,
    timestamp: new Date().toISOString(),
  });
});

pool.on("connect", (client) => {
  console.log("New client connected to database");
});

pool.on("acquire", (client) => {
  console.log("Client acquired from pool");
});

pool.on("remove", (client) => {
  console.log("Client removed from pool");
});

export async function checkPoolHealth() {
  try {
    const pool = getPool();
    const start = Date.now();

    const client = await pool.connect();
    const result = await client.query(
      "SELECT 1 as health_check, NOW() as timestamp"
    );
    const responseTime = Date.now() - start;

    client.release();

    console.log(`DB Health: OK (${responseTime}ms)`);

    return {
      healthy: result.rows.length === 1,
      responseTime,
      totalConnections: pool.totalCount,
      idleConnections: pool.idleCount,
      waitingCount: pool.waitingCount,
    };
  } catch (err) {
    console.error(`Health check failed:`, err);
    return { healthy: false, error: err.message };
  }
}

export function getPool() {
  return pool;
}

setInterval(() => {
  checkPoolHealth();
}, 5 * 60 * 1000);

export default pool;
