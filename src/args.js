// SPDX-License-Identifier: Apache-2.0

/** Flags that take a value: `--timeout 15` and `--timeout=15` both work. */
const NEEDS_VALUE = new Set(['serial', 'settle', 'nth', 'timeout', 'max', 'dir', 'dur', 'in', 'into',
  'scale', 'width', 'lines', 'grep', 'level', 'idle', 'quality']);
/** Flags that take a value only when one follows that is not another flag. */
const OPTIONAL_VALUE = new Set(['grid']);

/**
 * Splits argv into the command, its positional arguments and its flags.
 * `-s <serial>` is the one short flag, kept for parity with adb. Everything
 * after `shell` belongs to the device command, so `adbax shell logcat -s Tag`
 * keeps its own flags.
 */
export function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (pos[0] === 'shell') { pos.push(...argv.slice(i)); break; }
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (NEEDS_VALUE.has(a.slice(2)) && i + 1 < argv.length) flags[a.slice(2)] = argv[++i];
      else if (OPTIONAL_VALUE.has(a.slice(2)) && /^\d+$/.test(argv[i + 1] || '')) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else if (a === '-s' && i + 1 < argv.length) {
      flags.serial = argv[++i];
    } else if (a === '-h') {
      flags.help = true;
    } else {
      pos.push(a);
    }
  }
  return { cmd: pos.shift(), pos, flags };
}
