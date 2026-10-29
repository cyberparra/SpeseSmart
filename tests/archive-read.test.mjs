import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readConfirmedArchive } from '../src/lib/archive-read.ts';
import { archiveReadState } from '../src/lib/dashboard.ts';

test('LAN bootstrap: canale React debug disabilitato solo nella modalità operativa, senza aprire HMR o origini esterne', () => {
  for (const operational of ['true', 'false']) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', 'import config from "./next.config.ts"; console.log(JSON.stringify(config));'], {
      encoding: 'utf8', env: { ...process.env, SPESESMART_LAN_OPERATIONAL: operational },
    });
    assert.equal(result.status, 0);
    const loaded = JSON.parse(result.stdout);
    const config = loaded.default ?? loaded;
    assert.equal(config.experimental.reactDebugChannel, operational === 'true' ? false : undefined);
    assert.equal(config.distDir, operational === 'true' ? '.next-lan' : '.next');
    assert.equal(config.allowedDevOrigins, undefined);
  }
});

test('Archivio: lettura confermata o vuota, nessun retry né richiesta amministrativa', async () => {
  const archive = { expenses: [], receipts: [] }; let calls = 0;
  const result = await readConfirmedArchive(undefined, 1000, async (url, options) => {
    calls++; assert.equal(url, '/api/archive?view=dashboard'); assert.equal(options.cache, 'no-store');
    return Response.json({ archive });
  });
  assert.equal(calls, 1); assert.deepEqual(result.archive, archive);
  assert.equal(archiveReadState(true, false, '', result.archive), 'empty');
});

test('Archivio: timeout prima degli header termina il caricamento e permette una riprova esplicita', async () => {
  let calls = 0, receivedSignal;
  const stalled = async (_url, { signal }) => {
    calls++; receivedSignal = signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  };
  await assert.rejects(readConfirmedArchive(undefined, 15, stalled), /Riprova caricamento/);
  assert.equal(calls, 1); assert.equal(receivedSignal.aborted, true);
  assert.equal(archiveReadState(false, false, 'timeout', { expenses: [], receipts: [] }), 'error');
  assert.ok(await readConfirmedArchive(undefined, 1000, async () => Response.json({ archive: { expenses: [], receipts: [] } })));
});

test('Archivio: timeout anche con header 200 e corpo incompleto; dati precedenti restano obsoleti, non zero attendibile', async () => {
  let calls = 0;
  const previous = { expenses: [{ id: 'fixture', amount: 7 }], receipts: [] };
  await assert.rejects(readConfirmedArchive(undefined, 15, async (_url, { signal }) => {
    calls++;
    return { ok: true, status: 200, json: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })) };
  }), /Riprova caricamento/);
  assert.equal(calls, 1); assert.equal(previous.expenses[0].amount, 7);
  assert.equal(archiveReadState(true, false, 'timeout', previous), 'stale');
});

test('Archivio: 401/403/503, HTML o rete interrotta restituiscono errori recuperabili', async () => {
  for (const status of [401, 403, 503]) {
    let calls = 0;
    await assert.rejects(readConfirmedArchive(undefined, 1000, async () => { calls++; return new Response('not-json', { status }); }), /[Rr]iprova/);
    assert.equal(calls, 1);
  }
  await assert.rejects(readConfirmedArchive(undefined, 1000, async () => new Response('<html>error</html>')), /non valida/);
  await assert.rejects(readConfirmedArchive(undefined, 1000, async () => { throw new TypeError('network fixture'); }), /connessione/);
});

test('Archivio: annullamento della pagina propagato alla richiesta senza trasformarlo in timeout', async () => {
  const controller = new AbortController();
  const request = readConfirmedArchive(controller.signal, 1000, async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  controller.abort(); await assert.rejects(request, { name: 'AbortError' });
});
