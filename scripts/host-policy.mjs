// Administrative accident prevention, not distributed fencing or credential revocation.
import { userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { lstatSync, readFileSync, realpathSync, constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
export const hostPolicyPath = () => join(userInfo().homedir, '.local/share/spesesmart/host-policy/access.json');
export const hostIdentity = () => createHash('sha256').update(readFileSync('/etc/machine-id', 'utf8').trim()).digest('hex');
export function readHostPolicy(path = hostPolicyPath(), identity = hostIdentity()) {
  try {
    const folder = lstatSync(/*turbopackIgnore: true*/ dirname(path));
    const stat = lstatSync(/*turbopackIgnore: true*/ path);
    if (!folder.isDirectory() || folder.isSymbolicLink() || folder.uid !== process.getuid() || (folder.mode & 0o777) !== 0o700
      || realpathSync(/*turbopackIgnore: true*/ path) !== path || !stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw Error();
    const value = JSON.parse(readFileSync(/*turbopackIgnore: true*/ path, 'utf8'));
    if (value.version !== 1 || value.machine !== identity || !['disabled', 'pc', 'raspberry'].includes(value.role)
      || Object.keys(value).sort().join() !== 'machine,role,version') throw Error();
    return { valid: true, configured: true, role: value.role };
  } catch (error) {
    // Only a genuinely absent file AND private-policy directory absence/default is legacy PC mode.
    if (error.code === 'ENOENT') {
      try { lstatSync(/*turbopackIgnore: true*/ path); } catch (missing) {
        if (missing.code === 'ENOENT') {
          try { lstatSync(/*turbopackIgnore: true*/ dirname(path)); } catch (parentMissing) {
            if (parentMissing.code === 'ENOENT') return { valid: true, configured: false, role: 'pc' };
          }
        }
      }
    }
    return { valid: false, configured: true, role: 'disabled' };
  }
}
export function hostOperationsAllowed(path = hostPolicyPath(), identity = hostIdentity()) { const policy = readHostPolicy(path, identity); return policy.valid && policy.role !== 'disabled'; }
export function requireHostRole(role, path = hostPolicyPath(), identity = hostIdentity()) {
  const policy = readHostPolicy(path, identity);
  if (!policy.valid || policy.role !== role || (role === 'raspberry' && (!policy.configured || policy.role !== role))) throw Error('Host non autorizzato: verifica operational:status e il passaggio manuale del writer.');
}
// Caller must hold the same lifetime writer lock; no environment variable overrides path.
export async function saveHostPolicy(role, path = hostPolicyPath(), identity = hostIdentity()) {
  if (!['disabled', 'pc', 'raspberry'].includes(role)) throw Error('Ruolo non valido.');
  const folder = dirname(path);
  const current = readHostPolicy(path, identity);
  if (!current.valid) throw Error('Policy corrotta: intervento manuale necessario.');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const stat = lstatSync(folder);
  if (realpathSync(folder) !== folder || !stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) throw Error('Directory policy non privata.');
  const temporary = join(folder, `.${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify({ version: 1, machine: identity, role })); await file.sync(); } finally { await file.close(); }
  try { await rename(temporary, path); } catch (error) { await unlink(temporary); throw error; }
  const directory = await open(folder, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await directory.sync(); } finally { await directory.close(); }
  if (readHostPolicy(path, identity).role !== role) throw Error('Policy non verificata.');
}
