import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../generated/prisma/client.js";
import { databaseUrl } from "./database-url.js";

export function createDatabase(url = databaseUrl()) {
  return new PrismaClient({ adapter: new PrismaLibSql({ url }) });
}
