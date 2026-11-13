import type { TelemetryEvent } from "./api.js";

export type Connection = "connecting" | "connected" | "reconnecting";

export function connectTelemetry(url: string, handlers: {
  onState: (state: Connection) => void;
  onTelemetry: (event: TelemetryEvent) => void;
}) {
  let stopped = false;
  let attempts = 0;
  let socket: WebSocket | undefined;
  let retry: number | undefined;
  let deadline: number | undefined;

  function reconnect() {
    window.clearTimeout(deadline);
    if (stopped) return;
    handlers.onState("reconnecting");
    const delay = Math.min(15_000, 1000 * 2 ** Math.min(attempts++, 4));
    retry = window.setTimeout(connect, delay);
  }

  function connect() {
    let current: WebSocket;
    try {
      current = new WebSocket(url);
    } catch {
      reconnect();
      return;
    }
    socket = current;
    deadline = window.setTimeout(() => current.close(), 8000);
    current.onopen = () => {
      if (stopped) return;
      window.clearTimeout(deadline);
      attempts = 0;
      handlers.onState("connected");
    };
    current.onmessage = ({ data }) => {
      if (stopped || typeof data !== "string") return;
      let event: TelemetryEvent;
      try {
        event = JSON.parse(data) as TelemetryEvent;
      } catch {
        return;
      }
      if (event?.type === "telemetry" && event.version === 1 && Array.isArray(event.samples)) {
        handlers.onTelemetry(event);
      }
    };
    current.onerror = () => current.close();
    current.onclose = reconnect;
  }

  handlers.onState("connecting");
  connect();
  return () => {
    stopped = true;
    window.clearTimeout(retry);
    window.clearTimeout(deadline);
    socket?.close();
  };
}
