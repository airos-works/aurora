#!/bin/bash
# Make pgadmin4-<version>-1-<arch>.hpkg from the app folder build-haiku.sh made:
#   ports/pgadmin4/package-haiku.sh <app folder> <version> <output directory>
set -euo pipefail
APP=$(cd -- "${1:?app folder}" && pwd)
VERSION=${2:?version}
OUT=${3:?output directory}
ARCH=$(uname -m)
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/pgadmin-package.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/apps/pgAdmin4" "$STAGE/data/deskbar/menu/Applications" "$STAGE/data/licenses"
# Not the engine a development build may link to: the package uses Summit's.
tar -C "$APP" --exclude=./webkit -cf - . | tar -C "$STAGE/apps/pgAdmin4" -xf -
TARGET=$STAGE/apps/pgAdmin4
# The port's launcher settings, not a development folder's (runtime, REPL, traces).
PORT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cp "$PORT/files/aurora.json" "$TARGET/aurora.json"
SITE=$(cd "$TARGET/venv/lib/python3."*/site-packages && pwd)

echo "== Trim"
# Installing tools, and the commands pip generated (they name the build path).
rm -rf "$SITE"/pip "$SITE"/pip-* "$SITE"/setuptools "$SITE"/setuptools-* "$SITE"/wheel "$SITE"/wheel-* \
    "$SITE"/_distutils_hack "$SITE"/distutils-precedence.pth
find "$TARGET/venv/bin" -mindepth 1 ! -name 'python*' -exec rm -f {} +
# pgAdmin builds three Google APIs; the client ships 100 MB of the others.
find "$SITE/googleapiclient/discovery_cache/documents" -name '*.json' \
    ! -name 'cloudresourcemanager.*' ! -name 'compute.*' ! -name 'sqladmin.*' -delete
find "$SITE/pgadmin4" -name '*.js.map' -delete
find "$TARGET/venv" -name '*.so' -exec strip --strip-debug {} +
# The launcher: strip drops its resources (signature, icon), so keep them.
LAUNCHER="$TARGET/pgAdmin 4"
xres -o "$STAGE/launcher.rsrc" "$LAUNCHER"
strip --strip-debug "$LAUNCHER"
xres -o "$LAUNCHER" "$STAGE/launcher.rsrc"
mimeset -f "$LAUNCHER"
# The package is read-only: compile once, and never check the sources again.
"$TARGET/venv/bin/python3" -m compileall -q -j 0 --invalidation-mode unchecked-hash \
    -s "$STAGE" -p /boot/system "$SITE" > /dev/null
ln -s "../../../../apps/pgAdmin4/pgAdmin 4" "$STAGE/data/deskbar/menu/Applications/pgAdmin 4"
cp "$APP/LICENSE" "$STAGE/data/licenses/pgAdmin"
cat > "$STAGE/.PackageInfo" <<INFO
name			pgadmin4
version			$VERSION-1
architecture	$ARCH
summary			"The administration and development platform for PostgreSQL"
description		"pgAdmin 4 is the most popular and feature rich open source administration \
and development platform for PostgreSQL. This is its desktop app, which runs on Haiku \
with Aurora; the pgAdmin server runs from its own Python environment."
packager		"KunanyiOS contributors"
vendor			"KunanyiOS"
copyrights		{ "2013-2026 The pgAdmin Development Team" }
licenses		{ "pgAdmin" }
urls			{ "https://www.pgadmin.org/" }
provides {
	pgadmin4 = $VERSION
	app:pgAdmin_4 = $VERSION
}
requires {
	haiku
	aurora >= 0.1
	cmd:python3.12
	lib:libpq >= 5
	lib:libssl >= 3
	lib:libcrypto >= 3
	lib:libffi >= 8
	cmd:psql
	cmd:pg_dump
	cmd:pg_dumpall
	cmd:pg_restore
}
INFO
mkdir -p "$OUT"
package create -C "$STAGE" "$OUT/pgadmin4-$VERSION-1-$ARCH.hpkg"
echo "$OUT/pgadmin4-$VERSION-1-$ARCH.hpkg"
