// Disposable real-launcher/browser test. No personal credentials or data.
// Only the copied preflight accepts temporary fixture storage; original policy stays strict.
import assert from 'node:assert/strict';
import { cp, mkdir, chmod, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { request } from 'node:https';
import { once } from 'node:events';
import { X509Certificate, createHash } from 'node:crypto';
import { selectLAN } from './lan-gateway.mjs';
import { aiConfiguration, initializeAI } from '../src/lib/ai-usage.ts';
import { createUpdateStore } from '../src/lib/sheets-update-store.ts';

const repo = process.cwd(), directory = await mkdtemp(join(tmpdir(), 'spesesmart-home-browser-'));
const app = join(directory, 'app'), home = join(directory, 'home');
const lan = join(home, '.local/share/spesesmart/lan');
const interfaces = Object.fromEntries(Object.entries(networkInterfaces()).filter(([name]) => existsSync(join('/sys/class/net', name, 'device'))));
const network = selectLAN(interfaces, JSON.parse(execFileSync('ip', ['-j', '-4', 'route', 'show'], { encoding: 'utf8' })), process.env.SPESESMART_LAN_INTERFACE);
const freePort = async host => {
  const server = createServer(); server.listen(0, host); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
};
const port = await freePort(network.ip), upstream = await freePort('127.0.0.1');
const origin = `https://${network.ip}:${port}`;
const env = { ...process.env, HOME: home, NODE_ENV: 'production', VERCEL: '', SPESESMART_LAN_DIR: lan,
  SPESESMART_LAN_PORT: String(port), SPESESMART_LAN_UPSTREAM_PORT: String(upstream),
  SPESESMART_AI_DATA_DIR: join(directory, 'ai'), SPESESMART_SHEETS_UPDATE_DIR: join(directory, 'updates'),
  GOOGLE_SHEETS_SPREADSHEET_ID: 'home-production-fixture', GOOGLE_SERVICE_ACCOUNT_JSON: '{}',
  GOOGLE_APPLICATION_CREDENTIALS: join(directory, 'nonexistent-fixture-key'), OPENAI_API_KEY: '',
  SPESESMART_HOME_PRODUCTION: 'false', SPESESMART_LAN_OPERATIONAL: 'false', SPESESMART_LAN_READ_ONLY: 'false' };
delete env.NODE_TEST_CONTEXT;
let child, chrome;
const originalPreflight = await readFile(join(repo, 'scripts/home-preflight.mts'), 'utf8');
async function stop(processChild) {
  if (!processChild || processChild.exitCode !== null || processChild.signalCode !== null) return;
  const ended = once(processChild, 'exit'); processChild.kill('SIGTERM');
  const timer = setTimeout(() => processChild.kill('SIGKILL'), 35000);
  try { await ended; } finally { clearTimeout(timer); }
}
async function run(args, options = {}) {
  const processChild = spawn(process.execPath, args, { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let output = ''; processChild.stdout.on('data', c => output += c); processChild.stderr.resume();
  const [code] = await once(processChild, 'exit'); assert.equal(code, 0, 'Collaudo subprocess non riuscito.'); return output;
}
let cert;
const auth = 'Basic ' + Buffer.from('fixture:abcdefgh').toString('base64');
const call = (path, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
  const req = request(origin + path, { ca: cert, method, headers: { authorization: auth, ...headers } }, res => {
    let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode, body: text }));
  }); req.setTimeout(5000, () => req.destroy()); req.on('error', reject); req.end();
});
async function launch(mode) {
  let diagnostic = '';
  child = spawn(process.execPath, ['scripts/lan-server.mjs', ...mode], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', c => diagnostic += c); // Launcher emits only safe messages; backend raw stderr is discarded.
  child.stdout.on('data', c => diagnostic = (diagnostic + c).slice(-2000));
  for (let n = 0; n < 300; n++) {
    if (child.exitCode !== null) throw Error(`Launcher fixture ${mode[0] || 'readonly'} non avviato: ${diagnostic.trim()}`);
    try { if ((await call('/')).status === 200) return; } catch { /* Startup only. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Timeout avvio launcher fixture.');
}

try {
  await mkdir(app); await mkdir(lan, { recursive: true, mode: 0o700 });
  for (const name of ['scripts', 'src', 'public', 'package.json', 'next.config.ts', 'tsconfig.json', 'next-env.d.ts']) {
    await cp(join(repo, name), join(app, name), { recursive: true });
  }
  await cp(join(repo, '.next'), join(app, '.next'), { recursive: true, filter: source => !source.includes('/.next/dev') && !source.includes('/.next/cache') });
  // Next development/Turbopack needs dependencies inside its isolated project root.
  await cp(join(repo, 'node_modules'), join(app, 'node_modules'), { recursive: true });
  assert.ok(originalPreflight.includes('await homePreflight()'));
  await writeFile(join(app, 'scripts/home-preflight.mts'), originalPreflight.replace('await homePreflight()', 'await homePreflight(process.env, true)'));
  await initializeAI(aiConfiguration(env));
  await createUpdateStore({ ...env, NODE_ENV: 'test' }).lock(async () => {});
  await writeFile(join(lan, 'access.json'), JSON.stringify({ username: 'fixture', password: 'abcdefgh' }), { mode: 0o600 });
  const tls = join(lan, `tls-${network.ip}`); await mkdir(tls, { mode: 0o700 });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-days', '1', '-subj', '/CN=SpeseSmart fixture', '-addext', `subjectAltName=IP:${network.ip}`, '-keyout', join(tls, 'key.pem'), '-out', join(tls, 'cert.pem')], { stdio: 'ignore' });
  await chmod(join(tls, 'key.pem'), 0o600); await chmod(join(tls, 'cert.pem'), 0o600); cert = await readFile(join(tls, 'cert.pem'));
  await launch(['production']);
  assert.equal((await call('/', { authorization: '' })).status, 401);
  assert.equal((await call('/', { host: '192.168.254.254:3443' })).status, 421);
  assert.equal((await call('/', { origin: 'https://evil.invalid' })).status, 403);
  const archive = await call('/api/archive?view=dashboard');
  assert.equal(archive.status, 503); assert.equal(JSON.parse(archive.body).code, 'UPDATE_STORAGE'); // Real repository rejects /tmp fixture storage, after gateway gate, before Google.
  assert.equal((await fetch(`http://127.0.0.1:${upstream}/api/archive?view=dashboard`)).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${upstream}/`)).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${upstream}/favicon.ico`)).status, 403);
  assert.equal((await call('/api/archive', { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, 'POST')).status, 403);
  assert.equal((await call('/api/reset', {}, 'POST')).status, 403);
  await new Promise((resolve, reject) => {
    const socket = connect({ host: network.ip, port: upstream });
    socket.on('connect', () => { socket.destroy(); reject(Error('Backend esposto sulla LAN.')); });
    socket.on('error', resolve); socket.setTimeout(1000, () => { socket.destroy(); reject(Error('Controllo loopback non concluso.')); });
  });
  const otherLAN = join(directory, 'other-lan'); await mkdir(otherLAN, { mode: 0o700 });
  const competitor = spawn(process.execPath, ['scripts/lan-server.mjs', 'operate'], { cwd: app, env: { ...env, SPESESMART_LAN_DIR: otherLAN }, stdio: ['ignore', 'ignore', 'pipe'] });
  let competitorError = ''; competitor.stderr.on('data', c => competitorError += c);
  assert.equal((await once(competitor, 'exit'))[0], 1); assert.match(competitorError, /server finanziario è già attivo/);
  const profile = join(directory, 'chrome'); await mkdir(profile);
  const pin = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  chrome = spawn(process.env.SPESESMART_CHROME || 'google-chrome', ['--headless', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--ignore-certificate-errors-spki-list=${pin}`, '--no-first-run', '--disable-background-networking', 'about:blank'], { stdio: 'ignore' });
  let debugPort;
  for (let n = 0; n < 100; n++) {
    try { debugPort = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (debugPort) break; } catch { /* Starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!debugPort) throw Error('Chrome fixture non disponibile.');
  const browserResult = await run(['--conditions=react-server', '--import', 'tsx', 'scripts/test-dashboard-browser.mjs', '--lan-operations', '--home-production-fixture'],
    { env: { ...env, SPESESMART_BROWSER_URL: origin, SPESESMART_BROWSER_CDP: String(debugPort) } });
  console.log(browserResult.trim());
  await stop(chrome); chrome = null;
  await stop(child); child = null;
  for (const mode of [[], ['operate']]) {
    await launch(mode);
    assert.equal((await call('/api/archive?view=dashboard')).status, 503);
    assert.equal((await call('/api/archive', {}, 'POST')).status, 403);
    await stop(child); child = null;
  }
  child = spawn(process.execPath, ['scripts/dev-server.mjs', '--port', String(upstream)], { cwd: app, env: { ...env, NODE_ENV: 'development' }, stdio: 'ignore' });
  let devReady = false;
  for (let n = 0; n < 200; n++) {
    if (child.exitCode !== null) throw Error('Dev fixture non avviato.');
    try { if ((await fetch(`http://127.0.0.1:${upstream}/`)).status === 200) { devReady = true; break; } } catch { /* Startup only. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(devReady, true);
  await stop(child); child = null;
  assert.equal(await readFile(join(repo, 'scripts/home-preflight.mts'), 'utf8'), originalPreflight);
  console.log(JSON.stringify({ productionLauncher: true, nextStart: true, httpsAuthenticated: true, backendLoopback: true,
    directBackendDenied: true, hostOriginCSRF: true, writerCompetitorDenied: true, devCompatible: true, readonlyCompatible: true, operateCompatible: true,
    actualArchiveStatus: archive.status, fixtureTemporaryStorageRejected: true, realSheetsWrites: 0, paidOpenAICalls: 0, serverStopped: true }));
} finally {
  await stop(chrome); await stop(child); await rm(directory, { recursive: true, force: true });
}
