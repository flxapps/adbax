// SPDX-License-Identifier: Apache-2.0
/*
 * Host half of the on-device server (server/src). The server is a dex jar run
 * through app_process as the shell user. It keeps one UiAutomation connection
 * open and answers on an abstract unix socket that adb forwards to a local TCP
 * port. Because the connection stays up, it has seen every accessibility event
 * since it started and knows when the screen went quiet. A read on a settled
 * screen costs tens of milliseconds instead of a second of forced waiting.
 *
 * The jar's MD5 is the version handshake: the host passes it as --token, the
 * server echoes it, and a server answering with another token is an older
 * build and gets replaced.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { adbRaw } from '../adb.js';
import { AdbaxError, cachePath, delay, q, readJson, readText, serialKey, trace, writeJson } from '../util.js';

const SOCKET = 'adbax';
const PROCESS = 'adbax-server';
const REMOTE_JAR = '/data/local/tmp/adbax-server.jar';
const REMOTE_LOG = '/data/local/tmp/adbax-server.log';
const MIN_SDK = 24;
export const JAR = fileURLToPath(new URL('../../server/adbax-server.jar', import.meta.url));

let jarMd5;
function token() {
  if (!jarMd5) {
    if (!fs.existsSync(JAR)) throw new ServerUnavailable(`${JAR} is missing; run server/build.sh`);
    jarMd5 = crypto.createHash('md5').update(fs.readFileSync(JAR)).digest('hex');
  }
  return jarMd5;
}

/** Seconds without a request before the server exits and frees the connection. */
export const idleSeconds = () => +(process.env.ADBAX_SERVER_IDLE || 600);

/** The server cannot run here; the caller falls back to the shell backend. */
export class ServerUnavailable extends AdbaxError {
  constructor(message, { remembered = false } = {}) {
    super(message);
    this.remembered = remembered;
  }
}

export class ServerBackend {
  constructor(adb) {
    this.adb = adb;
    this.name = 'server';
    this.port = null;
    this.ready = false;
  }

  get markerFile() {
    return cachePath(`server-${serialKey(this.adb.serial)}.json`);
  }

  /** The local port adb already forwards to the server socket, or null. */
  async findPort() {
    const out = await adbRaw(['forward', '--list'], { soft: true });
    for (const line of out.split('\n')) {
      const [serial, local, remote] = line.trim().split(/\s+/);
      if (serial === this.adb.serial && remote === `localabstract:${SOCKET}`) return +local.replace('tcp:', '');
    }
    return null;
  }

  get portFile() {
    return cachePath(`port-${serialKey(this.adb.serial)}`);
  }

  async forward() {
    const port = (await this.findPort()) || +(await this.adb.run(['forward', 'tcp:0', `localabstract:${SOCKET}`])).trim();
    fs.writeFileSync(this.portFile, String(port));
    return port;
  }

  /** A server answering for this device and this build. */
  current(res) {
    return !!res && res.head.token === token() && res.head.serial === this.adb.serial;
  }

  /**
   * One request, one connection. Resolves {head, body}, or null when nothing
   * answered: adb accepts a forwarded connection even with no server behind
   * it and then closes it straight away.
   */
  send(req, timeoutMs = 15_000) {
    const started = performance.now();
    return new Promise((resolve) => {
      const sock = net.connect(this.port, '127.0.0.1');
      const chunks = [];
      const timer = setTimeout(() => sock.destroy(), timeoutMs);
      sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
      sock.on('data', (c) => chunks.push(c));
      sock.on('error', () => {});
      sock.on('close', () => {
        clearTimeout(timer);
        trace(`server ${req.cmd}`, started);
        const buf = Buffer.concat(chunks);
        const nl = buf.indexOf(10);
        if (nl < 0) return resolve(null);
        try {
          resolve({ head: JSON.parse(buf.subarray(0, nl).toString('utf8')), body: buf.subarray(nl + 1) });
        } catch {
          resolve(null);
        }
      });
    });
  }

  /** Makes sure a current server answers, starting one if needed. Returns its ping. */
  async ensure() {
    if (this.ready) return;
    // The last port saves an `adb forward --list`; the serial echo catches a
    // port that adb has since handed to another device.
    const cached = +readText(this.portFile);
    let ping = null;
    if (cached) {
      this.port = cached;
      ping = await this.send({ cmd: 'ping' }, 3000);
      if (ping && ping.head.serial !== this.adb.serial) ping = null;
    }
    if (!ping) {
      this.port = await this.forward();
      ping = await this.send({ cmd: 'ping' }, 3000);
    }
    if (this.current(ping)) {
      this.ready = true;
      this.info = ping.head;
      fs.rmSync(this.markerFile, { force: true });
      return ping.head;
    }
    if (ping && ping.head.serial === this.adb.serial) await this.send({ cmd: 'quit' }, 3000);
    const head = await this.start();
    this.ready = true;
    this.info = head;
    return head;
  }

  async request(req, timeoutMs) {
    await this.ensure();
    let res = await this.send(req, timeoutMs);
    if (!res) {
      // It exited between requests (idle timeout, killed). Start it once more.
      this.ready = false;
      await this.ensure();
      res = await this.send(req, timeoutMs);
    }
    if (!res) throw new AdbaxError(`server gave no answer to ${req.cmd}; see \`adbax server log\``);
    if (!res.head.ok) throw new AdbaxError(res.head.error);
    return res;
  }

