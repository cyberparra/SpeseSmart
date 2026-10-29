import { networkInterfaces, homedir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, lstat, mkdtemp, rename, chmod, access, realpath, unlink } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { X509Certificate, randomBytes } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createLANGateway, selectLAN } from './lan-gateway.mjs';
import { configuredTailscaleHostname, createTailscaleAdapter, TAILSCALE_ADAPTER_PORT } from './tailscale-ingress.mjs';
import { privateLANFile as privateFile, validateLANCredentials, withLANCredentialsLock, saveLANCredentials } from './lan-credentials.mjs';
import { withHomeWriterLock, writeHomeProof } from './home-runtime.mjs';
import { requireHostRole } from './host-policy.mjs';
import { preparePiProduction, preparePiSetup, piProductionTLS, privatePiDirectory, PI_DATA, PI_CA } from './pi-production-profile.mjs';
import nextEnvironment from '@next/env';
import { accountDirectory, readAccounts } from './accounts.mjs';
const { loadEnvConfig } = nextEnvironment;

// Keep the isolated PC preview distinct from the authenticated Pi writer.
export function accountBackendEnvironment(command, env = process.env) {
  const preview = command === 'accounts';
  const accounts = preview || (command === 'pi-production' && env.SPESESMART_MULTIUSER === 'true');
  const backend = preview ? Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ'].filter(name => env[name] !== undefined).map(name => [name, env[name]])) : { ...env };
  delete backend.SPESESMART_ACCOUNT_BACKUP_PRIVATE_KEY_FILE;
  Object.assign(backend, { SPESESMART_MULTIUSER: String(accounts), SPESESMART_ACCOUNT_DIR: accounts ? accountDirectory(env) : '',
    SPESESMART_SHEETS_WRITES_ENABLED: ['operate', 'production', 'pi-production'].includes(command) ? 'true' : 'false' });
  if (preview) for (const name of ['SPESESMART_PREFERENCES_DIR', 'SPESESMART_AI_DATA_DIR', 'SPESESMART_SHEETS_UPDATE_DIR']) if (env[name]) backend[name] = env[name];
  return backend;
}

async function main() {
  if (process.platform !== 'linux' || process.env.VERCEL) throw Error('Accesso LAN disponibile soltanto sul PC Ubuntu.');
  const accountsPreview = process.argv[2] === 'accounts';
  const pi = process.argv[2] === 'pi-production';
  if (pi) await preparePiProduction();
  const accountsMode = accountsPreview || (pi && process.env.SPESESMART_MULTIUSER === 'true');
  if (process.env.SPESESMART_MULTIUSER === 'true' && !accountsMode) throw Error('Per il profilo multiutente usare lan:accounts o pi:production.');
  if (accountsPreview) {
    if (['.env', '.env.local', '.env.development', '.env.development.local', '.env.production', '.env.production.local', '.env.test', '.env.test.local'].some(name => existsSync(join(process.cwd(), name)))) throw Error('Il collaudo account richiede una worktree senza file .env reali.');
    await readAccounts(accountDirectory());
  }
  const piSetup = process.argv[2] === 'pi-setup';
  if (piSetup) await preparePiSetup();
  const repo = process.cwd();
  const directory = resolve(process.env.SPESESMART_LAN_DIR || join(homedir(), '.local/share/spesesmart/lan'));
  if (accountsMode && accountDirectory() === directory) throw Error('Registro account e configurazione TLS devono usare directory distinte per consentire la revoca durante il servizio.');
  const fromRepo = relative(repo, directory);
  if (!fromRepo.startsWith('..') && !isAbsolute(fromRepo)) throw Error('La configurazione LAN deve restare fuori dal repository.');
  const setup = ['setup', 'pi-setup'].includes(process.argv[2]);
  if (setup) await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory).catch(() => { throw Error('Prima esegui npm run lan:setup dal terminale del PC.'); });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) throw Error('Directory LAN non privata: richiesti proprietario corrente e permessi 0700.');
  const canonical = relative(await realpath(repo), await realpath(directory));
  if (!canonical.startsWith('..') && !isAbsolute(canonical)) throw Error('La directory LAN reale deve restare fuori dal repository.');
  const writer = ['operate', 'production', 'pi-production', 'accounts'].includes(process.argv[2]);
  if (writer) await withHomeWriterLock((fd, runtimeDirectory) => {
    // Isolated multiuser mode never inherits provider credentials or grants Sheets writes.
    if (!accountsPreview) requireHostRole(pi ? 'raspberry' : 'pc');
    if (process.arch === 'arm64' && !pi) throw Error('Su ARM64 usare soltanto pi:production per operazioni reali.');
    return withLANCredentialsLock(directory, () => configureOrStartLAN(directory, setup, repo, fd, runtimeDirectory));
  });
  else await withLANCredentialsLock(directory, () => configureOrStartLAN(directory, setup, repo));
}

