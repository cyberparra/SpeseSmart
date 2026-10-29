import { piConfig } from './pi-config.mjs';
// ExecCondition only: no bind, API calls, initialization, lock creation or recovery.
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { preparePiProduction, piProductionTLS, PI_DATA } from './pi-production-profile.mjs';
import { privateLANFile, validateLANCredentials } from './lan-credentials.mjs';
import { homePreflight } from './home-preflight.mjs';
import { configuredTailscaleHostname } from './tailscale-ingress.mjs';
try {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw Error();
  await preparePiProduction();
  configuredTailscaleHostname(process.env, true);
  await piProductionTLS(piConfig().ip);
  if (process.env.SPESESMART_MULTIUSER !== 'true') validateLANCredentials(JSON.parse(await privateLANFile(join(PI_DATA, 'lan/access.json'))));
  await access('.next/BUILD_ID');
  const state = await homePreflight(process.env, false, true);
  console.log(`Preflight servizio valido: pending=${state.pending}, unknownAI=${state.unknownAI}, recovery=${state.recovery}. Nessuna ripresa automatica.`);
} catch {
  console.error('Avvio servizio impedito: verificare SSD UUID, policy, configurazione privata, TLS, build e registri. Nessun dato modificato.');
  // ExecCondition exit 1..254 skips ExecStart, without automatic restart storms.
  process.exitCode = 78;
}
