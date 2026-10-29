import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import { request } from 'node:https';
import { validatePiTLS, loadPiTLS } from '../scripts/pi-tls.mjs';
import { syntheticPKI } from './helpers/pi-pki.mjs';

test('PKI Raspberry: validazione rigorosa CA separata/leaf e rifiuti prima del bind', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'spesesmart-pki-tests-'));
  try {
    const pki = await syntheticPKI(directory);
    const input = { key: pki.key, cert: pki.cert, ca: pki.ca, ip: '127.0.0.1', expectedCA: pki.pin };
    await t.test('catena valida e leaf CA:FALSE accettata', async () => { const result = await validatePiTLS(input); assert.equal(result.certificate.ca, false); assert.equal(result.root.ca, true); });
    await t.test('CA non attendibile/pin diverso rifiutato', async () => { await assert.rejects(validatePiTLS({ ...input, expectedCA: 'aa'.repeat(32) })); await assert.rejects(validatePiTLS({ ...input, expectedCA: undefined })); });
    await t.test('SAN IP diverso rifiutato', async () => { await assert.rejects(validatePiTLS({ ...input, ip: '192.168.250.91' })); });
    const date = offset => new Date(Date.now()+offset*86400000).toISOString().replace(/[-:T]/g, '').slice(0, 14)+'Z';
    await t.test('certificato scaduto rifiutato', async () => { const cert = await pki.issue({ dates: [date(-5), date(-1)] }); await assert.rejects(validatePiTLS({ ...input, cert })); });
    await t.test('certificato non ancora valido rifiutato', async () => { const cert = await pki.issue({ dates: [date(1), date(5)] }); await assert.rejects(validatePiTLS({ ...input, cert })); });
    await t.test('CA:TRUE come leaf rifiutata', async () => { await assert.rejects(validatePiTLS({ ...input, cert: await pki.issue({ caLeaf: true }) })); await assert.rejects(validatePiTLS({ ...input, cert: pki.ca })); });
    await t.test('EKU clientAuth o KU di firma certificati rifiutati', async () => { await assert.rejects(validatePiTLS({ ...input, cert: await pki.issue({ eku: 'clientAuth' }) })); await assert.rejects(validatePiTLS({ ...input, cert: await pki.issue({ ku: 'digitalSignature,keyCertSign' }) })); });
    await t.test('chiave privata non corrispondente rifiutata senza divulgarla', async () => { const { readFile } = await import('node:fs/promises'); const key = await readFile(join(directory, 'root.key'), 'utf8'); await assert.rejects(validatePiTLS({ ...input, key }), error => !error.message.includes('PRIVATE KEY')); });
    await t.test('riuso della chiave CA nella leaf rifiutato', async () => { const cert = await pki.issue({ useRootKey: true }); const key = await readFile(join(directory, 'root.key'), 'utf8'); await assert.rejects(validatePiTLS({ ...input, cert, key })); });
    await t.test('catena estranea e bundle con certificati aggiuntivi rifiutati', async () => { await assert.rejects(validatePiTLS({ ...input, ca: pki.cert })); await assert.rejects(validatePiTLS({ ...input, cert: pki.cert+pki.ca })); });
    const bundle = await pki.bundle(join(directory, 'bundle'));
    await t.test('file privati validi accettati', async () => { assert.equal((await loadPiTLS(bundle, input.ip, input.expectedCA)).certificate.ca, false); });
    await t.test('permessi file/directory non privati rifiutati', async () => { await chmod(join(bundle, 'server.key'), 0o644); await assert.rejects(loadPiTLS(bundle, input.ip, input.expectedCA)); await chmod(join(bundle, 'server.key'), 0o600); await chmod(bundle, 0o755); await assert.rejects(loadPiTLS(bundle, input.ip, input.expectedCA)); await chmod(bundle, 0o700); });
    await t.test('symlink e chiave CA nel bundle rifiutati', async () => { await symlink(bundle, join(directory, 'link')); await assert.rejects(loadPiTLS(join(directory, 'link'), input.ip, input.expectedCA)); await writeFile(join(bundle, 'ca.key'), 'forbidden', { mode: 0o600 }); await assert.rejects(loadPiTLS(bundle, input.ip, input.expectedCA)); await rm(join(bundle, 'ca.key')); });
    await t.test('configurazione assente non ripiega sul vecchio TLS', async () => { await assert.rejects(loadPiTLS(undefined, input.ip, input.expectedCA)); });
    await t.test('HTTPS verifica CA e hostname, rifiuta root non attendibile', async () => {
      const tls = await loadPiTLS(bundle, input.ip, input.expectedCA);
      const server = createServer(tls, (_req, res) => res.end('synthetic TLS'));
      await new Promise(ok => server.listen(0, '127.0.0.1', ok));
      const get = ca => new Promise((ok, fail) => { const req = request(`https://127.0.0.1:${server.address().port}`, { ca, agent: false }, res => { res.resume(); res.on('end', () => ok(res.statusCode)); }); req.on('error', fail); req.end(); });
      try { assert.equal(await get(pki.ca), 200); await assert.rejects(get(undefined)); }
      finally { server.closeIdleConnections(); await new Promise(ok => server.close(ok)); }
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
