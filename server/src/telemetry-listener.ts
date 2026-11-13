import Fastify, { type FastifyInstance } from "fastify";

export function buildTelemetryListener(api: FastifyInstance) {
  const listener = Fastify({ bodyLimit: 256 * 1024 });

  listener.post("/api/v1/telemetry", async (request, reply) => {
    const authorization = request.headers.authorization;
    if (!authorization) return reply.code(401).send({ error: "Invalid device credentials" });
    if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
      return reply.code(415).send({ error: "Expected application/json" });
    }
    const response = await api.inject({
      method: "POST",
      url: "/api/v1/telemetry",
      headers: { "content-type": "application/json", authorization },
      payload: JSON.stringify(request.body),
    });
    return reply.code(response.statusCode).type("application/json").send(response.payload);
  });

  return listener;
}
