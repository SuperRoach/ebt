import { useEffect, useRef, useState, type FormEvent } from "react";
import { AdminTokenField } from "./AdminTokenField.js";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function MessagePreview({ message }: { message: string }) {
  const [length, setLength] = useState<number>();

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let deadline = 0;
    function finish() {
      cancelAnimationFrame(frame);
      window.clearTimeout(deadline);
      setLength(undefined);
    }
    function animate() {
      finish();
      if (motion.matches || document.hidden) return;
      const segments = [...segmenter.segment(message)].slice(0, 72);
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
    animate();
    motion.addEventListener("change", animate);
    document.addEventListener("visibilitychange", finish);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(deadline);
      motion.removeEventListener("change", animate);
      document.removeEventListener("visibilitychange", finish);
    };
  }, [message]);

  return <>
    <span className="message-preview-text" aria-hidden="true" data-typing={length !== undefined}>
      {length === undefined ? message : message.slice(0, length)}
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
    <h2><button className="dashboard-title-button" type="button" aria-haspopup="dialog"
      aria-label="Cart tracking, set dashboard message" onClick={openEditor}>
      Cart tracking <span className="dashboard-title-chevron" aria-hidden="true" />
    </button></h2>
    {message && <div className="header-message">
      <button className="message-preview" type="button" aria-haspopup="dialog" onClick={() => {
        setEditing(false);
        dialog.current?.showModal();
      }}>
        <MessagePreview key={message} message={message} />
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
