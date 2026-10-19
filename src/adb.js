// SPDX-License-Identifier: Apache-2.0
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AdbaxError, cachePath, fail, trace } from './util.js';

function sdkDir() {
  const env = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (env) return env;
  const home = os.homedir();
  const usual = { darwin: 'Library/Android/sdk', win32: 'AppData/Local/Android/Sdk' }[process.platform] || 'Android/Sdk';
  const guesses = [usual, 'Library/Android/sdk', 'Android/Sdk', 'AppData/Local/Android/Sdk'].map((g) => path.join(home, g));
  return guesses.find((g) => fs.existsSync(g)) || guesses[0];
}

const found = {};
/** Finds `adb` or `emulator` on PATH, then in the SDK. */
export function binary(name, sub) {
  if (found[name]) return found[name];
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, exe);
    if (dir && fs.existsSync(p)) return (found[name] = p);
  }
  const p = path.join(sdkDir(), sub, exe);
  if (fs.existsSync(p)) return (found[name] = p);
  fail(`${name} not found on PATH or in ${path.join(sdkDir(), sub)}. Set ANDROID_HOME.`);
}

/** Runs adb with the given argv. Resolves stdout (a string, or a Buffer with `buffer`). */
export function adbRaw(args, { buffer = false, timeout = 120_000, soft = false } = {}) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    execFile(binary('adb', 'platform-tools'), args,
      { encoding: buffer ? 'buffer' : 'utf8', maxBuffer: 256 * 1024 * 1024, timeout },
      (err, stdout, stderr) => {
        trace('adb ' + args.join(' ').slice(0, 120), started);
        if (!err) return resolve(stdout);
        if (soft) return resolve(buffer ? Buffer.alloc(0) : '');
        const detail = (stderr && stderr.toString().trim()) || err.message;
        reject(new AdbaxError(`adb ${args.join(' ')}\n       ${detail}`));
      });
  });
}

export async function listDevices() {
  const out = await adbRaw(['devices', '-l']);
  return out.split('\n').slice(1).filter((l) => l.trim()).map((l) => {
    const m = l.match(/^(\S+)\s+(\S+)(.*)$/);
    if (!m) return null;
    const props = {};
    for (const kv of (m[3] || '').trim().split(/\s+/)) {
      const i = kv.indexOf(':');
      if (i > 0) props[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return { serial: m[1], state: m[2], model: props.model || '', device: props.device || '' };
  }).filter(Boolean);
}

const PIN = () => cachePath('device');

export function pinnedSerial() {
  try { return fs.readFileSync(PIN(), 'utf8').trim(); } catch { return ''; }
}

export function pinSerial(serial) {
  if (serial) fs.writeFileSync(PIN(), serial);
  else fs.rmSync(PIN(), { force: true });
}

/**
 * Picks the device: -s, then $ANDROID_SERIAL, then the pinned one if it is
 * online, then the only one online. Several and none pinned is an error rather
 * than a guess.
 */
export async function resolveSerial(flags) {
  if (flags.serial) return flags.serial;
  if (process.env.ANDROID_SERIAL) return process.env.ANDROID_SERIAL;
  const all = await listDevices();
  const online = all.filter((d) => d.state === 'device');
  const pinned = pinnedSerial();
  if (pinned && online.some((d) => d.serial === pinned)) return pinned;
  if (online.length === 1) return online[0].serial;
  if (online.length === 0) {
    const waiting = all.find((d) => d.state === 'unauthorized');
    if (waiting) fail(`${waiting.serial} is unauthorized: accept the USB debugging prompt on the device.`);
    if (all.length) fail(`no device online: ${all.map((d) => `${d.serial} ${d.state}`).join(', ')}.`);
    fail('no device connected. `adbax avds` then `adbax boot <avd>`.');
  }
  fail(`several devices: ${online.map((d) => d.serial).join(', ')}\n` +
    '       pick one with `adbax use <serial>` or -s <serial>.');
}

/** adb bound to one device. */
export class Adb {
  constructor(serial) {
    this.serial = serial;
  }

  run(args, opts) {
    return adbRaw(['-s', this.serial, ...args], opts);
  }

  /** `cmd` is one string for the device shell; quote user input with q(). */
  shell(cmd, opts) {
    return this.run(['shell', cmd], opts);
  }

  execOut(cmd, opts) {
    return this.run(['exec-out', cmd], { buffer: true, ...opts });
  }
}

/** The emulator binary is only needed for avds/boot, so it is looked up lazily. */
export const emulatorBinary = () => binary('emulator', 'emulator');

export function runEmulatorSync(args) {
  return execFileSync(emulatorBinary(), args, { encoding: 'utf8' });
}
