// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { adbRaw, emulatorBinary, listDevices, pinSerial, pinnedSerial, runEmulatorSync } from '../adb.js';
import { cachePath, delay, fail } from '../util.js';

export async function devices(ctx) {
  const list = await listDevices();
  if (!list.length) return ctx.out('no devices');
  const pin = pinnedSerial();
  for (const d of list) ctx.out(`${d.serial === pin ? '*' : ' '} ${d.serial.padEnd(22)} ${d.state.padEnd(10)} ${d.model}`);
}

export async function use(ctx) {
  const s = ctx.pos[0];
  if (!s || s === '-') {
    pinSerial(null);
    return ctx.out('device pin cleared');
  }
  pinSerial(s);
  ctx.out('pinned ' + s);
}

export async function avds(ctx) {
  ctx.out(runEmulatorSync(['-list-avds']).trim());
}

/** Boots an AVD, waits for sys.boot_completed, unlocks it and pins it. */
export async function boot(ctx) {
  const { flags } = ctx;
  const avd = ctx.pos[0] || fail('usage: adbax boot <avd> [--cold] [--wipe] [--no-window]   (see `adbax avds`)');
  const before = new Set((await listDevices()).map((d) => d.serial));
  const args = ['-avd', avd];
  if (flags.cold) args.push('-no-snapshot-load');
  if (flags.wipe) args.push('-wipe-data');
  if (flags['no-window']) args.push('-no-window', '-no-audio');
  const logFile = cachePath(`emulator-${avd}.log`);
  const log = fs.openSync(logFile, 'w');
  // The launcher execs into the emulator itself, so an exit here is the
  // emulator giving up: an unknown AVD name, or one that is already running.
  const child = spawn(emulatorBinary(), args, { detached: true, stdio: ['ignore', log, log] });
  let exitCode = null;
  child.on('exit', (code) => { exitCode = code; });
  child.unref();
  process.stderr.write('booting ' + avd);
  let serial = null;
  for (let i = 0; i < 180; i++) {
    await delay(2000);
    if (exitCode) fail(`\nthe emulator exited with status ${exitCode}. Log: ${logFile}`);
    process.stderr.write('.');
    if (!serial) serial = ((await listDevices()).find((d) => !before.has(d.serial)) || {}).serial || null;
    if (!serial) continue;
    const booted = (await adbRaw(['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], { soft: true })).trim();
    if (booted === '1') {
      await adbRaw(['-s', serial, 'shell', 'input', 'keyevent', '82'], { soft: true });
      pinSerial(serial);
      process.stderr.write('\n');
      return ctx.out(`booted ${serial} (pinned)`);
    }
  }
  fail(`\ntimed out after 6 min. Log: ${logFile}`);
}

export async function kill(ctx) {
  if (ctx.flags.all) {
    for (const d of await listDevices()) {
      if (d.serial.startsWith('emulator-')) await adbRaw(['-s', d.serial, 'emu', 'kill'], { soft: true });
    }
  } else {
    await (await ctx.device()).adb.run(['emu', 'kill'], { soft: true });
  }
  ctx.out('sent kill');
}
