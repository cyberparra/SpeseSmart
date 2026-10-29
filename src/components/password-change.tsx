"use client";
import { useRef, useState } from "react";
import { useAccount } from "./account-session";
import { Icon } from "./icon";
import { sessionFetch } from "@/lib/session-fetch";

function PasswordField({ name, label, current, disabled }: { name: string; label: string; current?: boolean; disabled: boolean }) {
  const [visible, setVisible] = useState(false);
  const id = `change-${name}`;
  const toggleLabel = `${visible ? "Nascondi" : "Mostra"} ${label.toLowerCase()}`;
  return <label htmlFor={id}>{label}<span className="password-field">
    <input id={id} name={name} type={visible ? "text" : "password"} autoComplete={current ? "current-password" : "new-password"}
      autoCapitalize="none" spellCheck={false} required maxLength={512} disabled={disabled} />
    <button type="button" className="password-toggle" aria-label={toggleLabel} aria-controls={id} aria-pressed={visible} onClick={() => setVisible(value => !value)}>
      <Icon name={visible ? "eyeOff" : "eye"} />
    </button>
  </span></label>;
}

const messages: Record<string, string> = {
  CURRENT_PASSWORD: "La password attuale non è corretta.",
  PASSWORD_CONFIRMATION: "La conferma non corrisponde alla nuova password.",
  PASSWORD_POLICY: "La nuova password deve contenere da 8 a 256 caratteri, su una sola riga.",
};
export function PasswordChange() {
  const account = useAccount();
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reset, setReset] = useState(0);
  if (!account) return null;
  return <section className="panel password-change"><h2>Cambia password</h2>
    <p>Da 8 a 256 caratteri. Dopo il cambio, le altre sessioni saranno disconnesse; questa resterà attiva.</p>
    <form className="password-change-form" aria-label="Cambia password" method="post" action="/api/auth/password" onSubmit={async event => {
      event.preventDefault(); if (sending.current) return;
      const form = event.currentTarget, values = new FormData(form);
      const currentPassword = String(values.get("currentPassword") ?? ""), newPassword = String(values.get("newPassword") ?? ""), confirmPassword = String(values.get("confirmPassword") ?? "");
      setError(""); setNotice("");
      if (newPassword !== confirmPassword) { setError(messages.PASSWORD_CONFIRMATION); return; }
      if ([...newPassword].length < 8 || [...newPassword].length > 256 || /[\r\n]/.test(newPassword)) { setError(messages.PASSWORD_POLICY); return; }
      sending.current = true; setBusy(true);
      try {
        const response = await sessionFetch("/api/auth/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword, newPassword, confirmPassword }) });
        const body = await response.json();
        if (!response.ok) {
          setError(messages[body.code] ?? (response.status === 429 ? "Troppi tentativi. Attendi un minuto prima di riprovare." : response.status === 409 ? "Un’operazione è già in corso. Attendi prima di riprovare." : "Cambio password non completato. Verifica l’accesso prima di riprovare."));
          return;
        }
        if (body.changed !== true) throw Error();
        form.reset(); setReset(value => value + 1);
        setNotice("Password modificata. Le altre sessioni sono state disconnesse; questa resta attiva.");
      } catch {
        setError("Esito non verificabile. Prova ad accedere con la nuova password prima di ripetere il cambio.");
      } finally { sending.current = false; setBusy(false); }
    }}>
      <PasswordField key={`current-${reset}`} name="currentPassword" label="Password attuale" current disabled={busy} />
      <PasswordField key={`new-${reset}`} name="newPassword" label="Nuova password" disabled={busy} />
      <PasswordField key={`confirm-${reset}`} name="confirmPassword" label="Conferma nuova password" disabled={busy} />
      <button type="submit" className="secondary" disabled={busy}>{busy ? "Modifica in corso…" : "Salva nuova password"}</button>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
