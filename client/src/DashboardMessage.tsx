import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { AdminTokenField } from "./AdminTokenField.js";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const slideDuration = 350;
const announcementDuration = 10_000;

function MessagePreview({ message, animate }: { message: string; animate: boolean }) {
  const [length, setLength] = useState<number>();

  useLayoutEffect(() => {
    if (!animate) {
      setLength(undefined);
      return;
    }
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let deadline = 0;
    let startTimer = 0;
    function finish() {
      cancelAnimationFrame(frame);
      window.clearTimeout(deadline);
      window.clearTimeout(startTimer);
      setLength(undefined);
    }
    function startTyping() {
      const segments = [...segmenter.segment(message)];
      const duration = Math.min(850, segments.length * 28);
      const started = performance.now();
      function type(now: number) {
        const count = Math.floor(((now - started) / duration) * segments.length);
        if (count >= segments.length) {
          finish();
          return;
        }
        setLength(segments[count].index);
        frame = requestAnimationFrame(type);
      }
      setLength(0);
      frame = requestAnimationFrame(type);
      deadline = window.setTimeout(finish, duration + 100);
    }
    setLength(0);
    startTimer = window.setTimeout(startTyping, slideDuration);
    motion.addEventListener("change", finish);
    document.addEventListener("visibilitychange", finish);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(deadline);
      window.clearTimeout(startTimer);
      motion.removeEventListener("change", finish);
      document.removeEventListener("visibilitychange", finish);
    };
  }, [message, animate]);

  return <>
    <span className="message-preview-text" aria-hidden="true" data-typing={animate && length !== undefined}>
      {!animate || length === undefined ? message : message.slice(0, length)}
    </span>
    <span className="sr-only">Read dashboard message. {message}</span>
  </>;
}

export function DashboardMessage({ message, adminToken, saveMessage }: {
  message: string;
  adminToken: string;
  saveMessage: (message: string, token: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState<string>();
  const announcing = Boolean(message && announcement === message);

  useLayoutEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!message || motion.matches || document.hidden) {
      setAnnouncement(undefined);
      return;
    }
    const finish = () => setAnnouncement(undefined);
    setAnnouncement(message);
    const deadline = window.setTimeout(finish, announcementDuration);
    motion.addEventListener("change", finish);
    document.addEventListener("visibilitychange", finish);
    return () => {
      window.clearTimeout(deadline);
      motion.removeEventListener("change", finish);
      document.removeEventListener("visibilitychange", finish);
    };
  }, [message]);

  function openEditor() {
    setDraft(message);
    setToken(adminToken);
    setError("");
    setEditing(true);
    dialog.current?.showModal();
  }

  useEffect(() => {
    if (editing && dialog.current?.open) textarea.current?.focus();
  }, [editing]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      await saveMessage(draft, token.trim());
      dialog.current?.close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Dashboard message could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return <>
    <h2 data-announcing={announcing} onFocus={() => setAnnouncement(undefined)}><button className="dashboard-title-button" type="button" aria-haspopup="dialog"
      aria-label="Cart tracking, set dashboard message" onClick={openEditor}>
      Cart tracking <span className="dashboard-title-chevron" aria-hidden="true" />
    </button></h2>
    {message && <div className="header-message" data-announcing={announcing}>
      <button className="message-preview" type="button" aria-haspopup="dialog" onClick={() => {
        setEditing(false);
        dialog.current?.showModal();
      }}>
        <MessagePreview key={message} message={message} animate={announcing} />
      </button>
      {adminToken && <button type="button" className="message-edit" onClick={openEditor}>Edit</button>}
    </div>}
    <dialog className="message-dialog" ref={dialog} aria-label={editing ? "Edit dashboard message" : "Dashboard message"}
      onCancel={(event) => { if (saving) event.preventDefault(); }}
      onClose={() => { setEditing(false); setToken(""); setDraft(""); setError(""); }}>
      <div className="dialog-heading">
        <button type="button" disabled={saving} onClick={() => dialog.current?.close()}>Close</button>
      </div>
      {editing ? <form onSubmit={(event) => void submit(event)}>
        <label>Message
          <textarea ref={textarea} value={draft} maxLength={500} rows={4} disabled={saving}
            onChange={(event) => setDraft(event.target.value)} placeholder="Leave blank to clear" />
        </label>
        <AdminTokenField token={token} setToken={setToken} disabled={saving} />
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-button" type="submit" disabled={saving || !token.trim()}>
          {saving ? "Saving…" : draft.trim() ? "Publish message" : "Clear message"}
        </button>
      </form> : <>
        <p className="message-full">{message || "The message has been cleared."}</p>
        {adminToken && <button type="button" className="admin-message-action" onClick={openEditor}>Edit message</button>}
      </>}
    </dialog>
  </>;
}
