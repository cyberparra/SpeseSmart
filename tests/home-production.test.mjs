import { fixturePiConfig } from './helpers/pi-config.mjs';
import './helpers/isolated-host-policy.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, readFile, writeFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { withHomeWriterLock, homeRuntimeDirectory, writeHomeProof } from '../scripts/home-runtime.mjs';
import { homePreflight } from '../scripts/home-preflight.mts';
import { initializeAI, aiConfiguration } from '../src/lib/ai-usage.ts';
import { createUpdateStore } from '../src/lib/sheets-update-store.ts';
import { googleSheetsWritesEnabled } from '../src/lib/google-sheets.ts';
import { proxy } from '../src/proxy.ts';
import { NextRequest } from 'next/server';
import { accountBackendEnvironment } from '../scripts/lan-server.mjs';
import { validatePiEnvironment } from '../scripts/pi-production-profile.mjs';

test('Pi multiutente: ambiente operativo mantiene provider, preview li esclude e chiave recovery resta fuori backend', () => {
  const env = { SPESESMART_MULTIUSER: 'true', SPESESMART_ACCOUNT_DIR: '/srv/spesesmart/data/accounts', SPESESMART_PREFERENCES_DIR: '/srv/spesesmart/data/preferences',
    SPESESMART_AI_DATA_DIR: '/srv/spesesmart/data/ai', SPESESMART_SHEETS_UPDATE_DIR: '/srv/spesesmart/data/sheets-updates', SPESESMART_LAN_DIR: '/srv/spesesmart/data/lan',
    SPESESMART_ACCOUNT_BACKUP_PUBLIC_KEY_FILE: '/srv/spesesmart/data/credentials/account-backup-public.pem', SPESESMART_ACCOUNT_BACKUP_PRIVATE_KEY_FILE: '/srv/spesesmart/data/credentials/account-backup-private.pem',
    OPENAI_API_KEY: 'synthetic', GOOGLE_APPLICATION_CREDENTIALS: '/synthetic-only' };
  assert.doesNotThrow(() => validatePiEnvironment(env, fixturePiConfig));
  const pi = accountBackendEnvironment('pi-production', env), preview = accountBackendEnvironment('accounts', env);
  assert.equal(pi.SPESESMART_MULTIUSER, 'true'); assert.equal(pi.SPESESMART_SHEETS_WRITES_ENABLED, 'true');
  assert.equal(pi.OPENAI_API_KEY, 'synthetic'); assert.equal(pi.SPESESMART_ACCOUNT_BACKUP_PRIVATE_KEY_FILE, undefined);
  assert.equal(preview.SPESESMART_SHEETS_WRITES_ENABLED, 'false'); assert.equal(preview.OPENAI_API_KEY, undefined); assert.equal(preview.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  for (const key of ['SPESESMART_ACCOUNT_DIR', 'SPESESMART_PREFERENCES_DIR', 'SPESESMART_ACCOUNT_BACKUP_PUBLIC_KEY_FILE', 'SPESESMART_ACCOUNT_BACKUP_PRIVATE_KEY_FILE']) {
    assert.throws(() => validatePiEnvironment({ ...env, [key]: '/tmp/wrong' }, fixturePiConfig));
  }
});

test('Production multiutente: HTTPS account reali sintetici con proof e lock ereditato, protezioni e revoca', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spesesmart-account-production-')); await chmod(directory, 0o700);
  const oldHome = process.env.HOME; process.env.HOME = directory;
  try {
    await withHomeWriterLock(async fd => {
      const env = { ...process.env, SPESESMART_TEST_ACCOUNT_PRODUCTION: 'true' }; delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, ['--conditions=react-server', '--import', 'tsx', '--test-isolation=none', '--test-reporter=tap', '--test', 'tests/accounts.test.mjs'],
        { env, stdio: ['ignore', 'pipe', 'pipe', fd], encoding: 'utf8', timeout: 60000 });
      assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /# fail 0/);
    });
  } finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; await rm(directory, { recursive: true, force: true }); }
});

