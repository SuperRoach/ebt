import { useRef, useState, type FormEvent } from "react";
import type { Device, DeviceSettings } from "./api.js";

export function Admin({ devices, defaultColours, saveDevice, uploadFirmware, adminToken, editMessage, hasMessage }: {
  devices: Device[];
  defaultColours: readonly string[];
  saveDevice: (id: string, settings: DeviceSettings, token: string) => Promise<void>;
  adminToken: string;
  editMessage: () => void;
  hasMessage: boolean;
  uploadFirmware: (id: string, version: string, file: File, token: string) => Promise<{ release: { version: string }; assignedTo: string }>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [colour, setColour] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [firmwareVersion, setFirmwareVersion] = useState("");
  const [firmwareFile, setFirmwareFile] = useState<File | null>(null);

  function select(deviceId: string) {
    setId(deviceId);
    const device = devices.find((entry) => entry.id === deviceId);
    setName(device?.displayName ?? "");
    setColour(device?.colour ?? null);
    setNotice("");
    setError("");
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token.trim() || !firmwareVersion.trim() || !firmwareFile) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await uploadFirmware(id, firmwareVersion.trim(), firmwareFile, token.trim());
      setNotice(`${result.release.version} uploaded and assigned to ${result.assignedTo}.`);
      setFirmwareFile(null);
      setFirmwareVersion("");
      const input = dialog.current?.querySelector<HTMLInputElement>('input[type="file"]');
      if (input) input.value = "";
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Firmware could not be uploaded.");
    } finally {
      setSaving(false);
    }
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
    <button className="admin-button" type="button" onClick={() => {
      select(devices[0]?.id ?? "");
      setToken(adminToken);
      dialog.current?.showModal();
    }}>Device admin</button>
    <dialog ref={dialog} aria-labelledby="admin-title" onCancel={(event) => {
      if (saving) event.preventDefault();
      }} onClose={() => { setToken(""); setShowToken(false); setFirmwareFile(null); }}>
      <div className="dialog-heading">
        <h2 id="admin-title">Device admin</h2>
        <button type="button" disabled={saving} onClick={() => dialog.current?.close()}>Close</button>
      </div>
      {devices.length ? <>
      <div className="admin-token-field">
        <label htmlFor="admin-token">Admin token</label>
        <div className="admin-token-control">
          <input id="admin-token" type={showToken ? "text" : "password"} value={token}
            onChange={(event) => setToken(event.target.value)} autoComplete="off" spellCheck={false}
            autoCapitalize="none" required disabled={saving} />
          <button type="button" className="admin-token-toggle" aria-controls="admin-token"
            aria-label={showToken ? "Hide admin token" : "Show admin token"}
            title={showToken ? "Hide admin token" : "Show admin token"}
            onClick={() => setShowToken((visible) => !visible)}>
            <span className="admin-token-eye" data-visible={showToken} aria-hidden="true" />
          </button>
        </div>
      </div>
      <form onSubmit={(event) => void save(event)}>
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
        {error && <p role="alert" className="form-error">{error}</p>}
        {notice && <p role="status" className="form-notice">{notice}</p>}
        <button type="submit" className="primary-button" disabled={saving || !name.trim() || !token.trim()}>
          {saving ? "Saving…" : "Save settings"}
        </button>
      </form>
      <hr />
      <h3>Firmware update</h3>
      <p className="admin-help">Upload a compiled .bin file. It will be assigned only to the selected tracker.</p>
      <form onSubmit={(event) => void upload(event)}>
        <label>Firmware version
          <input value={firmwareVersion} onChange={(event) => setFirmwareVersion(event.target.value)} maxLength={64}
            pattern="[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}" placeholder="dual-link-0.5.0" required disabled={saving} />
        </label>
        <label>Firmware .bin
          <input type="file" accept=".bin,application/octet-stream" required disabled={saving}
            onChange={(event) => setFirmwareFile(event.target.files?.[0] ?? null)} />
        </label>
        {error && <p role="alert" className="form-error">{error}</p>}
        {notice && <p role="status" className="form-notice">{notice}</p>}
        <button type="submit" className="primary-button" disabled={saving || !firmwareVersion.trim() || !firmwareFile || !token.trim()}>
          {saving ? "Uploading…" : `Upload to ${devices.find((device) => device.id === id)?.displayName ?? id}`}
        </button>
      </form>
      </> : <p>No devices are available.</p>}
      <button className="admin-message-action" type="button" disabled={saving} onClick={() => {
        dialog.current?.close();
        editMessage();
      }}>{hasMessage ? "Edit dashboard message" : "Add dashboard message"}</button>
    </dialog>
  </>;
}
