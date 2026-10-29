// This module is imported only by the isolated preview, never by application APIs.
import { createServer, request } from 'node:http';
import { romeDate } from '../src/lib/calendar.ts';
import { createDraft, prepareConfirmation } from '../src/lib/receipts/model.ts';
import { demoReceipt } from '../src/lib/receipts/demo.ts';

export function previewArchive() {
  const analysis = structuredClone(demoReceipt);
  analysis.date = romeDate(); analysis.merchant = 'COLLAUDO — Market fittizio';
  analysis.warnings = ['Dati esclusivamente sintetici, nessuna analisi AI.'];
  let id = 0;
  const receipt = prepareConfirmation(createDraft(analysis, () => `preview-product-${++id}`), analysis, '', false, () => `preview-receipt-${++id}`);
  const notes = 'COLLAUDO ISOLATO: dati inventati, nessun collegamento a Google Sheets.';
  const expenses = receipt.Movimenti.map(m => ({ ...m, amount: m.amountCents / 100, notes }));
  expenses.push({ id: 'preview-manual', merchant: 'COLLAUDO — Spesa manuale fittizia', date: romeDate(), category: 'Trasporti', amount: 7, source: 'Manuale', notes });
  return { archive: { expenses, receipts: [receipt] }, persistedIds: expenses.map(e => e.id), editablePurchases: {}, pendingEdits: [], pendingDeletions: [], writesEnabled: false, lanReadOnly: true, lanOperational: false, previewOnly: true, warnings: [notes] };
}

export function fixtureProxy(nextPort) {
  return createServer((incoming, outgoing) => {
    const json = (status, value) => { outgoing.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); outgoing.end(JSON.stringify(value)); };
    if (!['GET', 'HEAD'].includes(incoming.method)) return json(403, { error: 'Collaudo isolato: tutte le operazioni sono disabilitate.', code: 'PREVIEW_ONLY' });
    if (incoming.url === '/api/archive?view=dashboard') return json(200, previewArchive());
    if (incoming.url === '/api/ai/usage') return json(503, { error: 'Collaudo isolato: nessun registro AI personale disponibile.', code: 'PREVIEW_ONLY' });
    // No API, Server Action, image optimizer or arbitrary path ever reaches Next.
    if (!(incoming.url === '/' || incoming.url === '/favicon.ico' || /^\/_next\/static\/[A-Za-z0-9_./%()-]+$/.test(incoming.url ?? '')) || incoming.url?.includes('..') || incoming.url?.endsWith('.map')) return json(403, { error: 'Risorsa estranea al collaudo.', code: 'PREVIEW_ONLY' });
    const backend = request({ hostname: '127.0.0.1', port: nextPort, method: incoming.method, path: incoming.url, headers: { host: `127.0.0.1:${nextPort}` }, timeout: 15000 }, response => {
      outgoing.writeHead(response.statusCode, { 'Content-Type': response.headers['content-type'] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }); response.pipe(outgoing);
    });
    backend.on('timeout', () => backend.destroy());
    backend.on('error', () => { if (!outgoing.headersSent) json(502, { error: 'Backend di collaudo non disponibile.' }); else outgoing.destroy(); });
    backend.end();
  });
}
