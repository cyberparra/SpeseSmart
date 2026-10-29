import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, chmod, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { renderPiService } from '../scripts/pi-install.mts';
import { fixturePiConfig } from './helpers/pi-config.mjs';
const unit = renderPiService(fixturePiConfig, '/etc/spesesmart/pi.json');
test('systemd Pi: identità parametrica, mount necessario, fail-closed e drain', () => {
  for (const line of ['User=spesesmart', 'WorkingDirectory=/srv/spesesmart/app', 'BindsTo=srv-spesesmart.mount', 'RequiresMountsFor=/srv/spesesmart', 'After=network-online.target srv-spesesmart.mount', 'Restart=on-failure', 'RestartSec=30', 'StartLimitBurst=3', 'KillMode=mixed', 'KillSignal=SIGTERM', 'TimeoutStopSec=360', 'ProtectSystem=strict', 'LimitCORE=0']) assert.ok(unit.split('\n').includes(line), line);
  assert.match(unit, /ExecCondition=.*node .*scripts\/pi-service-check\.mts/);
  assert.match(unit, /ExecStart=\/usr\/local\/bin\/node scripts\/lan-server\.mjs pi-production/);
  assert.doesNotMatch(unit, /@|npm-cli|nvm|39443|pi:preview|devices:setup|EnvironmentFile=/);
  const other = renderPiService({ ...fixturePiConfig, mount: '/opt/spese', app: '/opt/spese/app', data: '/opt/spese/data', home: '/home/altro', user: 'altro', node: '/opt/node/bin/node' }, '/etc/spese/pi.json');
  assert.match(other, /BindsTo=opt-spese.mount/);
  assert.match(other, /User=altro/);
  assert.doesNotMatch(other, /srv\/spesesmart|home\/spesesmart/);
});
test('systemd Pi: SIGTERM al launcher diretto e attende drain sintetico', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spesesmart-systemd-')); await chmod(root, 0o700);
  let child;
  try {
    await mkdir(join(root, 'scripts'));
    const events = join(root, 'events.log');
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { 'pi:production': 'node scripts/lan-server.mjs pi-production' } }));
    await writeFile(join(root, 'scripts/lan-server.mjs'), `import {appendFileSync} from 'node:fs'; const log=${JSON.stringify(events)}; const timer=setInterval(()=>{},1000); appendFileSync(log,'ready\\n'); process.once('SIGTERM',()=>{appendFileSync(log,'drain\\n');setTimeout(()=>{appendFileSync(log,'complete\\n');clearInterval(timer);},200);});`);
    child = spawn(process.execPath, ['scripts/lan-server.mjs', 'pi-production'], { cwd: root, env: { PATH: process.env.PATH, HOME: root }, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.resume(); const ended = once(child, 'exit');
    for (let n = 0; ; n++) {
      if ((await readFile(events, 'utf8').catch(() => '')).includes('ready')) break;
      if (n > 150 || child.exitCode !== null) throw Error('Fixture non pronta');
      await new Promise(ok => setTimeout(ok, 20));
    }
    child.kill('SIGTERM');
    await Promise.race([ended, new Promise((_, fail) => { const timer = setTimeout(() => fail(Error('Drain timeout')), 5000); timer.unref(); })]);
    assert.equal(await readFile(events, 'utf8'), 'ready\ndrain\ncomplete\n');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await rm(root, { recursive: true, force: true });
  }
});
