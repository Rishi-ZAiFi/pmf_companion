import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Creates a Drizzle ORM client connected to PostgreSQL.
 *
 * In production (Vercel / serverless), use a connection pool with a low max
 * to avoid exhausting the database connection limit.
 *
 * The caller is responsible for setting `app.current_account_id` as a
 * session-level parameter before executing any tenant-scoped query so that
 * PostgreSQL RLS policies can enforce row-level isolation.
 */
const connectionString = process.env.DATABASE_URL!;

// Disable prefetch as it is not supported for "Transaction" pool mode
const client = postgres(connectionString, { prepare: false });

export const db = drizzle(client, { schema });

export type Database = typeof db;
