import { useId, useState, type CSSProperties } from "react";
import { Admin } from "./Admin.js";
import { uploadFirmware, type StoredSample } from "./api.js";
import { CartMap, type MapCart } from "./CartMap.js";
import { DashboardMessage } from "./DashboardMessage.js";
import { cartStatus, isDemo, lastPositionSample, position, trailSegments } from "./tracking.js";
import { useTracking } from "./useTracking.js";

const colours = ["#1551b0", "#9c360d", "#5b3b9c", "#126d5d"];
const localTime = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Melbourne", dateStyle: "medium", timeStyle: "medium",
});

function StatusDot({ pulseKey }: { pulseKey?: string }) {
  return <span className="status-dot" aria-hidden="true">
    {pulseKey !== undefined && <span key={pulseKey} className="status-pulse" />}
  </span>;
}

function TransportChip({ sample }: { sample: StoredSample }) {
  const tooltipId = useId();
  const { transport, cellularRsrpDbm, cellularRsrqDb, cellularSinrDb, cellularRssiDbm } = sample;
  const hasSignal = [cellularRsrpDbm, cellularRsrqDb, cellularSinrDb, cellularRssiDbm].some((value) => value != null);
  const quality = cellularRsrpDbm == null ? "" : cellularRsrpDbm >= -90 ? "Good" : cellularRsrpDbm >= -105 ? "OK" : "Poor";
  const signalDetails = [
    cellularRsrpDbm != null && `RSRP ${cellularRsrpDbm} dBm`,
    cellularRsrqDb != null && `RSRQ ${cellularRsrqDb} dB`,
    cellularSinrDb != null && `SINR ${cellularSinrDb} dB`,
    cellularRssiDbm != null && `RSSI ${cellularRssiDbm} dBm`,
  ].filter(Boolean).join(" · ");
  const measuredAt = hasSignal ? ` · Measured ${localTime.format(new Date(sample.receivedAt))}` : "";
  const label = transport === "wifi" ? "Wi-Fi" : `4G cellular${quality ? ` · ${quality}` : hasSignal ? " · Signal measured" : " · Signal unavailable"}${signalDetails ? ` · ${signalDetails}` : ""}${measuredAt}`;
  return <span className="transport-chip" tabIndex={0} aria-describedby={tooltipId}>
    <span className={`transport-icon ${transport === "wifi" ? "wifi-icon" : "cellular-icon"}`} aria-hidden="true" />
    <span className="battery-tooltip" id={tooltipId} role="tooltip">{label}</span>
  </span>;
}

function Telemetry({ sample, status, now }: { sample: StoredSample | undefined; status: MapCart["status"]; now: number }) {
  const speed = status === "Live" && sample?.speedMps != null ? (sample.speedMps * 3.6).toFixed(1) : null;
  const batteryTooltipId = useId();
  const recordingTooltipId = useId();
  const gpsTooltipId = useId();
  const recordingState = sample?.recordingState;
  const hasFix = sample?.fixValid === true;
  const batteryVoltage = sample?.batteryVoltage;
  const ageSeconds = sample ? Math.max(0, Math.floor((now - Date.parse(sample.timestamp)) / 1000)) : Infinity;
  // Estimate charge from voltage for the tracker's single-cell lithium battery.
  const emptyVoltage = 3.3;
  const fullVoltage = 4.2;
  const batteryPercent = batteryVoltage == null ? null :
    Math.round(Math.min(1, Math.max(0, (batteryVoltage - emptyVoltage) / (fullVoltage - emptyVoltage))) * 100);
  return <>
    <dl className="cart-readings">
      <div><dt className="sr-only">Speed</dt><dd className="speed">{speed ?? "—"} <span>km/h</span></dd></div>
      <div className="battery-metric"><dt className="sr-only">Battery</dt><dd className="battery-value">
        <span className="battery-icon" aria-hidden="true">
          {batteryPercent != null && <span className="battery-fill" style={{ width: `${batteryPercent}%` }} />}
        </span>{batteryPercent != null && batteryVoltage != null ?
        <span className="battery-reading" tabIndex={0} aria-describedby={batteryTooltipId}>
          {batteryPercent}%
          <span className="battery-tooltip" id={batteryTooltipId} role="tooltip">
            Estimated charge · {batteryVoltage.toFixed(2)} V
          </span>
        </span> : "—"}</dd></div>
    </dl>
    <dl className="metrics">
      <div className="telemetry-chips">
        <dt className="sr-only">Recording</dt>
        <dd>
          <span className="telemetry-chip recording-chip" data-recording={recordingState === "recording"} tabIndex={0} aria-describedby={recordingTooltipId}>
            <span className="recording-icon" aria-hidden="true" />
            <span className="battery-tooltip" id={recordingTooltipId} role="tooltip">
              {recordingState ? `Recording: ${recordingState}` : "Recording status unavailable"}
            </span>
          </span>
        </dd>
        <dt className="sr-only">GPS fix</dt>
        <dd>
          <span className="telemetry-chip gps-chip" data-fix={hasFix} tabIndex={0} aria-describedby={gpsTooltipId}>
            <span className="satellite-icon" aria-hidden="true" />
            {hasFix && <span aria-hidden="true">{sample.satelliteCount}</span>}
            <span className="battery-tooltip" id={gpsTooltipId} role="tooltip">
              {hasFix ? `GPS fix · ${sample.satelliteCount} satellites` : sample ? "No GPS fix" : "GPS status unavailable"}
            </span>
          </span>
        </dd>
      </div>
      <div className="updated"><dt>Last update</dt><dd>{sample ?
        <time dateTime={sample.timestamp} title={localTime.format(new Date(sample.timestamp))}>
          {ageSeconds < 60 ? `${ageSeconds} sec ago` : localTime.format(new Date(sample.timestamp))}
        </time> : "No data yet"}</dd></div>
    </dl>
  </>;
}

