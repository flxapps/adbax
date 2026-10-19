// SPDX-License-Identifier: Apache-2.0
import { Adb } from './adb.js';
import { ServerBackend, ServerUnavailable } from './backends/server.js';
import { ShellBackend } from './backends/shell.js';
import { interesting, parseTree, rowRecord, screenInfo } from './tree.js';
import { cachePath, delay, readJson, serialKey, writeJson } from './util.js';

/**
 * One device, and the backend that talks to it: the on-device server when it
 * runs there, `adb shell` otherwise. Commands go through this and never pick a
 * backend themselves.
 */
export class Device {
  constructor(serial, { server = true, settle } = {}) {
    this.serial = serial;
    this.adb = new Adb(serial);
    this.server = new ServerBackend(this.adb);
    this.shell = new ShellBackend(this.adb);
    this.useServer = server;
    this.settle = settle;
    this.chosen = null;
  }

  async backend() {
    if (this.chosen) return this.chosen;
    if (this.useServer) {
      try {
        await this.server.ensure();
        return (this.chosen = this.server);
      } catch (e) {
        if (!(e instanceof ServerUnavailable)) throw e;
        if (!e.remembered) process.stderr.write(`adbax: on-device server unavailable (${e.message}); using uiautomator dump\n`);
      }
    }
    return (this.chosen = this.shell);
  }

  async fast() {
    return (await this.backend()) === this.server;
  }

  /**
   * The tree as XML. `afterAction` gives the screen time to react first: on
   * the server a short settle and then a wait for accessibility events to
   * stop, on the shell a fixed sleep (uiautomator waits a second on its own).
   */
  async dump({ afterAction = false, windows = false } = {}) {
    const b = await this.backend();
    if (b === this.server) {
      const settle = this.settle !== undefined ? +this.settle : afterAction ? 150 : 0;
      let d = await b.dump({ settle, idle: 300, timeout: afterAction ? 3000 : 2000, windows });
      // A new activity's window can go quiet before its content is attached,
      // which reads as an empty screen. Read again until something shows or
      // two reads agree: a game's canvas stays empty, and that is the answer.
      for (let i = 0; afterAction && i < 4 && interesting(parseTree(d.xml)).length === 0; i++) {
        await delay(250);
        const again = await b.dump({ idle: 300, timeout: 1500, windows });
        if (again.xml === d.xml) break;
        d = again;
      }
      return d;
    }
    if (windows) process.stderr.write('adbax: --windows needs the on-device server; showing the active window only\n');
    const settle = this.settle !== undefined ? +this.settle : afterAction ? 700 : 0;
    return b.dump({ settle });
  }

  async tree(opts) {
    const { xml } = await this.dump(opts);
    return parseTree(xml);
  }

  // Polling loops (wait, scroll-to) can go much faster when a read is cheap.
  async pollInterval() {
    return (await this.fast()) ? 150 : 600;
  }

  async tap(x, y) { return (await this.backend()).tap(x, y); }
  async swipe(x1, y1, x2, y2, ms) { return (await this.backend()).swipe(x1, y1, x2, y2, ms); }

  async key(codes, opts) { return (await this.backend()).key(codes, opts); }

  async type(text) { return (await this.backend()).type(text); }

  /** The field with input focus: {focused, editable, text, password}, or null if unknown. */
  async focus() {
    const b = await this.backend();
    if (b === this.server) return b.focus();
    const f = (await this.tree()).find((n) => n.focused && n.editable);
    return f ? { focused: true, editable: true, text: f.text, password: f.password } : { focused: false };
  }

  /** Empties the focused field; ACTION_SET_TEXT where possible, a run of DELs where not. */
  async clear(existingLength = 0) {
    const b = await this.backend();
    if (b === this.server && (await b.clear())) return;
    await this.shell.clear(existingLength);
  }

  /** Replaces the focused field's text. The field's text afterwards, or null without one. */
  async setText(text) {
    const b = await this.backend();
    if (b === this.server) {
      try { return (await b.request({ cmd: 'settext', text })).head.text ?? text; } catch (e) { if (process.env.ADBAX_DEBUG) console.error(e); return null; }
    }
    await this.shell.clear(4096);
    await this.shell.type(text);
    return text;
  }

  async screenshot(opts) { return (await this.backend()).screenshot(opts); }

  async keyboardUp() {
    const o = await this.adb.shell('dumpsys input_method | grep -E "mInputShown|mServedView" | head -3', { soft: true });
    return /mInputShown=true/.test(o);
  }

  /** Waits for a soft keyboard or an editable field with focus, whichever the device reports. */
  async waitForInput(ms = 3000) {
    const deadline = Date.now() + ms;
    const fast = await this.fast();
    while (Date.now() < deadline) {
      if (fast) {
        const f = await this.server.focus();
        if (f.focused && f.editable) return true;
      } else if (await this.keyboardUp()) {
        await delay(250);
        return true;
      }
      await delay(fast ? 80 : 200);
    }
    return false;
  }

  /**
   * "package/Activity" on top. From the server when it runs (a few ms), from
   * dumpsys otherwise (60-200 ms).
   */
  async where() {
    if (this.chosen === this.server) {
      const a = await this.server.activity().catch(() => null);
      if (a) return a;
    }
    // `dumpsys window displays` is the cheap section; Android 8 and older only
    // print mCurrentFocus in the full dump.
    let w = (await this.adb.shell('dumpsys window displays 2>/dev/null | grep -m1 mCurrentFocus', { soft: true })).trim();
    if (!w) w = (await this.adb.shell('dumpsys window 2>/dev/null | grep -m1 mCurrentFocus', { soft: true })).trim();
    const m = w.match(/([\w.]+)\/([\w.$]+)/);
    return m ? `${m[1]}/${m[2]}` : (w || '?');
  }

  /** The screen as currently rotated: a landscape game is wider than it is tall. */
  async screenSize(xml) {
    const info = xml ? screenInfo(xml) : {};
    if (info.width) return { width: info.width, height: info.height };
    if ((await this.fast()) && this.server.info && this.server.info.width) {
      return { width: this.server.info.width, height: this.server.info.height };
    }
    const m = (await this.adb.shell('wm size', { soft: true })).match(/(\d+)x(\d+)(?![\s\S]*\d+x\d+)/);
    if (!m) return { width: 1080, height: 1920 };
    // `wm size` is the physical, unrotated size.
    const rot = (await this.adb.shell("dumpsys input | grep -m1 SurfaceOrientation", { soft: true })).match(/(\d)\s*$/);
    const turned = rot && (rot[1] === '1' || rot[1] === '3');
    return turned ? { width: +m[2], height: +m[1] } : { width: +m[1], height: +m[2] };
  }

  // The rows of the last `ui`, so `tap 3` can skip a fresh dump.
  get rowsFile() {
    return cachePath(`ui-${serialKey(this.serial)}.json`);
  }

  saveRows(nodes, all = false) {
    const rows = interesting(nodes, all);
    writeJson(this.rowsFile, rows.map(rowRecord));
    return rows;
  }

  lastRows() {
    return readJson(this.rowsFile);
  }

  // The last screenshot's size, so `--shot` can map its pixels to the screen.
  get shotFile() {
    return cachePath(`shot-${serialKey(this.serial)}.json`);
  }

  saveShot(info) {
    writeJson(this.shotFile, info);
  }

  /** Maps a point in the last screenshot's pixels to screen pixels. */
  fromShot(x, y) {
    const s = readJson(this.shotFile);
    if (!s) return null;
    return [Math.round(x * s.deviceWidth / s.width), Math.round(y * s.deviceHeight / s.height)];
  }
}
