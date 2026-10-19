// SPDX-License-Identifier: Apache-2.0
import { describe, match, resolve, tappableAncestor } from '../select.js';
import { tappable } from '../tree.js';
import { delay, fail } from '../util.js';
import { KEYS, maybeUi, selectorOptions, selectorSource } from './common.js';

/** Screen pixels for x,y given with --shot, i.e. in the last screenshot's pixels. */
function shotPoint(dev, x, y) {
  return dev.fromShot(x, y) || fail('--shot: no screenshot taken yet on this device');
}

async function target(ctx, usage) {
  const sel = ctx.pos.join(' ') || fail(usage);
  const dev = await ctx.device();
  const r = await resolve(sel, selectorSource(dev), { forTap: true, ...selectorOptions(ctx.flags) });
  if (ctx.flags.shot) {
    if (r.how !== 'coords') fail('--shot only applies to x,y coordinates');
    const [x, y] = shotPoint(dev, r.x, r.y);
    return { dev, r: { x, y, how: `shot ${r.x},${r.y}` } };
  }
  return { dev, r };
}

export async function tap(ctx) {
  const { dev, r } = await target(ctx, 'usage: adbax tap <text|index|x,y>');
  await dev.tap(r.x, r.y);
  ctx.out(`tapped ${r.how} @${r.x},${r.y}`);
  await maybeUi(ctx);
}

export async function longpress(ctx) {
  const { dev, r } = await target(ctx, 'usage: adbax longpress <text|index|x,y> [--dur ms]');
  await dev.swipe(r.x, r.y, r.x, r.y, +(ctx.flags.dur || 900));
  ctx.out(`long-pressed ${r.how} @${r.x},${r.y}`);
  await maybeUi(ctx);
}

export async function type(ctx) {
  const { flags } = ctx;
  const text = ctx.pos.join(' ');
  if (!text && !flags.clear && !flags.set) fail('usage: adbax type <text> [--into <field>] [--clear | --set] [--enter]');
  const dev = await ctx.device();
  let existing = 0;
  if (flags.into) {
    const r = await resolve(String(flags.into), selectorSource(dev), { forTap: true, ...selectorOptions(flags) });
    existing = ((r.node && r.node.text) || '').length;
    await dev.tap(r.x, r.y);
    // Tapping a field often starts a new activity; typing before the field
    // has focus loses the first characters into the outgoing window.
    if (!(await dev.waitForInput(3000))) await delay(600);
    ctx.out(`focused ${r.how}`);
  }
  if (flags.set) {
    // The whole field in one ACTION_SET_TEXT: no keystrokes, nothing left over from what
    // was there, and no IME in between. For long values, where typing over a selection
    // races the field's own state.
    const now = await dev.setText(text);
    if (now === null) fail('adbax: no editable field has focus; tap it first or use --into');
    ctx.out(`set ${JSON.stringify(text)}` + (now !== text ? `  field reads ${JSON.stringify(now)}` : ''));
    return;
  }
  if (flags.clear) await dev.clear(existing);
  let via = '';
  if (text) {
    if (!(await dev.fast()) && /[^\x00-\x7F]/.test(text)) {
      process.stderr.write('adbax: `input text` drops non-ASCII on most builds; check the field.\n');
    }
    via = (await dev.type(text)).via;
  }
  if (flags.enter) await dev.key([66]);
  ctx.out(`typed ${JSON.stringify(text)}` + (via === 'settext' ? ' (set as field text, not keystrokes)' : '') +
    (flags.enter ? ' + enter' : ''));
  if (text && !flags.enter && !flags['no-verify']) {
    await delay((await dev.fast()) ? 100 : 400);
    const f = await dev.focus();
    if (f && f.focused && f.text && f.text !== text && !f.password) {
      ctx.out(`  field now reads ${JSON.stringify(f.text)}` + (f.text.length < text.length ? '  <- short, retry with --clear' : ''));
    }
  }
  await maybeUi(ctx);
}

export async function key(ctx) {
  if (!ctx.pos.length) fail(`usage: adbax key <name|number|KEYCODE_*>...   (${Object.keys(KEYS).join(' ')})`);
  const codes = ctx.pos.map((k) => {
    const lk = k.toLowerCase();
    if (KEYS[lk] !== undefined) return KEYS[lk];
    if (/^\d+$/.test(k)) return +k;
    if (/^KEYCODE_\w+$/i.test(k)) return k.toUpperCase();
    return fail('unknown key: ' + k);
  });
  const dev = await ctx.device();
  await dev.key(codes, { long: !!ctx.flags.long });
  ctx.out('key ' + ctx.pos.join(' '));
  await maybeUi(ctx);
}

function namedKey(code, name) {
  return async (ctx) => {
    await (await ctx.device()).key([code]);
    ctx.out(name);
    await maybeUi(ctx);
  };
}
export const back = namedKey(4, 'back');

/**
 * Closes the soft keyboard if one is showing, and does nothing otherwise. A bare
 * `adbax back` closes the keyboard when it is up and leaves the screen when it is not,
 * which turns a "hide the keyboard" step into a navigation bug.
 */
