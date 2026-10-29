import { createServer } from 'node:https';
import { request as upstreamRequest } from 'node:http';
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { validateTailscaleHostname, duplicateIngressHeaders, TAILSCALE_INGRESS_HEADER } from './tailscale-ingress.mjs';
import { authenticateAccount, changeAccountPassword, readAccounts, publicAccount } from './accounts.mjs';

const digest = value => createHash('sha256').update(value).digest();
const privateIPv4 = ip => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
export function selectLAN(interfaces, routes, preferred) {
  const candidates = Object.entries(interfaces).flatMap(([name, addresses]) => (addresses ?? [])
    .filter(address => address.family === 'IPv4' && !address.internal && privateIPv4(address.address))
    .map(address => ({ name, ip: address.address })));
  const defaults = routes.filter(route => route.dst === 'default').sort((a, b) => (a.metric ?? 0) - (b.metric ?? 0));
  const selected = preferred ? candidates.filter(candidate => candidate.name === preferred)
    : candidates.filter(candidate => candidate.name === defaults[0]?.dev && (!defaults[0]?.prefsrc || candidate.ip === defaults[0].prefsrc));
  if (selected.length !== 1) throw Error('Interfaccia LAN ambigua o assente. Imposta SPESESMART_LAN_INTERFACE con il nome dell’interfaccia domestica.');
  return selected[0];
}

