import { useRef } from "react";

export function About({ gpsUpdatesRead, serverUpdatesRead, maxSpeeds }: {
  gpsUpdatesRead: number;
  serverUpdatesRead: number;
  maxSpeeds: { deviceId: string; displayName: string; speedKmh: number | null }[];
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  return <>
    <button className="about-button" type="button" aria-label="About" aria-haspopup="dialog"
      onClick={() => dialog.current?.showModal()}>?</button>
    <dialog ref={dialog} aria-labelledby="about-title">
      <div className="dialog-heading">
        <h2 id="about-title">About</h2>
        <button type="button" onClick={() => dialog.current?.close()}>Close</button>
      </div>
      <p className="about-message">Made by Brett James for Brock, and for Lucas Primary School. Go team!</p>
      <section className="about-tracking" aria-labelledby="about-tracking-title">
        <h3 id="about-tracking-title">Tracking info</h3>
        <p>{gpsUpdatesRead} GPS updates read · {serverUpdatesRead} live server updates read</p>
        <ul className="max-speeds">
          {maxSpeeds.map(({ deviceId, displayName, speedKmh }) => <li key={deviceId}>
            {displayName}: max this session {speedKmh?.toFixed(1) ?? "—"} km/h
          </li>)}
        </ul>
      </section>
    </dialog>
  </>;
}
