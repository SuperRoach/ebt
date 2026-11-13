import { timingSafeEqual } from "node:crypto";
import websocket from "@fastify/websocket";
import { telemetrySchema, type TelemetryBatch } from "@ebt/shared";
import Fastify from "fastify";
import { WebSocket } from "ws";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { hashKey } from "./devices.js";
import { ingest, SequenceConflict } from "./ingest.js";

const deviceSelect = { id: true, displayName: true } as const;
const sampleOrder: Prisma.GpsSampleOrderByWithRelationInput[] = [{ timestamp: "desc" }, { sequence: "desc" }];
const sampleOmit = { captureHash: true } as const;
const params = {
  type: "object",
  required: ["id"],
  properties: { id: telemetrySchema.properties.deviceId },
};

interface HistoryQuery {
  from?: string;
  to?: string;
  limit?: string;
  offset?: string;
}

export async function buildApp(db: PrismaClient, logger = false, adminToken = process.env.EBT_ADMIN_TOKEN) {
  const app = Fastify({
    logger,
    bodyLimit: 256 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
  });
  await app.register(websocket, { options: { maxPayload: 1024 } });
  app.addSchema(telemetrySchema);

  app.get("/health", async (request, reply) => {
    try {
      await db.$queryRaw`SELECT 1 FROM "Device" UNION ALL SELECT 1 FROM "GpsSample" LIMIT 1`;
      return { status: "ok" };
    } catch (error) {
      request.log.error({ err: error }, "Database health check failed");
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  app.post<{ Body: TelemetryBatch }>("/api/v1/telemetry", {
    schema: { body: { $ref: "urn:ebt:telemetry:v1#" } },
  }, async (request, reply) => {
    const key = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{16,128})$/i)?.[1];
    if (!key) return reply.code(401).send({ error: "Invalid device credentials" });

    const batch = request.body;
    if (new Set(batch.samples.map(({ sequence }) => sequence)).size !== batch.samples.length) {
      return reply.code(400).send({ error: "Batch sequences must be unique" });
    }

    let result: Awaited<ReturnType<typeof ingest>>;
    try {
      const device = await db.device.findUnique({
        where: { id: batch.deviceId },
        select: { apiKeyHash: true },
      });
      if (!device || !timingSafeEqual(Buffer.from(device.apiKeyHash, "hex"), Buffer.from(hashKey(key), "hex"))) {
        return reply.code(401).send({ error: "Invalid device credentials" });
      }
      result = await ingest(db, batch);
    } catch (error) {
      if (error instanceof SequenceConflict) {
        return reply.code(409).send({ error: error.message, sequence: error.sequence });
      }
      request.log.error({ err: error }, "Telemetry write failed");
      return reply.code(503).send({ error: "Telemetry could not be stored. Retry the batch." });
    }

    if (result.newSamples.length) {
      const event = JSON.stringify({
        type: "telemetry",
        receivedAt: result.receivedAt,
        ...batch,
        samples: result.newSamples.map((sample) => ({
          ...sample,
          timestamp: new Date(sample.timestamp).toISOString(),
        })),
      });
      for (const socket of app.websocketServer.clients) {
        if (socket.readyState !== WebSocket.OPEN) continue;
        if (socket.bufferedAmount > 1024 * 1024) {
          socket.terminate();
          continue;
        }
        socket.send(event, (error) => {
          if (error) socket.terminate();
        });
      }
    }
    return result.ack;
  });

  app.get("/api/v1/devices", async () => ({
    devices: await db.device.findMany({ select: deviceSelect, orderBy: { id: "asc" } }),
  }));

  app.patch<{ Params: { id: string }; Body: { displayName: string } }>("/api/v1/devices/:id", {
    schema: {
      params,
      body: {
        type: "object",
        required: ["displayName"],
        additionalProperties: false,
        properties: { displayName: { type: "string", minLength: 1, maxLength: 100 } },
      },
    },
  }, async (request, reply) => {
    if (!adminToken) return reply.code(503).send({ error: "Device editing is disabled on the server" });
    const token = request.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token || !timingSafeEqual(Buffer.from(hashKey(token), "hex"), Buffer.from(hashKey(adminToken), "hex"))) {
      return reply.code(401).send({ error: "Invalid admin token" });
    }
    const displayName = request.body.displayName.trim();
    if (!displayName) return reply.code(400).send({ error: "Enter a device name" });
    try {
      const device = await db.device.update({
        where: { id: request.params.id },
        data: { displayName },
        select: deviceSelect,
      });
      return { device };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        return reply.code(404).send({ error: "Unknown device" });
      }
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/devices/:id/latest", {
    schema: { params },
  }, async (request, reply) => {
    const { id } = request.params;
    const device = await db.device.findUnique({ where: { id }, select: deviceSelect });
    if (!device) return reply.code(404).send({ error: "Unknown device" });
    const sample = await db.gpsSample.findFirst({
      where: { deviceId: id },
      orderBy: sampleOrder,
      omit: sampleOmit,
    });
    return { device, sample };
  });

  app.get<{ Params: { id: string }; Querystring: HistoryQuery }>("/api/v1/devices/:id/history", {
    schema: {
      params,
      querystring: {
        type: "object",
        additionalProperties: false,
        properties: {
          from: { $ref: "urn:ebt:telemetry:v1#/definitions/timestamp" },
          to: { $ref: "urn:ebt:telemetry:v1#/definitions/timestamp" },
          limit: { type: "string", pattern: "^(?:[1-9][0-9]{0,2}|1000)$" },
          offset: { type: "string", pattern: "^(?:0|[1-9][0-9]{0,8})$" },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const from = request.query.from ? new Date(request.query.from) : undefined;
    const to = request.query.to ? new Date(request.query.to) : undefined;
    const limit = Number(request.query.limit ?? 100);
    const offset = Number(request.query.offset ?? 0);
    if (from && to && from > to) return reply.code(400).send({ error: "from must be at or before to" });

    const device = await db.device.findUnique({ where: { id }, select: deviceSelect });
    if (!device) return reply.code(404).send({ error: "Unknown device" });
    const samples = await db.gpsSample.findMany({
      where: { deviceId: id, timestamp: { gte: from, lte: to } },
      orderBy: sampleOrder,
      skip: offset,
      take: limit + 1,
      omit: sampleOmit,
    });
    return { device, samples: samples.slice(0, limit), nextOffset: samples.length > limit ? offset + limit : null };
  });

  app.get("/api/v1/ws", { websocket: true }, (socket) => {
    socket.on("error", (error) => app.log.debug({ err: error }, "WebSocket client error"));
  });

  return app;
}
