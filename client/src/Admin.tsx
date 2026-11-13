import { useRef, useState, type FormEvent } from "react";
import type { Device } from "./api.js";

export function Admin({ devices, rename }: {
  devices: Device[];
  rename: (id: string, name: string, token: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  function select(deviceId: string) {
    setId(deviceId);
    setName(devices.find((device) => device.id === deviceId)?.displayName ?? "");
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
      await rename(id, name.trim(), token.trim());
      setName(name.trim());
      setNotice("Device name saved.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The device name could not be saved.");
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
        <label>Admin token
          <input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" required disabled={saving} />
        </label>
        {error && <p role="alert" className="form-error">{error}</p>}
        {notice && <p role="status" className="form-notice">{notice}</p>}
        <button type="submit" className="primary-button" disabled={saving || !name.trim() || !token.trim()}>
          {saving ? "Saving…" : "Save name"}
        </button>
      </form> : <p>No devices are available to edit.</p>}
    </dialog>
  </>;
}
