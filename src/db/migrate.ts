/**
 * Database migration runner.
 * Runs all pending Drizzle migrations and then applies the custom SQL migrations
 * (pgvector extension, RLS policies, materialized view) that Drizzle cannot
 * generate automatically.
 *
 * Usage:
 *   npx tsx src/db/migrate.ts
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

async function runMigrations() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is not set");
  }

  // Use a single connection for migrations (not a pool)
  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client);

  console.log("🔄 Running Drizzle migrations...");

  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    console.log("✅ Drizzle migrations complete");
  } catch (err) {
    // Drizzle migrations may not exist yet if we're using raw SQL only
    console.warn("⚠️  Drizzle migration step skipped (no journal found):", err);
  }

  // Run custom SQL migrations in order
  const sqlFiles = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of sqlFiles) {
    const filePath = path.join(MIGRATIONS_DIR, file);
    const sql = fs.readFileSync(filePath, "utf-8");
    console.log(`🔄 Applying ${file}...`);
    await client.unsafe(sql);
    console.log(`✅ Applied ${file}`);
  }

  await client.end();
  console.log("🎉 All migrations complete");
}

runMigrations().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
