import { useEffect, useId, useRef, useState, type FormEvent } from "react";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function MessagePreview({ message }: { message: string }) {
  const [length, setLength] = useState<number>();

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    function animate() {
      cancelAnimationFrame(frame);
      setLength(undefined);
      if (motion.matches) return;
      const segments = [...segmenter.segment(message)].slice(0, 72);
      const duration = Math.min(850, segments.length * 28);
      const started = performance.now();
      function type(now: number) {
        const count = Math.floor(((now - started) / duration) * segments.length);
        if (count >= segments.length) {
          setLength(undefined);
          return;
        }
        setLength(segments[count].index);
        frame = requestAnimationFrame(type);
      }
      setLength(0);
      frame = requestAnimationFrame(type);
    }
    animate();
    motion.addEventListener("change", animate);
    return () => {
      cancelAnimationFrame(frame);
      motion.removeEventListener("change", animate);
    };
  }, [message]);

  return <>
    <span className="message-preview-dot" aria-hidden="true" />
    <span className="message-preview-text" aria-hidden="true" data-typing={length !== undefined}>
      {length === undefined ? message : message.slice(0, length)}
    </span>
    <span className="sr-only">Read dashboard message. {message}</span>
  </>;
}

export function DashboardMessage({ message, adminToken, saveMessage, editorRequest }: {
  message: string;
  adminToken: string;
  saveMessage: (message: string, token: string) => Promise<void>;
  editorRequest: number;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
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

  const handledRequest = useRef(0);
  useEffect(() => {
    if (editorRequest === handledRequest.current) return;
    handledRequest.current = editorRequest;
    openEditor();
  }, [editorRequest, message, adminToken]);

  useEffect(() => {
    if (editing && dialog.current?.open) textarea.current?.focus();
  }, [editing, editorRequest]);

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
    {message && <div className="header-message">
      <button className="message-preview" type="button" aria-haspopup="dialog" onClick={() => {
        setEditing(false);
        dialog.current?.showModal();
      }}>
        <MessagePreview key={message} message={message} />
      </button>
      {adminToken && <button type="button" className="message-edit" onClick={openEditor}>Edit</button>}
    </div>}
    <dialog className="message-dialog" ref={dialog} aria-labelledby={titleId}
      onCancel={(event) => { if (saving) event.preventDefault(); }}
      onClose={() => { setToken(""); setDraft(""); setError(""); }}>
      <div className="dialog-heading">
        <h2 id={titleId}>{editing ? "Edit dashboard message" : "Dashboard message"}</h2>
        <button type="button" disabled={saving} onClick={() => dialog.current?.close()}>Close</button>
      </div>
      {editing ? <form onSubmit={(event) => void submit(event)}>
        <label>Message
          <textarea ref={textarea} value={draft} maxLength={500} rows={4} disabled={saving}
            onChange={(event) => setDraft(event.target.value)} placeholder="Leave blank to clear" />
        </label>
        <label>Admin token
          <input type="password" value={token} required disabled={saving} autoComplete="off"
            onChange={(event) => setToken(event.target.value)} />
        </label>
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
