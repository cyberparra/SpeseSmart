import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { checkServerIdentity } from 'node:tls';
import { isIP } from 'node:net';
import { caFingerprint } from './pi-tls.mjs';

export const TAILSCALE_ADAPTER_PORT = 3445;
export const TAILSCALE_INGRESS_HEADER = 'x-spesesmart-tailscale-ingress';

// A single explicitly configured FQDN, never a suffix/wildcard allowlist.
export function validateTailscaleHostname(hostname) {
  const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  if (typeof hostname !== 'string' || !new RegExp(`^${label}\\.${label}\\.ts\\.net$`).test(hostname)) {
    throw Error('Hostname Tailscale esatto richiesto, senza schema, porta o wildcard.');
  }
  return hostname;
}

export function configuredTailscaleHostname(env, piProduction) {
  if (env.SPESESMART_PI_TAILSCALE_HOSTNAME === undefined) return undefined;
  if (!piProduction || env.VERCEL) throw Error('Ingresso Tailscale disponibile soltanto nel launcher production Pi.');
  return validateTailscaleHostname(env.SPESESMART_PI_TAILSCALE_HOSTNAME);
}

export function duplicateIngressHeaders(request) {
  const names = new Set();
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i].toLowerCase();
    if (!['host', 'origin', TAILSCALE_INGRESS_HEADER].includes(name)) continue;
    if (names.has(name)) return true;
    names.add(name);
  }
  return false;
}

// Passive factory: no bind, credentials, financial runtime, Serve or Tailscale mutation.
// The production launcher binds this HTTP hop only to 127.0.0.1, behind Serve TLS.
export function createTailscaleAdapter({ hostname, ip, port, ca, expectedCA, capability }) {
  validateTailscaleHostname(hostname);
  if (!/^[a-f0-9]{64}$/.test(capability ?? '') || !Number.isInteger(port) || port < 1024 || port > 65535
    || isIP(ip) !== 4 || !/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) {
    throw Error('Destinazione TLS o capability dell’adattatore non valida.');
  }
  const caText = Buffer.isBuffer(ca) ? ca.toString('utf8') : ca;
  if (typeof caText !== 'string' || (caText.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length !== 1
    || caText.includes('PRIVATE KEY')) throw Error('Richiesta la sola CA pubblica autorizzata.');
  const root = new X509Certificate(caText);
  if (!root.ca || caFingerprint(root.fingerprint256) !== caFingerprint(expectedCA)
    || Date.parse(root.validFrom) > Date.now() || Date.parse(root.validTo) <= Date.now()
    || root.subject !== root.issuer || !root.verify(root.publicKey)) throw Error('CA dell’adattatore diversa da quella autorizzata.');
  const origin = `https://${hostname}`, pending = new Set();
  let draining = false;
  const server = createServer({ maxHeaderSize: 16384 }, (request, response) => {
    const deny = (status, message) => {
      response.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
      response.end(JSON.stringify({ error: message }));
    };
    if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) return deny(403, 'Ingresso consentito solo dal proxy locale.');
    if (duplicateIngressHeaders(request)) return deny(400, 'Header di ingresso duplicati.');
    if (request.headers.host !== hostname) return deny(421, 'Host non consentito.');
    if (request.headers.origin && request.headers.origin !== origin) return deny(403, 'Origine non consentita.');
    if (draining) return deny(503, 'Ingresso in arresto. Nessuna richiesta inoltrata.');
    if (!['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'].includes(request.method)) return deny(403, 'Metodo non consentito.');
    if (!request.url?.startsWith('/') || request.url.startsWith('//') || request.url.includes('\\')) return deny(400, 'Percorso non valido.');
    // Preserve the exact browser authority/Origin for gateway validation. Ignore all
    // forwarded/identity/capability headers supplied by clients or intermediaries.
    const headers = { host: hostname, [TAILSCALE_INGRESS_HEADER]: capability };
    for (const name of ['authorization', 'origin', 'cookie', 'x-spesesmart-csrf', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest',
      'content-type', 'content-length', 'accept', 'accept-language', 'rsc', 'next-router-state-tree', 'next-router-prefetch', 'next-url']) {
      if (request.headers[name] !== undefined) headers[name] = request.headers[name];
    }
    let released = false;
    const release = () => { if (!released) { released = true; pending.delete(upstream); } };
    const upstream = httpsRequest({ hostname: ip, port, path: request.url, method: request.method, headers,
      ca, rejectUnauthorized: true, minVersion: 'TLSv1.2', agent: false, servername: '',
      checkServerIdentity: (_name, certificate) => checkServerIdentity(ip, certificate), timeout: 240000,
    }, incoming => {
      const forwarded = {};
      for (const name of ['content-type', 'content-encoding', 'content-length', 'vary', 'cache-control', 'x-content-type-options',
        'referrer-policy', 'x-frame-options', 'permissions-policy', 'www-authenticate', 'set-cookie', 'retry-after']) {
        if (incoming.headers[name] !== undefined) forwarded[name] = incoming.headers[name];
      }
      if (!response.destroyed) { response.writeHead(incoming.statusCode ?? 502, forwarded); incoming.pipe(response); }
      else incoming.resume();
      // A lost phone connection never cancels or replays an operation already sent.
      response.on('close', () => { if (!incoming.complete) incoming.resume(); });
      incoming.on('end', release);
      incoming.on('error', () => { release(); response.destroy(); });
    });
    pending.add(upstream);
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => {
      release();
      if (!response.destroyed && !response.headersSent) deny(502, 'Collegamento verificato al gateway non disponibile. Nessun reinvio automatico.');
      else response.destroy();
    });
    // Incomplete uploads cannot reach the financial backend as complete requests.
    request.on('error', () => { if (!request.complete) upstream.destroy(); });
    request.pipe(upstream);
  });
  server.requestTimeout = 240000;
  server.headersTimeout = 10000;
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.on('connect', (_request, socket) => socket.destroy());
  server.beginDrain = () => { draining = true; server.closeIdleConnections(); };
  server.waitForDrain = async (timeout = 240000) => {
    const end = Date.now() + timeout;
    while (pending.size) {
      if (Date.now() >= end) return false;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return true;
  };
  return server;
}
