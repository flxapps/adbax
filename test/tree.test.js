// SPDX-License-Identifier: Apache-2.0
// A real `uiautomator dump` (Settings, Android 8.1) frozen in a file: if a
// release renames or drops an attribute adbax relies on, it fails here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { resolve } from '../src/select.js';
import { interesting, label, parseTree } from '../src/tree.js';

const xml = fs.readFileSync(new URL('./fixtures/settings-api27.xml', import.meta.url), 'utf8');

test('a uiautomator dump parses into labelled, tappable rows', async () => {
  const nodes = parseTree(xml);
  const rows = interesting(nodes);
  assert.equal(rows.length, 11);

  const network = rows[5];
  assert.equal(label(network), 'Network & Internet / Wi‑Fi, mobile, data usage');
  assert.deepEqual([network.cx, network.cy, network.w, network.h], [540, 903, 1080, 189]);
  assert.equal(network.id, 'com.android.settings:id/dashboard_tile');
  assert.ok(network.clickable && network.enabled);

  // The text sits on a TextView inside the tile; a tap resolves to the tile.
  const source = { nodes: async () => nodes, lastRows: () => null, where: async () => 'test' };
  const hit = await resolve('network & internet', source, { forTap: true });
  assert.deepEqual([hit.x, hit.y], [540, 903]);

  await assert.rejects(resolve('dashboard_tile', source, { forTap: true }), (e) => e.code === 2);
});
