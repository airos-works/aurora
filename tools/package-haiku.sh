#!/bin/bash
# Make aurora-<version>-1-<arch>.hpkg on Haiku from a built tree:
#   make WEBKIT_BUNDLE=... && tools/package-haiku.sh [output directory]
# Installs the runtime in data/aurora, the host beside it and `aurora` and
# `electron` commands; the WebKit engine is Summit's (see host/Environment.h).
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
OUT=${1:-$ROOT/build}
BUILD=${BUILD:-$ROOT/build}
VERSION=$(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$ROOT/runtime/package.json" | head -1)
ARCH=$(uname -m)
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/aurora-package.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/bin" "$STAGE/data/aurora/runtime" "$STAGE/documentation/packages/aurora"
cp -r "$ROOT/runtime/lib" "$ROOT/runtime/package.json" "$ROOT/runtime/tools" "$STAGE/data/aurora/runtime/"
cp "$BUILD/aurora-host" "$STAGE/data/aurora/aurora-host"
cat > "$STAGE/bin/aurora" <<'SCRIPT'
#!/bin/sh
# aurora: run an Electron app on Haiku (aurora --help).
exec "${AURORA_NODE:-node}" /boot/system/data/aurora/runtime/lib/main.js "$@"
SCRIPT
chmod +x "$STAGE/bin/aurora"
ln -s aurora "$STAGE/bin/electron"
cp "$ROOT/README.md" "$ROOT/LICENSE" "$STAGE/documentation/packages/aurora/" 2>/dev/null || cp "$ROOT/LICENSE" "$STAGE/documentation/packages/aurora/"
cat > "$STAGE/.PackageInfo" <<INFO
name			aurora
version			$VERSION-1
architecture	$ARCH
summary			"Runs Electron apps on Haiku with the system WebKit engine"
description		"Aurora runs apps written for Electron: Node.js is the main process, and the \
app's windows are native Haiku windows drawn by Summit's WebKit engine. Pages get \
Electron's preload scripts, ipcRenderer and contextBridge; menus, dialogs, the \
clipboard and notifications are Haiku's own."
packager		"KunanyiOS contributors"
vendor			"KunanyiOS"
copyrights		{ "2026 KunanyiOS contributors" }
licenses		{ "MIT" }
provides {
	aurora = $VERSION
	cmd:aurora = $VERSION
	cmd:electron = $VERSION
}
requires {
	haiku
	cmd:node
}
INFO
mkdir -p "$OUT"
package create -C "$STAGE" "$OUT/aurora-$VERSION-1-$ARCH.hpkg"
echo "$OUT/aurora-$VERSION-1-$ARCH.hpkg"