async function configureOrStartLAN(directory, setup, repo, writerFD, runtimeDirectory) {
  const accountsPreview = process.argv[2] === 'accounts';
  const pi = ['pi-production', 'pi-setup'].includes(process.argv[2]);
  const accountsMode = accountsPreview || (process.argv[2] === 'pi-production' && process.env.SPESESMART_MULTIUSER === 'true');
  const production = pi || process.argv[2] === 'production';
  const operational = production || process.argv[2] === 'operate' || accountsMode;
  if (operational && !pi && !accountsMode) loadEnvConfig(repo, !production, { info() {}, error() {} });
  const tailscaleHostname = configuredTailscaleHostname(process.env, process.argv[2] === 'pi-production');
  const routes = JSON.parse(execFileSync('ip', ['-j', '-4', 'route', 'show'], { encoding: 'utf8' }));
  const physicalInterfaces = Object.fromEntries(Object.entries(networkInterfaces()).filter(([name]) => existsSync(join('/sys/class/net', name, 'device'))));
  const network = selectLAN(physicalInterfaces, routes, process.env.SPESESMART_LAN_INTERFACE);
  const configPath = join(directory, 'access.json');
  let credentials, previousText = null, changed = false;
  try { if (!accountsMode) { previousText = await privateFile(configPath); credentials = validateLANCredentials(JSON.parse(previousText)); } }
  catch (error) {
    if (error.code !== 'ENOENT' || !setup) throw Error('Credenziali LAN assenti o non valide. Esegui npm run lan:setup; i file non validi non vengono sovrascritti.');
  }
  if (setup) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error('Configura le credenziali da un terminale interattivo; non passarle nella riga di comando.');
    let muted = false;
    const output = new Writable({ write(chunk, _encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); } });
    const prompt = createInterface({ input: process.stdin, output, terminal: true });
    try {
      const update = !credentials || /^(s|si|sì)$/i.test((await prompt.question('Aggiornare nome utente e password LAN? [s/N] ')).trim());
      if (update) {
        const username = (await prompt.question(credentials ? 'Nome utente LAN (Invio per mantenere quello attuale): ' : 'Nome utente LAN: ')) || credentials?.username;
        process.stdout.write('Password LAN (almeno 8 caratteri, input nascosto): '); muted = true;
        const password = await prompt.question('');
        muted = false; process.stdout.write('\n');
        credentials = validateLANCredentials({ username, password }); changed = true;
      }
    } finally { muted = false; prompt.close(); }
  }
  if (!accountsMode) validateLANCredentials(credentials);
  const tlsDirectory = join(directory, `tls-${network.ip}`);
  if (setup && !pi) {
    try { await access(tlsDirectory); }
    catch {
      const temporary = await mkdtemp(join(directory, '.tls-'));
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-sha256', '-days', '30', '-subj', '/CN=SpeseSmart LAN', '-addext', `subjectAltName=IP:${network.ip}`, '-addext', 'extendedKeyUsage=serverAuth', '-keyout', join(temporary, 'key.pem'), '-out', join(temporary, 'cert.pem')], { stdio: 'ignore' });
      await chmod(join(temporary, 'key.pem'), 0o600); await chmod(join(temporary, 'cert.pem'), 0o600);
      await rename(temporary, tlsDirectory);
    }
  }
  let key, cert, certificate, ca;
  if (pi) ({ key, cert, certificate, ca } = await piProductionTLS(network.ip));
  else {
    const tlsStat = await lstat(tlsDirectory).catch(() => { throw Error('Certificato assente per l’IP attuale. Esegui npm run lan:setup.'); });
    if (!tlsStat.isDirectory() || tlsStat.isSymbolicLink() || tlsStat.uid !== process.getuid() || (tlsStat.mode & 0o777) !== 0o700) throw Error('Directory TLS non privata.');
    key = await privateFile(join(tlsDirectory, 'key.pem')); cert = await privateFile(join(tlsDirectory, 'cert.pem'));
    certificate = new X509Certificate(cert);
    if (certificate.checkIP(network.ip) !== network.ip || Date.parse(certificate.validTo) <= Date.now() || Date.parse(certificate.validFrom) > Date.now()) throw Error('Certificato scaduto o non valido per l’IP attuale. Rinnovo esplicito necessario.');
    createSecureContext({ key, cert });
  }
  if (changed) await saveLANCredentials(directory, credentials, previousText);
  console.log(`Interfaccia ${network.name} · IP ${network.ip}\nImpronta SHA-256: ${certificate.fingerprint256}`);
  if (setup && pi) { console.log('Credenziali LAN Pi verificate. Certificati invariati, nessun server avviato o writer autorizzato.'); return; }
  if (setup) { console.log(changed ? 'Credenziali LAN salvate: il precedente accesso è sostituito. Avvia npm run lan con le nuove credenziali.' : 'Credenziali LAN conservate. Avvia npm run lan.'); return; }
  if (!operational || production) await access(join(repo, '.next/BUILD_ID')).catch(() => { throw Error('Prima esegui npm run build, a server fermo.'); });
  const port = Number(process.env.SPESESMART_LAN_PORT || 3443), upstreamPort = Number(process.env.SPESESMART_LAN_UPSTREAM_PORT || 3444);
  if (![port, upstreamPort].every(value => Number.isInteger(value) && value >= 1024 && value <= 65535) || port === upstreamPort) throw Error('Porte LAN non valide.');
  const capability = operational ? randomBytes(32).toString('hex') : '';
  // Kept only in the launcher. Never pass this ingress capability to Next/env/files.
  const tailscale = tailscaleHostname ? { hostname: tailscaleHostname, capability: randomBytes(32).toString('hex') } : undefined;
  let preflight, proofPath;
  const readPreflight = () => JSON.parse(execFileSync(process.execPath, ['--conditions=react-server', '--import', 'tsx', join(repo, 'scripts/home-preflight.mts')],
    { cwd: repo, env: { ...process.env, NODE_ENV: 'production' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 }));
  if (production) {
    if (pi) {
      await preparePiProduction();
      for (const name of ['ai', 'sheets-updates', 'lan', 'runtime']) await privatePiDirectory(`${PI_DATA}/${name}`);
    }
    try {
      preflight = readPreflight();
    } catch { throw Error('Preflight production fallito: verifica disco privato, ledger AI e journal esistenti. Nessun registro creato; nessuna scrittura remota.'); }
    process.env.SPESESMART_AI_DATA_DIR = preflight.aiDirectory;
    process.env.SPESESMART_SHEETS_UPDATE_DIR = preflight.updateDirectory;
    console.log(`Registri verificati: ${preflight.pending} operazioni pendenti, ${preflight.unknownAI} consumi AI da verificare. Nessuna ripresa automatica.`);
    proofPath = await writeHomeProof(pi ? `${PI_DATA}/runtime` : runtimeDirectory, { ...preflight, pi, ...(accountsMode ? { multiuser: true, accountDirectory: accountDirectory(), preferencesDirectory: process.env.SPESESMART_PREFERENCES_DIR } : {}), version: 1, pid: process.pid, capability, origin: `https://${network.ip}:${port}`, port: String(upstreamPort) });
  }
  const backendEnv = accountBackendEnvironment(process.argv[2]);
  const child = spawn(process.execPath, [join(repo, 'node_modules/next/dist/bin/next'), operational && !production ? 'dev' : 'start', '--hostname', '127.0.0.1', '--port', String(upstreamPort), ...(!operational || production ? ['--keepAliveTimeout', '70000'] : [])], {
    cwd: repo, detached: true, stdio: ['ignore', 'pipe', 'pipe', ...(operational ? [writerFD] : [])], env: { ...backendEnv, NODE_ENV: operational && !production ? 'development' : 'production', SPESESMART_HOME_PRODUCTION: String(production), SPESESMART_HOME_PROOF: proofPath || '', SPESESMART_LAN_READ_ONLY: operational ? 'false' : 'true', SPESESMART_LAN_OPERATIONAL: String(operational), SPESESMART_LAN_CAPABILITY: capability, SPESESMART_LAN_INTERNAL_PORT: String(upstreamPort), SPESESMART_LAN_ORIGIN: `https://${network.ip}:${port}`, SPESESMART_ACCESS_USER: operational ? '' : credentials.username, SPESESMART_ACCESS_PASSWORD: operational ? '' : credentials.password },
  });
  const childExited = new Promise(resolveExit => { child.once('exit', resolveExit); child.once('error', resolveExit); });
  const stopBackend = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const deadline = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }, 30000);
      await childExited; clearTimeout(deadline);
    }
  };
  let startupStopped = false;
  const stopStartup = () => { startupStopped = true; void stopBackend(); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stopStartup);
  let ready = false, log = '', gateway, adapter;
  const timeout = setTimeout(() => { child.kill(); }, 30000);
  try {
    await new Promise((resolveReady, reject) => {
      child.stdout.on('data', chunk => { log = (log + chunk.toString()).slice(-2000); if (log.includes('Ready in')) { ready = true; resolveReady(); } });
      child.stderr.resume(); // Do not forward raw server errors or environment to LAN logs.
      child.once('error', () => reject(Error('Avvio del server locale fallito.')));
      child.once('exit', () => { if (!ready) reject(Error('Server locale non avviato: verifica build e porta interna disponibile.')); });
    });
    clearTimeout(timeout);
    if (startupStopped) throw Error('Avvio interrotto.');
    if (pi) { await preparePiProduction(); await piProductionTLS(network.ip); }
    gateway = createLANGateway({ ...credentials, ip: network.ip, port, upstreamPort, key, cert, operational, capability, tailscale, accountsDirectory: accountsMode ? accountDirectory() : undefined });
    if (tailscale) adapter = createTailscaleAdapter({ ...tailscale, ip: network.ip, port, ca, expectedCA: PI_CA });
    let stopping, unexpectedExit = false;
    const stop = () => stopping ||= (async () => {
      adapter?.beginDrain();
      gateway.beginDrain();
      console.log('Arresto: nuovi invii bloccati; attesa delle operazioni già inoltrate (massimo 240 secondi).');
      const drained = (await Promise.all([gateway.waitForDrain(), adapter?.waitForDrain() ?? true])).every(Boolean);
      if (!drained) console.log('Tempo di arresto esaurito: esito potenzialmente incerto. Conservare lo stesso UUID e verificare dopo il riavvio.');
      if (production) {
        try { const state = readPreflight(); console.log(`Prima dell’arresto: ${state.pending} operazioni pendenti, ${state.unknownAI} consumi AI da verificare. Registri conservati.`); }
        catch { console.log('Registri non verificabili durante l’arresto: controllo manuale necessario prima del prossimo avvio. Nessuna inizializzazione o ripresa automatica.'); }
      }
      adapter?.close(); adapter?.closeAllConnections();
      gateway.close(); gateway.closeAllConnections();
      await stopBackend();
    })();
    child.once('exit', (code, signal) => {
      if (!stopping) { unexpectedExit = true; console.log(`Backend interrotto: ${signal || code || 'uscita inattesa'}. Arresto sicuro del gateway; registri conservati.`); }
      void stop();
    });
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.removeListener(signal, stopStartup);
      process.once(signal, () => { void stop(); });
    }
    gateway.listen(port, network.ip);
    await once(gateway, 'listening');
    if (adapter) {
      adapter.listen(TAILSCALE_ADAPTER_PORT, '127.0.0.1');
      await once(adapter, 'listening');
      adapter.on('error', () => { unexpectedExit = true; void stop(); });
      console.log(`Adattatore privato pronto su 127.0.0.1:${TAILSCALE_ADAPTER_PORT} per https://${tailscaleHostname}. Serve e policy non vengono modificati dal launcher.`);
    }
    console.log(`Apri https://${network.ip}:${port} dal telefono sulla stessa rete. ${accountsPreview ? 'Profilo multiutente di sviluppo: credenziali remote assenti e scritture Sheets disabilitate.' : accountsMode ? 'Profilo multiutente production: accesso personale richiesto.' : operational ? 'Operazioni autenticate abilitate sul server Ubuntu; strumenti amministrativi esclusi.' : 'Solo consultazione autenticata.'} Ctrl+C per fermare.`);
    await once(gateway, 'close');
    await stop(); // Keep lifetime locks until the backend has actually exited.
    if (unexpectedExit) throw Error('Backend interrotto.');
  } catch {
    clearTimeout(timeout);
    adapter?.close(); adapter?.closeAllConnections();
    gateway?.close(); gateway?.closeAllConnections();
    await stopBackend();
    throw Error('Avvio LAN non riuscito. Nessun accesso pubblico predisposto.');
  }
  finally {
    for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, stopStartup);
    if (proofPath) await unlink(proofPath).catch(() => {});
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(['pi-production', 'pi-setup'].includes(process.argv[2]) ? 'Configurazione/production Pi bloccata: verificare operational:status, migration:preflight, SSD, configurazione privata, registri e TLS. Nessuna autorizzazione creata.' : error.message); process.exitCode = 1; });
