#!/usr/bin/env sh
# Experimental POSIX launcher. The first release targets Windows; macOS/Linux
# keyring backends are not implemented yet, so only --mode env is usable there.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if command -v node >/dev/null 2>&1; then
  exec node "$HERE/zcode-sync.cjs" "$@"
fi

for candidate in \
  "/Applications/ZCode.app/Contents/MacOS/ZCode" \
  "$HOME/Applications/ZCode.app/Contents/MacOS/ZCode" \
  "/opt/ZCode/zcode" \
  "/usr/bin/zcode" \
  "/usr/local/bin/zcode"
do
  if [ -x "$candidate" ]; then
    ELECTRON_RUN_AS_NODE=1 exec "$candidate" "$HERE/zcode-sync.cjs" "$@"
  fi
done

echo "[zcode-sync] ZCode or Node.js not found; set ZCODE_EXE." >&2
exit 4
