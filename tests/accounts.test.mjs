import './helpers/isolated-host-policy.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, chmod, writeFile, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { initializeAccounts, administerAccount, changeAccountPassword, readAccounts, authenticateAccount, accountDirectory } from '../scripts/accounts.mjs';
import { createLANGateway } from '../scripts/lan-gateway.mjs';
import { authenticatedAccount } from '../src/lib/lan-mode.ts';
import { GET as me } from '../src/app/api/auth/me/route.ts';
import { GET, POST, PATCH, DELETE } from '../src/app/api/archive/route.ts';
import { aiAccess } from '../src/lib/ai-access.ts';
import { googleSheetsWritesEnabled } from '../src/lib/google-sheets.ts';
import { NextRequest } from 'next/server';
import { proxy } from '../src/proxy.ts';
import { createUpdateStore } from '../src/lib/sheets-update-store.ts';
import { initializeAI, aiConfiguration } from '../src/lib/ai-usage.ts';
import { homeRuntimeDirectory, writeHomeProof } from '../scripts/home-runtime.mjs';

const password = 'prova123', replacement = 'nuova456';
const origin = 'https://192.168.250.115:3443', capability = 'c'.repeat(64);

test('account: registro privato, hash salati, unicità, reset, disabilitazione e inizializzazione esplicita', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spesesmart-accounts-store-')), directory = join(root, 'accounts');
  try {
    await initializeAccounts(directory);
    await administerAccount(directory, 'create', 'a', { password });
    await administerAccount(directory, 'create', 'b', { password });
    const first = await readAccounts(directory);
    assert.notEqual(first.accounts[0].credential.salt, first.accounts[1].credential.salt);
    assert.notEqual(first.accounts[0].credential.hash, first.accounts[1].credential.hash);
    assert.equal(first.accounts[0].credential.N, 131072);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, 'accounts.json'))).mode & 0o777, 0o600);
    assert.equal((await readFile(join(directory, 'accounts.json'), 'utf8')).includes(password), false);
    assert.equal((await authenticateAccount(directory, 'a', password)).id, first.accounts[0].id);
    assert.equal(await authenticateAccount(directory, 'a', replacement), null);
    assert.equal(await authenticateAccount(directory, 'unknown', password), null);
    await assert.rejects(administerAccount(directory, 'create', 'a', { password }));
    await assert.rejects(administerAccount(directory, 'create', 'short', { password: 'short' }));
    for (const invalid of ['1234567', '😀'.repeat(7), 'a'.repeat(257), '1234567\n', '1234567\r']) {
      await assert.rejects(administerAccount(directory, 'password', 'b', { password: invalid }));
    }
    assert.equal(await authenticateAccount(directory, 'b', '1234567'), null);
    assert.ok(await authenticateAccount(directory, 'b', password));
    await assert.rejects(initializeAccounts(directory));
    await administerAccount(directory, 'password', 'a', { password: replacement });
    assert.equal(await authenticateAccount(directory, 'a', password), null);
    assert.notEqual((await readAccounts(directory)).accounts[0].revision, first.accounts[0].revision);
    assert.equal((await authenticateAccount(directory, 'a', replacement)).id, first.accounts[0].id);
    await administerAccount(directory, 'disable', 'a');
    assert.equal(await authenticateAccount(directory, 'a', replacement), null);
    assert.ok(await authenticateAccount(directory, 'b', password));
    await chmod(join(directory, 'accounts.json'), 0o644);
    await assert.rejects(readAccounts(directory));
    await chmod(join(directory, 'accounts.json'), 0o600);
    const original = await readFile(join(directory, 'accounts.json'));
    await rm(join(directory, 'accounts.json'));
    await assert.rejects(administerAccount(directory, 'create', 'c', { password }));
    await writeFile(join(root, 'target'), original, { mode: 0o600 });
    await symlink(join(root, 'target'), join(directory, 'accounts.json'));
    await assert.rejects(readAccounts(directory));
    assert.throws(() => accountDirectory({ SPESESMART_ACCOUNT_DIR: join(process.cwd(), 'accounts') }));
    const command = spawnSync(process.execPath, ['scripts/accounts.mjs', 'create', 'c', password], { env: { PATH: process.env.PATH, SPESESMART_ACCOUNT_DIR: directory }, encoding: 'utf8' });
    assert.notEqual(command.status, 0); assert.equal(command.stderr.includes(password), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('account: otto caratteri Unicode e spazi preservati nella password', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spesesmart-accounts-unicode-')), directory = join(root, 'accounts');
  try {
    await initializeAccounts(directory);
    await administerAccount(directory, 'create', 'unicode', { password: '😀'.repeat(8) });
    assert.ok(await authenticateAccount(directory, 'unicode', '😀'.repeat(8)));
    await administerAccount(directory, 'password', 'unicode', { password: '  prova ' });
    assert.ok(await authenticateAccount(directory, 'unicode', '  prova '));
    assert.equal(await authenticateAccount(directory, 'unicode', 'prova'), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function fixture(work, gatewayOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'spesesmart-account-gateway-'));
  const keys = ['NODE_ENV', 'VERCEL', 'SPESESMART_MULTIUSER', 'SPESESMART_ACCOUNT_DIR', 'SPESESMART_LAN_OPERATIONAL', 'SPESESMART_HOME_PRODUCTION', 'SPESESMART_LAN_READ_ONLY', 'SPESESMART_LAN_CAPABILITY', 'SPESESMART_LAN_INTERNAL_PORT', 'SPESESMART_LAN_ORIGIN', 'SPESESMART_SHEETS_WRITES_ENABLED', 'SPESESMART_HOME_PROOF', 'SPESESMART_AI_DATA_DIR', 'SPESESMART_SHEETS_UPDATE_DIR', 'GOOGLE_SHEETS_SPREADSHEET_ID', 'SPESESMART_PREFERENCES_DIR'];
  const previous = keys.map(key => process.env[key]);
  let gateway, backend, forwarded = 0, time = Date.now();
  try {
    await initializeAccounts(directory);
    for (const username of ['a', 'b', 'admin']) await administerAccount(directory, 'create', username, { password, role: username === 'admin' ? 'admin' : 'user' });
    const accounts = (await readAccounts(directory)).accounts;
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-days', '1', '-subj', '/CN=fixture', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' });
    const cert = await readFile(join(directory, 'cert.pem')), key = await readFile(join(directory, 'key.pem'));
    backend = createServer(async (req, res) => {
      forwarded++;
      assert.equal(req.headers.cookie, undefined); assert.equal(req.headers.authorization, undefined);
      const result = await me(new Request(`http://127.0.0.1:${backend.address().port}${req.url}`, { headers: req.headers }));
      res.writeHead(result.status, Object.fromEntries(result.headers)); res.end(await result.text());
    });
    backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
    Object.assign(process.env, { NODE_ENV: 'development', SPESESMART_MULTIUSER: 'true', SPESESMART_ACCOUNT_DIR: directory, SPESESMART_LAN_OPERATIONAL: 'true', SPESESMART_HOME_PRODUCTION: 'false', SPESESMART_LAN_READ_ONLY: 'false', SPESESMART_LAN_CAPABILITY: capability, SPESESMART_LAN_INTERNAL_PORT: String(backend.address().port), SPESESMART_LAN_ORIGIN: origin, SPESESMART_SHEETS_WRITES_ENABLED: 'true' });
    delete process.env.VERCEL;
    if (process.env.SPESESMART_TEST_ACCOUNT_PRODUCTION === 'true') {
      Object.assign(process.env, { NODE_ENV: 'production', SPESESMART_HOME_PRODUCTION: 'true', SPESESMART_AI_DATA_DIR: join(directory, 'ai'),
        SPESESMART_SHEETS_UPDATE_DIR: join(directory, 'journal'), GOOGLE_SHEETS_SPREADSHEET_ID: 'synthetic-account-production', SPESESMART_PREFERENCES_DIR: join(directory, 'preferences') });
      const { mkdir } = await import('node:fs/promises'); await mkdir(process.env.SPESESMART_PREFERENCES_DIR, { mode: 0o700 });
      await initializeAI(aiConfiguration()); const store = createUpdateStore({ ...process.env, NODE_ENV: 'test' }); await store.lock(async () => {});
      process.env.SPESESMART_HOME_PROOF = await writeHomeProof(homeRuntimeDirectory(), { version: 1, pid: process.pid, capability, origin, port: String(backend.address().port),
        scope: store.scope, aiDirectory: process.env.SPESESMART_AI_DATA_DIR, updateDirectory: process.env.SPESESMART_SHEETS_UPDATE_DIR,
        multiuser: true, accountDirectory: directory, preferencesDirectory: process.env.SPESESMART_PREFERENCES_DIR });
    }
    const options = { ip: '192.168.250.115', port: 3443, upstreamPort: backend.address().port, key, cert, operational: true, capability, accountsDirectory: directory, now: () => time, ...gatewayOptions };
    gateway = createLANGateway(options); gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
    const call = (path, { method = 'GET', headers = {}, body, port: targetPort = gateway.address().port } = {}) => new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: targetPort, ca: cert, method, path, servername: '',
        checkServerIdentity: (_host, certificate) => checkServerIdentity('127.0.0.1', certificate),
        headers: { host: '192.168.250.115:3443', 'sec-fetch-site': 'same-origin', ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }), ...headers } }, res => {
        let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: res.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : text }));
      }); req.on('error', reject); req.end(body);
    });
    const login = async (username, extra = {}) => {
      const response = await call('/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json', ...extra }, body: JSON.stringify({ username, password }) });
      assert.equal(response.status, 200);
      return { response, headers: { cookie: response.headers['set-cookie'][0].split(';')[0], origin, 'x-spesesmart-csrf': response.body.csrf } };
    };
    await work({ call, login, accounts, directory, gateway, port: backend.address().port, options, advance: ms => { time += ms; }, count: () => forwarded });
  } finally {
    gateway?.closeAllConnections(); backend?.closeAllConnections();
    await Promise.all([gateway && new Promise(resolve => gateway.close(resolve)), backend && new Promise(resolve => backend.close(resolve))]);
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    await rm(directory, { recursive: true, force: true });
  }
}

