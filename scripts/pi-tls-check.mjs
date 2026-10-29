// Offline preflight; never opens a listening socket or contacts any provider.
import { loadPiTLS } from './pi-tls.mjs';
try {
  const result = await loadPiTLS(process.env.SPESESMART_PI_TLS_DIR, process.argv[2], process.env.SPESESMART_PI_TLS_CA_SHA256);
  console.log('TLS Raspberry verificato: CA/leaf separate, catena, SAN, usi, chiave e permessi.');
  console.log(`CA SHA-256: ${result.root.fingerprint256}`);
  console.log(`Leaf SHA-256: ${result.certificate.fingerprint256}`);
  console.log(`Scadenza leaf: ${result.expiresAt}`);
} catch { console.error('TLS Raspberry non valido. Nessun avvio o modifica eseguiti; controlla bundle privato, CA attesa, SAN, catena, usi, date e chiave.'); process.exitCode = 1; }
