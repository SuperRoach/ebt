import { useRef, useState, type FormEvent } from "react";
import type { Device, DeviceSettings } from "./api.js";

export function Admin({ devices, defaultColours, saveDevice }: {
  devices: Device[];
  defaultColours: readonly string[];
  saveDevice: (id: string, settings: DeviceSettings, token: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [colour, setColour] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  function select(deviceId: string) {
    setId(deviceId);
    const device = devices.find((entry) => entry.id === deviceId);
    setName(device?.displayName ?? "");
    setColour(device?.colour ?? null);
    setNotice("");
    setError("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || !token.trim()) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await saveDevice(id, { displayName: name.trim(), colour }, token.trim());
      setName(name.trim());
      setNotice("Device settings saved.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Device settings could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return <>
    <button className="admin-button" type="button" disabled={!devices.length} onClick={() => {
      select(devices[0]?.id ?? "");
      dialog.current?.showModal();
    }}>Device admin</button>
    <dialog ref={dialog} aria-labelledby="admin-title" onCancel={(event) => {
      if (saving) event.preventDefault();
    }} onClose={() => setToken("")}>
      <div className="dialog-heading">
        <h2 id="admin-title">Device admin</h2>
        <button type="button" disabled={saving} onClick={() => dialog.current?.close()}>Close</button>
      </div>
      {devices.length ? <form onSubmit={(event) => void save(event)}>
        <label>Device
          <select value={id} onChange={(event) => select(event.target.value)} disabled={saving}>
            {devices.map((device) => <option key={device.id} value={device.id}>{device.displayName} ({device.id})</option>)}
          </select>
        </label>
        <label>Display name
          <input value={name} onChange={(event) => { setName(event.target.value); setNotice(""); }} maxLength={100} required disabled={saving} />
        </label>
        <div className="device-colour">
          <label>Cart colour
            <input type="color" value={colour ?? defaultColours[Math.max(0, devices.findIndex((device) => device.id === id)) % defaultColours.length]}
              disabled={saving} onChange={(event) => { setColour(event.target.value); setNotice(""); }} />
          </label>
          <button type="button" disabled={saving || colour === null} onClick={() => { setColour(null); setNotice(""); }}>
            Use default colour
          </button>
        </div>
        <label>Admin token
          <input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" required disabled={saving} />
        </label>
        {error && <p role="alert" className="form-error">{error}</p>}
        {notice && <p role="status" className="form-notice">{notice}</p>}
        <button type="submit" className="primary-button" disabled={saving || !name.trim() || !token.trim()}>
          {saving ? "Saving…" : "Save settings"}
        </button>
      </form> : <p>No devices are available to edit.</p>}
    </dialog>
  </>;
}