test('account HTTPS: A/B/admin, identità server, rotazione sessioni, logout e revoca immediata', async () => fixture(async ({ call, login, accounts, directory }) => {
  for (const username of ['a', 'b', 'admin']) {
    const signed = await login(username, { 'x-spesesmart-user-id': accounts[2].id, 'x-spesesmart-account-revision': accounts[2].revision });
    assert.match(signed.response.headers['set-cookie'][0], /__Host-.*; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=1800/);
    assert.deepEqual(signed.response.body.user, { id: accounts.find(a => a.username === username).id, username, role: username === 'admin' ? 'admin' : 'user' });
    const response = await call('/api/auth/me', { headers: { ...signed.headers, 'x-spesesmart-user-id': accounts[2].id, 'x-spesesmart-account-revision': accounts[2].revision, authorization: 'Basic forged', 'x-forwarded-host': 'evil.invalid' } });
    assert.equal(response.status, 200); assert.equal(response.body.user.username, username);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(JSON.stringify(response.body).includes('credential'), false);
  }
  const a = await login('a'), b = await login('b');
  const rotated = await login('a', { cookie: a.headers.cookie });
  assert.notEqual(rotated.headers.cookie, a.headers.cookie);
  assert.equal((await call('/api/auth/session', { headers: a.headers })).status, 401);
  assert.equal((await call('/api/auth/logout', { method: 'POST', headers: { ...rotated.headers, 'x-spesesmart-csrf': 'wrong' } })).status, 403);
  assert.equal((await call('/api/auth/session', { headers: rotated.headers })).status, 200);
  assert.equal((await call('/api/auth/logout', { method: 'POST', headers: rotated.headers })).status, 200);
  assert.equal((await call('/api/auth/session', { headers: rotated.headers })).status, 401);
  const fresh = await login('a');
  await administerAccount(directory, 'disable', 'a');
  assert.equal((await call('/api/auth/me', { headers: fresh.headers })).status, 401);
  assert.equal((await call('/api/auth/session', { headers: b.headers })).status, 200);
  await administerAccount(directory, 'password', 'b', { password: replacement });
  assert.equal((await call('/api/auth/session', { headers: b.headers })).status, 401);
}));

