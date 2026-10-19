// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { match } from '../select.js';
import { kind, label, shortId } from '../tree.js';
import { cachePath, fail } from '../util.js';
import { selectorOptions, showUi } from './common.js';

export async function ui(ctx) {
  await showUi(ctx);
}

export async function find(ctx) {
  const q = ctx.pos.join(' ') || fail('usage: adbax find <text>');
  const dev = await ctx.device();
  const nodes = await dev.tree();
  const hits = match(nodes, q, { regex: !!ctx.flags.re });
  if (!hits.length) fail(`no match for ${JSON.stringify(q)} on ${await dev.where()}`, 2);
  const rows = dev.saveRows(nodes, !!ctx.flags.all);
  for (const n of hits) {
    const idx = rows.indexOf(n);
    const id = shortId(n);
    ctx.out(`${idx > -1 ? `[${idx}]` : '[-]'}  ${kind(n).padEnd(6)}  ${JSON.stringify(label(n))}  ${id ? `id=${id}  ` : ''}` +
      `cls=${n.cls}  @${n.cx},${n.cy}  ${n.w}x${n.h}${n.enabled ? '' : '  !disabled'}`);
  }
}

export async function inspect(ctx) {
  const q = ctx.pos.join(' ') || fail('usage: adbax inspect <query>');
  const dev = await ctx.device();
  const nodes = await dev.tree();
  const opts = selectorOptions(ctx.flags);
  const hits = match(nodes, q, { regex: opts.regex });
  const n = hits[opts.nth !== undefined ? +opts.nth : 0] || fail(`no node matching ${JSON.stringify(q)}`, 2);
  ctx.out(JSON.stringify({
    class: n.fullCls, text: n.text, 'content-desc': n.desc, hint: n.hint, 'resource-id': n.id, package: n.pkg,
    bounds: `[${n.x1},${n.y1}][${n.x2},${n.y2}]`, center: [n.cx, n.cy], size: [n.w, n.h],
    clickable: n.clickable, longClickable: n.longClickable, editable: n.editable, checkable: n.checkable,
    checked: n.checked, scrollable: n.scrollable, enabled: n.enabled, focused: n.focused,
    focusable: n.focusable, password: n.password,
  }, null, 2));
  const chain = [];
  for (let a = n.parent; a; a = a.parent) {
    chain.unshift(a.cls + (shortId(a) ? '#' + shortId(a) : '') + (a.clickable ? '(clickable)' : ''));
  }
  ctx.out('ancestors: ' + chain.join(' > '));
  if (hits.length > 1) ctx.out(`(${hits.length} matches; --nth N picks another)`);
}

export async function current(ctx) {
  const dev = await ctx.device();
  ctx.out(await dev.where());
  const a = (await dev.adb.shell("dumpsys activity activities 2>/dev/null | grep -m1 'ResumedActivity'", { soft: true })).trim();
  if (a) ctx.out(a);
}

/** Resizes or converts on the host where the device could not; only macOS has a tool for it built in. */
function convertOnHost(file, { width, jpeg }) {
  if (process.platform !== 'darwin') return false;
  const args = [];
  if (width) args.push('--resampleWidth', String(width));
  if (jpeg) args.push('-s', 'format', 'jpeg');
  try {
    execFileSync('sips', [...args, file, '--out', file], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes a screenshot. Prints the path on stdout and the image size on stderr;
 * `tap x,y --shot` later takes coordinates in this image's pixels.
 */
export async function screenshot(ctx) {
  const { flags } = ctx;
  const dev = await ctx.device();
  let dest = path.resolve(ctx.pos[0] || cachePath(flags.small || flags.grid ? 'shot.jpg' : 'shot.png'));
  const width = +(flags.width || flags.scale || 0) || (flags.small || flags.grid ? 540 : 0);
  const grid = flags.grid ? (flags.grid === true ? Math.round((width || 540) / 6) : +flags.grid) : 0;
  const jpeg = /\.jpe?g$/i.test(dest);
  const shot = await dev.screenshot({ width, grid, format: jpeg ? 'jpeg' : 'png', quality: +(flags.quality || 80) });
  fs.writeFileSync(dest, shot.data);
  if (grid && !shot.scaled) process.stderr.write('adbax: --grid needs the on-device server; saved without it\n');
  const device = shot.screenWidth ? { width: shot.screenWidth, height: shot.screenHeight } : await dev.screenSize();
  let w = shot.width || (width || device.width);
  if (!shot.scaled && (width || jpeg) && !convertOnHost(dest, { width, jpeg })) {
    if (jpeg) {
      const png = dest.replace(/\.jpe?g$/i, '.png');
      fs.renameSync(dest, png);
      dest = png;
    }
    w = device.width;
    process.stderr.write('adbax: no on-device server and no host image tool; kept the full-size PNG\n');
  }
  const h = shot.height || Math.round(device.height * w / device.width);
  dev.saveShot({ width: w, height: h, deviceWidth: device.width, deviceHeight: device.height });
  ctx.out(dest);
  if (w !== device.width) process.stderr.write(`${w}x${h} of ${device.width}x${device.height}: tap x,y --shot takes these pixels\n`);
}

export async function record(ctx) {
  const dev = await ctx.device();
  const secs = Math.min(+(ctx.pos[0] || 15), 180);
  const dest = path.resolve(ctx.pos[1] || cachePath('rec.mp4'));
  process.stderr.write(`recording ${secs}s ...\n`);
  await dev.adb.shell(`screenrecord --time-limit ${secs} --bit-rate 4000000 /sdcard/adbax-rec.mp4`, { timeout: (secs + 30) * 1000 });
  await dev.adb.run(['pull', '/sdcard/adbax-rec.mp4', dest], { soft: true });
  await dev.adb.shell('rm -f /sdcard/adbax-rec.mp4', { soft: true });
  ctx.out(dest);
}
