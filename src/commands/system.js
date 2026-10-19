// SPDX-License-Identifier: Apache-2.0
/* Logs, device settings for screenshots, and raw adb passthrough. */
import { fail, q } from '../util.js';

export async function log(ctx) {
  const { flags } = ctx;
  const pkg = ctx.pos[0];
  const dev = await ctx.device();
  const args = ['logcat', '-d', '-v', 'brief', '-t', String(flags.lines || 200)];
  if (pkg) {
    const pid = (await dev.adb.shell(`pidof ${q(pkg)}`, { soft: true })).trim().split(/\s+/)[0];
    if (!pid) fail(`${pkg} is not running (no pid). Start it first, or drop the package argument.`);
    args.push('--pid=' + pid);
  }
  if (flags.level) args.push('*:' + String(flags.level).toUpperCase());
  let out = await dev.adb.run(args, { soft: true });
  if (flags.grep) {
    const re = new RegExp(String(flags.grep), 'i');
    out = out.split('\n').filter((l) => re.test(l)).join('\n');
  }
  ctx.out(out.trim());
}

export async function crash(ctx) {
  const dev = await ctx.device();
  const out = (await dev.adb.run(['logcat', '-b', 'crash', '-d', '-t', String(ctx.flags.lines || 120)], { soft: true })).trim();
  ctx.out(out || '(crash buffer empty)');
}

export async function clearlog(ctx) {
  const dev = await ctx.device();
  await dev.adb.run(['logcat', '-c'], { soft: true });
  await dev.adb.run(['logcat', '-b', 'crash', '-c'], { soft: true });
  ctx.out('log buffers cleared');
}

export async function dark(ctx) {
  const on = ctx.pos[0] !== 'off';
  await (await ctx.device()).adb.shell(`cmd uimode night ${on ? 'yes' : 'no'}`);
  ctx.out('dark mode ' + (on ? 'on' : 'off'));
}

export async function font(ctx) {
  const s = ctx.pos[0] || fail('usage: adbax font <0.85|1.0|1.3|2.0>');
  if (!/^\d+(\.\d+)?$/.test(s)) fail('font: a scale like 1.0 or 1.3');
  await (await ctx.device()).adb.shell(`settings put system font_scale ${s}`);
  ctx.out('font_scale ' + s);
}

export async function anim(ctx) {
  const on = ctx.pos[0] !== 'off';
  const dev = await ctx.device();
  const v = on ? '1.0' : '0.0';
  await dev.adb.shell(['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']
    .map((k) => `settings put global ${k} ${v}`).join('; '));
  ctx.out('animations ' + (on ? 'on' : 'off'));
}

export async function rotate(ctx) {
  const d = ctx.pos[0] || fail('usage: adbax rotate <0|90|180|270|auto>');
  const dev = await ctx.device();
  if (d === 'auto') {
    await dev.adb.shell('settings put system accelerometer_rotation 1');
    return ctx.out('rotation: auto');
  }
  const r = { 0: 0, 90: 1, 180: 2, 270: 3 }[d];
  if (r === undefined) fail('rotate: 0, 90, 180, 270 or auto');
  await dev.adb.shell(`settings put system accelerometer_rotation 0; settings put system user_rotation ${r}`);
  ctx.out('rotation ' + d);
}

/** SystemUI demo mode: a clean status bar for store screenshots. */
export async function demo(ctx) {
  const on = ctx.pos[0] !== 'off';
  const dev = await ctx.device();
  const b = (extras) => `am broadcast -a com.android.systemui.demo ${extras}`;
  if (!on) {
    await dev.adb.shell(b('-e command exit'), { soft: true });
    return ctx.out('demo mode off');
  }
  await dev.adb.shell(['settings put global sysui_demo_allowed 1',
    b('-e command enter'),
    b('-e command clock -e hhmm 1000'),
    b('-e command battery -e level 100 -e plugged false'),
    b('-e command network -e wifi show -e level 4'),
    b('-e command network -e mobile show -e datatype none -e level 4'),
    b('-e command notifications -e visible false')].join(' >/dev/null; '), { soft: true });
  ctx.out('demo mode on (clean status bar for store screenshots)');
}

export async function shell(ctx) {
  if (!ctx.pos.length) fail('usage: adbax shell <command>');
  ctx.out((await (await ctx.device()).adb.shell(ctx.pos.join(' '))).trim());
}

export async function pull(ctx) {
  ctx.out((await (await ctx.device()).adb.run(['pull', ...ctx.pos])).trim());
}

export async function push(ctx) {
  ctx.out((await (await ctx.device()).adb.run(['push', ...ctx.pos])).trim());
}
