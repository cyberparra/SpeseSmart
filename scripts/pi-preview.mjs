// Separate entrypoint. No financial launcher, runtime proof, writer lock or registry.
import { migrationHardwareCheck } from './pi-migration-check.mjs';
import { mkdir, lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import readline from 'node:readline';
import { createLANGateway, selectLAN } from './lan-gateway.mjs';
import { privateLANFile, saveLANCredentials, validateLANCredentials, withLANCredentialsLock } from './lan-credentials.mjs';
import { loadPiTLS } from './pi-tls.mjs';
import { fixtureProxy } from './pi-preview-fixture.mjs';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(process.env.SPESESMART_PI_PREVIEW_DIR ?? join(dirname(app), 'https-preview'));
const ports = { gateway: 39443, fixture: 39444, next: 39445 };
export function isolatedEnvironment(home) {
  return { PATH: dirname(process.execPath) + ':/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8', NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', SPESESMART_LAN_READ_ONLY: 'true', SPESESMART_LAN_OPERATIONAL: 'false', SPESESMART_HOME_PRODUCTION: 'false', SPESESMART_SHEETS_WRITES_ENABLED: 'false', GOOGLE_APPLICATION_CREDENTIALS: join(home, 'no-google-credentials'), SPESESMART_AI_DATA_DIR: join(home, 'no-ai-data'), SPESESMART_SHEETS_UPDATE_DIR: join(home, 'no-journal') };
}
async function privateDirectory(path) {
  await mkdir(path, { mode: 0o700, recursive: true });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700 || await realpath(path) !== path) throw Error('Directory di collaudo non privata o non canonica.');
}
function listen(server, port, ip) { return new Promise((ok, fail) => { server.once('error', fail); server.listen(port, ip, ok); }); }
async function waitForNext(child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error('Next production non avviato.');
    const ready = await new Promise(ok => { const req = request({ hostname: '127.0.0.1', port: ports.next, path: '/', timeout: 1000 }, r => { r.resume(); ok(r.statusCode === 200); }); req.on('error', () => ok(false)); req.on('timeout', () => req.destroy()); req.end(); });
    if (ready) return;
    await new Promise(ok => setTimeout(ok, 200));
  }
  throw Error('Timeout avvio Next production.');
}
async function passwordPrompt() {
  if (!process.stdin.isTTY) throw Error('Usa un terminale interattivo (ssh -t) per scegliere la password.');
  process.stdout.write('Nuova password di collaudo (8–256 caratteri, input nascosto): ');
  const result = await new Promise((ok, fail) => {
    let value = ''; readline.emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume();
    const handler = (text, key) => {
      if (key?.ctrl && key.name === 'c') finish(Error('Configurazione annullata.'));
      else if (key?.name === 'return') finish(null);
      else if (key?.name === 'backspace') value = [...value].slice(0, -1).join('');
      else if (text && !key?.ctrl && !/[\r\n\x00-\x1f\x7f]/.test(text)) value += text;
    };
    function finish(error) { process.stdin.off('keypress', handler); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); if (error) fail(error); else ok(value); }
    process.stdin.on('keypress', handler);
  });
  return result;
}
async function main() {
  if (process.platform !== 'linux' || process.env.VERCEL) throw Error('Collaudo soltanto su Ubuntu locale.');
  await migrationHardwareCheck();
  if (directory === app || directory.startsWith(app + '/')) throw Error('Il collaudo deve stare fuori dal progetto.');
  // No env files are loaded; refuse them even if Next would load them itself.
  if ((await readdir(app)).some(name => name === '.env' || name.startsWith('.env.'))) throw Error('Copia non isolata: presenti file .env. Nessun avvio.');
  await privateDirectory(directory);
  const routes = JSON.parse(execFileSync('ip', ['-j', '-4', 'route'], { encoding: 'utf8' }));
  const { ip } = selectLAN(networkInterfaces(), routes, process.env.SPESESMART_LAN_INTERFACE);
  await withLANCredentialsLock(directory, async () => {
    const mode = process.argv[2];
    if (mode === 'prepare') {
      // New environment only; never overwrite a previous key/password.
      if ((await readdir(directory)).some(name => name !== '.credentials.lock')) throw Error('Ambiente già preparato: nessun file sovrascritto.');
      await privateDirectory(join(directory, 'home'));
      await saveLANCredentials(directory, { username: 'collaudo', password: randomBytes(32).toString('hex') });
      console.log('Ambiente privato preparato. TLS CA/leaf separati richiesti; scegli la password con pi:preview:password.');
    } else if (mode === 'password') {
      const previous = await privateLANFile(join(directory, 'access.json'));
      const credentials = validateLANCredentials({ username: 'collaudo', password: await passwordPrompt() });
      await saveLANCredentials(directory, credentials, previous);
      console.log('Credenziali di collaudo sostituite; utente: collaudo.');
    } else if (mode === 'start') {
      await readFile(join(app, '.next/BUILD_ID'), 'utf8');
      await privateDirectory(join(directory, 'home'));
      const { username, password } = validateLANCredentials(JSON.parse(await privateLANFile(join(directory, 'access.json'))));
      const tlsPath = resolve(process.env.SPESESMART_PI_TLS_DIR ?? app);
      if (tlsPath === app || tlsPath.startsWith(app + '/')) throw Error('TLS deve risiedere fuori dal progetto.');
      const { key, cert, certificate: info, root } = await loadPiTLS(process.env.SPESESMART_PI_TLS_DIR, ip, process.env.SPESESMART_PI_TLS_CA_SHA256);
      // Reject occupied ports before spawning, never borrow another backend.
      for (const [name, port] of Object.entries(ports)) {
        const probe = createServer(); await listen(probe, port, name === 'gateway' ? ip : '127.0.0.1');
        await new Promise(ok => probe.close(ok));
      }
      let gateway, proxy, stopped = false;
      const child = spawn(process.execPath, ['--import', join(app, 'scripts/pi-preview-network.mjs'), join(app, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(ports.next)], { cwd: app, env: isolatedEnvironment(join(directory, 'home')), stdio: ['ignore', 'ignore', 'ignore'], detached: true });
      const exit = new Promise(ok => { child.once('exit', ok); child.once('error', ok); });
      const stop = async () => {
        if (stopped) return; stopped = true;
        gateway?.beginDrain(); if (gateway) await gateway.waitForDrain(20000);
        for (const server of [gateway, proxy]) if (server?.listening) { server.closeIdleConnections(); await new Promise(ok => server.close(ok)); }
        if (child.exitCode === null) { child.kill('SIGTERM'); await exit; }
        console.log('Collaudo arrestato; nessuna operazione finanziaria eseguita.');
      };
      process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
      try {
        await waitForNext(child);
        proxy = fixtureProxy(ports.next); await listen(proxy, ports.fixture, '127.0.0.1');
        gateway = createLANGateway({ ip, port: ports.gateway, upstreamPort: ports.fixture, username, password, key, cert, operational: true, capability: randomBytes(32).toString('hex') });
        await listen(gateway, ports.gateway, ip);
        console.log(`COLLAUDO SINTETICO https://${ip}:${ports.gateway} — tutte le operazioni disabilitate.`);
        console.log(`Certificato SHA-256: ${info.fingerprint256}`);
        console.log(`CA SHA-256: ${root.fingerprint256}`);
        // Unexpected backend exit also closes the gateway. No restart/retry.
        await exit; await stop();
      } catch (error) { await stop(); throw error; }
    } else throw Error('Comando: prepare | password | start');
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('Collaudo non avviato o interrotto: verifica isolamento, porte, file privati e certificato. Nessun bypass applicato.'); process.exitCode = 1; });
