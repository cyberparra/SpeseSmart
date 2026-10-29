import 'server-only';
import { createPublicKey, createPrivateKey, publicEncrypt, privateDecrypt, randomBytes, createCipheriv, createDecipheriv, constants, createHash } from 'node:crypto';
import { lstat, realpath, open } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { accountDirectory, readAccounts, validateAccounts } from '../../scripts/accounts.mjs';

const fail = (): never => { throw Error('Backup account non disponibile: verificare registro e chiavi private. Nessun segreto esposto.'); };
const base64 = (length: number) => z.string().refine(value => Buffer.from(value, 'base64').toString('base64') === value && Buffer.from(value, 'base64').length === length);
const envelopeSchema = z.object({ version: z.literal(1), algorithm: z.literal('RSA-OAEP-SHA256/AES-256-GCM'), scope: z.string().regex(/^[a-f0-9]{64}$/),
  keyId: z.string().regex(/^[a-f0-9]{64}$/), wrappedKey: z.string().min(512).max(1400), iv: base64(12), tag: base64(16), ciphertext: z.string().min(1).max(2 * 1024 * 1024) }).strict();
export async function readAccountBackupKey(path: string | undefined) {
  if (!path || !isAbsolute(path)) return fail();
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600
    || info.size > 16384 || await realpath(path) !== path) return fail();
  const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { return await file.readFile(); } finally { await file.close(); }
}
const keyId = (key: ReturnType<typeof createPublicKey>) => createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
export function inspectEncryptedAccounts(data: Buffer, scope: string) {
  try {
    const value = envelopeSchema.parse(JSON.parse(data.toString()));
    if (value.scope !== scope || Buffer.from(value.ciphertext, 'base64').toString('base64') !== value.ciphertext
      || Buffer.from(value.wrappedKey, 'base64').toString('base64') !== value.wrappedKey) return fail();
    return value;
  } catch { return fail(); }
}
const aad = (scope: string, recipient: string) => Buffer.from(`SpeseSmartAccounts:1:${scope}:${recipient}`);
export async function encryptAccounts(env: NodeJS.ProcessEnv, scope: string) {
  try {
    const accounts = await readAccounts(accountDirectory(env));
    const publicKey = createPublicKey(await readAccountBackupKey(env.SPESESMART_ACCOUNT_BACKUP_PUBLIC_KEY_FILE));
    if (publicKey.asymmetricKeyType !== 'rsa' || (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 3072) return fail();
    const id = keyId(publicKey), key = randomBytes(32), iv = randomBytes(12);
    try {
      const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad(scope, id));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(accounts)), cipher.final()]);
      return Buffer.from(JSON.stringify({ version: 1, algorithm: 'RSA-OAEP-SHA256/AES-256-GCM', scope, keyId: id,
        wrappedKey: publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key).toString('base64'),
        iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }));
    } finally { key.fill(0); }
  } catch { return fail(); }
}
export async function decryptAccounts(data: Buffer, env: NodeJS.ProcessEnv, scope: string) {
  try {
    const value = inspectEncryptedAccounts(data, scope);
    const privateKey = createPrivateKey(await readAccountBackupKey(env.SPESESMART_ACCOUNT_BACKUP_PRIVATE_KEY_FILE));
    if (privateKey.asymmetricKeyType !== 'rsa' || keyId(createPublicKey(privateKey)) !== value.keyId) return fail();
    const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(value.wrappedKey, 'base64'));
    try {
      const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
      cipher.setAAD(aad(scope, value.keyId)); cipher.setAuthTag(Buffer.from(value.tag, 'base64'));
      const plain = Buffer.concat([cipher.update(Buffer.from(value.ciphertext, 'base64')), cipher.final()]);
      try { return validateAccounts(JSON.parse(plain.toString())); } finally { plain.fill(0); }
    } finally { key.fill(0); }
  } catch { return fail(); }
}
