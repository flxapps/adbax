# Working on adbax

- Node 18+, ES modules, **no runtime dependencies**. Keep it that way: adbax is
  installed globally and run hundreds of times a session, and every dependency is
  startup time and an attack surface. `node:` built-ins only.
- `docs/architecture.md` explains the layout and the on-device server. Read it
  before changing `src/device.js`, `src/backends/` or anything in `server/`.
- Commands never pick a backend. They call `Device`, which uses the server where
  it runs and `adb shell` where it does not. A new command has to work on both,
  or say clearly why it needs the server (`--windows`, `--grid`).
- The server's dump format must stay what `uiautomator dump` writes. One parser
  reads both, and `adbax ui` must print the same rows on either backend. Check a
  change there by diffing `adbax ui` against `adbax ui --no-server` on the same
  screen (stop the server first: they cannot both hold the connection).

## Building and checking

```sh
npm test                                   # the frozen-dump parser test
sh server/build.sh                         # after any change in server/src; commit the jar
ADBAX_TRACE=1 adbax ui                       # where the time goes
```

`server/build.sh` needs a JDK 11+ (`JAVA_HOME`) and an Android SDK with a
platform and build-tools. The jar is committed so that a clone and the npm
package work without either. The server compiles at `-source 8` against
android.jar, which has no `LambdaMetafactory`: no lambdas, anonymous classes
instead.

Test server changes on more than one Android version. The hidden APIs it uses
moved between releases; `Automation.java` lists which ones and where. Emulators
cover it: 8.1 (API 27), 13 (33) and 17 (37) are what it has been run on.

## Writing

Commit messages are lowercase, one line, saying what changed. Docs and help
text say what a thing does and give the actual number; no marketing tone.
