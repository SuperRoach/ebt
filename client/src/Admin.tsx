import { useRef, useState, type FormEvent } from "react";
import { AdminTokenField } from "./AdminTokenField.js";
import type { Device, DeviceSettings } from "./api.js";

export function Admin({ devices, defaultColours, saveDevice, uploadFirmware, adminToken }: {
  devices: Device[];
  defaultColours: readonly string[];
  saveDevice: (id: string, settings: DeviceSettings, token: string) => Promise<void>;
  adminToken: string;
  uploadFirmware: (id: string, version: string, file: File, token: string) => Promise<{ release: { version: string }; assignedTo: string }>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [colour, setColour] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [pending, setPending] = useState<"settings" | "firmware" | null>(null);
  const saving = pending !== null;
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
    setPending("firmware");
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
      setPending(null);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || !token.trim()) return;
    setPending("settings");
    setError("");
    setNotice("");
    try {
      await saveDevice(id, { displayName: name.trim(), colour }, token.trim());
      setName(name.trim());
      setNotice("Device settings saved.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Device settings could not be saved.");
    } finally {
      setPending(null);
    }
  }

  return <>
    <button className="admin-button" type="button" aria-haspopup="dialog" onClick={() => {
      select(devices[0]?.id ?? "");
      setToken(adminToken);
      setOpen(true);
      dialog.current?.showModal();
    }}>Device admin</button>
    <dialog ref={dialog} aria-labelledby="admin-title" onCancel={(event) => {
      if (saving) event.preventDefault();
    }} onClose={() => { setOpen(false); setToken(""); setFirmwareFile(null); setFirmwareVersion(""); }}>
      <div className="dialog-heading">
        <h2 id="admin-title">Device admin</h2>
        <button type="button" disabled={saving} onClick={() => dialog.current?.close()}>Close</button>
      </div>
      {open && (devices.length ? <>
        <AdminTokenField token={token} setToken={setToken} disabled={saving} />
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
          <button type="submit" className="primary-button" disabled={saving || !name.trim() || !token.trim()}>
            {pending === "settings" ? "Saving…" : "Save settings"}
          </button>
        </form>
        <details className="firmware-update">
          <summary>Firmware update</summary>
          <form onSubmit={(event) => void upload(event)}>
            <p className="admin-help">Upload a .bin file for {devices.find((device) => device.id === id)?.displayName ?? id}.</p>
            <label>Firmware version
              <input value={firmwareVersion} onChange={(event) => setFirmwareVersion(event.target.value)} maxLength={64}
                pattern={"[A-Za-z0-9][A-Za-z0-9.+_\\-]{0,63}"} required disabled={saving} />
            </label>
            <label>Firmware file
              <input type="file" accept=".bin,application/octet-stream" required disabled={saving}
                onChange={(event) => setFirmwareFile(event.target.files?.[0] ?? null)} />
            </label>
            <button type="submit" disabled={saving || !firmwareVersion.trim() || !firmwareFile || !token.trim()}>
              {pending === "firmware" ? "Uploading…" : "Upload firmware"}
            </button>
          </form>
        </details>
        {error && <p role="alert" className="form-error admin-feedback">{error}</p>}
        {notice && <p role="status" className="form-notice admin-feedback">{notice}</p>}
      </> : <p>No devices are available.</p>)}
    </dialog>
  </>;
}