export async function hideKeyboard(ctx) {
  const dev = await ctx.device();
  if (await dev.keyboardUp()) {
    await dev.key([4]);
    ctx.out('keyboard hidden');
  } else {
    ctx.out('no keyboard');
  }
  await maybeUi(ctx);
}
export const home = namedKey(3, 'home');
export const recents = namedKey(187, 'recents');

export async function swipe(ctx) {
  const { flags } = ctx;
  const a = ctx.pos[0] || fail('usage: adbax swipe <up|down|left|right|x1,y1,x2,y2> [--dur ms] [--in <sel>]');
  const dur = +(flags.dur || 300);
  const dev = await ctx.device();
  let pts;
  if (a.split(',').length === 4) {
    pts = a.split(',').map((v) => +v.trim());
    if (flags.shot) pts = [...shotPoint(dev, pts[0], pts[1]), ...shotPoint(dev, pts[2], pts[3])];
  } else if (!['up', 'down', 'left', 'right'].includes(a)) {
    fail(`swipe: ${a}? Use up, down, left, right or x1,y1,x2,y2.`);
  } else if (flags.in) {
    const n = match(await dev.tree(), String(flags.in), { regex: !!flags.re })[0] || fail(`no node for --in ${flags.in}`);
    const mx = n.cx;
    const my = n.cy;
    const padY = Math.round(n.h * 0.2);
    const padX = Math.round(n.w * 0.15);
    pts = { up: [mx, n.y2 - padY, mx, n.y1 + padY], down: [mx, n.y1 + padY, mx, n.y2 - padY],
      left: [n.x2 - padX, my, n.x1 + padX, my], right: [n.x1 + padX, my, n.x2 - padX, my] }[a];
  } else {
    const { width: W, height: H } = await dev.screenSize();
    // "swipe up" is the finger going up, i.e. scrolling down the content.
    const r = Math.round;
    pts = { up: [r(W / 2), r(H * 0.75), r(W / 2), r(H * 0.28)], down: [r(W / 2), r(H * 0.28), r(W / 2), r(H * 0.75)],
      left: [r(W * 0.85), r(H / 2), r(W * 0.15), r(H / 2)], right: [r(W * 0.15), r(H / 2), r(W * 0.85), r(H / 2)] }[a];
  }
  await dev.swipe(...pts, dur);
  ctx.out(`swipe ${pts.join(' ')} ${dur}`);
  await maybeUi(ctx);
}

export async function scrollTo(ctx) {
  const { flags } = ctx;
  const q = ctx.pos.join(' ') || fail('usage: adbax scroll-to <text> [--max 12] [--dir up|down] [--tap]');
  const max = +(flags.max || 12);
  const contentUp = flags.dir === 'up';
  const dev = await ctx.device();
  for (let i = 0; i <= max; i++) {
    const nodes = await dev.tree({ afterAction: i > 0 });
    const hits = match(nodes, q, { regex: !!flags.re });
    if (hits.length) {
      dev.saveRows(nodes);
      const n = hits[0];
      ctx.out(`found after ${i} swipe(s): ${describe(n)} @${n.cx},${n.cy}`);
      if (flags.tap) {
        const t = tappable(n) ? n : tappableAncestor(n);
        await dev.tap(t.cx, t.cy);
        ctx.out(`tapped it @${t.cx},${t.cy}`);
      }
      return maybeUi(ctx);
    }
    if (i === max) break;
    const sc = nodes.filter((n) => n.scrollable && n.h > 200).sort((a, b) => b.h * b.w - a.h * a.w)[0];
    let x, top, bottom;
    if (sc) {
      const pad = Math.round(sc.h * 0.2);
      [x, top, bottom] = [sc.cx, sc.y1 + pad, sc.y2 - pad];
    } else {
      const { width: W, height: H } = await dev.screenSize();
      [x, top, bottom] = [Math.round(W / 2), Math.round(H * 0.28), Math.round(H * 0.75)];
    }
    if (contentUp) await dev.swipe(x, top, x, bottom, 250);
    else await dev.swipe(x, bottom, x, top, 250);
  }
  fail(`${JSON.stringify(q)} not found after ${max} swipes on ${await dev.where()}`, 2);
}

export async function wait(ctx) {
  const { flags } = ctx;
  const q = ctx.pos.join(' ') || fail('usage: adbax wait <text> [--timeout 15] [--gone]');
  const dev = await ctx.device();
  const deadline = Date.now() + +(flags.timeout || 15) * 1000;
  const interval = await dev.pollInterval();
  while (Date.now() < deadline) {
    const nodes = await dev.tree();
    const hits = match(nodes, q, { regex: !!flags.re });
    if (flags.gone ? !hits.length : hits.length) {
      dev.saveRows(nodes);
      if (hits.length) ctx.out(`ready: ${describe(hits[0])} @${hits[0].cx},${hits[0].cy}`);
      else ctx.out(`gone: ${JSON.stringify(q)}`);
      return maybeUi(ctx);
    }
    await delay(interval);
  }
  fail(`timed out waiting for ${JSON.stringify(q)}${flags.gone ? ' to disappear' : ''} on ${await dev.where()}`, 2);
}
