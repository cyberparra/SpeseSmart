# Servizi systemd

Il percorso eseguibile di prima installazione è nel README §6. La configurazione
locale è `/etc/spesesmart/pi.json`, root:root 0644, con antenati non modificabili
da altri utenti. `SPESESMART_PI_CONFIG` seleziona il file per i comandi Node;
il servizio generato conserva il percorso assoluto. Non contiene segreti.

`npm run --silent pi:install -- service` genera l'unità production da
`spesesmart-pi.service.example`: utente, HOME, Node, mount e directory provengono
dalla configurazione. Il launcher parte direttamente con Node 24, esegue il
preflight offline e conserva lock, proof, loopback, TLS e drain. Nessun comando
npm installa o attiva unità. Non modificare le protezioni per superare il preflight.
L'esempio `spesesmart-home.service.example` riguarda il profilo legacy.

Il backup pianificato è facoltativo e separato. Prima aggiungere a `pi.json`:

```json
{
  "backupMount": "/mnt/backup-spese",
  "backupUUID": "UUID_REALE_DEL_PROPRIO_DISCO_BACKUP",
  "backupLabel": "SPESESMART_BKP"
}
```

Sono campi aggiuntivi, non un file sostitutivo. `production.env` deve contenere
`SPESESMART_BACKUP_MOUNT`, `SPESESMART_BACKUP_ROOT` (mount + `/spesesmart`) e
`SPESESMART_BACKUP_UUID` corrispondenti. Il disco è ext4 separato dall'SSD.
Preparare il repository backup con i comandi di [backup.md](backup.md), a writer
fermo, e verificarne un daily e il ripristino prima di qualsiasi timer.

Il coordinatore privilegiato legge **solo** `/etc/spesesmart/pi.json` root-owned;
non accetta override da ambiente o argomenti. Verifica UUID, label, mount e
namespace host prima dello stop. Il codice installato deve essere root-owned in
`/usr/local/libexec/spesesmart/pi-backup-coordinator.py`, con antenati protetti.
Le operazioni su dati e configurazioni eseguono il worker con l'utente dedicato.
Non avviare il sorgente con sudo. Il comando
`npm run --silent pi:install -- backup-service` genera anche l'unità backup
con mount/app configurati; richiede il file `/etc/spesesmart/pi.json` e i campi
backup. Installare l'output dopo ispezione, insieme al timer d'esempio.

Solo dopo verifica amministrativa del supporto readonly e del codice installato,
eseguire il primo collaudo esplicito del coordinatore con `--first-trial`, che
richiede il ripristino isolato. Installare/abilitare il timer d'esempio soltanto
se tale prova riesce. Il coordinatore non effettua letture Sheets o chiamate AI.
Nessuna dipendenza del servizio production dalla VPN o dal disco backup.
