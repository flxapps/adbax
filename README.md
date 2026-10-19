# adbax

adbax drives an Android phone or emulator by its accessibility tree. Run
`adbax ui` and you get the screen as a numbered list of labels with their
positions; `adbax tap "Sign in"` then taps whatever is labelled Sign in. You
never squint at a screenshot or guess a coordinate. The name is adb plus AX, a
common shorthand for accessibility.

I built it for Claude Code, after watching it screenshot the emulator, estimate
where a button was and tap beside it, again and again. Typed by hand or run from
a shell script, the commands behave the same.

```console
$ adbax ui
# com.android.settings/.Settings   1080x1920   11 nodes
  [0]  TAP     "Search settings"  id=search_action_bar  @540,147  1038x126
  [5]  TAP     "Network & Internet / Wi‑Fi, mobile, data usage"  id=dashboard_tile  @540,903  1080x189
  [6]  TAP     "Connected devices / Bluetooth, Cast"  id=dashboard_tile  @540,1092  1080x189
  ...
$ adbax tap "Network & Internet" --ui
tapped TAP "Network & Internet" id=dashboard_tile @540,903
# com.android.settings/.Settings$NetworkDashboardActivity   1080x1920   12 nodes
  [0]  TAP     "Navigate up"  @74,137  147x147
  ...
```

## Install

You need Node 18 or later and adb, either on the PATH or in the SDK that
`ANDROID_HOME` points to. adbax itself has zero dependencies.

```sh
npm install -g @flxapps/adbax
```

npm wouldn't take the bare name, hence the scope. The command is `adbax`.

## Usage

```sh
adbax ui                                # the screen; --all for every node, --json for scripts
adbax tap "Sign in"                     # by text, content-desc or resource-id
adbax tap 5                             # row 5 of the last `ui`, no fresh read
adbax tap "Sign in" --ui                # act, then print the screen it led to
adbax type you@example.com --into Email --enter
adbax scroll-to "Delete account" --tap
adbax wait "Welcome" --timeout 20
adbax launch com.example.app            # returns once the activity is drawn
adbax screenshot --small                # 540 px wide JPEG
```

Every invocation is a separate process, which means steps string together with
`&&`.

Matching ignores case and prefers an exact hit, then a prefix, then a
substring. If what matched can't be tapped itself, like the title text inside a
list row, adbax goes up to the closest clickable parent. When a selector fits
more than one node, adbax won't choose for you. It lists them and exits with
status 2:

```console
$ adbax tap "Play Store"
adbax: "Play Store" matches 2 nodes:
  --nth 0  TAP "Play Store" @158,1679
  --nth 1  TAP "Play Store" @923,2003
       Narrow the query, or add --nth N / --first.
```

A game, or anything else painted onto a canvas, exposes no tree at all. There,
`adbax screenshot --grid` draws a labelled coordinate grid over the image and
`adbax tap 270,480 --shot` takes coordinates in that image's own pixels. Whoever
reads the picture, usually a model, taps what it sees without converting to
screen size.

Dark mode, font scale, logcat, the environment variables and every other
command are in [docs/commands.md](docs/commands.md).

## The on-device server

Reading the screen with `uiautomator dump` costs roughly two seconds, even when
there's hardly anything on it. Each run boots a fresh VM, and since a brand-new
connection has no idea when the screen last changed, it then sits through a
whole second of waiting for things to go idle.

adbax gets around that. The first time you use it, it copies a 13 KB jar to
`/data/local/tmp` and launches it through `app_process` as the shell user:
there's no APK, and nothing asks for permission. That server holds one
accessibility connection for as long as it runs, so it always knows when the
screen last moved. Measured end to end on an arm64 Android 13 emulator,
`adbax ui` goes from 2.2 s down to 0.21-0.27 s, and most of what's left is Node
starting up. Only the very first call is slower, about a second, because it
starts the server. Taps, keys and swipes travel over that connection too, and
after each one adbax waits until the accessibility events die down rather than
sleeping for some fixed delay.

The server wants Android 7.0 (API 24) or later, and I've tried it on 8.1, 13
and 17. Older devices, or `--no-server`, get the same commands on top of
`uiautomator dump` and `input`, at the old speed.

There is one catch. Android hands out a single UiAutomation connection at a
time, so while the server holds it, UiAutomator and screenshot tests, Appium and
Maestro are locked out. After ten minutes without a request it exits on its
own, and `adbax server stop` releases it immediately.

The internals are written up in [docs/architecture.md](docs/architecture.md).

## Compared with an MCP server

Shell commands can be chained. For an agent,
`adbax launch com.example.app && adbax wait Start && adbax tap Settings --ui` is a
single tool call. Through an MCP server the same steps take four calls, and
every one of them goes back through the model. You can also type the identical
commands yourself, put them in CI, or hand them to any agent with shell access,
with no client to configure.

The price is that you need the shell. Chat apps that don't have one can't run
adbax at all. There's no schema either, so an agent picks the commands up from
`adbax help` or from the skill below. And a screenshot arrives as a path the
agent has to open, whereas an MCP tool returns the picture directly.

## With Claude Code

[`skill/SKILL.md`](skill/SKILL.md) shows an agent how to work with it: read the
tree, act on labels, chain steps, and keep screenshots for screens that have
nothing to read.

```sh
ln -s "$(npm root -g)/@flxapps/adbax/skill" ~/.claude/skills/android-device
```

## License

Apache 2.0, see [LICENSE](LICENSE).
