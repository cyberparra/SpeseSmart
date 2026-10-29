// Local installation identity, shared by launcher, runtime proof and tools.
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { isIP } from 'node:net';
export function validatePiConfig(value) {
  const keys = ['mount', 'ssdUUID', 'ip', 'tlsDirectory', 'caSHA256', 'user', 'home', 'node'];
  if (!value || keys.some(key => typeof value[key] !== 'string')
    || Object.keys(value).some(key => ![...keys, 'backupMount', 'backupUUID', 'backupLabel'].includes(key))) throw Error('Configurazione Pi incompleta.');
  for (const key of ['mount', 'tlsDirectory', 'home', 'node', ...(value.backupMount ? ['backupMount'] : [])]) {
    if (!/^\/[a-zA-Z0-9_./-]+$/.test(value[key]) || resolve(value[key]) !== value[key] || value[key] === '/') throw Error('Percorso Pi non canonico.');
  }
  const uuid = /^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/;
  if (!uuid.test(value.ssdUUID) || isIP(value.ip) !== 4 || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(value.ip)
    || !/^[a-fA-F0-9]{64}$/.test(value.caSHA256.replaceAll(':', '')) || /^0+$/.test(value.caSHA256.replaceAll(':', ''))
    || !/^[a-z_][a-z0-9_-]*$/.test(value.user) || !value.tlsDirectory.startsWith(value.mount + '/tls/')) throw Error('Identità Pi non valida.');
  if ([value.backupMount, value.backupUUID, value.backupLabel].some(v => v !== undefined)
    && (!value.backupMount || !uuid.test(value.backupUUID || '') || !/^[A-Z0-9_-]{1,16}$/.test(value.backupLabel || '')
      || value.backupUUID === value.ssdUUID || value.backupMount === value.mount || value.backupMount.startsWith(value.mount + '/'))) throw Error('Identità backup non valida.');
  return { ...value, app: value.mount + '/app', data: value.mount + '/data' };
}
export function piConfig(env = process.env) {
  const path = env.SPESESMART_PI_CONFIG;
  if (!path || resolve(path) !== path || realpathSync(/*turbopackIgnore: true*/ path) !== path) throw Error('SPESESMART_PI_CONFIG obbligatorio e canonico.');
  for (let current = path; ; current = dirname(current)) {
    const info = lstatSync(/*turbopackIgnore: true*/ current);
    if (info.isSymbolicLink() || ![0, process.getuid()].includes(info.uid)
      || (info.mode & 0o022) && !(current !== path && info.uid === 0 && info.mode & 0o1000)
      || (current === path ? !info.isFile() : !info.isDirectory())) throw Error('Configurazione Pi non protetta.');
    if (current === dirname(current)) break;
  }
  return validatePiConfig(JSON.parse(readFileSync(/*turbopackIgnore: true*/ path, 'utf8')));
}
