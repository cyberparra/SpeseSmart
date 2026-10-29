import { fixturePiConfig as config } from './helpers/pi-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMigrationMount } from '../scripts/pi-migration-check.mjs';
const disk = { target: '/srv/spesesmart', uuid: config.ssdUUID, fstype: 'ext4', options: 'rw,nosuid,nodev,relatime' };
test('Preparazione Pi: SSD corretto, nessuna capability operativa', () => assert.doesNotThrow(() => validateMigrationMount({ filesystems: [disk] }, config)));
for (const [name, value] of Object.entries({ assente: {}, ambiguo: { filesystems: [disk, disk] }, UUID: { filesystems: [{ ...disk, uuid: 'altro' }] }, directory: { filesystems: [{ ...disk, target: '/' }] }, filesystem: { filesystems: [{ ...disk, fstype: 'tmpfs' }] }, readonly: { filesystems: [{ ...disk, options: 'ro,nosuid' }] } })) {
  test(`Preparazione Pi: rifiuta ${name}`, () => assert.throws(() => validateMigrationMount(value, config)));
}