async function storage(work) {
  const directory = await mkdtemp(join(tmpdir(), 'spesesmart-home-fixture-')); await chmod(directory, 0o700);
  const env = { NODE_ENV: 'test', GOOGLE_SHEETS_SPREADSHEET_ID: 'fixture', SPESESMART_AI_DATA_DIR: join(directory, 'ai'), SPESESMART_SHEETS_UPDATE_DIR: join(directory, 'updates') };
  await initializeAI(aiConfiguration(env));
  const store = createUpdateStore(env); await store.lock(async () => {});
  try { await work({ directory, env, store }); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('Production domestica: preflight non altera consumi o journal, non crea registri mancanti e rifiuta permessi errati', async () => storage(async ({ env, store }) => {
  const ledger = join(env.SPESESMART_AI_DATA_DIR, 'usage.json'), original = await readFile(ledger, 'utf8');
  const state = await homePreflight(env, true); assert.equal(state.pending, 0); assert.equal(state.unknownAI, 0);
  assert.equal(await readFile(ledger, 'utf8'), original);
  const cache = join(env.SPESESMART_AI_DATA_DIR, 'fixture.cache.json');
  await writeFile(cache, '{}', { mode: 0o644 }); await assert.rejects(homePreflight(env, true)); await unlink(cache);
  await chmod(ledger, 0o644); await assert.rejects(homePreflight(env, true)); await chmod(ledger, 0o600);
  await writeFile(ledger, '{corrupt'); await assert.rejects(homePreflight(env, true)); await writeFile(ledger, original);
  const marker = join(env.SPESESMART_SHEETS_UPDATE_DIR, `${store.scope}.initialized`);
  await unlink(marker); await assert.rejects(homePreflight(env, true));
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await writeFile(marker, store.scope, { mode: 0o600 }); await unlink(ledger);
  await assert.rejects(homePreflight(env, true)); await assert.rejects(readFile(ledger), { code: 'ENOENT' });
}));

test('Production domestica: filesystem temporaneo rifiutato dal preflight reale, journal danneggiati bloccano prima del server', async () => storage(async ({ env, store }) => {
  await assert.rejects(homePreflight(env));
  await writeFile(join(env.SPESESMART_SHEETS_UPDATE_DIR, store.scope, '00000000-0000-4000-8000-000000000000.json'), '{}', { mode: 0o600 });
  await assert.rejects(homePreflight(env, true));
}));

test('Writer domestico: lock comune blocca altri processi e resta occupato mentre un backend eredita FD 3', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spesesmart-home-lock-')); await chmod(directory, 0o700);
  let child;
  try {
    await withHomeWriterLock(async fd => {
      await assert.rejects(withHomeWriterLock(async () => {}, directory), /già attivo/);
      child = spawn(process.execPath, ['-e', 'process.stdout.write("READY\\n"); process.stdin.resume();'], { stdio: ['pipe', 'pipe', 'ignore', fd] });
      await once(child.stdout, 'data');
    }, directory);
    await assert.rejects(withHomeWriterLock(async () => {}, directory), /già attivo/);
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    await withHomeWriterLock(async () => {}, directory);
  } finally { child?.kill(); await rm(directory, { recursive: true, force: true }); }
});

test('Production generica, Vercel e flag senza prova privata non autorizzano scritture', () => {
  const base = { NODE_ENV: 'production', SPESESMART_SHEETS_WRITES_ENABLED: 'true' };
  for (const change of [{}, { SPESESMART_HOME_PRODUCTION: 'true' }, { SPESESMART_LAN_OPERATIONAL: 'true' }, { VERCEL: '1', SPESESMART_HOME_PRODUCTION: 'true' }]) {
    assert.equal(googleSheetsWritesEnabled({ ...base, ...change }), false);
  }
});

test('Dev: override hostname respinto prima di aprire porte o acquisire registri', () => {
  for (const args of [['--hostname', '0.0.0.0'], ['--hostname=192.168.250.115'], ['-H', '0.0.0.0']]) {
    const result = spawnSync(process.execPath, ['scripts/dev-server.mjs', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /127\.0\.0\.1/);
  }
});

test('Proxy production domestico: pagina, asset e API diretti negati senza prova, nessun cambio alla produzione generica', () => {
  const previous = process.env.SPESESMART_HOME_PRODUCTION;
  try {
    process.env.SPESESMART_HOME_PRODUCTION = 'true';
    for (const path of ['/', '/favicon.ico', '/_next/static/chunk.js', '/api/archive?view=dashboard']) {
      assert.equal(proxy(new NextRequest('http://localhost:3444' + path)).status, 403);
    }
    process.env.SPESESMART_HOME_PRODUCTION = 'false';
    assert.equal(proxy(new NextRequest('http://localhost:3444/')).headers.get('x-middleware-next'), '1');
  } finally { if (previous === undefined) delete process.env.SPESESMART_HOME_PRODUCTION; else process.env.SPESESMART_HOME_PRODUCTION = previous; }
});

test('Production domestica: prova valida richiede lock ereditato e registri corrispondenti, marker scomparso blocca gli invii', async () => storage(async ({ directory, env, store }) => {
  const oldHome = process.env.HOME; process.env.HOME = directory;
  try {
    await withHomeWriterLock(async (fd, runtime) => {
      const origin = 'https://192.168.250.115:3443', capability = 'a'.repeat(64);
      const proof = await writeHomeProof(runtime, { version: 1, pid: process.pid, capability, origin, port: '3444', scope: store.scope, aiDirectory: env.SPESESMART_AI_DATA_DIR, updateDirectory: env.SPESESMART_SHEETS_UPDATE_DIR });
      const childEnv = { ...process.env, ...env, NODE_ENV: 'production', SPESESMART_HOME_PRODUCTION: 'true', SPESESMART_HOME_PROOF: proof,
        SPESESMART_LAN_OPERATIONAL: 'true', SPESESMART_LAN_CAPABILITY: capability, SPESESMART_LAN_ORIGIN: origin, SPESESMART_LAN_INTERNAL_PORT: '3444', SPESESMART_SHEETS_WRITES_ENABLED: 'true' };
      delete childEnv.VERCEL;
      const code = 'import {googleSheetsWritesEnabled} from "./src/lib/google-sheets.ts"; import {aiAccess} from "./src/lib/ai-access.ts"; import {GET} from "./src/app/api/archive/route.ts"; console.log(JSON.stringify({enabled:googleSheetsWritesEnabled(), ai:aiAccess(new Request("http://localhost:3444/api/ai/usage", {headers:{host:"127.0.0.1:3444", "x-spesesmart-lan-capability":process.env.SPESESMART_LAN_CAPABILITY}}))?.status??200, direct:(await GET(new Request("http://localhost:3444/api/archive?view=dashboard",{headers:{host:"127.0.0.1:3444"}}))).status}));';
      const run = (changes = {}, inherit = true) => {
        const result = spawnSync(process.execPath, ['--conditions=react-server', '--import', 'tsx', '--input-type=module', '-e', code], { env: { ...childEnv, ...changes }, stdio: ['ignore', 'pipe', 'pipe', ...(inherit ? [fd] : [])], encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
      };
      assert.deepEqual(run(), { enabled: true, ai: 200, direct: 403 });
      assert.equal(run({}, false).enabled, false);
      assert.equal(run({ VERCEL: '1' }).enabled, false);
      assert.equal(run({ SPESESMART_LAN_ORIGIN: 'https://public.example:3443' }).enabled, false);
      assert.equal(run({ SPESESMART_AI_DATA_DIR: join(directory, 'other') }).enabled, false);
      assert.equal(run({ SPESESMART_LAN_INTERNAL_PORT: '3445' }).enabled, false);
      assert.equal(run({ GOOGLE_SHEETS_SPREADSHEET_ID: 'different-fixture' }).enabled, false);
      assert.equal(run({ SPESESMART_LAN_READ_ONLY: 'true' }).enabled, false);
      await unlink(join(env.SPESESMART_SHEETS_UPDATE_DIR, `${store.scope}.initialized`));
      assert.equal(run().enabled, false);
    });
  } finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; }
}));

test('Production domestica: intera suite operativa con HTTPS, Sheets/OpenAI simulati e recupero dopo riavvio', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spesesmart-home-suite-')); await chmod(directory, 0o700);
  const oldHome = process.env.HOME; process.env.HOME = directory;
  try {
    await withHomeWriterLock(async fd => {
      assert.equal(homeRuntimeDirectory(), join(directory, '.local/share/spesesmart/runtime'));
      const childEnv = { ...process.env, SPESESMART_TEST_HOME_PRODUCTION: 'true' };
      delete childEnv.NODE_TEST_CONTEXT; // Start an independent runner, not the parent's binary IPC reporter.
      const result = spawnSync(process.execPath, ['--conditions=react-server', '--import', 'tsx', '--test-isolation=none', '--test-reporter=tap', '--test', 'tests/lan-operations.test.mjs'],
        { env: childEnv, stdio: ['ignore', 'pipe', 'pipe', fd], encoding: 'utf8', timeout: 60000 });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /# fail 0/);
    });
  } finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; await rm(directory, { recursive: true, force: true }); }
});
