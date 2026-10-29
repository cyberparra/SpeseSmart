<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

Read the relevant guides in `node_modules/next/dist/docs/` before writing Next.js
code. This version may have breaking API and convention changes.

<!-- END:nextjs-agent-rules -->

# SpeseSmart — contributi

Leggere README, implementazione e test pertinenti prima di modificare codice.
Interfaccia e documentazione in italiano; Node >=22. Progetto di sole spese:
non aggiungere gestione entrate, stipendi o saldi bancari.

- Riutilizzare `src/lib/categories.ts`; mantenere gli ID e la compatibilità storica.
- Conservare l'isolamento per account e assegnare UtenteID solo dal server.
- Non indebolire autenticazione, TLS, Host/Origin/CSRF, capability, proof runtime,
  limiti AI, writer unico, journal, checksum, fsync, controlli mount e recovery.
- Nessun segreto, account reale, immagine di ricevuta, backup, journal, ledger,
  certificato o configurazione personale nel repository. Solo fixture sintetiche.
- Nessuna chiamata provider reale, scrittura Sheets o modifica di dati personali
  per test/build. I test devono isolare anche HOME e policy host dei figli.
- Non ricreare registri mancanti di installazioni esistenti o azzerare consumi.
- Non esporre Next sulla rete o introdurre retry automatici per mutazioni/AI.
- Non attivare systemd, Tailscale, rete o produzione durante lo sviluppo.
- Scegliere test proporzionati al rischio: mirati per documentazione/UI; aggiungere
  TypeScript e regressioni pertinenti per logica, isolamento o sicurezza.
- Non modificare installazioni o repository esterni; nessun deploy implicito.

La configurazione Pi è locale e obbligatoria: seguire README §6 e generare
le unità systemd dai modelli, senza aggirare i controlli per superare i preflight.
Licenza PolyForm Noncommercial 1.0.0: progetto source-available, non open source
in senso OSI; uso commerciale non autorizzato dalla licenza. Conservare il testo
ufficiale inalterato in LICENSE, l’attribuzione © 2026 Adriano Parracciani
(Cyberparra) in NOTICE e il credito nel footer. Non alterare le licenze delle
dipendenze.
