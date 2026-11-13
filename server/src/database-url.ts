import { resolve } from "node:path";

export function databaseUrl(value = process.env.DATABASE_URL ?? "file:./ebt.db") {
  if (!value.startsWith("file:") || value.length === 5 || /[?#]/.test(value)) {
    throw new Error("DATABASE_URL must be a local SQLite path such as file:./ebt.db");
  }
  return `file:${resolve(value.slice(5))}`;
}
