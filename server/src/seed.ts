import { createDatabase } from "./db.js";
import { deviceKeys, seedDevices } from "./devices.js";

const db = createDatabase();
try {
  await seedDevices(db, deviceKeys());
  console.log("Seeded lps-ebt-01 and lps-ebt-02.");
} finally {
  await db.$disconnect();
}
