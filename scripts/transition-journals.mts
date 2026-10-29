import { transitionJournals } from '../src/lib/journal-transition';
Object.assign(process.env, { NODE_ENV: 'production' });
const [action, fingerprint, ...extra] = process.argv.slice(2);
try {
  if (!['plan', 'apply', 'rollback'].includes(action) || extra.length || (action === 'plan' && fingerprint)) throw Error();
  console.log(JSON.stringify(await transitionJournals(process.env, action as 'plan' | 'apply' | 'rollback', fingerprint)));
} catch { console.error('Transizione journal non completata. Conservare originali e guard; consultare la procedura.'); process.exitCode = 1; }