test('account HTTPS: scadenza, CSRF/Host/Origin, header falsi e blocco finanziario anche admin', async () => fixture(async ({ call, login, advance, count, accounts, port }) => {
  assert.match((await call('/')).body, /Accesso account/);
  assert.equal((await call('/api/auth/me', { headers: { 'x-spesesmart-user-id': accounts[0].id, 'x-spesesmart-lan-capability': capability, cookie: '__Host-spesesmart-account=' + 'a'.repeat(64) } })).status, 401);
  const signed = await login('admin'); const before = count();
  for (const path of ['/api/archive?view=backup', '/api/archive?UtenteID=other', '/api/ai/usage?other=1', '/api/receipts/analyze?other=1', '/api/auth/session?UtenteID=other']) {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) assert.equal((await call(path, { method, headers: signed.headers, body: method === 'GET' ? undefined : '{}' })).status, 403);
  }
  assert.equal(count(), before);
  for (const headers of [{ origin: 'https://evil.invalid' }, { origin: '' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await call('/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ username: 'a', password }) })).status, 403);
    assert.equal((await call('/api/auth/logout', { method: 'POST', headers: { ...signed.headers, ...headers } })).status, 403);
  }
  assert.equal((await call('/api/auth/session', { headers: { ...signed.headers, host: 'evil.invalid' } })).status, 421);
  assert.equal((await call('/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'a', password, UtenteID: accounts[1].id }) })).status, 400);
  assert.equal((await call('/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: 'x'.repeat(4097) })).status, 413);
  advance(30 * 60000 + 1);
  assert.equal((await call('/api/auth/session', { headers: signed.headers })).status, 401);
  const backendRequest = new Request(`http://127.0.0.1:${port}/api/auth/me`, { headers: { host: `127.0.0.1:${port}`, 'x-spesesmart-user-id': accounts[0].id, 'x-spesesmart-account-revision': accounts[0].revision } });
  assert.equal(await authenticatedAccount(backendRequest), null);
  assert.equal((await me(backendRequest)).status, 401);
  assert.equal(proxy(new NextRequest(backendRequest.url, { headers: backendRequest.headers })).status, 403);
  const trusted = new Request(backendRequest.url, { headers: { ...Object.fromEntries(backendRequest.headers), 'x-spesesmart-lan-capability': capability } });
  assert.equal((await authenticatedAccount(trusted)).id, accounts[0].id);
  assert.equal(await authenticatedAccount(new Request(backendRequest.url, { headers: { ...Object.fromEntries(trusted.headers), 'x-spesesmart-user-id': randomUUID() } })), null);
  for (const action of [GET, POST, PATCH, DELETE]) assert.equal((await action(backendRequest)).status, 401);
  assert.equal(aiAccess(backendRequest)?.status, 401); assert.equal(aiAccess(backendRequest, true)?.status, 401);
  assert.equal(googleSheetsWritesEnabled(), true);
}));

test('account HTTPS: limite login, registro corrotto e riavvio senza ripristino sessioni', async () => fixture(async ({ call, login, advance, directory, options }) => {
  const signed = await login('a');
  const restarted = createLANGateway(options);
  restarted.listen(0, '127.0.0.1'); await once(restarted, 'listening');
  try {
    const status = await new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: restarted.address().port, ca: options.cert, path: '/api/auth/session',
        headers: { host: '192.168.250.115:3443', 'sec-fetch-site': 'same-origin', cookie: signed.headers.cookie } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      }); req.on('error', reject); req.end();
    });
    assert.equal(status, 401);
  } finally { restarted.closeAllConnections(); await new Promise(resolve => restarted.close(resolve)); }
  for (let i = 0; i < 10; i++) assert.equal((await call('/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'unknown', password }) })).status, 401);
  assert.equal((await call('/api/auth/session', { headers: signed.headers })).status, 429);
  advance(60001);
  assert.equal((await call('/api/auth/session', { headers: signed.headers })).status, 200);
  await writeFile(join(directory, 'accounts.json'), '{}');
  assert.equal((await call('/api/auth/session', { headers: signed.headers })).status, 503);
}));

test('cambio password: verifica atomica, revisione superata e account disabilitato', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spesesmart-change-password-')), directory = join(root, 'accounts');
  try {
    await initializeAccounts(directory);
    await administerAccount(directory, 'create', 'a', { password });
    const account = (await readAccounts(directory)).accounts[0], before = await readFile(join(directory, 'accounts.json'), 'utf8');
    await assert.rejects(changeAccountPassword(directory, account.id, account.revision, 'errata12', replacement), { code: 'CURRENT_PASSWORD' });
    await assert.rejects(changeAccountPassword(directory, account.id, account.revision, password, '1234567'), { code: 'PASSWORD_POLICY' });
    assert.equal(await readFile(join(directory, 'accounts.json'), 'utf8'), before);
    await changeAccountPassword(directory, account.id, account.revision, password, replacement);
    await assert.rejects(changeAccountPassword(directory, account.id, account.revision, replacement, password), { code: 'ACCOUNT_CHANGED' });
    assert.equal(await authenticateAccount(directory, 'a', password), null);
    assert.ok(await authenticateAccount(directory, 'a', replacement));
    const current = (await readAccounts(directory)).accounts[0];
    assert.equal(current.id, account.id); assert.equal(current.role, account.role); assert.equal(current.username, account.username);
    assert.notEqual(current.credential.salt, account.credential.salt); assert.equal(current.credential.N, 131072);
    await administerAccount(directory, 'disable', 'a');
    const disabled = (await readAccounts(directory)).accounts[0];
    await assert.rejects(changeAccountPassword(directory, disabled.id, disabled.revision, replacement, password), { code: 'ACCOUNT_CHANGED' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cambio password HTTPS: solo sessione corrente, revoca altre origini/istanze e identità invariata', async () => fixture(async ({ call, login, accounts, directory, options, advance, count }) => {
  const a = await login('a'), other = await login('a'), b = await login('b'), admin = await login('admin');
  const second = createLANGateway(options); second.listen(0, '127.0.0.1'); await once(second, 'listening');
  try {
    const remoteLogin = await call('/api/auth/login', { port: second.address().port, method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'a', password }) });
    assert.equal(remoteLogin.status, 200);
    const tailHeaders = { host: 'fixture.tailtest.ts.net', origin: 'https://fixture.tailtest.ts.net', 'x-spesesmart-tailscale-ingress': 'd'.repeat(64) };
    const tailLogin = await call('/api/auth/login', { method: 'POST', headers: { ...tailHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'a', password }) });
    assert.equal(tailLogin.status, 200);
    const before = await readAccounts(directory), forwarded = count();
    advance(10000);
    const result = await call('/api/auth/password', { method: 'POST', headers: { ...a.headers, 'content-type': 'application/json', 'x-spesesmart-user-id': accounts[1].id }, body: JSON.stringify({ currentPassword: password, newPassword: replacement, confirmPassword: replacement }) });
    assert.equal(result.status, 200); assert.deepEqual(result.body, { changed: true }); assert.equal(count(), forwarded);
    assert.match(result.headers['set-cookie'][0], /Secure; HttpOnly; SameSite=Strict; Max-Age=1790$/);
    const currentHeaders = { ...a.headers, cookie: result.headers['set-cookie'][0].split(';')[0] };
    assert.notEqual(currentHeaders.cookie, a.headers.cookie);
    assert.equal((await call('/api/auth/session', { headers: a.headers })).status, 401);
    assert.equal((await call('/api/auth/session', { headers: other.headers })).status, 401);
    assert.equal((await call('/api/auth/session', { headers: { ...tailHeaders, cookie: tailLogin.headers['set-cookie'][0].split(';')[0] } })).status, 401);
    assert.equal((await call('/api/auth/session', { port: second.address().port, headers: { cookie: remoteLogin.headers['set-cookie'][0].split(';')[0] } })).status, 401);
    const session = await call('/api/auth/session', { headers: currentHeaders });
    assert.equal(session.status, 200); assert.equal(session.body.csrf, a.response.body.csrf);
    assert.equal((await call('/api/auth/me', { headers: currentHeaders })).body.user.id, accounts[0].id);
    assert.equal((await call('/api/auth/session', { headers: b.headers })).status, 200);
    assert.equal((await call('/api/auth/session', { headers: admin.headers })).status, 200);
    const after = await readAccounts(directory);
    assert.deepEqual(after.accounts.slice(1), before.accounts.slice(1));
    assert.equal(after.accounts[0].id, before.accounts[0].id); assert.equal(after.accounts[0].role, before.accounts[0].role);
    assert.equal(await authenticateAccount(directory, 'a', password), null);
    assert.ok(await authenticateAccount(directory, 'a', replacement));
    for (const secret of [password, replacement, after.accounts[0].credential.hash, after.accounts[0].credential.salt]) assert.equal(JSON.stringify(result.body).includes(secret), false);
    advance(1790001);
    assert.equal((await call('/api/auth/session', { headers: currentHeaders })).status, 401);
  } finally { second.closeAllConnections(); await new Promise(resolve => second.close(resolve)); }
}, { tailscale: { hostname: 'fixture.tailtest.ts.net', capability: 'd'.repeat(64) } }));

test('cambio password HTTPS: CSRF, origine, corpo limitato, conferma e password attuale errata', async () => fixture(async ({ call, login, directory, count }) => {
  const a = await login('a'), before = await readFile(join(directory, 'accounts.json'), 'utf8'), forwarded = count();
  const input = { currentPassword: password, newPassword: replacement, confirmPassword: replacement };
  const change = (patch = {}, headers = {}) => call('/api/auth/password', { method: 'POST', headers: { ...a.headers, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ ...input, ...patch }) });
  assert.equal((await change({}, { 'x-spesesmart-csrf': 'wrong' })).status, 403);
  assert.equal((await change({}, { origin: '' })).status, 403);
  assert.equal((await change({}, { origin: 'https://external.invalid' })).status, 403);
  assert.equal((await change({}, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await change({}, { cookie: '' })).status, 401);
  assert.equal((await change({}, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await change({ username: 'b' })).status, 400);
  assert.equal((await call('/api/auth/password?user=b', { method: 'POST', headers: a.headers, body: '{}' })).status, 403);
  assert.equal((await call('/api/auth/password', { method: 'PATCH', headers: a.headers, body: '{}' })).status, 403);
  const confirmation = await change({ confirmPassword: 'different-confirmation' });
  assert.equal(confirmation.status, 422); assert.equal(confirmation.body.code, 'PASSWORD_CONFIRMATION');
  for (const invalid of ['1234567', '😀'.repeat(7), 'a'.repeat(257), '12345678\n']) {
    const response = await change({ newPassword: invalid, confirmPassword: invalid });
    assert.equal(response.status, 422); assert.equal(response.body.code, 'PASSWORD_POLICY');
  }
  const wrong = await change({ currentPassword: 'wrong-current-password' });
  assert.equal(wrong.status, 403); assert.equal(wrong.body.code, 'CURRENT_PASSWORD');
  assert.equal((await call('/api/auth/session', { headers: a.headers })).status, 200);
  assert.equal((await call('/api/auth/password', { method: 'POST', headers: { ...a.headers, 'content-type': 'application/json' }, body: 'x'.repeat(4097) })).status, 413);
  assert.equal(await readFile(join(directory, 'accounts.json'), 'utf8'), before); assert.equal(count(), forwarded);
}));

test('cambio password HTTPS: limite condiviso dei tentativi errati senza revocare la sessione corrente', async () => fixture(async ({ call, login, advance, directory }) => {
  const a = await login('a'), before = await readFile(join(directory, 'accounts.json'), 'utf8');
  for (let n = 0; n < 10; n++) {
    const result = await call('/api/auth/password', { method: 'POST', headers: { ...a.headers, 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword: 'wrong-current-password', newPassword: replacement, confirmPassword: replacement }) });
    assert.equal(result.status, 403); assert.equal(result.body.code, 'CURRENT_PASSWORD');
  }
  assert.equal((await call('/api/auth/session', { headers: a.headers })).status, 429);
  advance(60001);
  assert.equal((await call('/api/auth/session', { headers: a.headers })).status, 200);
  assert.equal(await readFile(join(directory, 'accounts.json'), 'utf8'), before);
}));

test('cambio password HTTPS: upload a frammenti limitato e arresto attende il salvataggio', async () => fixture(async ({ call, login, directory, gateway, options }) => {
  const a = await login('a'), before = await readFile(join(directory, 'accounts.json'), 'utf8');
  const headers = { ...a.headers, host: '192.168.250.115:3443', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'transfer-encoding': 'chunked' };
  const requestOptions = { hostname: '127.0.0.1', port: gateway.address().port, ca: options.cert, path: '/api/auth/password', method: 'POST', headers };
  const oversized = await new Promise((resolve, reject) => {
    const req = request(requestOptions, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end('x'.repeat(4097));
  });
  assert.equal(oversized, 413); assert.equal(await readFile(join(directory, 'accounts.json'), 'utf8'), before);
  assert.equal((await login('b')).response.status, 200); // authentication resource released
  const invalid = await call('/api/auth/password', { method: 'POST', headers: { ...a.headers, 'content-type': 'application/json' }, body: '{' });
  assert.equal(invalid.status, 400);
  const body = JSON.stringify({ currentPassword: password, newPassword: replacement, confirmPassword: replacement });
  let pending;
  const response = new Promise((resolve, reject) => {
    pending = request(requestOptions, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    pending.on('error', reject); pending.write(body.slice(0, 10));
  });
  let busy = false;
  for (let n = 0; n < 50 && !busy; n++) { await new Promise(resolve => setTimeout(resolve, 10)); busy = !await gateway.waitForDrain(1); }
  assert.ok(busy);
  gateway.beginDrain(); assert.equal(await gateway.waitForDrain(1), false);
  assert.equal((await call('/api/auth/password', { method: 'POST', headers: a.headers, body: '{}' })).status, 503);
  pending.end(body.slice(10));
  assert.equal(await response, 200); assert.equal(await gateway.waitForDrain(100), true);
  assert.ok(await authenticateAccount(directory, 'a', replacement));
}));
