import { useEffect, useRef, useState } from "react";
import {
  history, listDevices, socketUrl, updateDashboardMessage, updateDevice,
  type DashboardMessage, type Device, type DeviceSettings, type StoredSample,
} from "./api.js";
import { connectTelemetry, type Connection } from "./telemetrySocket.js";
import { fromEvent, mergeSamples } from "./tracking.js";

export function useTracking() {
  const [notice, setNotice] = useState<DashboardMessage>({ message: "", revision: 0 });
  const [devices, setDevices] = useState<Device[]>([]);
  const [samples, setSamples] = useState<Record<string, StoredSample[]>>({});
  const [connection, setConnection] = useState<Connection>("connecting");
  const [streamed, setStreamed] = useState<Record<string, StoredSample>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now);
  const [refreshKey, setRefreshKey] = useState(0);
  const editedDevices = useRef(new Map<string, Device>());
  const openedAt = useRef(now);

  function receiveMessage(next: DashboardMessage) {
    setNotice((current) => next.revision >= current.revision ? next : current);
  }

  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(clock);
  }, []);

  useEffect(() => {
    let active: AbortController | undefined;
    let connected = false;
    let needsRetry = true;
    const lifetime = new AbortController();

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
      const editsAtStart = new Map(editedDevices.current);
      try {
        const { devices: roster, message, messageRevision } = await listDevices(signal);
        if (signal.aborted) return;
        receiveMessage({ message: message ?? "", revision: messageRevision ?? 0 });
        setDevices(roster.map((device) => {
          const edited = editedDevices.current.get(device.id);
          return edited && edited !== editsAtStart.get(device.id) ? edited : device;
        }));
        const results = await Promise.allSettled(roster.map(({ id }) =>
          history(id, signal).then(({ samples: trail }) => {
            if (!signal.aborted) merge(id, trail);
          }),
        ));
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
      onDashboardMessage: receiveMessage,
      onState(state) {
        connected = state === "connected";
        setConnection(state);
        if (!connected) setStreamed({});
        if (connected) void refresh();
      },
      onTelemetry(event) {
        const incoming = fromEvent(event);
        const receivedNow = Date.now();
        merge(event.deviceId, incoming);
        const fresh = incoming.filter((sample) => Date.parse(sample.timestamp) >= openedAt.current);
        if (fresh.length) {
          setStreamed((current) => {
            const previous = current[event.deviceId];
            const [newest] = mergeSamples(previous ? [previous] : [], fresh, receivedNow);
            return newest === previous ? current : { ...current, [event.deviceId]: newest };
          });
        }
        setNow(receivedNow);
      },
    });
    void refresh();
    const poll = window.setInterval(() => {
      if (!connected || needsRetry) {
        void refresh();
      } else {
        // Recover a missed message event without reloading cart history.
        void listDevices(lifetime.signal).then(({ message, messageRevision }) => {
          if (!lifetime.signal.aborted) receiveMessage({ message: message ?? "", revision: messageRevision ?? 0 });
        }).catch(() => {});
      }
    }, 15_000);
    return () => {
      lifetime.abort();
      active?.abort();
      disconnect();
      window.clearInterval(poll);
    };
  }, [refreshKey]);

  async function saveDevice(id: string, settings: DeviceSettings, token: string) {
    const { device } = await updateDevice(id, settings, token);
    editedDevices.current.set(id, device);
    setDevices((current) => current.map((entry) => entry.id === id ? device : entry));
  }

  async function saveMessage(message: string, token: string) {
    receiveMessage(await updateDashboardMessage(message, token));
  }

  return {
    devices, message: notice.message, samples, connection, streamed, loading, error, now,
    saveDevice, saveMessage, retry: () => setRefreshKey((key) => key + 1),
  };
}
