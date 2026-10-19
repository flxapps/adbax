// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';
import { fail, q } from '../util.js';
import { maybeUi } from './common.js';

export async function apps(ctx) {
  const filter = (ctx.pos[0] || '').toLowerCase();
  const dev = await ctx.device();
  const out = await dev.adb.shell(`pm list packages ${ctx.flags.system ? '' : '-3'}`, { soft: true });
  ctx.out(out.split('\n').map((l) => l.replace('package:', '').trim()).filter(Boolean)
    .filter((p) => !filter || p.toLowerCase().includes(filter)).sort().join('\n'));
}

/** Starts the launcher activity and waits until it is drawn (`am start -W`). */
export async function launch(ctx) {
  const pkg = ctx.pos[0] || fail('usage: adbax launch <package>');
  const dev = await ctx.device();
  const comp = (await dev.adb.shell(
    `cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${q(pkg)} | tail -n 1`, { soft: true })).trim();
  if (comp.includes('/')) await dev.adb.shell(`am start -W -n ${q(comp)}`, { soft: true, timeout: 30_000 });
  else {
    const out = await dev.adb.shell(`monkey -p ${q(pkg)} -c android.intent.category.LAUNCHER 1 2>&1 || true`, { soft: true });
    if (/No activities found/i.test(out)) fail(`${pkg} is not installed or has no launcher activity. \`adbax apps\` lists packages.`, 2);
  }
  ctx.out(`launched ${pkg} -> ${await dev.where()}`);
  await maybeUi(ctx);
}

export async function start(ctx) {
  const comp = ctx.pos[0] || fail('usage: adbax start <pkg/.Activity>');
  const dev = await ctx.device();
  ctx.out((await dev.adb.shell(`am start -W -n ${q(comp)}`)).trim());
  await maybeUi(ctx);
}

export async function stop(ctx) {
  const pkg = ctx.pos[0] || fail('usage: adbax stop <package>');
  await (await ctx.device()).adb.shell(`am force-stop ${q(pkg)}`);
  ctx.out('stopped ' + pkg);
}

export async function clear(ctx) {
  const pkg = ctx.pos[0] || fail('usage: adbax clear <package>');
  ctx.out((await (await ctx.device()).adb.shell(`pm clear ${q(pkg)}`)).trim());
}

/**
 * -r -g -t: replace, grant runtime permissions, allow test builds. Several
 * files (a base APK plus splits) go in as one install-multiple.
 */
export async function install(ctx) {
  if (!ctx.pos.length) fail('usage: adbax install <file.apk> [split.apk ...]');
  const files = ctx.pos.map((f) => path.resolve(f));
  const dev = await ctx.device();
  const verb = files.length > 1 ? 'install-multiple' : 'install';
  ctx.out((await dev.adb.run([verb, '-r', '-g', '-t', ...files], { timeout: 300_000 })).trim());
}

export async function uninstall(ctx) {
  const pkg = ctx.pos[0] || fail('usage: adbax uninstall <package>');
  ctx.out((await (await ctx.device()).adb.run(['uninstall', pkg])).trim());
}

export async function deeplink(ctx) {
  const url = ctx.pos[0] || fail('usage: adbax deeplink <url> [package]');
  const dev = await ctx.device();
  const pkg = ctx.pos[1] ? ` -p ${q(ctx.pos[1])}` : '';
  ctx.out((await dev.adb.shell(`am start -W -a android.intent.action.VIEW -d ${q(url)}${pkg}`, { soft: true })).trim());
  ctx.out('-> ' + await dev.where());
  await maybeUi(ctx);
}

export async function perm(ctx) {
  const [action, pkg, ...perms] = ctx.pos;
  if (!['grant', 'revoke'].includes(action) || !pkg || !perms.length) {
    fail('usage: adbax perm <grant|revoke> <package> <PERMISSION...>');
  }
  const dev = await ctx.device();
  for (const p of perms) {
    const full = p.includes('.') ? p : 'android.permission.' + p.toUpperCase();
    await dev.adb.shell(`pm ${action} ${q(pkg)} ${q(full)}`, { soft: true });
    ctx.out(`${action} ${full}`);
  }
}

export async function perms(ctx) {
  const pkg = ctx.pos[0] || fail('usage: adbax perms <package>');
  const out = await (await ctx.device()).adb.shell(`dumpsys package ${q(pkg)} | sed -n '/runtime permissions:/,/^$/p'`, { soft: true });
  ctx.out(out.trim() || '(none granted)');
}
