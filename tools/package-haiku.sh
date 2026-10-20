#!/bin/bash
# Make aurora-<version>-<revision>-<arch>.hpkg on Haiku from a built tree:
#   make WEBKIT_BUNDLE=... && tools/package-haiku.sh [output directory]
# Installs the runtime in data/aurora, the host beside it and `aurora` and
# `electron` commands; the WebKit engine is Summit's summit_webkit package,
# in /boot/system/lib/summit-webkit (see host/Environment.h).
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
OUT=${1:-$ROOT/build}
BUILD=${BUILD:-$ROOT/build}
VERSION=$(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$ROOT/runtime/package.json" | head -1)
# The package's revision: raise it for a new package of the same version
# (pkgman does not replace an installed package with an equal version).
REVISION=1
ARCH=$(uname -m)
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/aurora-package.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/bin" "$STAGE/data/aurora/runtime" "$STAGE/documentation/packages/aurora"
cp -r "$ROOT/runtime/lib" "$ROOT/runtime/package.json" "$ROOT/runtime/tools" "$STAGE/data/aurora/runtime/"
cp "$BUILD/aurora-host" "$STAGE/data/aurora/aurora-host"
# strip drops the resources appended to the executable: add them back.
strip --strip-debug "$STAGE/data/aurora/aurora-host"
xres -o "$STAGE/data/aurora/aurora-host" "$BUILD/aurora-host.rsrc"
mimeset -f "$STAGE/data/aurora/aurora-host"
# The Deskbar add-on for Tray icons; Deskbar finds it by its signature.
cp "$BUILD/aurora-tray" "$STAGE/data/aurora/aurora-tray"
strip --strip-debug "$STAGE/data/aurora/aurora-tray"
xres -o "$STAGE/data/aurora/aurora-tray" "$BUILD/aurora-tray.rsrc"
mimeset -f "$STAGE/data/aurora/aurora-tray"
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
version			$VERSION-$REVISION
architecture	$ARCH
summary			"Runs Electron apps on Haiku with the system WebKit engine"
description		"Aurora runs apps written for Electron: Node.js is the main process, and the \
app's windows are native Haiku windows drawn by Summit's WebKit engine. Pages get \
Electron's preload scripts, ipcRenderer and contextBridge, and Node.js with \
nodeIntegration; menus, dialogs, the clipboard, notifications and the key store \
are Haiku's own."
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
	summit_webkit >= 1.10.0
}
INFO
mkdir -p "$OUT"
package create -C "$STAGE" "$OUT/aurora-$VERSION-$REVISION-$ARCH.hpkg"
echo "$OUT/aurora-$VERSION-$REVISION-$ARCH.hpkg"
