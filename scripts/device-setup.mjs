import { piConfig } from './pi-config.mjs';
// Temporary certificate bootstrap. No Next backend, credentials, proxy or financial modules.
import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { open, realpath, access } from 'node:fs/promises';
import { createHash, X509Certificate } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectLAN } from './lan-gateway.mjs';

export const EXPECTED_CA = process.env.SPESESMART_PI_TLS_CA_SHA256;
const DEFAULT_CA = process.env.SPESESMART_PI_TLS_DIR ? join(process.env.SPESESMART_PI_TLS_DIR, 'ca.crt') : '';
export function verifyPublicCA(pem, expected) {
  if (typeof pem !== 'string' || Buffer.byteLength(pem) > 16384 || !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----\s*$/.test(pem)) throw Error('È ammesso soltanto un certificato CA pubblico PEM.');
  const cert = new X509Certificate(pem);
  if (cert.fingerprint256.replaceAll(':', '').toUpperCase() !== String(expected).replaceAll(':', '').toUpperCase() || !cert.ca || cert.subject !== cert.issuer || !cert.verify(cert.publicKey) || Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) <= Date.now()) throw Error('CA inattesa o non valida: servizio bloccato.');
  return { pem: cert.toString(), fingerprint: cert.fingerprint256 };
}
export async function readPublicCA(path, expected = EXPECTED_CA) {
  const canonical = resolve(path);
  if (await realpath(canonical) !== canonical || !canonical.endsWith('.crt')) throw Error('Percorso CA non canonico o non .crt.');
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16384 || stat.uid !== process.getuid() || (stat.mode & 0o022)) throw Error('File CA non regolare, troppo grande o modificabile da altri.');
    const buffer = Buffer.alloc(16385); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16384) throw Error('CA troppo grande.');
    return verifyPublicCA(buffer.subarray(0, bytesRead).toString('utf8'), expected);
  } finally { await file.close(); }
}
const numericIP = ip => ip.split('.').reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0);
export function sameSubnet(client, ip, netmask) {
  if (client?.startsWith('::ffff:')) client = client.slice(7);
  if ([client, ip, netmask].some(value => isIP(value ?? '') !== 4)) return false;
  const mask = numericIP(netmask), inverse = (~mask) >>> 0;
  if (!mask || (inverse & (inverse + 1)) !== 0) return false;
  return (numericIP(client) & mask) === (numericIP(ip) & mask);
}
const style = `*{box-sizing:border-box}body{margin:0;background:#f4f7f5;color:#20352e;font-family:system-ui,sans-serif;font-size:16px;line-height:1.6}main{max-width:760px;margin:auto;padding:24px 16px 48px}h1{font-size:clamp(1.8rem,5vw,2.5rem);line-height:1.2;margin:10px 0 16px}h2{font-size:1.2rem;line-height:1.35;margin:0 0 12px}p{margin:0 0 16px}.tag{color:#405f51;font-size:.9rem;font-weight:650}.card{background:white;border:1px solid #d6e2da;border-radius:16px;padding:20px;margin:20px 0}.warning{background:#fff7df;border-color:#e1c978;color:#493b12}.fingerprint{display:block;white-space:normal;overflow-wrap:anywhere;font-family:ui-monospace,monospace;font-size:.94rem;line-height:1.85;background:#edf3ef;padding:14px;border-radius:10px;margin:12px 0}.button{display:flex;align-items:center;justify-content:center;min-height:48px;padding:12px 18px;background:#245b46;color:white;border-radius:10px;font-weight:700;text-decoration:none;text-align:center}.secondary{background:#e8f0eb;color:#204b38}a{color:#245b46;overflow-wrap:anywhere}a:focus-visible,summary:focus-visible{outline:3px solid #a76c00;outline-offset:4px}ol{padding-left:24px;margin:0}li{padding-left:4px;margin:0 0 22px}li:last-child{margin-bottom:0}li strong{display:block;margin-bottom:5px}summary{cursor:pointer;min-height:44px;display:flex;align-items:center;font-weight:700}details p{margin:12px 0}small{color:#40584a}code{overflow-wrap:anywhere}footer{margin-top:24px}@media(min-width:768px){main{padding:40px 24px 64px}.card{padding:28px}.button{width:fit-content;min-width:240px}}`;
export function setupPage({ fingerprint, appOrigin }) {
  assertOrigin(appOrigin);
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Configura SpeseSmart</title><style>${style}</style></head><body><main>
<p class="tag">Rete domestica · Solo certificato pubblico</p><h1>Configura SpeseSmart</h1>
<p>SpeseSmart usa HTTPS con una CA privata per proteggere la connessione. Su un nuovo dispositivo devi aggiungere manualmente la fiducia alla sua autorità.</p>
<section class="card warning"><h2>Prima di installare</h2><p>Questa pagina usa HTTP e può essere alterata da chi controlla la rete. <strong>L’impronta mostrata qui non basta a provarne l’autenticità.</strong> Confronta il certificato scaricato con l’impronta ottenuta da una fonte separata e attendibile, come il terminale del PC proprietario.</p><p>Installare una CA significa concederle fiducia. Installa soltanto quella verificata e rimuovila se non serve più.</p></section>
<section class="card" aria-labelledby="passaggi"><h2 id="passaggi">Cinque passaggi sul telefono</h2><ol>
<li><strong>Scarica il certificato pubblico</strong><p>Il file contiene soltanto la CA pubblica, senza password o chiavi private.</p><a class="button" href="/spesesmart-ca.crt" download="spesesmart-home-root-ca-2026.crt">Scarica certificato .crt</a></li>
<li><strong>Verifica l’impronta SHA-256</strong><code class="fingerprint">${fingerprint}</code><p>Confrontala con il valore comunicato dal proprietario tramite un canale fidato, non solo con questa pagina HTTP. Se non puoi controllare il file sul telefono, usa un trasferimento USB verificato.</p></li>
<li><strong>Installa la CA nelle impostazioni Android</strong><p>Cerca Sicurezza → Crittografia e credenziali → Installa un certificato → <b>Certificato CA</b>. I nomi cambiano secondo il telefono. Non scegliere certificato Wi-Fi o identità VPN/app.</p><p><b>Android richiede la tua conferma manuale</b> e può chiedere il PIN. Questo sito non può installare la CA automaticamente. Usa lo stesso profilo Android dei browser.</p></li>
<li><strong>Riapri Chrome o Vivaldi</strong><p>Chiudi e riapri il browser dopo l’installazione. Se compare ancora un errore HTTPS, fermati e controlla CA, impronta e profilo: non ignorare gli avvisi.</p></li>
<li><strong>Apri SpeseSmart in HTTPS</strong><p>La configurazione della CA non sostituisce l’autenticazione dell’app.</p><a class="button secondary" href="${appOrigin}" rel="noreferrer">Apri SpeseSmart in HTTPS</a></li>
</ol></section>
<details class="card"><summary>Chrome e Brave su Ubuntu</summary><p>Apri il gestore certificati dalle impostazioni Sicurezza del browser. In Chrome puoi usare <code>chrome://certificate-manager</code>. Importa la CA pubblica fra le autorità locali attendibili per HTTPS, dopo il confronto dell’impronta.</p><p>Non importarla fra le identità personali: non serve alcuna chiave privata. Verifica Chrome e Brave separatamente; possono usare archivi o profili diversi. Il solo archivio Ubuntu non garantisce la fiducia nel browser.</p></details>
<details class="card"><summary>Rimuovere o sostituire la CA</summary><p>Quando non serve più, rimuovi soltanto questa CA dal gestore del browser o dalle autorità utente Android, verificandone l’impronta. Non cancellare tutte le credenziali.</p><p>Se la CA cambia, ottieni la nuova impronta dal proprietario tramite un canale fidato prima di installarla. Dopo la verifica della nuova connessione, rimuovi la vecchia fiducia.</p></details>
<footer><small>Questa pagina non offre login, spese, account o API. Il servizio di configurazione è temporaneo; il proprietario deve arrestarlo dopo l’uso.</small></footer></main></body></html>`;
}
function assertOrigin(origin) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || isIP(url.hostname) !== 4 || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('Destinazione HTTPS LAN non valida.');
}
export function createDeviceSetup({ ip, netmask, port, publicCA, expectedCA, appOrigin, now = Date.now }) {
  if (isIP(ip) !== 4 || !sameSubnet(ip, ip, netmask) || !Number.isInteger(port) || port < 1 || port > 65535) throw Error('Rete configurazione non valida.');
  const verified = verifyPublicCA(publicCA, expectedCA);
  const html = Buffer.from(setupPage({ fingerprint: verified.fingerprint, appOrigin }));
  const certificate = Buffer.from(verified.pem);
  if (html.length > 40000) throw Error('Pagina troppo grande.');
  const authority = `${ip}:${port}`, origin = `http://${authority}`;
  const csp = `default-src 'none'; style-src 'sha256-${createHash('sha256').update(style).digest('base64')}'; script-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;
  let draining = false, windowEnd = 0, count = 0;
  const clients = new Map();
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000, connectionsCheckingInterval: 1000 }, (request, response) => {
    const common = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': csp, 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', Connection: 'close' };
    const deny = (status, text, extra = {}) => { const body = Buffer.from(text+'\n'); response.writeHead(status, { ...common, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length, ...extra }); response.end(request.method === 'HEAD' ? undefined : body); };
    if (draining) return deny(503, 'Servizio in arresto.');
    if (!sameSubnet(request.socket.remoteAddress, ip, netmask)) return deny(403, 'Solo rete domestica locale.');
    const time = now();
    if (time >= windowEnd) { windowEnd = time+60000; count = 0; clients.clear(); }
    const client = request.socket.remoteAddress, previous = clients.get(client) ?? 0;
    if (++count > 120 || previous >= 30 || (!clients.has(client) && clients.size >= 256)) return deny(429, 'Troppe richieste. Riprova tra un minuto.', { 'Retry-After': '60' });
    clients.set(client, previous+1);
    if (request.headers.host !== authority) return deny(421, 'Host non consentito.');
    if (request.headers.authorization || request.headers.cookie) return deny(400, 'Non inviare credenziali a questo servizio.');
    if (request.headers.origin && request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site') return deny(403, 'Origine non consentita.');
    if (!['GET', 'HEAD'].includes(request.method)) return deny(405, 'Metodo non consentito.', { Allow: 'GET, HEAD' });
    if (request.headers['transfer-encoding'] || request.headers['content-length'] && request.headers['content-length'] !== '0') return deny(413, 'Corpo richiesta non consentito.');
    const path = request.url;
    if (path !== '/' && path !== '/spesesmart-ca.crt') return deny(404, 'Risorsa non disponibile.');
    const body = path === '/' ? html : certificate;
    const headers = path === '/' ? { 'Content-Type': 'text/html; charset=utf-8' } : { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="spesesmart-home-root-ca-2026.crt"' };
    response.writeHead(200, { ...common, ...headers, 'Content-Length': body.length });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  server.maxHeadersCount = 32; server.maxConnections = 32; server.maxRequestsPerSocket = 10; server.keepAliveTimeout = 1000;
  server.on('upgrade', (_request, socket) => socket.destroy()); server.on('connect', (_request, socket) => socket.destroy());
  server.on('checkContinue', (_request, response) => { response.writeHead(417, { Connection: 'close' }); response.end(); });
  server.on('checkExpectation', (_request, response) => { response.writeHead(417, { Connection: 'close' }); response.end(); });
  server.beginDrain = () => { draining = true; server.closeIdleConnections(); };
  return server;
}
async function main() {
  if (process.platform !== 'linux' || process.env.VERCEL) throw Error('Configurazione dispositivi solo su Ubuntu locale.');
  const routes = JSON.parse(execFileSync('ip', ['-j', '-4', 'route'], { encoding: 'utf8' }));
  const interfaces = networkInterfaces(); const { name, ip } = selectLAN(interfaces, routes, process.env.SPESESMART_LAN_INTERFACE);
  await access(`/sys/class/net/${name}/device`);
  const netmask = interfaces[name].find(address => address.address === ip)?.netmask;
  const config = process.env.SPESESMART_PI_CONFIG ? piConfig() : null;
  if (config && config.ip !== ip) throw Error('IP diverso dalla configurazione Pi.');
  const pin = config?.caSHA256 ?? EXPECTED_CA;
  const ca = await readPublicCA(process.env.SPESESMART_DEVICE_CA_FILE ?? (config ? join(config.tlsDirectory, 'ca.crt') : DEFAULT_CA), pin);
  const port = 39440;
  const server = createDeviceSetup({ ip, netmask, port, publicCA: ca.pem, expectedCA: pin, appOrigin: `https://${ip}:3443` });
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; server.beginDrain(); server.close(() => console.log('Configurazione dispositivi arrestata.')); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  server.once('error', () => { console.error('Avvio configurazione fallito: verifica porta e rete. Nessun fallback.'); process.exitCode = 1; });
  server.listen(port, ip, () => {
    console.log(`Configurazione temporanea: http://${ip}:${port} — solo CA pubblica, arresto automatico dopo 15 minuti.`);
    console.log(`Confrontare da canale fidato: ${ca.fingerprint}`);
  });
  const timer = setTimeout(stop, 15*60000); timer.unref(); server.once('close', () => clearTimeout(timer));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('Configurazione bloccata: CA, impronta o rete non valide. Nessun dato privato esposto.'); process.exitCode = 1; });
