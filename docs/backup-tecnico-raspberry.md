# Coordinatore backup Raspberry

Il coordinatore `scripts/pi-backup-coordinator.py` gestisce il daily tecnico:
controlli USB, stop ordinato, finestra di scrittura, verifica e ripartenza
condizionata. Non esporta periodicamente Google Sheets. Il timer facoltativo è
alle 03:15 Europe/Rome, con `Persistent=false`.

UUID, mount, label, utente, HOME e Node provengono dal file root-owned
`/etc/spesesmart/pi.json`; nessuna identità di un'installazione è fissata nel
codice. La produzione funziona anche senza coordinatore o timer installati.
Configurazione e requisiti amministrativi sono in
[systemd-raspberry.md](systemd-raspberry.md); verifiche e ripristino in
[backup.md](backup.md).
