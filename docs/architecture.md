# How adbax works

Two halves: a Node CLI on the host, and a small Java server that runs on the
device. The CLI works without the server, just slower.

```
bin/adbax.js              entry point, turns errors into exit codes
src/cli.js               command table and help
src/args.js              argv into command, positionals and flags
src/adb.js               finding adb, choosing the device, running adb
src/device.js            one device: picks a backend, reads the tree, acts
src/backends/server.js   host half of the on-device server
src/backends/shell.js    the fallback: uiautomator dump and `input`
src/tree.js              XML into nodes, nodes into rows, rows into text
src/select.js            matching a selector against the tree
src/commands/*.js        one file per group of commands
server/src/              the on-device server
server/build.sh          javac + d8 into server/adbax-server.jar
```

Commands only ever talk to a `Device`. Which backend sits behind it is decided
once per call, the first time it is needed.

## Why `uiautomator dump` is slow

`adb shell uiautomator dump` runs `/system/framework/uiautomator.jar` through
`app_process`, so every call:

1. starts a VM (a few hundred ms, more on old releases),
2. registers a new UiAutomation connection with the accessibility manager,
3. calls `waitForIdle(1000, 10000)`. A fresh connection has never seen an
   event, so it counts "idle" from the moment it connected and always waits the
   full second,
4. dumps the active window to a file and exits.

Steps 1 and 3 are almost all of the two seconds, and both exist only because
the process is new.

## The server

`server/src/es/flx/adbax` is about 870 lines of Java, compiled against
`android.jar` and dexed with d8. adbax pushes the jar to
`/data/local/tmp/adbax-server.jar` and starts it:

```sh
CLASSPATH=/data/local/tmp/adbax-server.jar nohup app_process / --nice-name=adbax-server \
    es.flx.adbax.Main --socket adbax --token <jar md5> --serial <adb serial> --idle 600
```

It runs as the shell user, the same as `uiautomator`, so it may inject input and
read every window, and it needs no APK and no permission prompt.

- `Automation` creates and connects the UiAutomation through hidden API, by
  reflection. The constructor takes a Looper up to Android 13 and may take a
  Context later, so both are tried. It connects with
  `FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES`, so TalkBack keeps running. The
  same class finds the top activity: `getStackInfo(getFocusedStackId())` up to
  8.1, `getFocusedStackInfo` from 9, on IActivityTaskManager from 10,
  `getFocusedRootTaskInfo` from 12.
- `Hierarchy` writes the tree in the format `uiautomator dump` uses: the same
  attributes in the same order, the same rule of skipping children that are not
  visible to the user, bounds clipped to the display. The host parses both with
  one parser, and the fallback prints the same rows.
- `Input` injects touches and keys through the connection, and types through
  the virtual keyboard's key map, falling back to `ACTION_SET_TEXT` for
  characters the map does not have.
- `Grid` draws the screenshot grid. Its labels are stroked seven-segment digits:
  an `app_process` has no font setup, and drawing text on Android 8 aborts it.
- `Server` listens on the abstract unix socket `@adbax`.

### Protocol

One request per connection. The host writes one line of JSON and the server
answers with one line of JSON, then the payload (XML or image bytes) until it
closes the socket.

```
> {"cmd":"dump","settle":150,"idle":300,"timeout":3000}
< {"ok":true,"busy":false,"activity":"com.android.settings/.SubSettings","width":1080,
   "height":2400,"rotation":0,"waitMs":212,"dumpMs":18,"token":"7fa7…","serial":"emulator-5554"}
< <?xml version='1.0' …><hierarchy …>…</hierarchy>
```

| cmd | |
| --- | --- |
| `ping` | sdk, pid, uptime |
| `dump` | `settle`, `idle`, `timeout`, `windows` |
| `screenshot` | `width`, `format` (`png`/`jpeg`), `quality`, `grid` |
| `tap` | `x`, `y` |
| `swipe` | `x1`, `y1`, `x2`, `y2`, `ms` |
| `key` | `code` or `name`, `long` |
| `text` | `text`: key events, or `ACTION_SET_TEXT` for what the key map lacks |
| `settext` | `text`, `append`: always `ACTION_SET_TEXT` |
| `focus` | the node with input focus: editable, text, password |
| `activity` | the top activity |
| `quit` | disconnect and exit |

Requests are served one at a time. A client that connects and sends nothing is
dropped after 10 s.

### Reading after an action

A plain `dump` waits up to 2 s for 300 ms without accessibility events. On a
settled screen the last event is long past and that returns at once. That is
the part a fresh connection cannot do.

After an action the host sends `settle: 150`. The server sleeps that long so
the app has started reacting, waits for the events to stop, and then compares
the top activity's package with the package of the active window. When they
differ, an activity switch has not reached the accessibility tree yet, and it
keeps waiting until they agree or `timeout` runs out. It only checks that after
an action: with the notification shade or a system dialog open the two disagree
for as long as it stays open, and a plain read should not wait that out.

One gap remains: a new activity of the same package can go quiet before its
content is attached, which reads as an empty screen. If a read after an action
has no rows, the host reads again every 250 ms until something shows or two
reads come back identical. A game's canvas has no rows either, and two
identical reads end the loop for it after a quarter of a second.

### The node cache

The framework caches accessibility nodes per connection and invalidates them
from accessibility events. A long-lived connection depends on every toolkit
sending the right events, and they do not: a Compose text field kept reporting
the text of three edits ago. So the server clears the cache before every dump
and before every look at the focused field. `UiAutomation.clearCache()` exists
from Android 14; before that it is `AccessibilityInteractionClient.clearCache(id)`,
which is what `setServiceInfo()` calls first. On a settled screen a full read
still takes 10-15 ms.

### Lifecycle and versioning

- **Start.** On the first command that needs it. The host pushes the jar when
  the MD5 on the device differs, kills any older server (only one UiAutomation
  client may exist), starts the new one and polls `ping` until it answers.
- **Version.** The jar's MD5 is passed as `--token` and echoed in every reply. A
  server answering with another token is an older build, so the host sends it
  `quit` and starts the current one.
- **Port.** `adb forward tcp:0 localabstract:adbax` picks a free port, which is
  cached in `~/.cache/adbax/port-<serial>` to save an `adb forward --list` per
  call. The server echoes its `--serial`, so a cached port that adb has since
  given to another device is noticed rather than used.
- **Exit.** After `--idle` seconds without a request (600 by default), on
  `quit`, or when killed. The UiAutomation registration dies with the process.
- **Failure.** A server that cannot start on a device (below API 24, or a stack
  trace in its log) is recorded in `~/.cache/adbax/server-<serial>.json` against
  the jar's MD5, and adbax stays on the shell backend for that device until the
  jar changes or `adbax server start` asks again. If another UiAutomation client
  holds the connection, adbax says so and does not record anything.

### Interactive windows

`getWindows()` only works with `FLAG_RETRIEVE_INTERACTIVE_WINDOWS` set. With that
flag on, the framework also reports views scrolled underneath other views as
invisible, so a dump stops matching what `uiautomator dump` prints for the same
screen (on the Android 17 Settings home, 81 nodes against 88). The server
therefore turns the flag on only for the duration of a `--windows` dump.

## Building

`server/build.sh` compiles with `javac -source 8 -target 8` against the newest
`android.jar` in the SDK and dexes with d8 at `--min-api 24`. The android.jar
stubs have no `LambdaMetafactory`, so the server uses anonymous classes instead
of lambdas. The jar is about 13 KB and checked in, so neither a clone nor the
npm package needs an Android SDK.
