"use client";
import { createContext, useContext, useEffect, useState } from "react";
import { bindSession, clearSession, sessionFetch } from "@/lib/session-fetch";
import { applyCategoryExtensions } from "@/lib/categories";
type Account = { id: string; username: string; role: "admin" | "user" };
const AccountContext = createContext<Account | null>(null);
export const useAccount = () => useContext(AccountContext);
export function AccountSession({ multiuser, children }: { multiuser: boolean; children: React.ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [checking, setChecking] = useState(multiuser);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!multiuser) { bindSession(undefined, undefined, false); return; }
    const controller = new AbortController();
    let boot: { user: Account; csrf: string } | null = null;
    const ended = () => { setAccount(null); setChecking(false); setError("Sessione terminata. Accedi nuovamente."); };
    const check = async () => {
      if (document.visibilityState === "hidden") return;
      setChecking(true);
      try {
        const response = await fetch("/api/auth/session", { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok || !data.user?.id || !data.csrf || (boot && (boot.user.id !== data.user.id || boot.csrf !== data.csrf))) throw Error("Accesso account richiesto.");
        if (!boot) { bindSession(data.user.id, data.csrf); boot = data; }
        const catalog = await sessionFetch("/api/categories", { cache: "no-store", signal: controller.signal });
        if (!catalog.ok) throw Error("Catalogo personale non disponibile. Riprova l’accesso.");
        const categories = await catalog.json(); applyCategoryExtensions(categories.extensions, categories.revision);
        if (!controller.signal.aborted) { setAccount(data.user); setError(""); document.documentElement.style.visibility = ""; }
      } catch (caught) {
        if (!controller.signal.aborted) { clearSession(); setAccount(null); setError(caught instanceof Error ? caught.message : "Accesso non disponibile."); document.documentElement.style.visibility = ""; }
      } finally { if (!controller.signal.aborted) setChecking(false); }
    };
    const changed = (event: StorageEvent) => { if (event.key === "spesesmart:auth-event") { clearSession(); } };
    const leaving = () => { clearSession(); document.documentElement.style.visibility = "hidden"; };
    const restored = (event: PageTransitionEvent) => { if (event.persisted) window.location.replace("/login"); else void check(); };
    const visibility = () => { if (document.visibilityState === "hidden") document.documentElement.style.visibility = "hidden"; else void check(); };
    window.addEventListener("spesesmart:session-ended", ended);
    window.addEventListener("storage", changed);
    window.addEventListener("focus", check); window.addEventListener("pagehide", leaving); window.addEventListener("pageshow", restored); document.addEventListener("visibilitychange", visibility);
    void check();
    return () => { controller.abort(); bindSession(); window.removeEventListener("spesesmart:session-ended", ended); window.removeEventListener("storage", changed); window.removeEventListener("focus", check); window.removeEventListener("pagehide", leaving); window.removeEventListener("pageshow", restored); document.removeEventListener("visibilitychange", visibility); };
  }, [multiuser]);
  if (!multiuser) return children;
  return <AccountContext.Provider value={account}>
    {account && <div hidden={checking} key={account.id}>{children}</div>}
    {checking && <main className="panel" role="status">Verifica accesso…</main>}
    {!checking && !account && <main className="panel"><h1>SpeseSmart</h1><p role="alert">{error || "Accesso account richiesto."}</p><a className="primary" href="/login">Accedi</a></main>}
  </AccountContext.Provider>;
}
export function AccountControls() {
  const account = useAccount();
  if (!account) return null;
  return <><span>{account.username}</span><button className="text-button" onClick={async () => {
    try { await sessionFetch("/api/auth/logout", { method: "POST" }); }
    catch {}
    finally { clearSession(); try { localStorage.setItem("spesesmart:auth-event", crypto.randomUUID()); } catch {} window.location.replace("/login"); }
  }}>Esci / Cambia account</button></>;
}
