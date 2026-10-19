// SPDX-License-Identifier: Apache-2.0
/*
 * The fallback backend: plain `adb shell` commands. Works on any device, but
 * every read is a fresh `uiautomator dump`, which starts a VM, connects to the
 * accessibility service and waits a full second for the screen to go idle, so
 * about two seconds per read.
 */
import { delay, fail, q } from '../util.js';

export class ShellBackend {
  constructor(adb) {
    this.adb = adb;
    this.name = 'shell';
  }

  async dump({ settle = 0 } = {}) {
    if (settle) await delay(settle);
    for (let attempt = 0; attempt < 3; attempt++) {
      const out = await this.adb.run(['exec-out', 'uiautomator', 'dump', '/dev/tty'], { soft: true, timeout: 30_000 });
      const i = out.indexOf('<hierarchy');
      if (i > -1 && out.includes('</hierarchy>')) return { xml: out.slice(i), busy: false };
      // Some builds refuse /dev/tty; go through a file instead. Removed first,
      // so a dump that fails cannot hand back the previous screen.
      const f = await this.adb.shell(
        'rm -f /sdcard/adbax.xml; uiautomator dump /sdcard/adbax.xml >/dev/null && cat /sdcard/adbax.xml', { soft: true });
      const j = f.indexOf('<hierarchy');
      if (j > -1) return { xml: f.slice(j), busy: false };
      await delay(700);
    }
    const holder = (await this.adb.shell('pidof adbax-server', { soft: true })).trim();
    fail('uiautomator dump failed 3x. ' + (holder
      ? 'The adbax server is holding the accessibility connection; `adbax server stop` first.'
      : 'The screen may be mid-animation, showing a secure surface, or the app draws no\n' +
        '       accessibility nodes. Try `adbax screenshot --small`.'));
  }

  tap(x, y) {
    return this.adb.shell(`input tap ${x} ${y}`);
  }

  swipe(x1, y1, x2, y2, ms) {
    return this.adb.shell(`input swipe ${x1} ${y1} ${x2} ${y2} ${ms}`);
  }

  key(codes, { long = false } = {}) {
    return this.adb.shell(`input keyevent ${long ? '--longpress ' : ''}${codes.map(q).join(' ')}`);
  }

  /** `input text` takes ASCII only on most builds; the caller warns about the rest. */
  async type(text) {
    await this.adb.shell(`input text ${q(text.replace(/ /g, '%s'))}`);
    return { via: 'input' };
  }

  async clear(existingLength) {
    await this.adb.shell('input keyevent KEYCODE_MOVE_END');
    const n = Math.min(200, Math.max(existingLength + 5, 60));
    await this.adb.shell('input keyevent ' + Array(n).fill('KEYCODE_DEL').join(' '));
  }

  /** The shell has no cheap way to ask; callers fall back to a dump. */
  focus() {
    return null;
  }

  async screenshot() {
    return { data: await this.adb.execOut('screencap -p'), format: 'png', scaled: false };
  }
}
