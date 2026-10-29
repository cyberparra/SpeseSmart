import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, chmod, rm, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSheetsRepository } from "../src/lib/sheets-repository.ts";
import { createUpdateStore } from "../src/lib/sheets-update-store.ts";
import { TABLE_HEADERS, extraHeaders, canonical, readSnapshot, operationRows } from "../src/lib/sheets-persistence-model.ts";
import { categoryDefinitions } from "../src/lib/categories.ts";
import { createDraft, prepareConfirmation } from "../src/lib/receipts/model.ts";
import { demoReceipt } from "../src/lib/receipts/demo.ts";
import { parseBackup } from "../src/lib/archive.ts";
import { spendingSummary } from "../src/lib/spending.ts";
import { buildPurchases } from "../src/lib/purchases.ts";
import { DELETE } from "../src/app/api/archive/route.ts";

const manual = () => ({ kind: "manual", operationId: randomUUID(), draft: { description: "Ferramenta", date: "2026-10-12", notes: "Da conservare nel backup", items: [{ amount: "10.10", category: "Casa e Pulizia" }, { amount: "2.20", category: "Trasporti" }] } });
async function fixture(work, kind = "manual") {
  const directory = await mkdtemp(join(tmpdir(), "spesesmart-deletions-test-")); await chmod(directory, 0o700);
  const env = { NODE_ENV: "test", SPESESMART_SHEETS_UPDATE_DIR: directory, GOOGLE_SHEETS_SPREADSHEET_ID: "fixture-spreadsheet" };
  const store = createUpdateStore(env);
  const data = Object.fromEntries(Object.entries(TABLE_HEADERS).map(([name, headers], id) => [name, { id, columns: 50, rows: [[...headers, ...(name === "Categorie" ? [] : extraHeaders(1))]] }]));
  data.Categorie.rows.push(...categoryDefinitions.map(c => [c.name, "Spese", "Sì", c.description]));
  const transport = { data, writes: [], async read() { return structuredClone(data); }, async guardDeletion() {}, async write(changes) {
    this.writes.push(structuredClone(changes));
    for (const c of changes) {
      assert.ok("sheet" in c); assert.notEqual(c.sheet, "Categorie");
      for (let n = 0; n < c.values.length; n++) {
        data[c.sheet].rows[c.row + n] ??= [];
        c.values[n].forEach((v, i) => { data[c.sheet].rows[c.row + n][c.column + i] = v; });
        while (data[c.sheet].rows[c.row + n].at(-1) === "") data[c.sheet].rows[c.row + n].pop();
      }
    }
  } };
  const repo = createSheetsRepository({ id: "11111111-1111-4111-8111-111111111111" }, transport, true, store);
  let documentId;
  if (kind === "manual") { const value = manual(); await repo.save(value); documentId = `manual-${value.operationId}`; }
  else {
    let n = 0; const analysis = structuredClone(demoReceipt);
    if (kind === "large-receipt") analysis.items[0].originalText = "Testo strutturato lungo ".repeat(3000);
    const value = prepareConfirmation(createDraft(analysis, () => `product-${++n}`), analysis, "", false, () => `receipt-${++n}`, "a".repeat(64));
    await repo.save({ kind: "receipt", operationId: value.Documenti[0].id, receipt: value }); documentId = value.Documenti[0].id;
  }
  const editable = (await repo.load()).editablePurchases[documentId];
  const request = { documentId, operationId: randomUUID(), expectedVersion: editable.version, confirmed: true };
  try { await work({ env, store, transport, repo, directory, documentId, editable, request }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("eliminazione manuale: tutte e sole le voci dell’acquisto, categorie, budget e dati estranei intatti", async () => fixture(async ({ repo, transport, request, documentId }) => {
  const other = manual(); await repo.save(other);
  const before = structuredClone(transport.data); const result = await repo.delete(request);
  assert.equal(result.deleted, true); assert.deepEqual(result.deletedDocumentIds, [documentId]);
  assert.equal(buildPurchases(result.archive).length, 1); assert.equal(result.archive.expenses.length, 2);
  assert.ok(result.archive.expenses.every(e => e.sheetsDocumentId !== documentId));
  const summary = spendingSummary(result.archive.expenses, "2026-10", 200000);
  assert.equal(summary.totalCents, 1230); assert.equal(summary.remainingCents, 198770);
  assert.deepEqual(transport.data.Categorie, before.Categorie);
  for (const sheet of ["Documenti", "Movimenti", "Prodotti"]) {
    assert.deepEqual(transport.data[sheet].rows[0], before[sheet].rows[0]);
    before[sheet].rows.slice(1).forEach((row, index) => {
      const owned = sheet === "Documenti" ? row[0] === documentId : row[1] === documentId;
      if (!owned) assert.deepEqual(transport.data[sheet].rows[index + 1], row);
      else assert.equal(transport.data[sheet].rows[index + 1][0], row[0]);
    });
  }
  assert.ok(transport.data.Movimenti.rows.filter(r => r[1] === documentId).every(r => r[9] === "Eliminato"));
  assert.deepEqual((await repo.load()).archive, result.archive);
}));

test("eliminazione scontrino: prodotti e categorie collegati marcati, archivio vuoto e statistiche a zero", async () => fixture(async ({ repo, transport, request }) => {
  const before = await repo.load(); assert.ok(before.archive.receipts[0].Movimenti.length > 1);
  const result = await repo.delete(request);
  assert.equal(result.archive.receipts.length, 0); assert.equal(result.archive.expenses.length, 0);
  assert.deepEqual(buildPurchases(result.archive), []); assert.deepEqual(result.warnings, []);
  assert.equal(spendingSummary(result.archive.expenses, "2026-10", 200000).remainingCents, 200000);
  for (const sheet of ["Prodotti", "Movimenti", "Documenti"]) for (const row of transport.data[sheet].rows.slice(1)) {
    const json = JSON.parse(row.slice(TABLE_HEADERS[sheet].length + 2).join("")); assert.equal(json.deletion.operationId, request.operationId);
  }
  assert.equal(JSON.stringify(transport.data).includes("data:image"), false);
}, "receipt"));

test("eliminazione: backup verificabile privato prima della prima scrittura, sufficiente al recupero", async () => fixture(async ({ repo, store, transport, request, directory }) => {
  const original = (await repo.load()).archive.receipts[0]; const write = transport.write.bind(transport);
  transport.write = async changes => {
    const journal = (await store.list()).find(j => j.operationId === request.operationId);
    assert.ok(journal?.backup); assert.equal(journal.state, "pending");
    assert.deepEqual(parseBackup(JSON.stringify(journal.backup)).archive.receipts[0], original);
    await write(changes);
  };
  await repo.delete(request);
  const path = join(directory, store.scope, `${request.operationId}.json`);
  assert.equal((await stat(path)).mode & 0o777, 0o600); assert.equal((await stat(join(directory, store.scope))).mode & 0o777, 0o700);
  const envelope = JSON.parse(await readFile(path, "utf8"));
  assert.equal(envelope.checksum, createHash("sha256").update(canonical(envelope.journal)).digest("hex"));
  assert.equal(JSON.stringify(envelope).includes("data:image"), false);
  // Recovery data recreate the exact pre-deletion snapshot; production restoration needs separate authorization.
  const restored = structuredClone(transport.data);
  for (const p of [envelope.journal.marker, ...envelope.journal.patches]) restored[p.sheet].rows[p.row] = p.before;
  assert.deepEqual(readSnapshot(restored, "11111111-1111-4111-8111-111111111111").archive.receipts[0], original);
}, "receipt"));

test("eliminazione: invii duplicati simultanei non riscrivono e UUID riutilizzati sono rifiutati", async () => fixture(async ({ repo, transport, request }) => {
  const results = await Promise.all([repo.delete(request), repo.delete(request)]);
  assert.equal(results[0].duplicate, false); assert.equal(results[1].duplicate, true);
  const writes = transport.writes.length; assert.equal((await repo.delete(request)).duplicate, true); assert.equal(transport.writes.length, writes);
  await assert.rejects(repo.delete({ ...request, documentId: "different" }), { code: "EDIT_CONFLICT" });
  assert.equal(transport.writes.length, writes);
}));

test("eliminazione: versione obsoleta dopo modifica, conferma assente e ID arbitrari non scrivono", async () => fixture(async ({ repo, transport, request, editable }) => {
  await assert.rejects(repo.delete({ ...request, confirmed: false }), { code: "INVALID" });
  await assert.rejects(repo.delete({ ...request, documentId: "missing" }), { code: "NOT_FOUND" });
  const draft = structuredClone(editable.draft); draft.notes = "Aggiornata";
  await repo.update({ documentId: request.documentId, expectedVersion: editable.version, operationId: randomUUID(), draft });
  const before = canonical(transport.data); await assert.rejects(repo.delete(request), { code: "EDIT_CONFLICT" }); assert.equal(canonical(transport.data), before);
}));

test("eliminazione: fallimento a metà, blocco comune alle scritture, ripresa dopo riavvio", async () => fixture(async ({ repo, store, env, transport, request, editable }) => {
  const write = transport.write.bind(transport); let phase = 0;
  transport.write = async changes => { if (++phase === 2) { await write(changes.slice(0, 1)); throw Error("interruzione"); } await write(changes); };
  await assert.rejects(repo.delete(request), { code: "UPDATE_PENDING" });
  const loaded = await repo.load(); assert.equal(loaded.archive.expenses.length, 0); assert.equal(loaded.pendingDeletions.length, 1); assert.equal(loaded.pendingEdits.length, 0);
  assert.deepEqual(loaded.pendingDeletions[0].request, request);
  await assert.rejects(repo.save(manual()), { code: "UPDATE_PENDING" });
  await assert.rejects(repo.update({ documentId: request.documentId, operationId: randomUUID(), expectedVersion: editable.version, draft: editable.draft }), { code: "UPDATE_PENDING" });
  await assert.rejects(repo.delete({ ...request, operationId: randomUUID() }), { code: "UPDATE_PENDING" });
  transport.write = write;
  const restarted = createSheetsRepository({ id: "11111111-1111-4111-8111-111111111111" }, transport, true, createUpdateStore(env)); const result = await restarted.delete(loaded.pendingDeletions[0].request);
  assert.equal(result.deleted, true); assert.equal(result.archive.expenses.length, 0);
  assert.equal((await restarted.load()).pendingDeletions.length, 0); assert.equal((await store.list())[0].state, "complete");
}, "receipt"));

test("eliminazione: interruzione prima del marker, backup conserva il tentativo senza cambiare Sheets", async () => fixture(async ({ repo, transport, request, env }) => {
  const before = canonical(transport.data); const write = transport.write.bind(transport);
  transport.write = async () => { throw Error("rete assente"); };
  await assert.rejects(repo.delete(request), { code: "UPDATE_PENDING" }); assert.equal(canonical(transport.data), before);
  const pending = (await repo.load()).pendingDeletions[0]; assert.deepEqual(pending.request, request);
  transport.write = write; assert.equal((await createSheetsRepository({ id: "11111111-1111-4111-8111-111111111111" }, transport, true, createUpdateStore(env)).delete(pending.request)).deleted, true);
}));

test("eliminazione: preflight 403 conserva UUID e backup prima del marker, recupero dopo riavvio", async () => fixture(async ({ repo, store, transport, request, env }) => {
  const before = canonical(transport.data); const writes = transport.writes.length;
  transport.guardDeletion = async () => { throw { response: { status: 403, data: { error: { details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } } } }; };
  await assert.rejects(repo.delete(request)); assert.equal(canonical(transport.data), before); assert.equal(transport.writes.length, writes);
  const journal = (await store.list()).find(j => j.operationId === request.operationId);
  assert.equal(journal.state, "pending"); assert.deepEqual(journal.request, request); assert.ok(journal.backup);
  transport.guardDeletion = async () => {};
  const restarted = createSheetsRepository({ id: "11111111-1111-4111-8111-111111111111" }, transport, true, createUpdateStore(env));
  const pending = (await restarted.load()).pendingDeletions; assert.equal(pending.length, 1); assert.deepEqual(pending[0].request, request);
  assert.equal((await restarted.delete(pending[0].request)).deleted, true);
  assert.equal((await store.list()).length, 1); assert.equal((await store.list())[0].operationId, request.operationId);
}));

test("eliminazione: scrittura parziale dentro una riga e nei frammenti JSON è recuperabile", async () => {
  for (const kind of ["manual", "receipt"]) for (const stopPhase of [2, 3]) await fixture(async ({ repo, transport, request, env }) => {
    const write = transport.write.bind(transport); let phase = 0;
    transport.write = async changes => { if (++phase === stopPhase) { await write(changes.slice(0, 1)); throw Error("interruzione dopo una cella"); } await write(changes); };
    await assert.rejects(repo.delete(request), { code: "UPDATE_PENDING" });
    assert.equal((await repo.load()).pendingDeletions.length, 1);
    transport.write = write;
    const recovered = await createSheetsRepository({ id: "11111111-1111-4111-8111-111111111111" }, transport, true, createUpdateStore(env)).delete(request);
    assert.equal(recovered.deleted, true); assert.equal(recovered.archive.expenses.length, 0);
  }, kind);
});

test("eliminazione: risposta persa viene verificata senza retry ciechi", async () => fixture(async ({ repo, transport, request }) => {
  const write = transport.write.bind(transport); transport.write = async changes => { await write(changes); throw Error("risposta persa"); };
  assert.equal((await repo.delete(request)).deleted, true);
}));

test("eliminazione: crash dopo commit e prima conferma durabile, ripresa senza riscritture", async () => fixture(async ({ repo, store, transport, request, env }) => {
  const put = store.put.bind(store); store.put = async j => { if (j.state === "complete") throw Error("crash"); await put(j); };
  await assert.rejects(repo.delete(request)); const writes = transport.writes.length;
  const result = await createSheetsRepository({ id: "11111111-1111-4111-8111-111111111111" }, transport, true, createUpdateStore(env)).delete(request);
  assert.equal(result.deleted, true); assert.equal(transport.writes.length, writes);
}));

test("eliminazione: dati esterni, righe spostate o collegate inattese bloccano il recupero", async () => {
  for (const mutate of [t => { t.data.Movimenti.rows[1][4] = "Esterno"; }, t => { t.data.Movimenti.rows.splice(1, 0, []); }, t => { const extra = [...t.data.Movimenti.rows[1]]; extra[0] = "foreign-id"; t.data.Movimenti.rows.push(extra); }]) await fixture(async ({ repo, transport, request }) => {
    const write = transport.write.bind(transport); let phase = 0;
    transport.write = async changes => { if (++phase === 2) throw Error("interrotto"); await write(changes); };
    await assert.rejects(repo.delete(request), { code: "UPDATE_PENDING" });
    mutate(transport); const before = canonical(transport.data); transport.write = write;
    await assert.rejects(repo.delete(request), { code: "UPDATE_CONFLICT" }); assert.equal(canonical(transport.data), before);
  });
});

test("eliminazione: backup corrotto o non scrivibile blocca, nessuna modifica a cache e consumi AI", async () => fixture(async ({ repo, transport, store, directory, request }) => {
  const usage = join(directory, "usage.json"), cache = join(directory, "analysis.cache.json");
  await writeFile(usage, '{"reserved":500,"calls":40}', { mode: 0o600 }); await writeFile(cache, '{"structured":"cached"}', { mode: 0o600 });
  const sentinels = [await readFile(usage), await readFile(cache)];
  const put = store.put.bind(store); store.put = async () => { throw Object.assign(Error("disco"), { code: "UPDATE_STORAGE" }); };
  const before = canonical(transport.data); await assert.rejects(repo.delete(request), { code: "UPDATE_STORAGE" }); assert.equal(canonical(transport.data), before);
  store.put = put; await repo.delete(request);
  assert.deepEqual([await readFile(usage), await readFile(cache)], sentinels);
  const path = join(directory, store.scope, `${request.operationId}.json`); const envelope = JSON.parse(await readFile(path, "utf8"));
  envelope.journal.backup.archive.expenses[0].amount = 777; await writeFile(path, JSON.stringify(envelope));
  const after = canonical(transport.data); await assert.rejects(repo.delete(request), { code: "UPDATE_STORAGE" }); assert.equal(canonical(transport.data), after);
}));

test("eliminazione: formule conservate, controlli readonly e registro assente bloccano", async () => fixture(async ({ transport, repo, request }) => {
  const before = canonical(transport.data);
  await assert.rejects(createSheetsRepository({ id: "11111111-1111-4111-8111-111111111111" }, transport).delete(request), { code: "WRITES_DISABLED" });
  await assert.rejects(createSheetsRepository({ id: "11111111-1111-4111-8111-111111111111" }, transport, true).delete(request), { code: "UPDATE_STORAGE" });
  transport.guardDeletion = async changes => {
    assert.ok(changes.every(c => c.row > 0 && (c.column >= TABLE_HEADERS[c.sheet].length + 2 || (c.sheet === "Documenti" && c.column === 8) || (c.sheet === "Movimenti" && c.column === 9))));
    throw Object.assign(Error("formula protetta"), { code: "UPDATE_CONFLICT" });
  };
  await assert.rejects(repo.delete(request), { code: "UPDATE_CONFLICT" }); assert.equal(canonical(transport.data), before);
}));

test("eliminazione: documento con stato ambiguo resta readonly", async () => fixture(async ({ repo, transport, request }) => {
  transport.data.Documenti.rows[1][8] = "Eliminato"; const before = canonical(transport.data);
  await assert.rejects(repo.delete(request), { code: "NOT_EDITABLE" }); assert.equal(canonical(transport.data), before);
}));

test("eliminazione: fotografia storica nativa è leggibile ma non viene copiata nel backup", async () => fixture(async ({ repo, transport, request }) => {
  const source = (await repo.load()).archive;
  delete source.googleSheetsSnapshot; source.receipts[0].Documenti[0].image = "data:image/png;base64,dGVzdA==";
  const rows = operationRows({ kind: "receipt", operationId: request.documentId, archive: source }, String(transport.data.Documenti.rows[1][TABLE_HEADERS.Documenti.length]), undefined, "11111111-1111-4111-8111-111111111111");
  for (const sheet of ["Documenti", "Prodotti", "Movimenti"]) transport.data[sheet].rows = [transport.data[sheet].rows[0], ...rows[sheet]];
  assert.equal((await repo.load()).archive.receipts.length, 1);
  const before = canonical(transport.data); await assert.rejects(repo.delete(request), { code: "NOT_EDITABLE" }); assert.equal(canonical(transport.data), before);
}, "receipt"));

test("eliminazione: acquisto con un record storico di entrata è preservato integralmente", async () => fixture(async ({ repo, transport, request }) => {
  const source = (await repo.load()).archive; delete source.googleSheetsSnapshot;
  for (const e of source.expenses) delete e.sheetsDocumentId;
  source.expenses[0].type = "income";
  const creationId = String(transport.data.Documenti.rows[1][TABLE_HEADERS.Documenti.length + 1]);
  const rows = operationRows({ kind: "manual", operationId: creationId, archive: source }, String(transport.data.Documenti.rows[1][TABLE_HEADERS.Documenti.length]), undefined, "11111111-1111-4111-8111-111111111111");
  for (const sheet of ["Documenti", "Prodotti", "Movimenti"]) transport.data[sheet].rows = [transport.data[sheet].rows[0], ...rows[sheet]];
  const before = canonical(transport.data); await assert.rejects(repo.delete(request), { code: "NOT_EDITABLE" }); assert.equal(canonical(transport.data), before);
  assert.equal((await repo.load()).archive.expenses[0].type, "income");
}));

test("eliminazione: JSON dei prodotti su più frammenti interrotto è escluso e recuperato", async () => fixture(async ({ repo, transport, request, env }) => {
  assert.ok(transport.data.Documenti.rows[1].length > TABLE_HEADERS.Documenti.length + 3);
  const write = transport.write.bind(transport); let phase = 0;
  transport.write = async changes => { if (++phase === 2) { await write(changes.slice(0, 1)); throw Error("frammenti parziali"); } await write(changes); };
  await assert.rejects(repo.delete(request), { code: "UPDATE_PENDING" });
  const pending = await repo.load(); assert.equal(pending.archive.receipts.length, 0); assert.equal(pending.pendingDeletions.length, 1);
  transport.write = write; assert.equal((await createSheetsRepository({ id: "11111111-1111-4111-8111-111111111111" }, transport, true, createUpdateStore(env)).delete(request)).deleted, true);
}, "large-receipt"));

test("eliminazione: nuova registrazione con stessa foto ammessa, vecchio ID non riattivato", async () => fixture(async ({ repo, request }) => {
  const receipt = structuredClone((await repo.load()).archive.receipts[0]);
  await repo.delete(request);
  await assert.rejects(repo.save({ kind: "receipt", operationId: receipt.Documenti[0].id, receipt }), { code: "CONFLICT" });
  const id = randomUUID(); receipt.Documenti[0].id = id;
  for (const p of receipt.Prodotti) { p.id += "-new"; p.documentId = id; }
  for (const m of receipt.Movimenti) { m.id += "-new"; m.documentId = id; }
  assert.equal((await repo.save({ kind: "receipt", operationId: id, receipt })).saved, true);
  assert.equal(buildPurchases((await repo.load()).archive).length, 1);
}, "receipt"));

test("DELETE: CSRF, Vercel e produzione bloccano prima di Google", async () => {
  const keys = ["NODE_ENV", "VERCEL", "SPESESMART_SHEETS_WRITES_ENABLED", "SPESESMART_ACCESS_USER", "SPESESMART_ACCESS_PASSWORD"];
  const old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const req = (origin = "http://localhost") => new Request("http://localhost/api/archive", { method: "DELETE", headers: { origin }, body: "{}" });
  try {
    process.env.NODE_ENV = "development"; delete process.env.SPESESMART_SHEETS_WRITES_ENABLED; delete process.env.VERCEL;
    assert.equal((await DELETE(req())).status, 403);
    process.env.SPESESMART_SHEETS_WRITES_ENABLED = "true"; process.env.VERCEL = "1"; assert.equal((await DELETE(req())).status, 403);
    delete process.env.VERCEL; assert.equal((await DELETE(req("https://outside.example"))).status, 403);
    process.env.NODE_ENV = "production"; delete process.env.SPESESMART_ACCESS_USER; delete process.env.SPESESMART_ACCESS_PASSWORD;
    assert.equal((await DELETE(req())).status, 503);
  } finally { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});
