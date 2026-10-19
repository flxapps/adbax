---
name: android-device
description: Drive an Android emulator or physical device through its accessibility tree instead of screenshots and pixel guessing. Boot AVDs, read the screen as a labelled node list, tap and type by label, scroll to off-screen elements, wait for state, install APKs, read logcat and crashes, play canvas games through grid screenshots, set dark mode / font scale / demo-mode status bar for store screenshots. Use whenever a task involves an emulator or a connected phone, e.g. "open the app on the emulator", "tap through onboarding", "boot Pixel_7_Pro and check the settings screen", "why does it crash on launch", "take store screenshots".
---

# Driving an Android device

`adbax` must be on the PATH (`npm install -g @flxapps/adbax`, or a link to
`bin/adbax.js` in a checkout). `adbax help` prints the whole surface.

## Read the tree, do not read pixels

A full-size phone screenshot costs about 1,800 image tokens, has to be read
like an image and gives coordinates you then guess at. The accessibility tree
costs a few hundred text tokens and gives exact labels, ids and centres:

```
$ adbax ui
# com.android.settings/.Settings   1080x1920   11 nodes
  [0]  TAP     "Search settings"  id=search_action_bar  @540,147  1038x126
  [5]  TAP     "Network & Internet / Wi‑Fi, mobile, data usage"  id=dashboard_tile  @540,903  1080x189
```

Then act on the label, never on the pixel:

```bash
adbax tap "Network & Internet"
```

The first call starts a small server on the device (about a second). After
that a read takes 0.2-0.3 s end to end, so reading after every step is cheap.
If adbax says the server is unavailable it has fallen back to `uiautomator dump`
at about 2 s per read; budget for that and do not poll `ui` in a loop.

## The loop

Chain steps in **one** Bash call; each `adbax` is its own process and `&&` costs
nothing:

```bash
adbax launch com.example.app && adbax wait "Start" && adbax tap "Settings" --ui
```

`--ui` on any action prints the screen it led to, after waiting for the
transition to finish. Use it whenever you need to see the result.

| Want | Command |
| --- | --- |
| see the screen | `adbax ui` (`--all` includes layout nodes, `--full` adds classes, `--windows` adds system bars and the keyboard) |
| find one thing | `adbax find "Delete"` (cheaper to read than a full dump) |
| everything about a node | `adbax inspect "Delete"` (attributes plus ancestor chain) |
| tap | `adbax tap "Sign in"` / `adbax tap 5` / `adbax tap 540,1200` |
| type | `adbax type you@example.com --into Email --enter` |
| replace a field's text | `adbax type "new" --into Name --clear` |
| off-screen element | `adbax scroll-to "Delete account" --tap` |
| block until ready | `adbax wait "Welcome" --timeout 20` (`--gone` for the inverse) |
| hardware keys | `adbax key back home enter recents del` |

Selectors match **text, content-desc and resource-id**, case-insensitively,
exact before prefix before substring. A match that is not itself clickable
resolves to its nearest clickable ancestor, so `adbax tap "mobile, data usage"`
hits the whole row. `--re` switches to a regex.

**Ambiguity exits 2 and lists the candidates** rather than picking one. Narrow
the query, or pass `--nth N` / `--first`. Treat that list as the answer, not as
an error to retry around.

`adbax tap 5` reuses the last read's row numbers and skips a fresh one. Row
numbers are only valid until the screen changes.

`type` handles umlauts, CJK and emoji when the server runs (it sets the field's
text for characters the keyboard map lacks and says so). It reads the field back
afterwards and reports when it holds something other than what was typed.

## When the tree comes back empty

Compose, Views and Flutter all populate it. What does not:

- Games and other canvas or GL surfaces. These draw without nodes.
- `FLAG_SECURE` windows: payment sheets, some password managers. Screenshots of
  them come back black as well.
- WebViews that draw to a `<canvas>`.

For those, read the screen as an image with a coordinate grid, and tap in the
image's own pixels:

```bash
adbax screenshot --grid            # prints the path of a 540 px JPEG with a labelled grid
adbax tap 270,480 --shot           # 270,480 in that image, scaled to the screen
adbax swipe 100,800,440,800 --shot --dur 400
```

Read the labels off the grid rather than estimating. `--shot` always refers to
the last screenshot taken on that device, so take a fresh one after the screen
moves. `adbax screenshot --small` is the same image without the grid.

## The server holds the accessibility connection

Android allows one UiAutomation client at a time. While the adbax server runs,
`uiautomator dump`, UiAutomator or screenshot instrumentation tests, Appium and
Maestro cannot connect. Before running instrumentation tests, `adbax server stop`.
It also exits on its own after ten minutes without a request.

## Device and app management

```bash
adbax avds                       # list AVDs
adbax boot Pixel_7_Pro           # boots, waits for sys.boot_completed, pins it
adbax devices                    # * marks the pinned one
adbax use emulator-5554          # pin when several are attached (or -s per call)

adbax apps example               # installed third-party packages matching "example"
adbax install app-debug.apk      # -r -g -t, so runtime permissions are pre-granted
adbax install base.apk split_config.arm64_v8a.apk   # split APKs in one go
adbax launch com.example.app     # returns once the activity is drawn
adbax clear com.example.app      # wipe data, back to first run
adbax deeplink "myapp://order/42"
adbax perm grant com.example.app POST_NOTIFICATIONS
```

## Debugging

```bash
adbax clearlog && adbax launch com.example.app && adbax log com.example.app --lines 200 --level W
adbax crash                      # the crash buffer, which survives the process dying
adbax log com.example.app --grep "OkHttp|Retrofit"
```

`log <pkg>` resolves the current pid, so after the app restarts it shows the
new process only. Without a package it is the whole buffer.

## Screenshots worth keeping

```bash
adbax demo on                    # 10:00, full battery, full signal, no notification icons
adbax dark on
adbax anim off                   # also makes reads after actions settle sooner
adbax font 1.0
adbax screenshot ~/shots/01.png  # full resolution
adbax demo off
```

`adbax record 20 walkthrough.mp4` for a clip.
