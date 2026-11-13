import { useEffect, useRef, useState } from "react";
import { history, latest, listDevices, renameDevice, socketUrl, type Device, type StoredSample } from "./api.js";
import { connectTelemetry, type Connection } from "./telemetrySocket.js";
import { fromEvent, mergeSamples, TRAIL_MS } from "./tracking.js";

export function useTracking() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [samples, setSamples] = useState<Record<string, StoredSample[]>>({});
  const [connection, setConnection] = useState<Connection>("connecting");
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now);
  const [refreshKey, setRefreshKey] = useState(0);
  const namesEdited = useRef(new Map<string, Device>());

  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(clock);
  }, []);

  useEffect(() => {
    let active: AbortController | undefined;
    let connected = false;
    let needsRetry = true;
    const lifetime = new AbortController();

    function confirm(id: string) {
      setConfirmed((current) => current.has(id) ? current : new Set([...current, id]));
    }

    function merge(id: string, incoming: StoredSample[]) {
      if (lifetime.signal.aborted || !incoming.length) return;
      const capturedNow = Date.now();
      setSamples((current) => ({ ...current, [id]: mergeSamples(current[id] ?? [], incoming, capturedNow) }));
    }

    async function refresh() {
      active?.abort();
      const controller = new AbortController();
      active = controller;
      const { signal } = controller;
      const namesAtStart = new Map(namesEdited.current);
      try {
        const { devices: roster } = await listDevices(signal);
        if (signal.aborted) return;
        setDevices(roster.map((device) => {
          const renamed = namesEdited.current.get(device.id);
          return renamed && renamed !== namesAtStart.get(device.id) ? renamed : device;
        }));
        const from = new Date(Date.now() - TRAIL_MS).toISOString();
        const results = await Promise.allSettled(roster.flatMap(({ id }) => [
          latest(id, signal).then(({ sample }) => {
            if (signal.aborted) return;
            merge(id, sample ? [sample] : []);
            if (connected) confirm(id);
          }),
          history(id, from, signal).then(({ samples: trail }) => merge(id, trail)),
        ]));
        if (signal.aborted) return;
        needsRetry = results.some(({ status }) => status === "rejected");
        setError(needsRetry ? "Some cart data could not be loaded. Retrying…" : "");
      } catch {
        if (signal.aborted) return;
        needsRetry = true;
        setError("The tracking server could not be reached. Retrying…");
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    }

    const disconnect = connectTelemetry(socketUrl(), {
      onState(state) {
        connected = state === "connected";
        setConnection(state);
        if (!connected) setConfirmed(new Set());
        if (connected) void refresh();
      },
      onTelemetry(event) {
        merge(event.deviceId, fromEvent(event));
        setNow(Date.now());
      },
    });
    void refresh();
    const poll = window.setInterval(() => {
      if (!connected || needsRetry) void refresh();
    }, 15_000);
    return () => {
      lifetime.abort();
      active?.abort();
      disconnect();
      window.clearInterval(poll);
    };
  }, [refreshKey]);

  async function rename(id: string, name: string, token: string) {
    const { device } = await renameDevice(id, name, token);
    namesEdited.current.set(id, device);
    setDevices((current) => current.map((entry) => entry.id === id ? device : entry));
  }

  return { devices, samples, connection, confirmed, loading, error, now, rename, retry: () => setRefreshKey((key) => key + 1) };
}
