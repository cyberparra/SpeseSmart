// Export local import files only: no credentials, SDK or network.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const directory = process.argv[2];
if (!directory) throw Error('Uso: node scripts/sheets-template.mjs DIRECTORY_NUOVA');
const target = resolve(directory);
await mkdir(target, { mode: 0o700 });
const template = JSON.parse(await readFile(new URL('../docs/google-sheets-template.json', import.meta.url), 'utf8'));
for (const sheet of template.sheets) {
  const text = sheet.rows.map(row => row.map(cell => '"' + String(cell).replaceAll('"', '""') + '"').join(',')).join('\n') + '\n';
  await writeFile(join(target, sheet.title + '.csv'), text, { flag: 'wx', mode: 0o600 });
}
console.log('Creati cinque CSV strutturali da importare nelle schede omonime del proprio foglio vuoto.');
