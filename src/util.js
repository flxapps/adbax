// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** An error the CLI prints as `adbax: <message>` and exits with `code`. */
export class AdbaxError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

export function fail(message, code = 1) {
  throw new AdbaxError(message, code);
}

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Quotes one word for the device's /bin/sh. */
export function q(s) {
  s = String(s);
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export const CACHE_DIR = process.env.ADBAX_CACHE ||
  path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'adbax');

export function cachePath(name) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  return path.join(CACHE_DIR, name);
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function readText(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

export function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
}

/** A filesystem-safe form of a device serial ("emulator-5554", "192.168.1.5:5555"). */
export const serialKey = (serial) => serial.replace(/[^\w.-]/g, '_');

const T0 = performance.now();
/** ADBAX_TRACE=1 prints every adb call and server request with its duration to stderr. */
export const tracing = !!process.env.ADBAX_TRACE;
export function trace(what, started) {
  if (!tracing) return;
  const now = performance.now();
  process.stderr.write(`[${(now - T0).toFixed(0).padStart(5)} ms] ${(now - started).toFixed(0).padStart(4)} ms  ${what}\n`);
}
