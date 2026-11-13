import { createDatabase } from "./db.js";

const [, , id, ...words] = process.argv;
const displayName = words.join(" ").trim();
if (!id || !displayName || displayName.length > 100) {
  throw new Error('Usage: npm run device:rename -- lps-ebt-01 "Display name" (1–100 characters)');
}

const db = createDatabase();
try {
  const device = await db.device.update({
    where: { id },
    data: { displayName },
    select: { id: true, displayName: true },
  });
  console.log(device);
} finally {
  await db.$disconnect();
}
