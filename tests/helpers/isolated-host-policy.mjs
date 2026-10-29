// TEST ONLY. Keep the real userInfo-based policy and HOME away from financial
// fixtures. Production code has no environment switch for bypassing its policy.
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const realUserInfo = os.userInfo;
export const realHome = realUserInfo().homedir;
export const policyHome = mkdtempSync(join(os.tmpdir(), 'spesesmart-test-policy-'));
if (os.homedir() === realHome) process.env.HOME = policyHome;
os.userInfo = options => {
  const info = realUserInfo(options);
  return { ...info, homedir: Buffer.isBuffer(info.homedir) ? Buffer.from(policyHome) : policyHome };
};
syncBuiltinESMExports();

// Fixture child Node processes must also avoid the real fixed userInfo home.
// Preserve their explicit HOME (used by inherited-lock/runtime tests).
const preload = `--import=${import.meta.url}`;
if (!(process.env.NODE_OPTIONS ?? '').split(/\s+/).includes(preload)) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} ${preload}`.trim();
}
process.once('exit', () => rmSync(policyHome, { recursive: true, force: true }));
