import { spawnSync } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { databaseUrl } from "./database-url.js";

const require = createRequire(import.meta.url);
const manifest = require.resolve("prisma/package.json");
const cli = resolve(dirname(manifest), require(manifest).bin.prisma);

// Create the file exclusively to work around a Prisma engine error on
// first-time SQLite setup. An existing database stays intact.
try {
  closeSync(openSync(databaseUrl().slice(5), "wx", 0o600));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
}

const result = spawnSync(process.execPath, [
  cli,
  "migrate",
  "deploy",
  "--config",
  "server/prisma7.config.ts",
], {
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
