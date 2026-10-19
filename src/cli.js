// SPDX-License-Identifier: Apache-2.0
import { parseArgs } from './args.js';
import { resolveSerial } from './adb.js';
import { Device } from './device.js';
import { AdbaxError } from './util.js';
import * as apps from './commands/apps.js';
import * as device from './commands/device.js';
import * as screen from './commands/screen.js';
import * as server from './commands/server.js';
import * as system from './commands/system.js';
import * as touch from './commands/touch.js';

const COMMANDS = {
  ...device, ...screen, ...apps, ...system, ...server,
  ...touch, 'scroll-to': touch.scrollTo, 'hide-keyboard': touch.hideKeyboard,
  press: touch.longpress, text: touch.type, screencap: screen.screenshot, logcat: system.log, ls: apps.apps,
};
delete COMMANDS.scrollTo;
delete COMMANDS.hideKeyboard;

export const HELP = `adbax - drive an Android device or emulator by its accessibility tree

  DEVICE    devices | use <serial|-> | avds | boot <avd> [--cold --wipe --no-window] | kill [--all]
  SEE       ui [--all --full --json --raw --windows] | find <text> | inspect <text> | current
            screenshot [path] [--small --width N --grid [step]]  (a .jpg path saves JPEG)
  TOUCH     tap <text|n|x,y> | longpress <sel> [--dur ms] | type <text> [--into <sel>] [--clear --set --enter]
            key <back|home|enter|recents|del|...|KEYCODE_*> [--long] | back | home | recents | hide-keyboard
            swipe <up|down|left|right|x1,y1,x2,y2> [--dur ms] [--in <sel>]
            scroll-to <text> [--max 12] [--dir up|down] [--tap]  |  wait <text> [--timeout 15] [--gone]
  APPS      apps [filter] [--system] | launch <pkg> | start <pkg/.Act> | stop <pkg> | clear <pkg>
            install <apk> [splits...] | uninstall <pkg> | deeplink <url> [pkg] | perm <grant|revoke> <pkg> <PERM> | perms <pkg>
  DEBUG     log [pkg] [--lines N --grep re --level E] | crash | clearlog | record [secs] [path]
  STATE     dark <on|off> | font <scale> | anim <on|off> | rotate <0|90|180|270|auto> | demo <on|off>
  SERVER    server [status|start|stop|restart|log] [--idle seconds]
  RAW       shell <cmd> | pull <remote> <local> | push <local> <remote> | version

  Global: -s <serial>, --ui (show the screen after acting), --settle <ms>, --nth N, --first, --re,
          --shot (x,y are pixels of the last screenshot, not of the screen),
          --no-server (plain adb shell and uiautomator, as on devices the server cannot run on)

  Selectors match text, content-desc and resource-id; a match that is not itself
  clickable resolves to its nearest clickable ancestor. An ambiguous selector
  exits 2 and lists the candidates rather than guessing.

  adbax ui
  adbax tap "Sign in" --ui
  adbax type you@example.com --into Email --enter
  adbax scroll-to "Delete account" --tap
`;

export async function main(argv) {
  const { cmd, pos, flags } = parseArgs(argv);
  if (!cmd || cmd === 'help' || flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === 'version' || flags.version) {
    const { createRequire } = await import('node:module');
    process.stdout.write(createRequire(import.meta.url)('../package.json').version + '\n');
    return 0;
  }
  const run = COMMANDS[cmd];
  if (!run) throw new AdbaxError(`unknown command "${cmd}". Run \`adbax help\`.`);

  let dev = null;
  const ctx = {
    pos,
    flags,
    out: (s) => process.stdout.write(s + '\n'),
    async device() {
      if (!dev) {
        const serverOff = flags['no-server'] || /^(0|off|false|no)$/i.test(process.env.ADBAX_SERVER || '');
        dev = new Device(await resolveSerial(flags), { server: !serverOff, settle: flags.settle });
      }
      return dev;
    },
  };
  await run(ctx);
  return 0;
}
