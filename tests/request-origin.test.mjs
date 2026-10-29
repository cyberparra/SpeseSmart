import './helpers/isolated-host-policy.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server.js";
import { isSameOriginRequest } from "../src/lib/request-origin.ts";
import { POST } from "../src/app/api/archive/route.ts";

const request = (host, origin, extra = {}) => new Request("http://localhost:3000/api/archive", { method: "POST", headers: { host, ...(origin === undefined ? {} : { origin }), ...extra }, body: "not-json" });

test("CSRF: riproduce normalizzazione NextRequest e accetta soltanto l'origine effettiva locale", () => {
  const next = new NextRequest("http://127.0.0.1:3000/api/archive", { method: "POST", headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-origin" }, body: "not-json" });
  assert.equal(new URL(next.url).hostname, "localhost");
  assert.equal(isSameOriginRequest(next), true);
  for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000"]) assert.equal(isSameOriginRequest(request(host, "http://" + host)), true);
});

test("CSRF: rifiuta origini esterne, alias differenti, porte o protocolli diversi, Host contraffatto e Origin assente", () => {
  for (const [host, origin, extra] of [
    ["127.0.0.1:3000", "http://localhost:3000"],
    ["localhost:3000", "http://127.0.0.1:3000"],
    ["127.0.0.1:3000", "http://127.0.0.1:3001"],
    ["127.0.0.1:3001", "http://127.0.0.1:3001"],
    ["127.0.0.1:3000", "https://127.0.0.1:3000"],
    ["127.0.0.1:3000", "http://external.invalid"],
    ["external.invalid:3000", "http://external.invalid:3000"],
    ["127.0.0.1:3000@external.invalid", "http://external.invalid"],
    ["127.0.0.1:3000", undefined],
    ["127.0.0.1:3000", "null"],
    ["127.0.0.1:3000", "http://127.0.0.1:3000/path"],
    ["127.0.0.1:3000", "http://127.0.0.1:3000", { "sec-fetch-site": "cross-site" }],
    ["127.0.0.1:3000", "http://external.invalid", { "x-forwarded-host": "external.invalid", "x-forwarded-proto": "http" }],
  ]) assert.equal(isSameOriginRequest(request(host, origin, extra)), false, `${host} / ${origin}`);
});

test("CSRF: endpoint consente il loopback corretto, respinge l'esterno e conserva il blocco Vercel senza contattare Google", async () => {
  const keys = ["NODE_ENV", "VERCEL", "SPESESMART_SHEETS_WRITES_ENABLED"];
  const before = keys.map(key => process.env[key]);
  try {
    process.env.NODE_ENV = "development";
    process.env.SPESESMART_SHEETS_WRITES_ENABLED = "true";
    delete process.env.VERCEL;
    const allowed = await POST(request("127.0.0.1:3000", "http://127.0.0.1:3000"));
    assert.equal((await allowed.json()).code, "INVALID");
    const denied = await POST(request("127.0.0.1:3000", "http://external.invalid"));
    assert.equal(denied.status, 403); assert.equal((await denied.json()).code, "CSRF");
    process.env.VERCEL = "1";
    const vercel = await POST(request("127.0.0.1:3000", "http://127.0.0.1:3000"));
    assert.equal(vercel.status, 403); assert.equal((await vercel.json()).code, "WRITES_DISABLED");
  } finally { keys.forEach((key, index) => { if (before[index] === undefined) delete process.env[key]; else process.env[key] = before[index]; }); }
});
