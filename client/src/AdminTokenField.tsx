import { useId, useState } from "react";

export function AdminTokenField({ token, setToken, disabled }: {
  token: string;
  setToken: (value: string) => void;
  disabled: boolean;
}) {
  const id = useId();
  const helpId = useId();
  const [visible, setVisible] = useState(false);

  return <div className="admin-token-field">
    <div className="admin-token-label">
      <label htmlFor={id}>Admin token</label>
      <span className="admin-token-help" id={helpId}>The admin token is required to save these settings.</span>
    </div>
    <div className="admin-token-control">
      <input id={id} type={visible ? "text" : "password"} value={token} aria-describedby={helpId}
        onChange={(event) => setToken(event.target.value)} autoComplete="off" spellCheck={false}
        autoCapitalize="none" required disabled={disabled} />
      <button type="button" className="admin-token-toggle" aria-controls={id}
        aria-label={visible ? "Hide admin token" : "Show admin token"}
        title={visible ? "Hide admin token" : "Show admin token"}
        onClick={() => setVisible((current) => !current)}>
        <span className="admin-token-eye" data-visible={visible} aria-hidden="true" />
      </button>
    </div>
  </div>;
}
