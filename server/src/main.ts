import { buildApp } from "./app.js";
import { createDatabase } from "./db.js";
import { buildTelemetryListener } from "./telemetry-listener.js";

const db = createDatabase();
const app = await buildApp(db, true);
const telemetryHost = process.env.TELEMETRY_HOST;
const telemetry = telemetryHost ? buildTelemetryListener(app) : undefined;
app.addHook("onClose", async () => { await db.$disconnect(); });

async function close() {
  try {
    await telemetry?.close();
  } finally {
    await app.close();
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void close().catch((error) => {
      app.log.error(error);
      process.exitCode = 1;
    });
  });
}

try {
  await app.listen({ host: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 3000) });
  if (telemetry && telemetryHost) {
    const address = await telemetry.listen({ host: telemetryHost, port: Number(process.env.TELEMETRY_PORT ?? 3001) });
    app.log.info({ address }, "Telemetry upload listener ready");
  }
} catch (error) {
  app.log.error(error);
  await close();
  process.exitCode = 1;
}
