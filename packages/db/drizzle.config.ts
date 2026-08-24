import { defineConfig } from "drizzle-kit";

/**
 * Migrations are generated as plain `.sql` files and committed. That is the
 * whole reason Drizzle is the migration tool here: pg_dump and pg_restore
 * round-trip plain SQL cleanly, which keeps the schema in `src/schema.ts`
 * loosely coupled to the restore proof.
 *
 * Run from this directory: `pnpm --dir packages/db exec drizzle-kit generate`.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  casing: "snake_case",
  strict: true,
});
