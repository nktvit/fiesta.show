import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDiskutil, isExternalHdd } from './disk-guard.mjs';

const monster = `   Volume Name:               Monster
   Protocol:                  USB
   Device Location:           External
   Solid State:               No`;
const boot = `   Volume Name:               Macintosh HD
   Protocol:                  Apple Fabric
   Device Location:           Internal
   Solid State:               Yes`;

test('the external USB hard drive is accepted', () => assert.equal(isExternalHdd(parseDiskutil(monster)), true));
test('the internal SSD boot disk is refused', () => assert.equal(isExternalHdd(parseDiskutil(boot)), false));
test('an external SSD is refused too (only the HDD is meant for bulk downloads)', () =>
  assert.equal(isExternalHdd(parseDiskutil(monster.replace('No', 'Yes'))), false));
test('missing fields are refused', () => assert.equal(isExternalHdd(parseDiskutil('')), false));
