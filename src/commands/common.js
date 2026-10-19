// SPDX-License-Identifier: Apache-2.0
import { parseTree, render, rowRecord } from '../tree.js';

/** What resolve() needs from a device. */
export const selectorSource = (dev) => ({
  nodes: () => dev.tree(),
  lastRows: () => dev.lastRows(),
  where: () => dev.where(),
});

export const selectorOptions = (flags) => ({ nth: flags.nth, first: !!flags.first, regex: !!flags.re });

/** Prints the screen. The server names the top activity with the dump; the shell asks dumpsys. */
export async function showUi(ctx, { afterAction = false } = {}) {
  const { flags } = ctx;
  const dev = await ctx.device();
  const dump = await dev.dump({ afterAction, windows: !!flags.windows });
  if (flags.raw) return ctx.out(dump.xml);
  const nodes = parseTree(dump.xml);
  const rows = dev.saveRows(nodes, !!flags.all);
  if (flags.json) return ctx.out(JSON.stringify(rows.map(rowRecord), null, 2));
  const [where, size] = await Promise.all([(dump.head && dump.head.activity) || dev.where(), dev.screenSize(dump.xml)]);
  ctx.out(`# ${where}   ${size.width}x${size.height}   ${rows.length} nodes` +
    (flags.all ? ' (--all)' : '') + (dump.busy ? '   (still changing: read before it went quiet)' : ''));
  ctx.out(render(rows, { full: !!flags.full }));
  if (!flags.all) ctx.out('# tap by text: adbax tap "Label"   or by index: adbax tap 3   (--all shows every node)');
}

/** `--ui` on an action: show the screen it led to. */
export async function maybeUi(ctx) {
  if (ctx.flags.ui) await showUi(ctx, { afterAction: true });
}

export const KEYS = {
  back: 4, home: 3, recents: 187, apps: 187, enter: 66, tab: 61, del: 67, delete: 67,
  esc: 111, escape: 111, up: 19, down: 20, left: 21, right: 22, menu: 82, search: 84,
  power: 26, volup: 24, voldown: 25, camera: 27, space: 62, dpad_center: 23, ok: 23,
  wake: 224, sleep: 223, notifications: 83, mute: 164, call: 5, endcall: 6, paste: 279,
};
