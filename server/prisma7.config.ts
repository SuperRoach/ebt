import { config } from "dotenv";
import { defineConfig } from "prisma/config";
import { databaseUrl } from "./src/database-url.js";

// Match the npm commands: shell environment, then server/.env, then root .env.
config({ path: ["server/.env", ".env"], quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: databaseUrl() },
});
