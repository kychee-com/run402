import pg from "pg";
import type { SQL } from "./sql.js";

const rawPool = new pg.Pool({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "5432", 10),
  database: process.env.DB_NAME || "agentdb",
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

rawPool.on("error", (err) => {
  console.error("Unexpected pool error:", err.message);
});

/** Pool client with query narrowed to SQL branded type. */
export interface TypedPoolClient extends Omit<pg.PoolClient, "query"> {
  query(queryText: SQL, values?: unknown[]): Promise<pg.QueryResult>;
  release(err?: boolean | Error): void;
}

/** Pool with query narrowed to SQL branded type. */
export interface TypedPool {
  query(queryText: SQL, values?: unknown[]): Promise<pg.QueryResult>;
  connect(): Promise<TypedPoolClient>;
  end(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): this;
}

export const pool: TypedPool = rawPool as unknown as TypedPool;
