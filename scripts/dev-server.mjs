import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { hostOperationsAllowed } from './host-policy.mjs';
import { withHomeWriterLock } from './home-runtime.mjs';

// Same loopback dev command, coordinated with both home-LAN writer launchers.
const args = process.argv.slice(2);
if (args.some(arg => arg.startsWith('--hostname') || arg.startsWith('-H'))) {
  console.error('Dev deve restare su 127.0.0.1: non è consentito cambiare hostname.'); process.exitCode = 1;
} else withHomeWriterLock(async fd => {
  const child = spawn(process.execPath, [join(process.cwd(), 'node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', ...args],
    { detached: true, stdio: ['inherit', 'inherit', 'inherit', fd], env: { ...process.env, SPESESMART_HOME_PRODUCTION: 'false', SPESESMART_LAN_OPERATIONAL: 'false', SPESESMART_LAN_READ_ONLY: String(process.arch === 'arm64' || !hostOperationsAllowed()) } });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  const [code] = await once(child, 'exit'); process.exitCode = code ?? 0;
}).catch(() => { console.error('Avvio dev bloccato: verifica il lock e ferma gli altri server finanziari.'); process.exitCode = 1; });
