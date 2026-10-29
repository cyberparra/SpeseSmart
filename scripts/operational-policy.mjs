import { createInterface } from 'node:readline/promises';
import { withHomeWriterLock } from './home-runtime.mjs';
import { readHostPolicy, saveHostPolicy } from './host-policy.mjs';
const command = process.argv[2] || 'status';
try {
  if (command === 'status') { const policy = readHostPolicy(); console.log(JSON.stringify({ ...policy, piAuthorized: policy.valid && policy.configured && policy.role === 'raspberry' })); if (!policy.valid) process.exitCode = 1; }
  else {
    const roles = { disable: 'disabled', 'enable-pc': 'pc', 'enable-pi': 'raspberry' };
    if (!roles[command] || !process.stdin.isTTY || !process.stdout.isTTY) throw Error();
    if (command === 'enable-pi' && (process.platform !== 'linux' || process.arch !== 'arm64')) throw Error();
    await withHomeWriterLock(async () => {
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const expected = command === 'disable' ? 'DISABILITA QUESTO HOST' : 'ALTRO HOST FERMO E DISABILITATO';
        if (await prompt.question(`Intervento amministrativo locale, non fencing distribuito. Digita ${expected}: `) !== expected) throw Error();
        await saveHostPolicy(roles[command]);
        console.log('Policy locale aggiornata e verificata. Nessun server avviato.');
      } finally { prompt.close(); }
    });
  }
} catch { console.error('Policy non aggiornata: comando, conferma, lock o permessi non validi. Nessuna credenziale modificata.'); process.exitCode = 1; }