  async start({ idle = idleSeconds(), force = false } = {}) {
    const marker = readJson(this.markerFile);
    if (!force && marker && marker.token === token() && marker.unsupported) {
      throw new ServerUnavailable(marker.unsupported, { remembered: true });
    }
    const sdk = +(await this.adb.shell('getprop ro.build.version.sdk')).trim();
    if (sdk < MIN_SDK) this.unsupported(`Android API ${sdk}; the server needs ${MIN_SDK} or newer`);

    const remote = (await this.adb.shell(`md5sum ${REMOTE_JAR} 2>/dev/null`, { soft: true })).split(/\s/)[0];
    if (remote !== token()) await this.adb.run(['push', JAR, REMOTE_JAR]);

    // A server that no longer answers on our forward may still hold the
    // accessibility connection, and only one client can have it.
    await this.kill();
    await this.adb.shell(`CLASSPATH=${REMOTE_JAR} nohup app_process / --nice-name=${PROCESS} ` +
      `es.flx.adbax.Main --socket ${SOCKET} --token ${token()} --serial ${q(this.adb.serial)} --idle ${idle} ` +
      `>${REMOTE_LOG} 2>&1 &`);
    this.port = await this.forward();

    const deadline = Date.now() + 10_000;
    for (let i = 0; Date.now() < deadline; i++) {
      await delay(i < 10 ? 60 : 200);
      const ping = await this.send({ cmd: 'ping' }, 2000);
      if (this.current(ping)) {
        fs.rmSync(this.markerFile, { force: true });
        return ping.head;
      }
      if (i < 4) continue;
      const log = (await this.adb.shell(`cat ${REMOTE_LOG}`, { soft: true })).trim();
      const crashed = /Exception|Error/.test(log);
      // Until the VM applies --nice-name the process is still "app_process",
      // so only call it dead after a grace period, or on a stack trace.
      if (crashed || (Date.now() > deadline - 7000 && !(await this.running()))) {
        if (/already registered/i.test(log)) {
          throw new ServerUnavailable('another UiAutomation client holds the accessibility connection ' +
            '(an instrumentation test, uiautomator, Appium, Maestro). Stop it, or pass --no-server.');
        }
        const reason = log.split('\n').find((l) => /Exception|Error/.test(l)) || log.split('\n')[0] || 'exited at start';
        await this.kill();
        this.unsupported(`server failed to start: ${reason.trim()}`);
      }
    }
    throw new ServerUnavailable('server did not answer within 10 s; see `adbax server log`');
  }

  unsupported(reason) {
    writeJson(this.markerFile, { token: token(), unsupported: reason, at: new Date().toISOString() });
    throw new ServerUnavailable(reason);
  }

  async pid() {
    return (await this.adb.shell(`pidof ${PROCESS}`, { soft: true })).trim();
  }

  /**
   * Matches the command line rather than the process name, so it also finds a
   * server still starting up. The brackets keep the pattern from matching the
   * shell that runs it.
   */
  async running() {
    return (await this.adb.shell(`pgrep -f '[a]dbx-server'`, { soft: true })).trim() !== '';
  }

  async kill() {
    await this.adb.shell(`pkill -f '[a]dbx-server'; sleep 0.1`, { soft: true });
  }

  /** Ping without starting anything. */
  async status() {
    this.port = await this.findPort();
    const pid = await this.pid();
    if (!this.port) return { running: !!pid, pid, port: null };
    const ping = await this.send({ cmd: 'ping' }, 3000);
    return { running: !!ping, pid, port: this.port, ping: ping && ping.head, current: this.current(ping) };
  }

  async stop() {
    this.port = await this.findPort();
    if (this.port) await this.send({ cmd: 'quit' }, 3000);
    await this.kill();
    if (this.port) await this.adb.run(['forward', '--remove', `tcp:${this.port}`], { soft: true });
    fs.rmSync(this.portFile, { force: true });
    this.ready = false;
  }

  log() {
    return this.adb.shell(`cat ${REMOTE_LOG}`, { soft: true });
  }

  // ---------------------------------------------------------------- backend

  async dump({ settle = 0, idle = 300, timeout = 2000, windows = false } = {}) {
    const res = await this.request({ cmd: 'dump', settle, idle, timeout, windows }, settle + timeout + 10_000);
    return { xml: res.body.toString('utf8'), busy: res.head.busy, head: res.head };
  }

  tap(x, y) {
    return this.request({ cmd: 'tap', x, y });
  }

  swipe(x1, y1, x2, y2, ms) {
    return this.request({ cmd: 'swipe', x1, y1, x2, y2, ms }, ms + 10_000);
  }

  async key(codes, { long = false } = {}) {
    for (const code of codes) {
      await this.request(typeof code === 'number' ? { cmd: 'key', code, long } : { cmd: 'key', name: String(code).toUpperCase(), long });
    }
  }

  /** Key events where the virtual keyboard map has the characters, ACTION_SET_TEXT where not. */
  async type(text) {
    return { via: (await this.request({ cmd: 'text', text })).head.via };
  }

  /** Empties the focused field. Returns false when it has none. */
  async clear() {
    try {
      await this.request({ cmd: 'settext', text: '' });
      return true;
    } catch {
      return false;
    }
  }

  async focus() {
    return (await this.request({ cmd: 'focus' })).head;
  }

  async activity() {
    return (await this.request({ cmd: 'activity' })).head.activity || null;
  }

  async screenshot({ width = 0, grid = 0, format = 'png', quality = 85 } = {}) {
    const res = await this.request({ cmd: 'screenshot', width, grid, format, quality }, 20_000);
    return {
      data: res.body, format: res.head.format, width: res.head.width, height: res.head.height, scaled: true,
      screenWidth: res.head.screenWidth, screenHeight: res.head.screenHeight,
    };
  }
}
