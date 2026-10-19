# Commands

`adbax <command> [arguments] [flags]`. Flags go anywhere on the line,
`--flag value` and `--flag=value` both work, and `--` ends flag parsing.
The exception is `shell`: everything after it goes to the device as it is, so
`-s` and the other global flags go before it.

Exit status is 0 on success, 2 when something was not there (no match, an
ambiguous selector, a `wait` or `scroll-to` that timed out) and 1 for any other
failure. Errors go to stderr as `adbax: <message>`.

## Global flags

| Flag | |
| --- | --- |
| `-s <serial>` | the device to talk to; otherwise `$ANDROID_SERIAL`, then the pinned device, then the only one online |
| `--ui` | after an action, print the screen it led to (saves a separate `adbax ui`) |
| `--settle <ms>` | how long to give the screen after an action before reading it. Default: 150 with the server, which then also waits for events to stop; 700 without |
| `--nth N` / `--first` | pick one of several matches instead of exiting 2 |
| `--re` | the selector is a regular expression |
| `--shot` | `x,y` are pixels of the last screenshot, not of the screen |
| `--no-server` | plain `adb shell` and `uiautomator dump`, as on devices the server cannot run on |

## Selectors

Anything that takes a selector accepts:

- **text**: matched against text, content-desc, hint and resource-id,
  case-insensitively. Exact beats prefix beats substring; text beats
  content-desc beats ids. A tap prefers clickable nodes, and a match that is not
  clickable itself resolves to its nearest clickable ancestor.
- **a row number**, `5` or `#5`: row 5 of the last `adbax ui`, `find`, `wait` or
  `scroll-to`, without reading the screen again. Valid until the screen changes.
- **coordinates**, `540,1200`: taken as they are, or scaled from the last
  screenshot with `--shot`.

## Devices

| Command | |
| --- | --- |
| `devices` | attached devices; `*` marks the pinned one |
| `use <serial>` | pin a device for later calls; `use -` clears the pin |
| `avds` | the emulator's AVDs |
| `boot <avd> [--cold] [--wipe] [--no-window]` | start an AVD, wait for `sys.boot_completed`, unlock and pin it. Emulator output goes to `~/.cache/adbax/emulator-<avd>.log`; gives up after six minutes |
| `kill [--all]` | shut down the current emulator, or every running one |

## Seeing the screen

| Command | |
| --- | --- |
| `ui` | the screen as rows: index, kind, label, short resource-id, centre, size, state. The first line names the top activity, the screen size and the row count |
| `ui --all` | every node, including labels already folded into a clickable parent |
| `ui --full` | adds each node's class |
| `ui --json` | the rows as JSON, for scripts |
| `ui --raw` | the XML as it came off the device |
| `ui --windows` | every window, not just the active one: status bar, navigation bar, the keyboard, overlays. Needs the server |
| `find <text>` | only the nodes matching a selector, with their row numbers |
| `inspect <text>` | every attribute of the best match, and its ancestor chain |
| `current` | the focused window and the resumed activity |
| `screenshot [path]` | writes a PNG (a `.jpg` path writes JPEG) and prints the path. Defaults to `~/.cache/adbax/shot.png` |
| `screenshot --small` | 540 px wide JPEG. For Claude that is about 690 image tokens, where a full-size 1080x1920 screenshot is about 1,840 |
| `screenshot --width N` | any width, scaled on the device |
| `screenshot --quality N` | JPEG quality, 80 by default |
| `screenshot --grid [step]` | a labelled coordinate grid over the image, in the image's own pixels (default: a sixth of its width). Needs the server |
| `record [secs] [path]` | a screen recording, 15 s by default, 180 at most |

Row kinds: `TAP` clickable, `EDIT` a text field, `CHK[x]`/`CHK[ ]` checkable,
`SCRL` a scroll container, `TXT` text you can read but not act on. State marks:
`*focused`, `*selected`, `*password`, `*scrollable`, `!disabled`.

## Acting

