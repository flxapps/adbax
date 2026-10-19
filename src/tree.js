// SPDX-License-Identifier: Apache-2.0
/*
 * The accessibility tree as `uiautomator dump` writes it (the on-device server
 * writes the same format), parsed into nodes and reduced to the rows worth
 * showing.
 */

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function unescape(s) {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e];
    return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1));
  });
}

function attributes(s) {
  const a = {};
  const re = /([\w:-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(s))) a[m[1]] = unescape(m[2]);
  return a;
}

/** {width, height, rotation} from the <hierarchy> element, where the server provides it. */
export function screenInfo(xml) {
  const m = xml.match(/<hierarchy([^>]*)>/);
  if (!m) return {};
  const a = attributes(m[1]);
  return { width: +a.width || 0, height: +a.height || 0, rotation: +a.rotation || 0 };
}

export function parseTree(xml) {
  const nodes = [];
  const stack = [];
  const re = /<node((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>|<\/node>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[0] === '</node>') { stack.pop(); continue; }
    const a = attributes(m[1]);
    const b = (a.bounds || '').match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    const n = {
      i: nodes.length,
      cls: (a.class || '').split('.').pop(),
      fullCls: a.class || '',
      text: (a.text || '').trim(),
      desc: (a['content-desc'] || '').trim(),
      hint: (a.hint || '').trim(),
      id: a['resource-id'] || '',
      pkg: a.package || '',
      window: a.window || '',
      clickable: a.clickable === 'true',
      longClickable: a['long-clickable'] === 'true',
      checkable: a.checkable === 'true',
      checked: a.checked === 'true',
      selected: a.selected === 'true',
      scrollable: a.scrollable === 'true',
      enabled: a.enabled !== 'false',
      focused: a.focused === 'true',
      focusable: a.focusable === 'true',
      password: a.password === 'true',
      x1: b ? +b[1] : 0, y1: b ? +b[2] : 0, x2: b ? +b[3] : 0, y2: b ? +b[4] : 0,
      parent: stack.length ? stack[stack.length - 1] : null,
      kids: [],
    };
    n.w = n.x2 - n.x1;
    n.h = n.y2 - n.y1;
    n.cx = Math.round((n.x1 + n.x2) / 2);
    n.cy = Math.round((n.y1 + n.y2) / 2);
    n.editable = /EditText|AutoComplete|TextInputEditText/.test(n.fullCls) ||
      (n.focusable && n.clickable && /Edit/.test(n.fullCls));
    if (n.parent) n.parent.kids.push(n);
    nodes.push(n);
    if (!m[2]) stack.push(n);
  }
  return nodes;
}

/**
 * Up to three labels from a node's descendants, for wrappers that carry none
 * themselves. Clickable descendants are rows of their own (the star button in
 * a list row), so their labels only count when nothing else has one.
 */
function descendantLabels(n, skipClickable, out = [], depth = 0) {
  if (depth > 4 || out.length >= 3) return out;
  for (const k of n.kids) {
    if (skipClickable && (k.clickable || k.editable)) continue;
    const t = k.text || k.desc;
    if (t && !out.includes(t)) out.push(t);
    descendantLabels(k, skipClickable, out, depth + 1);
  }
  return out;
}

export function label(n) {
  if (n.text) return n.text;
  if (n.desc) return n.desc;
  if (n.hint) return '(hint) ' + n.hint;
  const own = descendantLabels(n, true);
  return (own.length ? own : descendantLabels(n, false)).join(' / ');
}

/** "submit" for "com.example:id/submit" inside com.example; the full id otherwise. */
export function shortId(n) {
  if (!n.id) return '';
  const m = n.id.match(/^([^:]+):id\/(.+)$/);
  if (!m) return n.id;
  return m[1] === n.pkg ? m[2] : n.id;
}

export function kind(n) {
  if (n.editable) return 'EDIT';
  if (n.checkable) return n.checked ? 'CHK[x]' : 'CHK[ ]';
  if (n.clickable || n.longClickable) return 'TAP';
  if (n.scrollable) return 'SCRL';
  return 'TXT';
}

export const actionable = (n) => n.clickable || n.longClickable || n.checkable || n.editable;
export const tappable = (n) => n.clickable || n.editable || n.checkable;

/**
 * Reduces the raw tree to the rows worth printing: everything you can act on,
 * scroll containers, and labelled nodes that no actionable ancestor has
 * already absorbed. `all` keeps absorbed labels and unlabelled nodes with ids.
 */
export function interesting(nodes, all = false) {
  const absorbed = new Set();
  const picked = new Set();
  const rows = [];
  for (const n of nodes) {
    if (n.w <= 0 || n.h <= 0 || !actionable(n)) continue;
    // A clickable wrapper eats the labels of its descendants.
    const stack = n.kids.slice();
    while (stack.length) {
      const k = stack.pop();
      if (k.clickable || k.editable || k.scrollable) continue;
      absorbed.add(k.i);
      stack.push(...k.kids);
    }
    rows.push(n);
    picked.add(n.i);
  }
  for (const n of nodes) {
    if (n.w <= 0 || n.h <= 0 || picked.has(n.i)) continue;
    if (n.scrollable) { rows.push(n); continue; }
    if (absorbed.has(n.i) && !all) continue;
    if (n.text || n.desc) rows.push(n);
    else if (all && n.id) rows.push(n);
  }
  rows.sort((a, b) => a.i - b.i);
  return rows;
}

export function renderRow(n, idx, { full = false } = {}) {
  const parts = [`[${idx}]`, kind(n).padEnd(6)];
  const l = label(n);
  parts.push(JSON.stringify(l));
  const sid = shortId(n);
  if (sid) parts.push('id=' + sid);
  if (full) parts.push('cls=' + n.cls);
  if (n.window && n.window !== 'application') parts.push('win=' + n.window);
  parts.push(`@${n.cx},${n.cy}`);
  parts.push(`${n.w}x${n.h}`);
  if (!n.enabled) parts.push('!disabled');
  if (n.focused) parts.push('*focused');
  if (n.selected) parts.push('*selected');
  if (n.password) parts.push('*password');
  if (n.scrollable && !n.clickable) parts.push('*scrollable');
  return '  ' + parts.join('  ');
}

export function render(rows, opts) {
  return rows.map((n, idx) => renderRow(n, idx, opts)).join('\n');
}

/** The compact form `adbax ui --json` prints and `tap <index>` reads back. */
export function rowRecord(n) {
  return {
    i: n.i, k: kind(n), label: label(n), id: shortId(n), fullId: n.id, cls: n.cls,
    x: n.cx, y: n.cy, w: n.w, h: n.h, enabled: n.enabled, checked: n.checked,
  };
}
