import './helpers/isolated-host-policy.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile, chmod, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { validateAICache, aiConfiguration, initializeAI, controlledAnalysis, getAIUsage, usageCost, MAX_AI_INPUT, MAX_AI_OUTPUT } from "../src/lib/ai-usage.ts";
import { demoReceipt } from "../src/lib/receipts/demo.ts";
import { apiError } from "../src/lib/receipts/analyze-server.ts";
import { AIControlError } from "../src/lib/ai-usage.ts";
import { imageStorageAudit } from "../src/lib/image-storage-audit.ts";
import { aiAccess } from "../src/lib/ai-access.ts";
import { POST as receiptPOST } from "../src/app/api/receipts/analyze/route.ts";
import { GET as usageGET } from "../src/app/api/ai/usage/route.ts";

const image = Buffer.from("fake-private-image");
const usage = { input: 4000, cached: 1000, output: 1500 };
const response = () => ({ receipt: structuredClone(demoReceipt), usage, model: "gpt-4.1-mini-2025-04-14", completed: true });
async function fixture(run, env = {}) {
  const directory = await mkdtemp(join(tmpdir(), "spesesmart-ai-test-"));
  const config = aiConfiguration({ SPESESMART_AI_DATA_DIR: directory, ...env });
  try { await initializeAI(config); await run(config); }
  finally { await chmod(directory, 0o700); await rm(directory, { recursive: true, force: true }); }
}
const rejectsCode = (promise, code) => assert.rejects(promise, e => e.code === code);

