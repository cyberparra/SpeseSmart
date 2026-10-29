import { realHome, policyHome } from './helpers/isolated-host-policy.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { hostPolicyPath, readHostPolicy, saveHostPolicy, hostOperationsAllowed } from '../scripts/host-policy.mjs';

test('Fixture: policy sintetica e processi figli isolati senza toccare il writer reale', async () => {
  const realPath = join(realHome, '.local/share/spesesmart/host-policy/access.json');
  const fingerprint = async () => createHash('sha256').update(await readFile(realPath).catch(error => {
    if (error.code !== 'ENOENT') throw error; return Buffer.from('absent');
  })).digest('hex');
  const before = await fingerprint();
  assert.notEqual(policyHome, realHome);
  assert.equal(hostPolicyPath(), join(policyHome, '.local/share/spesesmart/host-policy/access.json'));
  assert.equal(readHostPolicy().configured, false);
  await saveHostPolicy('disabled'); assert.equal(hostOperationsAllowed(), false);
  await saveHostPolicy('pc'); assert.equal(hostOperationsAllowed(), true);
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(process.execPath, ['--input-type=module','-e',
    'import {hostPolicyPath} from "./scripts/host-policy.mjs"; console.log(hostPolicyPath());'],
    { encoding:'utf8',env:process.env });
  assert.equal(child.status,0,child.stderr);
  assert.notEqual(child.stdout.trim(),realPath);
  assert.notEqual(child.stdout.trim(),hostPolicyPath());
  assert.equal(await fingerprint(),before);
});
