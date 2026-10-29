import { fixturePiConfig } from './pi-config.mjs';
// Isolated VM test of the real production runtime gate; no filesystem/API writes.
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { validateMigrationMount } from '../../scripts/pi-migration-check.mjs';
const uid = process.getuid(), scope = crypto.createHash('sha256').update('fixture').digest('hex');
const runtime = '/srv/spesesmart/data/runtime', ai = '/srv/spesesmart/data/ai', updates = '/srv/spesesmart/data/sheets-updates';
const home = '/synthetic-home', lock = `${home}/.local/share/spesesmart/runtime/writer.lock`;
const env = { NODE_ENV: 'production', SPESESMART_HOME_PRODUCTION: 'true', SPESESMART_PI_PRODUCTION: 'true', SPESESMART_HOME_PROOF: `${runtime}/production.json`,
  SPESESMART_LAN_CAPABILITY: 'a'.repeat(64), SPESESMART_LAN_ORIGIN: 'https://192.168.250.91:3443', SPESESMART_LAN_INTERNAL_PORT: '3444',
  GOOGLE_SHEETS_SPREADSHEET_ID: 'fixture', SPESESMART_AI_DATA_DIR: ai, SPESESMART_SHEETS_UPDATE_DIR: updates };
const proof = { version: 1, pi: true, pid: 100, capability: env.SPESESMART_LAN_CAPABILITY, origin: env.SPESESMART_LAN_ORIGIN, port: '3444', scope, aiDirectory: ai, updateDirectory: updates };
let authorized = true, held = true, mounted = true, marker = scope;
const directories = new Set([runtime, ai, updates, `${updates}/${scope}`]);
const files = new Set([`${runtime}/production.json`, `${ai}/usage.json`, `${updates}/${scope}.initialized`, lock]);
const stat = name => {
  if (!directories.has(name) && !files.has(name)) throw Error('missing fixture');
  return { isSymbolicLink: () => false, isDirectory: () => directories.has(name), isFile: () => files.has(name), uid, mode: directories.has(name) ? 0o700 : 0o600, ino: 1, dev: 1 };
};
const context = createContext({ process: { platform: 'linux', arch: 'arm64', getuid: () => uid, kill: () => {}, env }, Buffer });
const modules = {
  'node:fs': { constants: {}, fstatSync: () => stat(lock), lstatSync: stat, realpathSync: name => name, readFileSync: name => name === `${runtime}/production.json` ? JSON.stringify(proof) : marker },
  'node:fs/promises': Object.fromEntries(['mkdir', 'open', 'realpath', 'unlink'].map(name => [name, () => { throw Error('unexpected mutation'); }])),
  'node:os': { homedir: () => home }, 'node:path': path, 'node:crypto': crypto,
  'node:child_process': { spawnSync: command => command === 'findmnt' ? { status: mounted ? 0 : 1, stdout: JSON.stringify({ filesystems: [{ target: '/srv/spesesmart', uuid: fixturePiConfig.ssdUUID, fstype: 'ext4', options: 'rw,nosuid' }] }) } : { status: held ? 1 : 0 } },
  './host-policy.mjs': { hostOperationsAllowed: () => authorized, requireHostRole: role => { if (!authorized || role !== 'raspberry') throw Error('unauthorized'); } },
  './pi-config.mjs': { piConfig: () => fixturePiConfig },
  './pi-migration-check.mjs': { validateMigrationMount },
};
const runtimeModule = new SourceTextModule(readFileSync(new URL('../../scripts/home-runtime.mjs', import.meta.url), 'utf8'), { context });
await runtimeModule.link(specifier => {
  const values = modules[specifier]; if (!values) throw Error(`Unexpected import ${specifier}`);
  return new SyntheticModule(Object.keys(values), function () { for (const [name, value] of Object.entries(values)) this.setExport(name, value); }, { context });
});
await runtimeModule.evaluate();
const ready = () => runtimeModule.namespace.homeProductionReady(env);
assert.equal(ready(), true);
authorized = false; assert.equal(ready(), false); authorized = true;
mounted = false; assert.equal(ready(), false); mounted = true;
held = false; assert.equal(ready(), false); held = true;
marker = 'wrong-scope'; assert.equal(ready(), false); marker = scope;
files.delete(`${ai}/usage.json`); assert.equal(ready(), false); files.add(`${ai}/usage.json`);
proof.pi = false; assert.equal(ready(), false); proof.pi = true;
env.SPESESMART_LAN_CAPABILITY = 'b'.repeat(64); assert.equal(ready(), false); env.SPESESMART_LAN_CAPABILITY = 'a'.repeat(64);
env.VERCEL = '1'; assert.equal(ready(), false); delete env.VERCEL;
assert.equal(ready(), true);
console.log('Pi production runtime: 10 controlli sintetici riusciti, nessuna mutazione.');