test("AI: tariffario, cached input e output contabilizzati una sola volta", async () => {
  assert.equal(usageCost(usage, { input: .4, cachedInput: .1, output: 1.6 }), 3_700_000);
  await fixture(async config => {
    await controlledAnalysis(image, false, async () => response(), config);
    const summary = await getAIUsage(config);
    assert.equal(summary.analyses, 1); assert.equal(summary.inputTokens, 4000); assert.equal(summary.cachedInputTokens, 1000);
    assert.equal(summary.outputTokens, 1500); assert.equal(summary.totalTokens, 5500); assert.equal(summary.estimatedUsd, .0037);
    const ledger = await readFile(join(config.directory, "usage.json"), "utf8");
    for (const privateValue of ["fake-private-image", demoReceipt.merchant, demoReceipt.items[0].originalText]) if (privateValue) assert.equal(ledger.includes(privateValue), false);
    assert.equal((await stat(config.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(config.directory, "usage.json"))).mode & 0o777, 0o600);
  });
});
test("AI: stessa immagine simultanea, cache dopo riavvio e rianalisi volontaria", async () => {
  await fixture(async config => {
    let calls = 0; const call = async () => { calls++; await new Promise(r => setTimeout(r, 60)); return response(); };
    const results = await Promise.all(Array.from({ length: 4 }, () => controlledAnalysis(image, false, call, config)));
    assert.equal(calls, 1); assert.equal(results.filter(r => r.reusedFromCache).length, 3);
    // New configuration/instance; no in-memory cache or counters.
    const restarted = aiConfiguration({ SPESESMART_AI_DATA_DIR: config.directory });
    assert.equal((await controlledAnalysis(image, false, call, restarted)).reusedFromCache, true);
    await controlledAnalysis(image, true, call, restarted); assert.equal(calls, 2);
    const summary = await getAIUsage(config); assert.equal(summary.analyses, 2); assert.equal(summary.cacheHits, 4);
  });
});
test("AI: limite di 100 nuove analisi, cache gratuita anche a limite raggiunto", async () => {
  await fixture(async config => {
    for (let i = 0; i < 100; i++) await controlledAnalysis(Buffer.from(String(i)), false, async () => response(), config);
    let calls = 0;
    await rejectsCode(controlledAnalysis(Buffer.from("101"), false, async () => { calls++; return response(); }, config), "AI_LIMIT");
    assert.equal(calls, 0);
    assert.equal((await controlledAnalysis(Buffer.from("0"), false, async () => { calls++; return response(); }, config)).reusedFromCache, true);
    assert.equal((await getAIUsage(config)).percent, 100);
  });
});
test("AI: prenotazione insufficiente blocca PRIMA dell’API e concorrenza rispetta il budget", async () => {
  await fixture(async config => {
    let calls = 0;
    const out = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => controlledAnalysis(Buffer.from(`unknown-${i}`), false, async () => { calls++; throw new Error("simulated timeout"); }, config)));
    assert.equal(calls, 4); assert.equal(out.filter(x => x.status === "rejected" && x.reason.code === "AI_LIMIT").length, 2);
    const summary = await getAIUsage(config);
    assert.equal(summary.unknown, 4); assert.ok(summary.committedUsd <= 2); assert.ok(summary.percent >= 80); assert.equal(summary.estimatedUsd, 0);
  });
  await fixture(async config => { let calls = 0; await rejectsCode(controlledAnalysis(image, false, async () => { calls++; return response(); }, config), "AI_LIMIT"); assert.equal(calls, 0); }, { SPESESMART_AI_MONTHLY_USD: ".01" });
});
test("AI: timeout e consumo sconosciuto restano prenotati dopo riavvio", async () => {
  await fixture(async config => {
    const timeout = new Error("timeout"); timeout.name = "AbortError";
    await assert.rejects(controlledAnalysis(image, false, async () => { throw timeout; }, config));
    assert.equal(apiError(timeout).status, 504);
    const summary = await getAIUsage(config); assert.equal(summary.unknown, 1); assert.equal(summary.totalTokens, 0);
    assert.equal(summary.committedUsd, usageCost({ input: MAX_AI_INPUT, cached: 0, output: MAX_AI_OUTPUT }, config.tariff) / 1e9);
    await initializeAI(config); assert.equal((await getAIUsage(config)).analyses, 1);
    await rejectsCode(controlledAnalysis(image, false, async () => response(), config), "AI_UNKNOWN");
    await controlledAnalysis(image, true, async () => response(), config); assert.equal((await getAIUsage(config)).analyses, 2);
  });
});
test("AI: errore del parser OpenAI mantiene classificazione e prenotazione", async () => {
  await fixture(async config => {
    await assert.rejects(controlledAnalysis(image, false, async () => { throw new SyntaxError("simulated provider payload"); }, config), e => apiError(e).code === "INVALID_AI");
    assert.equal((await getAIUsage(config)).unknown, 1);
    assert.ok((await getAIUsage(config)).committedUsd > .4);
  });
});
test("AI: output fallito/incompleto e cache corrotta non vengono riutilizzati", async () => {
  await fixture(async config => {
    for (const bad of [{ ...response(), completed: false }, { ...response(), receipt: { status: "receipt" } }, { ...response(), receipt: { ...demoReceipt, status: "unreadable" } }]) await rejectsCode(controlledAnalysis(image, false, async () => bad, config), bad.receipt.status === "unreadable" ? "unreadable" : "INVALID_AI");
    let calls = 0; await controlledAnalysis(image, false, async () => { calls++; return response(); }, config);
    const cache = (await readdir(config.directory)).find(f => f.endsWith(".cache.json"));
    await writeFile(join(config.directory, cache), '{"key":"incompatible"}');
    await controlledAnalysis(image, false, async () => { calls++; return response(); }, config); assert.equal(calls, 2);
    const ledger = JSON.parse(await readFile(join(config.directory, "usage.json"), "utf8"));
    assert.deepEqual(ledger.entries.slice(0, 3).map(e => e.status), ["fallita", "fallita", "fallita"]);
    assert.equal((await getAIUsage(config)).unknown, 0);
  });
});
test("AI: cambio mese Europe/Rome, chiamata contabilizzata nel mese della prenotazione", async () => {
  await fixture(async config => {
    const old = () => new Date("2026-10-31T22:59:00Z"); const next = () => new Date("2026-10-31T23:01:00Z");
    await controlledAnalysis(image, false, async () => response(), config, old);
    assert.equal((await getAIUsage(config, old())).analyses, 1);
    assert.equal((await getAIUsage(config, next())).analyses, 0);
    await controlledAnalysis(image, false, async () => { throw new Error("must reuse"); }, config, next);
    assert.equal((await getAIUsage(config, next())).cacheHits, 1);
    await controlledAnalysis(image, true, async () => response(), config, next);
    assert.equal((await getAIUsage(config, next())).analyses, 1);
  });
});
test("AI: registro mancante, corrotto o pubblico blocca senza API", async () => {
  await fixture(async config => {
    const path = join(config.directory, "usage.json"); let calls = 0; const call = async () => { calls++; return response(); };
    const content = await readFile(path, "utf8");
    await unlink(path); await rejectsCode(controlledAnalysis(image, false, call, config), "AI_STORAGE");
    await writeFile(path, "corrupt", { mode: 0o600 }); await rejectsCode(controlledAnalysis(image, false, call, config), "AI_STORAGE");
    await writeFile(path, content); await chmod(path, 0o644); await rejectsCode(controlledAnalysis(image, false, call, config), "AI_STORAGE");
    assert.equal(calls, 0);
  });
});
test("AI: errore di scrittura dopo la chiamata conserva la prenotazione", async () => {
  await fixture(async config => {
    await rejectsCode(controlledAnalysis(image, false, async () => { await chmod(config.directory, 0o500); return response(); }, config), "AI_STORAGE");
    await chmod(config.directory, 0o700);
    assert.equal((await getAIUsage(config)).unknown, 1);
    assert.ok((await getAIUsage(config)).committedUsd > .4);
  });
});
test("AI: processi Node distinti condividono lock e cache", async () => {
  await fixture(async config => {
    const moduleUrl = new URL("../src/lib/ai-usage.ts", import.meta.url).href;
    const fixtureUrl = new URL("../src/lib/receipts/demo.ts", import.meta.url).href;
    const code = `import {controlledAnalysis,aiConfiguration} from ${JSON.stringify(moduleUrl)}; import {demoReceipt} from ${JSON.stringify(fixtureUrl)}; const c=aiConfiguration({SPESESMART_AI_DATA_DIR:process.argv[1]}); const r=await controlledAnalysis(Buffer.from('child-image'),false,async()=>({receipt:demoReceipt,usage:{input:4000,cached:1000,output:1500},model:'gpt-4.1-mini',completed:true}),c); console.log(r.reusedFromCache);`;
    const child = (script = code, expected = 0) => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", script, config.directory], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = ""; p.stdout.on("data", d => out += d); p.stderr.on("data", d => err += d);
      p.on("error", reject); p.on("close", exit => exit === expected ? resolve(out.trim()) : reject(new Error(err)));
    });
    assert.deepEqual((await Promise.all([child(), child()])).sort(), ["false", "true"]);
    assert.equal((await getAIUsage(config)).analyses, 1);
    const crash = `import {controlledAnalysis,aiConfiguration} from ${JSON.stringify(moduleUrl)}; const c=aiConfiguration({SPESESMART_AI_DATA_DIR:process.argv[1]}); await controlledAnalysis(Buffer.from('crash-image'),false,async()=>{process.exit(7);},c);`;
    await child(crash, 7);
    assert.equal((await getAIUsage(config)).unknown, 1);
    await rejectsCode(controlledAnalysis(Buffer.from("crash-image"), false, async () => response(), config), "AI_UNKNOWN");
    // Kernel released the crashed process' lock; explicit retry remains budgeted.
    await controlledAnalysis(Buffer.from("crash-image"), true, async () => response(), config);
    assert.equal((await getAIUsage(config)).analyses, 3);
  });
});
test("AI: configurazioni senza prenotazione verificabile vengono rifiutate", () => {
  for (const env of [{ OPENAI_RECEIPT_MODEL: "other" }, { VERCEL: "1" }, { SPESESMART_AI_DATA_DIR: process.cwd() }, { SPESESMART_AI_TARIFF_JSON: '{"input":-1,"cachedInput":0,"output":1}' }]) assert.throws(() => aiConfiguration(env), AIControlError);
});
test("AI: usage sconosciuto o oltre i limiti resta prenotato, modello diverso non riusa cache", async () => {
  await fixture(async config => {
    for (const bad of [{ ...response(), usage: null }, { ...response(), usage: { ...usage, input: MAX_AI_INPUT + 1 } }]) await rejectsCode(controlledAnalysis(image, true, async () => bad, config), "INVALID_AI");
    assert.equal((await getAIUsage(config)).unknown, 2);
    await controlledAnalysis(Buffer.from("new"), false, async () => response(), config);
    let calls = 0;
    await controlledAnalysis(Buffer.from("new"), false, async () => { calls++; return response(); }, { ...config, model: "gpt-4.1-mini-2025-04-14" });
    assert.equal(calls, 1);
  });
});
test("AI: endpoint protegge origine, accesso e Vercel; espone solo aggregati", async () => {
  const old = { NODE_ENV: process.env.NODE_ENV, VERCEL: process.env.VERCEL, OPENAI_API_KEY: process.env.OPENAI_API_KEY, SPESESMART_AI_DATA_DIR: process.env.SPESESMART_AI_DATA_DIR, SPESESMART_ACCESS_USER: process.env.SPESESMART_ACCESS_USER, SPESESMART_ACCESS_PASSWORD: process.env.SPESESMART_ACCESS_PASSWORD };
  try {
    process.env.NODE_ENV = "development"; delete process.env.VERCEL;
    const req = (origin) => new Request("http://127.0.0.1:3000/api/receipts/analyze", { method: "POST", headers: { Host: "127.0.0.1:3000", Origin: origin } });
    assert.equal((await receiptPOST(req("https://external.example"))).status, 403);
    assert.equal(aiAccess(req("http://127.0.0.1:3000"), true), null);
    process.env.VERCEL = "1"; assert.equal((await receiptPOST(req("http://127.0.0.1:3000"))).status, 503); delete process.env.VERCEL;
    await fixture(async config => {
      process.env.SPESESMART_AI_DATA_DIR = config.directory;
      const output = await usageGET(new Request("http://127.0.0.1:3000/api/ai/usage"));
      assert.equal(output.status, 200); const body = await output.json();
      assert.equal(body.analyses, 0); assert.equal(body.budgetUsd, 2); assert.equal(body.maxAnalyses, 100);
      assert.equal(JSON.stringify(body).includes(config.directory), false);
      await unlink(join(config.directory, "usage.json"));
      assert.equal((await usageGET(new Request("http://localhost:3000/api/ai/usage"))).status, 503);
    });
    process.env.NODE_ENV = "production"; delete process.env.SPESESMART_ACCESS_USER; delete process.env.SPESESMART_ACCESS_PASSWORD;
    assert.equal(aiAccess(new Request("https://app.example/api/ai/usage")).status, 503);
    process.env.SPESESMART_ACCESS_USER = "test-user"; process.env.SPESESMART_ACCESS_PASSWORD = "test-password";
    assert.equal(aiAccess(new Request("https://app.example/api/ai/usage")).status, 401);
    assert.equal(aiAccess(new Request("https://app.example/api/ai/usage", { headers: { Authorization: `Basic ${Buffer.from("test-user:test-password").toString("base64")}` } })), null);
  } finally { for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
test("audit immagini: byte originali, base64 e duplicati senza dati personali nel resoconto", () => {
  const data = Buffer.from("image-fixture"); const image = `data:image/png;base64,${data.toString("base64")}`;
  const row = ["doc", ...Array(10).fill(""), "11111111-1111-4111-8111-111111111111", "hash", "op", JSON.stringify({ archive: { receipts: [{ Documenti: [{ image, merchant: "private merchant" }] }] } })];
  const report = imageStorageAudit({ Documenti: { rows: [[], row, row] } });
  assert.equal(report.images, 2); assert.equal(report.uniqueImages, 1); assert.equal(report.originalBytes, data.length * 2); assert.equal(report.embeddedBytes, Buffer.byteLength(image) * 2);
  assert.equal(JSON.stringify(report).includes("private merchant"), false); assert.equal(JSON.stringify(report).includes(image), false);
});

test("AI: le cache storiche restano verificabili per backup senza cambiare categorie o consumi", () => {
  const receipt = structuredClone(demoReceipt);
  for (const category of ["Abbonamenti Digitali", "Abbonamenti digitali"]) {
    receipt.items[0].category = category;
    const cache = { key: "a".repeat(64), receipt };
    assert.deepEqual(validateAICache(cache, cache.key), cache);
  }
  receipt.items[0].category = "Categoria sconosciuta";
  assert.throws(() => validateAICache({ key: "a".repeat(64), receipt }, "a".repeat(64)));
});
