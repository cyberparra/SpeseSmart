# Backup e ripristino

Questa è una guida del codice, non lo stato di un'installazione attiva.
Il bootstrap production e la configurazione locale sono descritti nel README §6.

Configurare privatamente `SPESESMART_BACKUP_ROOT`, `SPESESMART_BACKUP_MOUNT`
e `SPESESMART_BACKUP_UUID` con un supporto proprio. Il programma verifica mount
esatto, UUID e device; non formatta, monta o ripara dischi e non usa fallback.
I percorsi dei registri devono essere quelli della propria installazione.

Comandi, da eseguire consapevolmente dopo un arresto ordinato del writer:

```sh
npm run backup:init
npm run backup:daily
npm run backup:weekly
npm run backup:verify -- /percorso/privato/sets/UUID-COPIA
npm run backup:restore-test -- /percorso/privato/sets/UUID-COPIA /percorso/privato/nuova-prova
```

Su Pi usare il file esterno, ad esempio:

```sh
node --env-file=/srv/spesesmart/data/production.env --conditions=react-server --import tsx scripts/backup.mts init
node --env-file=/srv/spesesmart/data/production.env --conditions=react-server --import tsx scripts/backup.mts daily
```

Sostituire `init`/`daily` con gli altri sottocomandi elencati sopra e i relativi
argomenti. La destinazione deve essere montata ext4 rw con `nosuid,nodev,noexec`
e directory backup 0700 dell’utente dedicato. Prima del coordinatore ripristinare
il mount readonly con `nosuid,nodev,noexec,noload` seguendo la procedura di
chiusura del supporto; non rimuovere un disco ancora montato.

`init` è esclusivamente per destinazioni nuove. Daily conserva journal, marker,
ledger, cache strutturata e preferenze; weekly aggiunge una lettura di tutte le
schede Google. Manifest SHA-256, staging atomico e permessi privati sono obbligatori.
Nessuna foto o credenziale provider. Storico non conforme blocca l'esportazione.

Nel profilo multiutente configurare `SPESESMART_ACCOUNT_BACKUP_PUBLIC_KEY_FILE`
e `SPESESMART_ACCOUNT_BACKUP_PRIVATE_KEY_FILE`. Il registro account è cifrato;
le chiavi non vengono incluse nella copia. Il formato e i requisiti RSA sono
validati da `src/lib/account-backup.ts`. Conservare separatamente la chiave
di recupero e collaudare una copia isolata prima di affidarsi al backup.

Il restore-test richiede una directory nuova e un ledger aggiornato attendibile
quando previsto; non scrive Google Sheets, non promuove registri attivi e non
risolve pendenti. Conservare UUID, prenotazioni AI ignote e tombstone.

`backup:rotation` propone un piano; `backup:prune` applica soltanto un piano
verificato con conferma esplicita. Nessuna cancellazione automatica è necessaria
alla prima installazione. Gli esempi systemd non sono installati o abilitati.
Il coordinatore root usa `/etc/spesesmart/pi.json`; preparazione e generazione
dell’unità sono descritte in [systemd-raspberry.md](systemd-raspberry.md).