| Command | |
| --- | --- |
| `tap <selector>` | a tap at the centre of the match |
| `longpress <selector> [--dur ms]` | press and hold, 900 ms by default |
| `type <text>` | types into the focused field |
| `type <text> --into <selector>` | taps the field first and waits until it has input focus |
| `type --clear` | empties the field before typing (or on its own) |
| `type <text> --set` | replaces the whole field in one step (ACTION_SET_TEXT), no keystrokes. For long values, where typing over the old text can leave part of it behind |
| `type ... --enter` | presses Enter afterwards |
| `type ... --no-verify` | skips reading the field back |
| `key <key>...` | key events by name (`back home enter recents del tab esc up down left right menu search power volup voldown space paste`...), by number, or as `KEYCODE_*` |
| `key <key> --long` | a long press of the key |
| `back`, `home`, `recents` | shorthands |
| `hide-keyboard` | presses Back only if the soft keyboard is showing; a plain `back` would leave the screen when it isn't |
| `swipe <up\|down\|left\|right>` | a swipe across the screen. "up" is the finger moving up, which scrolls the content down |
| `swipe <dir> --in <selector>` | the same inside one node, a carousel or a list |
| `swipe x1,y1,x2,y2 [--dur ms]` | between two points, 300 ms by default |
| `scroll-to <text> [--max 12] [--dir up\|down] [--tap]` | swipes the largest scroll container until the text shows up, then optionally taps it |
| `wait <text> [--timeout 15] [--gone]` | blocks until the text appears (or disappears) |

`type` sends key events where the virtual keyboard map has the characters and
sets the field's text through `ACTION_SET_TEXT` where it does not, so `Grüße`
and `日本` arrive intact with the server. Without it, `input text` drops
non-ASCII on most builds and adbax warns about it. After typing, `type` reads the
field back and says so when it holds something else, a sign that an IME
autocorrected it or that characters went missing.

## Apps

| Command | |
| --- | --- |
| `apps [filter] [--system]` | installed packages, third-party only unless `--system` |
| `launch <package>` | starts the launcher activity and returns once it is drawn |
| `start <package/.Activity>` | starts one activity |
| `stop <package>` | force-stop |
| `clear <package>` | wipe the app's data |
| `install <apk> [split.apk ...]` | `-r -g -t`: replace, grant runtime permissions, allow test builds. Several files are installed as one split APK |
| `uninstall <package>` | |
| `deeplink <url> [package]` | an `ACTION_VIEW` intent |
| `perm <grant\|revoke> <package> <PERMISSION>...` | `CAMERA` is short for `android.permission.CAMERA` |
| `perms <package>` | runtime permissions and their state |

## Debugging

| Command | |
| --- | --- |
| `log [package] [--lines 200] [--grep re] [--level W]` | logcat; with a package, only its current process |
| `crash` | the crash buffer, which survives the process dying |
| `clearlog` | empties the main and crash buffers |

## Device state

| Command | |
| --- | --- |
| `dark <on\|off>` | night mode |
| `font <scale>` | system font scale, `1.0` normal, `1.3` large, `2.0` the maximum |
| `anim <on\|off>` | all three animation scales; off also makes reads after actions settle sooner |
| `rotate <0\|90\|180\|270\|auto>` | |
| `demo <on\|off>` | SystemUI demo mode: 10:00, full battery and signal, no notification icons |

## The server

| Command | |
| --- | --- |
| `server status` | pid, Android version, uptime and the forwarded port |
| `server start [--idle seconds]` | start it now rather than on first use |
| `server stop` | stop it and free the accessibility connection |
| `server restart` | |
| `server log` | the server's stderr, from `/data/local/tmp/adbax-server.log` |

## Raw adb

| Command | |
| --- | --- |
| `shell <command>` | runs on the device shell |
| `pull <remote> [local]`, `push <local> <remote>` | |
| `version` | |

`text`, `press`, `screencap`, `logcat` and `ls` are aliases of `type`,
`longpress`, `screenshot`, `log` and `apps`.

## Environment

| Variable | |
| --- | --- |
| `ANDROID_SERIAL` | the device to use; `-s` and `adbax use` do the same |
| `ANDROID_HOME` | the SDK, if adb or the emulator is not on the PATH |
| `ADBAX_SERVER=0` | never start the on-device server |
| `ADBAX_SERVER_IDLE` | seconds before an unused server exits (600) |
| `ADBAX_CACHE` | where the device pin and the last dump go (`~/.cache/adbax`) |
| `ADBAX_TRACE=1` | print every adb call and server request with its duration |