export function App() {
  const trailTooltipId = useId();
  const { devices, message, samples, connection, streamed, loading, error, now, saveDevice, saveMessage, retry } = useTracking();
  const [adminToken, setAdminToken] = useState("");
  const [editorRequest, setEditorRequest] = useState(0);
  const [hidden, setHidden] = useState<string[]>([]);
  const [followId, setFollowId] = useState("");
  const [fitRequest, setFitRequest] = useState(0);

  const carts = devices.map((device, index) => {
    const recent = samples[device.id] ?? [];
    const sample = recent[0];
    const liveSample = connection === "connected" && sample?.sequence === streamed[device.id]?.sequence;
    const status = cartStatus(sample, now, liveSample);
    const fix = lastPositionSample(recent, now);
    const historical = Boolean(fix && status !== "Live");
    return {
      device, sample, status, historical, number: index + 1,
      colour: device.colour ?? (historical ? "#606b75" : colours[index % colours.length]),
      liveSequence: status === "Live" ? sample?.sequence : undefined,
      demo: Boolean(sample && isDemo(sample)),
      positionDemo: Boolean(fix && isDemo(fix)),
      point: fix ? position(fix) : null,
      headingDeg: fix?.headingDeg ?? null,
      trail: trailSegments(fix ? recent.slice(recent.indexOf(fix)) : recent, historical && fix ? Date.parse(fix.timestamp) : now),
    };
  });
  const visible = carts.filter(({ device }) => !hidden.includes(device.id));
  const onMap = visible.filter(({ point }) => point).length;
  const historicalOnMap = visible.filter((cart) => cart.historical).length;
  const liveCount = carts.filter(({ status }) => status === "Live").length;
  const demo = carts.some((cart) => cart.demo || cart.positionDemo);
  const connectionText = { connecting: "Connecting", connected: "Feed connected", reconnecting: "Reconnecting" }[connection];
  const feedPulseKey = connection === "connected"
    ? JSON.stringify(carts.map(({ device }) => streamed[device.id]?.sequence))
    : undefined;

  return <>
    <header className="masthead">
      <div className="masthead-inner">
        <div className="school-mark" aria-hidden="true">LP</div>
        <div className="brand">
          <p>Lucas Primary School</p>
          <h1>Energy Breakthrough</h1>
        </div>
        {demo && <details className="demo-notice">
          <summary><span>Demo</span><span className="sr-only"> mode</span></summary>
          <p className="demo-popover">Positions marked Demo are generated by the simulator.</p>
        </details>}
        <Admin devices={devices} defaultColours={colours} uploadFirmware={uploadFirmware} adminToken={adminToken} hasMessage={Boolean(message)}
          editMessage={() => setEditorRequest((request) => request + 1)}
          saveDevice={async (id, settings, token) => {
            await saveDevice(id, settings, token);
            setAdminToken(token);
          }} />
      </div>
    </header>
    <main>
      <div className="page-heading">
        <div className="dashboard-title">
          <h2>Cart tracking</h2>
          <DashboardMessage message={message} adminToken={adminToken} editorRequest={editorRequest}
            saveMessage={async (value, token) => {
              await saveMessage(value, token);
              setAdminToken(token);
            }} />
        </div>
        <div className="dashboard-status">
          {carts.length > 0 && <span className="fleet-count"><strong>{liveCount}/{carts.length}</strong> reporting live</span>}
          <span role="status" className={`connection ${connection}`}>
            <StatusDot pulseKey={feedPulseKey} />
            {connectionText}
          </span>
        </div>
      </div>

      {error && <div className="notice" role="status"><span>{error}</span><button type="button" onClick={retry}>Retry now</button></div>}
      {connection === "reconnecting" && !error &&
        <div className="notice" role="status">Live feed interrupted. Showing last known positions while reconnecting.</div>}

      <div className="dashboard">
        <section className="map-panel" aria-labelledby="map-title">
          <div className="panel-heading">
            <div className="map-title-row">
              <h2 id="map-title">Circuit map</h2>
              <p className="map-count">{onMap} {onMap === 1 ? "cart" : "carts"} on map{historicalOnMap > 0 && ` · ${historicalOnMap} last known`}</p>
            </div>
            <div className="map-actions">
              <label className="follow">Follow
                <select aria-label="Follow cart" value={followId} onChange={(event) => setFollowId(event.target.value)} disabled={!visible.length}>
                  <option value="">Off</option>
                  {visible.map(({ device }) => <option key={device.id} value={device.id}>{device.displayName}</option>)}
                </select>
              </label>
              <button type="button" onClick={() => { setFollowId(""); setFitRequest((value) => value + 1); }}>Fit all carts</button>
            </div>
          </div>
          <CartMap carts={visible} followId={followId} fitRequest={fitRequest} />
          <div className="map-caption">
            <span className="trail-legend" tabIndex={0} aria-describedby={trailTooltipId}>
              <span className="trail-key" aria-hidden="true" /> Past trail
              <span className="battery-tooltip" id={trailTooltipId} role="tooltip">Up to 5 minutes</span>
            </span>
            {!onMap && <span>{loading ? "Loading cart positions…" : "No cart positions available"}</span>}
            {followId && !visible.some(({ device, status }) => device.id === followId && status === "Live") && <span>Follow paused until the cart has a current fix</span>}
          </div>
        </section>

        <aside className="cart-list" aria-labelledby="carts-title">
          <h2 id="carts-title">Tracked carts</h2>
          {loading && !carts.length && <p className="empty" role="status">Loading devices…</p>}
          {!loading && !carts.length && !error && <p className="empty">No tracking devices are registered.</p>}
          {!loading && !carts.length && error && <p className="empty">Device list unavailable.</p>}
          {carts.map(({ device, colour, number, demo: simulated, status, sample, liveSequence }) =>
            <article className="cart-card" key={device.id} style={{ "--cart-colour": colour } as CSSProperties}>
              <div className="cart-heading">
                <span className="cart-number" aria-hidden="true">{number}</span>
                <div className="cart-name">
                  <h3>{device.displayName}</h3>
                  <p>{device.id}</p>
                </div>
                <div className="cart-chips">
                  <span className={`cart-status ${status.toLowerCase().replaceAll(" ", "-")}`}>
                    <StatusDot pulseKey={liveSequence} />{status === "No GPS Fix"
                      ? `Online · ${sample?.transport === "4g" ? "4G" : "Wi-Fi"} · No GPS fix`
                      : status}
                  </span>
                  {sample && <TransportChip sample={sample} />}
                </div>
              </div>
              {simulated && <p className="demo-tag">Demo telemetry</p>}
              <Telemetry sample={sample} status={status} now={now} />
              <label className="visibility">
                <input type="checkbox" checked={!hidden.includes(device.id)} onChange={(event) => {
                  const show = event.target.checked;
                  setHidden((current) => show ? current.filter((id) => id !== device.id) : [...current, device.id]);
                  if (!show && followId === device.id) setFollowId("");
                }} aria-label={`Show ${device.displayName} on map`} />
                Show on map
              </label>
            </article>,
          )}
        </aside>
      </div>
    </main>
  </>;
}
