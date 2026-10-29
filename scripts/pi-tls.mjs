// Dedicated direct-root PKI: no system trust lookup, no legacy self-signed leaf.
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, lstat, realpath, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { privateLANFile } from './lan-credentials.mjs';

export function caFingerprint(value) {
  const pin = String(value ?? '').replaceAll(':', '').toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(pin)) throw Error('Impronta SHA-256 CA attesa obbligatoria.');
  return pin;
}
const openssl = (args, input) => execFileSync('openssl', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });
const validAt = cert => Date.parse(cert.validFrom) <= Date.now() && Date.parse(cert.validTo) > Date.now();
function strongKey(key) {
  return key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength >= 3072;
}
export async function validatePiTLS({ key, cert, ca, ip, expectedCA }) {
  let snapshot;
  try {
    // Exactly one certificate in each file: root signs leaf directly, no extras.
    for (const text of [cert, ca]) if ((text.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length !== 1 || text.includes('PRIVATE KEY')) throw Error();
    const leaf = new X509Certificate(cert), root = new X509Certificate(ca);
    if (caFingerprint(root.fingerprint256) !== caFingerprint(expectedCA)) throw Error();
    if (leaf.ca || !root.ca || leaf.checkIP(ip) !== ip || !validAt(leaf) || !validAt(root)) throw Error();
    if (root.subject !== root.issuer || !root.verify(root.publicKey) || !leaf.checkIssued(root) || !leaf.verify(root.publicKey)) throw Error();
    if (leaf.publicKey.export({ type: 'spki', format: 'der' }).equals(root.publicKey.export({ type: 'spki', format: 'der' }))) throw Error();
    if (!strongKey(root.publicKey) || !strongKey(leaf.publicKey) || !leaf.checkPrivateKey(createPrivateKey(key))) throw Error();
    if (Date.parse(leaf.validTo) > Date.parse(root.validTo) || Date.parse(leaf.validTo) - Date.parse(leaf.validFrom) > 91 * 86400000) throw Error();
    if (leaf.keyUsage?.length !== 1 || leaf.keyUsage[0] !== '1.3.6.1.5.5.7.3.1') throw Error();
    const extensions = openssl(['x509', '-noout', '-ext', 'basicConstraints,keyUsage'], cert);
    const rootExtensions = openssl(['x509', '-noout', '-ext', 'basicConstraints,keyUsage'], ca);
    if (!/Basic Constraints: critical\s+CA:FALSE/.test(extensions) || !/Key Usage: critical\s+Digital Signature, Key Encipherment\s*$/.test(extensions)) throw Error();
    if (!/Basic Constraints: critical\s+CA:TRUE, pathlen:0/.test(rootExtensions) || !/Key Usage: critical\s+Certificate Sign, CRL Sign\s*$/.test(rootExtensions)) throw Error();
    // Verify immutable copies of the public bytes used by Node, never reopen originals.
    snapshot = await mkdtemp(join(tmpdir(), 'spesesmart-tls-verify-'));
    await writeFile(join(snapshot, 'ca.crt'), ca, { mode: 0o600 });
    await writeFile(join(snapshot, 'server.crt'), cert, { mode: 0o600 });
    openssl(['verify', '-no-CAfile', '-no-CApath', '-no-CAstore', '-trusted', join(snapshot, 'ca.crt'), '-check_ss_sig', '-x509_strict', '-auth_level', '2', '-purpose', 'sslserver', '-verify_ip', ip, join(snapshot, 'server.crt')]);
    return { key, cert, ca, certificate: leaf, root, expiresAt: leaf.validTo };
  } catch {
    throw Error('TLS Raspberry rifiutato: controllare CA attesa, catena, SAN, date, usi e corrispondenza della chiave. Nessun segreto mostrato.');
  } finally { if (snapshot) await rm(snapshot, { recursive: true, force: true }); }
}
export async function loadPiTLS(directory, ip, expectedCA) {
  if (!directory) throw Error('Configura SPESESMART_PI_TLS_DIR: nessun fallback al certificato CA/server storico.');
  const path = resolve(directory);
  if (await realpath(path) !== path) throw Error('Percorso TLS non canonico.');
  for (let parent = path; ; parent = dirname(parent)) {
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Directory TLS non valida.');
    if (parent === path) {
      if (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) throw Error('Directory TLS richiede proprietario corrente e permessi 0700.');
    } else if (![0, process.getuid()].includes(stat.uid)) throw Error('Directory antenata TLS di un altro utente.');
    else if ((stat.mode & 0o022) && !(stat.uid === 0 && (stat.mode & 0o1000))) throw Error('Directory antenata TLS modificabile da altri.');
    if (parent === dirname(parent)) break;
  }
  const files = await readdir(path);
  if (files.length !== 3 || !['ca.crt', 'server.crt', 'server.key'].every(name => files.includes(name))) throw Error('Directory TLS deve contenere soltanto ca.crt, server.crt, server.key; mai la chiave CA.');
  const ca = await privateLANFile(join(path, 'ca.crt'));
  const cert = await privateLANFile(join(path, 'server.crt'));
  const key = await privateLANFile(join(path, 'server.key'));
  return validatePiTLS({ ca, cert, key, ip, expectedCA });
}