// Explicit allowlist, no trust in client forwarding headers, no public listener.
export function createLANGateway({ ip, port, upstreamPort, username, password, key, cert, operational = false, capability, now = Date.now, tailscale, accountsDirectory }) {
  if (accountsDirectory && !operational) throw Error('Gli account richiedono il gateway con capability operativa.');
  if (operational && !/^[a-f0-9]{64}$/.test(capability ?? '')) throw Error('Configurazione operativa LAN incompleta.');
  const authority = `${ip}:${port}`;
  const lanOrigin = `https://${authority}`;
  if (tailscale && (!operational || !/^[a-f0-9]{64}$/.test(tailscale.capability ?? '') || tailscale.capability === capability)) {
    throw Error('Ingresso Tailscale richiede una capability separata e il gateway operativo.');
  }
  const remoteHost = tailscale ? validateTailscaleHostname(tailscale.hostname) : null;
  const expected = digest(`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
  const securityHeaders = {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    'Permissions-Policy': `camera=${operational ? '(self)' : '()'}, microphone=(), geolocation=()`,
  };
  const sessions = new Map(), failures = new Map();
  let failureWindow = 0, failureCount = 0, mutationWindow = 0, mutationCount = 0, aiCount = 0, inFlight = false, draining = false, authenticating = false;
  const forwardedRequests = new Set();
  const sessionCookie = accountsDirectory ? '__Host-spesesmart-account' : '__Host-spesesmart-lan';
  const server = createServer({ key, cert, minVersion: 'TLSv1.2' }, async (request, response) => {
    const deny = (status, error, extra = {}) => {
      response.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', ...extra });
      response.end(JSON.stringify({ error }));
    };
    if (request.socket.encrypted !== true) return deny(400, 'HTTPS richiesto.');
    if (duplicateIngressHeaders(request)) return deny(400, 'Header di ingresso duplicati.');
    const ingress = request.headers[TAILSCALE_INGRESS_HEADER];
    const remote = remoteHost && request.headers.host === remoteHost && typeof ingress === 'string'
      && timingSafeEqual(digest(ingress), digest(tailscale.capability));
    if (!remote && (request.headers.host !== authority || ingress !== undefined)) return deny(421, 'Host non consentito.');
    const origin = remote ? `https://${remoteHost}` : lanOrigin;
    const time = now();
    for (const [id, entry] of failures) if (entry.until <= time) failures.delete(id);
    if (time >= failureWindow) { failureWindow = time + 60000; failureCount = 0; }
    const address = request.socket.remoteAddress;
    if (failureCount >= 100 || (failures.get(address)?.count ?? 0) >= 10) return deny(429, 'Troppi tentativi di accesso. Riprova tra un minuto.', { 'Retry-After': '60' });
    if (!accountsDirectory && !timingSafeEqual(expected, digest(request.headers.authorization ?? ''))) {
      failureCount++;
      if (failures.size < 256 || failures.has(address)) {
        const entry = failures.get(address) ?? { count: 0, until: time + 60000 };
        entry.count++; failures.set(address, entry);
      }
      return deny(401, 'Accesso personale richiesto.', { 'WWW-Authenticate': 'Basic realm="SpeseSmart LAN", charset="UTF-8"' });
    }
    if (draining) return deny(503, 'Server in arresto. La richiesta non è stata inoltrata; riprova dopo il riavvio.');
    const mutation = ['POST', 'PATCH', 'DELETE'].includes(request.method);
    if (!['GET', 'HEAD'].includes(request.method) && !(operational && mutation)) return deny(403, 'Operazione LAN non consentita.');
    if (request.headers.origin && request.headers.origin !== origin) return deny(403, 'Origine non consentita.');
    let url;
    try {
      if (!request.url?.startsWith('/') || request.url.startsWith('//') || request.url.includes('\\')) throw Error();
      url = new URL(request.url, origin);
    } catch { return deny(400, 'Percorso non valido.'); }
    // Fetch-Site describes the initiating page, not the destination. A link from
    // another site may open our authenticated home page in the top-level tab.
    // Never extend this exception to APIs, assets, frames, fetch(), or mutations.
    const homeNavigation = request.method === 'GET' && url.pathname === '/'
      && request.headers['sec-fetch-mode'] === 'navigate'
      && request.headers['sec-fetch-dest'] === 'document';
    if (request.headers['sec-fetch-site'] === 'cross-site' && !homeNavigation) return deny(403, 'Richiesta esterna non consentita.');
    for (const [id, session] of sessions) if (session.expires <= time) sessions.delete(id);
    const cookie = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${sessionCookie}=`))?.slice(sessionCookie.length + 1);
    let session = sessions.get(cookie);
    let accountIdentity;
    const passwordMutation = accountsDirectory && request.method === 'POST' && url.pathname === '/api/auth/password' && !url.search;
    if (session?.origin !== origin) session = undefined;
    if (accountsDirectory) {
      // Re-read on EVERY request: disable/password reset revokes existing sessions.
      try {
        const registry = await readAccounts(accountsDirectory);
        const account = registry.accounts.find(a => a.id === session?.userId);
        if (!account?.active || account.revision !== session?.revision) {
          if (cookie) sessions.delete(cookie);
          session = undefined;
        }
        if (request.method === 'GET' && !url.search && (url.pathname === '/login' || (url.pathname === '/' && !session))) {
          response.writeHead(200, { ...securityHeaders, 'Content-Type': 'text/html; charset=utf-8' });
          return response.end(accountPage);
        }
        if (request.method === 'POST' && url.pathname === '/api/auth/login' && !url.search) {
          if (request.headers.origin !== origin || request.headers['sec-fetch-site'] !== 'same-origin') return deny(403, 'Origine login non consentita.');
          if (!/^application\/json(?:;|$)/.test(request.headers['content-type'] ?? '')) return deny(415, 'Formato login non consentito.');
          if (authenticating || sessions.size >= 64) return deny(429, 'Troppi accessi in corso. Riprova più tardi.');
          if (Number(request.headers['content-length']) > 4096) return deny(413, 'Login troppo grande.');
          authenticating = true;
          try {
            const parts = []; let length = 0;
            for await (const chunk of request) {
              length += chunk.length;
              if (length > 4096) return deny(413, 'Login troppo grande.');
              parts.push(chunk);
            }
            let input;
            try { input = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { return deny(400, 'Login non valido.'); }
            if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'password,username'
              || typeof input.username !== 'string' || typeof input.password !== 'string') return deny(400, 'Login non valido.');
            const authenticated = await authenticateAccount(accountsDirectory, input.username, input.password);
            if (!authenticated) {
              failureCount++;
              if (failures.size < 256 || failures.has(address)) {
                const entry = failures.get(address) ?? { count: 0, until: time + 60000 };
                entry.count++; failures.set(address, entry);
              }
              return deny(401, 'Credenziali non valide.');
            }
            if (draining) return deny(503, 'Server in arresto.');
            if (cookie) sessions.delete(cookie);
            const id = randomBytes(32).toString('hex');
            const csrf = randomBytes(32).toString('hex');
            sessions.set(id, { userId: authenticated.id, revision: authenticated.revision, csrf, origin, expires: now() + 30 * 60000 });
            response.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8',
              'Set-Cookie': `${sessionCookie}=${id}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=1800` });
            return response.end(JSON.stringify({ user: publicAccount(authenticated), csrf }));
          } finally { authenticating = false; }
        }
        if (!session) return deny(401, 'Accesso account richiesto.');
        if (request.method === 'GET' && ['/api/auth/session', '/api/lan/session'].includes(url.pathname) && !url.search) {
          if (request.headers['sec-fetch-site'] !== 'same-origin') return deny(403, 'Sessione richiedibile soltanto dalla pagina autenticata.');
          response.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' });
          return response.end(JSON.stringify({ user: publicAccount(account), csrf: session.csrf }));
        }
        if (request.method === 'POST' && url.pathname === '/api/auth/logout' && !url.search) {
          if (request.headers.origin !== origin || request.headers['sec-fetch-site'] !== 'same-origin'
            || !timingSafeEqual(digest(session.csrf), digest(request.headers['x-spesesmart-csrf'] ?? ''))) return deny(403, 'Sessione o protezione CSRF non valida.');
          sessions.delete(cookie);
          response.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8',
            'Set-Cookie': `${sessionCookie}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` });
          return response.end(JSON.stringify({ loggedOut: true }));
        }
        const appPage = request.method === 'GET' && ((url.pathname === '/' && !url.search) || url.pathname === '/favicon.ico' || (url.pathname.startsWith('/_next/static/') && !url.pathname.endsWith('.map')));
        const personalServices = ((request.method === 'GET' && ['/api/auth/me', '/api/ai/usage', '/api/categories'].includes(url.pathname) && !url.search)
          || (url.pathname === '/api/preferences' && ((request.method === 'GET' && /^\?month=20[0-9]{2}-(0[1-9]|1[0-2])$/.test(url.search)) || (request.method === 'PATCH' && !url.search)))
          || (request.method === 'POST' && ['/api/receipts/analyze', '/api/categories', '/api/auth/password'].includes(url.pathname) && !url.search));
        if (request.method === 'POST' && url.pathname === '/api/categories' && account.role !== 'admin') return deny(403, 'Gestione categorie riservata all’amministratore.');
        const personalArchive = url.pathname === '/api/archive'
          && ((request.method === 'GET' && url.search === '?view=dashboard') || (mutation && !url.search));
        if (appPage || personalServices || personalArchive) {
          if (!appPage && request.method === 'GET' && request.headers['x-spesesmart-csrf'] !== session.csrf) return deny(401, 'Sessione della pagina non valida. Accedi nuovamente.');
          accountIdentity = { id: account.id, revision: account.revision };
        } else return deny(403, 'Risorsa non disponibile nel profilo multiutente.');
      } catch { return deny(503, 'Registro account non disponibile. Accesso bloccato.'); }
    }
    if (operational && url.pathname === '/api/lan/session' && !url.search && request.method === 'GET') {
      if (request.headers['sec-fetch-site'] !== 'same-origin') return deny(403, 'Sessione richiedibile soltanto dalla pagina autenticata.');
      let setCookie = {};
      if (!session) {
        if (sessions.size >= 64) return deny(429, 'Troppe sessioni LAN attive. Riprova più tardi.');
        const id = randomBytes(32).toString('hex');
        session = { csrf: randomBytes(32).toString('hex'), expires: time + 30 * 60000, origin };
        sessions.set(id, session);
        setCookie = { 'Set-Cookie': `${sessionCookie}=${id}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=1800` };
      }
      response.writeHead(200, { ...securityHeaders, ...setCookie, 'Content-Type': 'application/json; charset=utf-8' });
      return response.end(JSON.stringify({ csrf: session.csrf }));
    }
    const allowedRead = !mutation && (url.pathname === '/' || url.pathname === '/favicon.ico'
      || (url.pathname.startsWith('/_next/static/') && !url.pathname.endsWith('.map'))
      || (url.pathname === '/api/archive' && url.search === '?view=dashboard')
      || (url.pathname === '/api/ai/usage' && !url.search));
    const archiveMutation = mutation && url.pathname === '/api/archive' && !url.search;
    const aiMutation = request.method === 'POST' && url.pathname === '/api/receipts/analyze' && !url.search;
    const allowed = allowedRead || (accountsDirectory && accountIdentity)
      || (operational && (archiveMutation || aiMutation));
    if (!allowed || url.origin !== origin) return deny(403, 'Risorsa non disponibile in questa fase LAN.');
    let body;
    if (mutation) {
      if (request.headers.origin !== origin || request.headers['sec-fetch-site'] !== 'same-origin'
        || !session || !timingSafeEqual(digest(session.csrf), digest(request.headers['x-spesesmart-csrf'] ?? ''))) return deny(403, 'Sessione o protezione CSRF non valida. Riapri la pagina autenticata.');
      const type = request.headers['content-type'] ?? '';
      if (!(aiMutation ? type.startsWith('multipart/form-data;') : /^application\/json(?:;|$)/.test(type))) return deny(415, 'Formato della richiesta non consentito.');
      if (inFlight) return deny(409, 'Un’operazione è già in corso. Non creare un nuovo tentativo.');
      if (passwordMutation && authenticating) return deny(429, 'Un accesso è già in corso. Riprova più tardi.');
      if (time >= mutationWindow) { mutationWindow = time + 60000; mutationCount = 0; aiCount = 0; }
      if (mutationCount >= 30 || (aiMutation && aiCount >= 6)) return deny(429, 'Troppe operazioni. Riprova tra un minuto senza cambiare tentativo.', { 'Retry-After': '60' });
      const limit = ['/api/preferences', '/api/categories', '/api/auth/password'].includes(url.pathname) ? 4096 : aiMutation ? 10 * 1024 * 1024 + 65536 : 20 * 1024 * 1024;
      if (Number(request.headers['content-length']) > limit) return deny(413, 'Richiesta troppo grande.');
      inFlight = true; mutationCount++; if (aiMutation) aiCount++;
      if (passwordMutation) authenticating = true;
      const chunks = []; let length = 0;
      try {
        for await (const chunk of request) {
          length += chunk.length;
          if (length > limit) { inFlight = false; if (passwordMutation) authenticating = false; return deny(413, 'Richiesta troppo grande.'); }
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks);
      } catch { inFlight = false; if (passwordMutation) authenticating = false; return deny(400, 'Caricamento interrotto: nessuna richiesta inoltrata.'); }
    }
    // Credentials stay in the gateway: never forward passwords to Next or Sheets.
    if (passwordMutation) {
      const fail = (status, code, error) => {
        response.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ code, error }));
      };
      try {
        let input;
        try { input = JSON.parse(body.toString('utf8')); } catch { return fail(400, 'INVALID', 'Richiesta di cambio password non valida.'); }
        if (!input || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'confirmPassword,currentPassword,newPassword'
          || ['currentPassword', 'newPassword', 'confirmPassword'].some(key => typeof input[key] !== 'string')) {
          return fail(400, 'INVALID', 'Richiesta di cambio password non valida.');
        }
        if (input.newPassword !== input.confirmPassword) return fail(422, 'PASSWORD_CONFIRMATION', 'La conferma non corrisponde alla nuova password.');
        const updated = await changeAccountPassword(accountsDirectory, accountIdentity.id, accountIdentity.revision, input.currentPassword, input.newPassword);
        for (const [id, other] of sessions) if (other.userId === updated.id && id !== cookie) sessions.delete(id);
        // Never revive a session explicitly logged out or expired during scrypt.
        if (sessions.get(cookie) !== session || session.expires <= now()) {
          sessions.delete(cookie);
          return fail(401, 'SESSION_ENDED', 'Password modificata. Accedi nuovamente con la nuova password.');
        }
        const id = randomBytes(32).toString('hex');
        sessions.delete(cookie);
        // Keep this document's CSRF binding and remaining lifetime; rotate its cookie.
        sessions.set(id, { ...session, revision: updated.revision });
        response.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': `${sessionCookie}=${id}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.floor((session.expires - now()) / 1000)}` });
        return response.end(JSON.stringify({ changed: true }));
      } catch (error) {
        if (error?.code === 'CURRENT_PASSWORD') {
          failureCount++;
          if (failures.size < 256 || failures.has(address)) {
            const entry = failures.get(address) ?? { count: 0, until: time + 60000 };
            entry.count++; failures.set(address, entry);
          }
          return fail(403, 'CURRENT_PASSWORD', 'La password attuale non è corretta.');
        }
        if (error?.code === 'PASSWORD_POLICY') return fail(422, 'PASSWORD_POLICY', 'La nuova password deve contenere da 8 a 256 caratteri, su una sola riga.');
        if (error?.code === 'ACCOUNT_CHANGED') { sessions.delete(cookie); return fail(401, 'SESSION_ENDED', 'Sessione terminata. Accedi nuovamente.'); }
        return fail(503, 'PASSWORD_UNAVAILABLE', 'Cambio password non completato. Verifica l’accesso prima di riprovare.');
      } finally { inFlight = false; authenticating = false; }
    }
    // Headers forwarded by allowlist: client forwarding headers and cookies cannot influence Next.
    const headers = { host: `127.0.0.1:${upstreamPort}` };
    if (!operational) headers.authorization = request.headers.authorization;
    if (operational) headers['x-spesesmart-lan-capability'] = capability;
    if (accountIdentity) {
      headers['x-spesesmart-user-id'] = accountIdentity.id;
      headers['x-spesesmart-account-revision'] = accountIdentity.revision;
    }
    if (mutation) {
      // The external Host/Origin pair and its own session were verified above.
      // Next keeps the existing canonical LAN runtime/proof, never a new writer.
      headers.origin = lanOrigin; headers['sec-fetch-site'] = 'same-origin';
      headers['content-type'] = request.headers['content-type']; headers['content-length'] = body.length;
    }
    for (const name of ['accept', 'accept-language', 'rsc', 'next-router-state-tree', 'next-router-prefetch', 'next-url']) {
      if (request.headers[name]) headers[name] = request.headers[name];
    }
    let released = false;
    const release = () => { if (released) return; released = true; forwardedRequests.delete(upstream); if (mutation) inFlight = false; };
    const upstream = upstreamRequest({ hostname: '127.0.0.1', port: upstreamPort, path: url.pathname + url.search, method: request.method, headers, timeout: operational ? 240000 : 30000 }, incoming => {
      const forwarded = {};
      for (const name of ['content-type', 'content-encoding', 'content-length', 'vary']) if (incoming.headers[name]) forwarded[name] = incoming.headers[name];
      response.writeHead(incoming.statusCode ?? 502, { ...forwarded, ...securityHeaders });
      incoming.on('end', release);
      incoming.on('error', () => { release(); response.destroy(); });
      incoming.pipe(response);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => { release(); if (!response.headersSent) deny(502, 'Esito non verificabile. Rileggi i dati e riprendi lo stesso tentativo; nessun nuovo invio automatico.'); else response.destroy(); });
    forwardedRequests.add(upstream);
    // After forwarding, let the Ubuntu server finish and journal/cache the result
    // even if Wi-Fi disappears. Never replay an uncertain operation in the proxy.
    upstream.end(body);
  });
  server.requestTimeout = operational ? 240000 : 35000;
  server.headersTimeout = 10000;
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.beginDrain = () => { draining = true; server.closeIdleConnections(); };
  server.waitForDrain = async (timeout = 240000) => {
    const deadline = Date.now() + timeout;
    while (inFlight || forwardedRequests.size) {
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return true;
  };
  return server;
}

const accountPage = `<!doctype html><html lang="it"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SpeseSmart · Accesso account</title><style>body{font:16px system-ui;margin:24px auto;padding:0 16px;max-width:480px}input,button{box-sizing:border-box;font:inherit;min-height:44px;width:100%;margin:8px 0}label{display:block}button{cursor:pointer}.password-field{display:flex;align-items:center;gap:8px;margin:8px 0}.password-field input{flex:1;min-width:0;margin:0}.password-toggle{display:grid;place-items:center;flex:0 0 44px;width:44px;margin:0}</style>
<h1>SpeseSmart</h1><p>Accedi al tuo spazio personale.</p>
<form id="login" method="post" action="/api/auth/login"><label>Nome utente<input name="username" autocomplete="username" required maxlength="64" autocapitalize="none"></label>
<label for="login-password">Password<span class="password-field"><input id="login-password" name="password" type="password" autocomplete="current-password" autocapitalize="none" spellcheck="false" required maxlength="512"><button type="button" class="password-toggle" aria-label="Mostra password" aria-controls="login-password" aria-pressed="false"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0" /></svg></button></span></label><button type="submit">Accedi</button></form>
<p id="status" role="status" aria-live="polite">Inserisci le credenziali personali.</p>
<script>
const form=document.getElementById('login'),status=document.getElementById('status'),submit=form.querySelector('button[type="submit"]'),toggle=form.querySelector('.password-toggle'),password=form.elements.password;
function visibility(visible){password.type=visible?'text':'password';toggle.setAttribute('aria-pressed',String(visible));toggle.setAttribute('aria-label',visible?'Nascondi password':'Mostra password');toggle.querySelector('path').setAttribute('d',visible?'m3 3 18 18 M10 5a12 12 0 0 1 2 0c7 0 10 7 10 7a18 18 0 0 1-3 4 M6 6a21 21 0 0 0-4 6s3 7 10 7a13 13 0 0 0 6-2 M10 10a3 3 0 0 0 4 4':'M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0');}
toggle.addEventListener('click',()=>visibility(password.type==='password'));
form.addEventListener('submit',async event=>{event.preventDefault();if(submit.disabled)return;submit.disabled=true;try{const response=await fetch('/api/auth/login',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:form.elements.username.value,password:password.value})});const data=await response.json();if(!response.ok)throw Error(data.error||'Accesso non disponibile.');form.reset();visibility(false);try{localStorage.setItem('spesesmart:auth-event',crypto.randomUUID());}catch{}location.replace('/');}catch(error){password.value='';visibility(false);status.textContent=error.message;}finally{submit.disabled=false;}});
</script></html>`;
