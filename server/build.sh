#!/bin/sh
# Builds server/adbax-server.jar: javac against the newest android.jar in the
# SDK, then d8 to dex. Needs a JDK 11 or newer (17 is what it is built with)
# and an Android SDK with a platform and build-tools installed.
#
#   ANDROID_HOME  SDK location (default ~/Library/Android/sdk, then ~/Android/Sdk)
#   JAVA_HOME     JDK to compile with (default: javac on PATH)
set -eu

here=$(cd "$(dirname "$0")" && pwd)
sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
if [ -z "$sdk" ]; then
  for guess in "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
    [ -d "$guess" ] && sdk=$guess && break
  done
fi
[ -n "$sdk" ] && [ -d "$sdk" ] || { echo "build.sh: set ANDROID_HOME" >&2; exit 1; }

newest() { ls -d "$1"/* 2>/dev/null | sort -V | tail -n 1; }
platform=$(newest "$sdk/platforms")
buildtools=$(newest "$sdk/build-tools")
[ -f "$platform/android.jar" ] || { echo "build.sh: no platform in $sdk/platforms" >&2; exit 1; }
[ -x "$buildtools/d8" ] || { echo "build.sh: no d8 in $sdk/build-tools" >&2; exit 1; }

javac=javac
[ -n "${JAVA_HOME:-}" ] && javac="$JAVA_HOME/bin/javac"

# Relative paths from here on: the file lists below are word-split, and the
# checkout may sit under a directory with a space in its name.
cd "$here"
rm -rf build
mkdir -p build/classes

# -source/-target 8 because d8 desugars from there and the server has to run
# on API 24; android.jar stands in for the JDK's own class library.
"$javac" -source 8 -target 8 -Xlint:-options -encoding UTF-8 \
  -bootclasspath "$platform/android.jar" \
  -d build/classes $(find src -name '*.java')

"$buildtools/d8" --release --min-api 24 --lib "$platform/android.jar" \
  --output build/adbax-server.jar $(find build/classes -name '*.class')

cp build/adbax-server.jar adbax-server.jar
echo "built $here/adbax-server.jar ($(basename "$platform"), build-tools $(basename "$buildtools"))"
