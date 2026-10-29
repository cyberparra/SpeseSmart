"use client";
import { useState } from "react";
import { useAccount } from "./account-session";
import { categoryDefinitions, applyCategoryExtensions } from "@/lib/categories";
import { sessionFetch } from "@/lib/session-fetch";
import { operationalHeaders } from "@/lib/operational-headers";
export function CategorySettings() {
  const account = useAccount();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return <section className="panel"><h2>Categorie condivise</h2><p>{categoryDefinitions.filter(c => c.kind === "expense").map(c => c.name).join(" · ")}</p>
    {account?.role === "admin" && <form onSubmit={async event => {
      event.preventDefault(); if (busy) return;
      const form = event.currentTarget, values = new FormData(form); setBusy(true); setMessage("");
      try {
        const read = await sessionFetch("/api/categories", { cache: "no-store" });
        if (!read.ok) throw Error("Catalogo non disponibile.");
        const catalog = await read.json();
        const response = await sessionFetch("/api/categories", { method: "POST", headers: await operationalHeaders(true, true), body: JSON.stringify({ name: values.get("name"), description: values.get("description"), expectedVersion: catalog.revision }) });
        const body = await response.json(); if (!response.ok) throw Error(body.error || "Categoria non aggiunta.");
        applyCategoryExtensions(body.extensions, body.revision); form.reset(); setMessage("Categoria aggiunta al catalogo condiviso.");
      } catch (error) { setMessage(error instanceof Error ? error.message : "Categoria non aggiunta."); }
      finally { setBusy(false); }
    }}><label>Nuova categoria<input name="name" required maxLength={60} /></label><label>Indicazioni per la classificazione<input name="description" required maxLength={300} /></label><button className="secondary" disabled={busy}>Aggiungi categoria</button><p>Le categorie esistenti conservano nome e identificativo.</p></form>}
    {message && <p role="alert">{message}</p>}
  </section>;
}
