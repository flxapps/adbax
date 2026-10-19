// SPDX-License-Identifier: Apache-2.0
import { kind, label, shortId, tappable } from './tree.js';
import { fail } from './util.js';

const norm = (s) => (s || '').toLowerCase().trim();

/**
 * How well a node matches a query: exact before prefix before substring, and
 * within each, text before content-desc before hint and resource-id.
 */
function score(n, q, re) {
  const fields = [n.text, n.desc, n.hint, shortId(n), n.id];
  let best = 0;
  fields.forEach((f, i) => {
    if (!f) return;
    const weight = i === 0 ? 0 : i === 1 ? 1 : 4;
    if (re) { if (re.test(f)) best = Math.max(best, 80 - weight); return; }
    const nf = norm(f);
    if (nf === q) best = Math.max(best, 100 - weight);
    else if (nf.startsWith(q)) best = Math.max(best, 75 - weight);
    else if (nf.includes(q)) best = Math.max(best, 55 - weight);
  });
  return best;
}

/** The best-scoring nodes for a query; several only when they tie (within 4 points). */
export function match(nodes, query, { regex = false, preferTappable = false } = {}) {
  const re = regex ? new RegExp(query, 'i') : null;
  const q = norm(query);
  const hits = nodes
    .filter((n) => n.w > 0 && n.h > 0)
    .map((n) => ({ n, s: score(n, q, re) }))
    .filter((h) => h.s > 0);
  if (!hits.length) return [];
  // A tap prefers something you can actually tap.
  if (preferTappable) hits.forEach((h) => { if (tappable(h.n)) h.s += 12; });
  hits.sort((a, b) => b.s - a.s || a.n.i - b.n.i);
  const top = hits[0].s;
  return hits.filter((h) => h.s >= top - 4).map((h) => h.n);
}

export function tappableAncestor(n) {
  for (let c = n; c; c = c.parent) if (c.clickable && c.enabled) return c;
  return n;
}

/** One line describing a node, for messages. */
export function describe(n) {
  const sid = shortId(n);
  return `${kind(n)} ${JSON.stringify(label(n))}${sid ? ' id=' + sid : ''}`;
}

/**
 * Resolves a selector to a point: "540,1200" is taken as is, "3" or "#3" is a
 * row of the last `adbax ui`, anything else is matched against a fresh tree.
 *
 * `ctx` supplies the tree (`nodes()`), the last rows (`lastRows()`) and a line
 * naming the current screen for error messages (`where()`).
 */
export async function resolve(sel, ctx, { forTap = false, nth, first = false, regex = false } = {}) {
  if (/^-?\d+\s*,\s*-?\d+$/.test(sel)) {
    const [x, y] = sel.split(',').map((v) => +v.trim());
    return { x, y, how: 'coords' };
  }
  if (/^#?\d+$/.test(sel)) {
    const idx = +sel.replace('#', '');
    const rows = ctx.lastRows();
    if (!rows) fail('no cached dump. Run `adbax ui` first, or select by text.');
    const r = rows[idx] || fail(`index ${idx} not in the last dump (${rows.length} rows).`);
    return { x: r.x, y: r.y, how: `[${idx}] ${r.k} ${JSON.stringify(r.label)}` };
  }
  const nodes = await ctx.nodes();
  let hits = match(nodes, sel, { regex, preferTappable: forTap });
  if (!hits.length) {
    fail(`no node matching ${JSON.stringify(sel)}.\n       Current screen: ${await ctx.where()}\n` +
      '       Run `adbax ui` to see what is there.');
  }
  if (nth !== undefined) {
    const k = +nth;
    if (!hits[k]) fail(`--nth ${k} out of range (${hits.length} matches).`);
    hits = [hits[k]];
  }
  if (hits.length > 1 && !first) {
    const lines = hits.map((n, k) => `  --nth ${k}  ${describe(n)} @${n.cx},${n.cy}`);
    fail(`${JSON.stringify(sel)} matches ${hits.length} nodes:\n${lines.join('\n')}\n` +
      '       Narrow the query, or add --nth N / --first.', 2);
  }
  const hit = hits[0];
  const target = forTap && !tappable(hit) ? tappableAncestor(hit) : hit;
  const sid = shortId(target);
  return {
    x: target.cx, y: target.cy, node: target,
    how: `${kind(target)} ${JSON.stringify(label(hit))}${sid ? ' id=' + sid : ''}`,
  };
}
