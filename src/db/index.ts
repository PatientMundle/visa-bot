import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
const { Pool } = pg;
import * as schema from "./schema.ts";

declare global {
  var _postgresPool: pg.Pool | undefined;
  var _dbReachableCache: { status: boolean; timestamp: number } | undefined;
}

/**
 * Indique si des paramètres PostgreSQL ont été définis dans l'environnement
 */
export const isDatabaseConfigured = (): boolean => {
  return Boolean(
    (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== "") ||
    (process.env.SQL_HOST && process.env.SQL_HOST.trim() !== "")
  );
};

export const createPool = () => {
  if (!global._postgresPool) {
    if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim()) {
      global._postgresPool = new Pool({
        connectionString: process.env.DATABASE_URL.trim(),
        max: 10,
        connectionTimeoutMillis: 3000,
      });
    } else if (process.env.SQL_HOST && process.env.SQL_HOST.trim()) {
      global._postgresPool = new Pool({
        host: process.env.SQL_HOST.trim(),
        user: process.env.SQL_USER?.trim(),
        password: process.env.SQL_PASSWORD?.trim(),
        database: process.env.SQL_DB_NAME?.trim(),
        port: process.env.SQL_PORT ? parseInt(process.env.SQL_PORT, 10) : 5432,
        max: 10,
        connectionTimeoutMillis: 3000,
      });
    } else {
      global._postgresPool = new Pool({
        host: "127.0.0.1",
        port: 5432,
        max: 1,
        connectionTimeoutMillis: 1000,
      });
    }

    global._postgresPool.on("error", () => {
      // Éviter les UncaughtException
    });
  }
  return global._postgresPool;
};

export const pool = createPool();
export const db = drizzle(pool, { schema });

/**
 * Vérifie de manière non-bloquante et avec cache si la BDD est réellement joignable
 */
export const checkDatabaseReachable = async (): Promise<boolean> => {
  if (!isDatabaseConfigured()) {
    return false;
  }

  const now = Date.now();
  if (global._dbReachableCache && now - global._dbReachableCache.timestamp < 30000) {
    return global._dbReachableCache.status;
  }

  try {
    const probePromise = pool.query("SELECT 1");
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout")), 2000)
    );
    await Promise.race([probePromise, timeoutPromise]);
    global._dbReachableCache = { status: true, timestamp: now };
    return true;
  } catch {
    global._dbReachableCache = { status: false, timestamp: now };
    return false;
  }
};
