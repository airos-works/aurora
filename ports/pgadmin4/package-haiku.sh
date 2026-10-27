#!/bin/bash
# Make pgadmin4-<version>-<revision>-<arch>.hpkg from the app folder build-haiku.sh made:
#   ports/pgadmin4/package-haiku.sh <app folder> <version> <output directory>
# On Haiku it uses the system's tools. cross.sh runs it on Linux with
# HAIKU_HOST_TOOLS (a Haiku build's host tools: xres, resattr, mimeset,
# package; HAIKU_MIME_DB its MIME database), CROSS (the cross binutils
# prefix), ARCH and PYTHON (a Python 3.12 that compiles the bytecode).
set -euo pipefail
APP=$(cd -- "${1:?app folder}" && pwd)
VERSION=${2:?version}
OUT=${3:?output directory}
# The package's revision: raise it for a new package of the same pgAdmin
# (pkgman does not replace an installed package with an equal version).
REVISION=3
ARCH=${ARCH:-$(uname -m)}
if [[ -n ${HAIKU_HOST_TOOLS:-} ]]; then
	TOOLS=$HAIKU_HOST_TOOLS
	XRES=$TOOLS/xres PACKAGE=$TOOLS/package/package STRIP=${CROSS:?cross binutils prefix}strip
	MIMESET=("$TOOLS/mimeset" --mimedb "${HAIKU_MIME_DB:?a Haiku build MIME database}")
	PYTHON=${PYTHON:?a Python 3.12 for the bytecode}
else
	XRES=xres PACKAGE=package STRIP=strip MIMESET=(mimeset) PYTHON=""
fi
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/pgadmin-package.XXXXXX")
# Outside the stage, or the package would install it in /boot/system.
RESOURCES=$(mktemp "${TMPDIR:-/tmp}/pgadmin-launcher.XXXXXX")
# The host tools keep attributes in their build's store: rm_attrs forgets them.
cleanup() {
	if [[ -n ${TOOLS:-} ]]; then
		"$TOOLS/rm_attrs" -rf "$STAGE" "$RESOURCES"
	else
		rm -rf "$STAGE" "$RESOURCES"
	fi
}
trap cleanup EXIT

mkdir -p "$STAGE/apps/pgAdmin4" "$STAGE/data/deskbar/menu/Applications" "$STAGE/data/licenses"
# Not the engine a development build may link to: the package uses Summit's.
tar -C "$APP" --exclude=./webkit -cf - . | tar -C "$STAGE/apps/pgAdmin4" -xf -
TARGET=$STAGE/apps/pgAdmin4
# The port's launcher settings, not a development folder's (runtime, REPL, traces).
PORT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cp "$PORT/files/aurora.json" "$TARGET/aurora.json"
SITE=$(cd "$TARGET/venv/lib/python3."*/site-packages && pwd)
# The venv's Python on Haiku (cross.sh's has none).
PYTHON=${PYTHON:-$TARGET/venv/bin/python3}

echo "== Trim"
# Installing tools, and the commands pip generated (they name the build path).
rm -rf "$SITE"/pip "$SITE"/pip-* "$SITE"/setuptools "$SITE"/setuptools-* "$SITE"/wheel "$SITE"/wheel-* \
    "$SITE"/_distutils_hack "$SITE"/distutils-precedence.pth
find "$TARGET/venv/bin" -mindepth 1 ! -name 'python*' -exec rm -f {} +
# pgAdmin builds three Google APIs; the client ships 100 MB of the others.
find "$SITE/googleapiclient/discovery_cache/documents" -name '*.json' \
    ! -name 'cloudresourcemanager.*' ! -name 'compute.*' ! -name 'sqladmin.*' -delete
find "$SITE/pgadmin4" -name '*.js.map' -delete
find "$TARGET/venv" -name '*.so' -exec "$STRIP" --strip-debug {} +
# The launcher: strip drops its resources (signature, icon), so keep them.
LAUNCHER="$TARGET/pgAdmin 4"
"$XRES" -o "$RESOURCES" "$LAUNCHER"
"$STRIP" --strip-debug "$LAUNCHER"
"$XRES" -o "$LAUNCHER" "$RESOURCES"
# On Haiku xres gives the file its attributes; on Linux resattr does.
[[ -z ${TOOLS:-} ]] || "$TOOLS/resattr/resattr" -O -o "$LAUNCHER" "$RESOURCES"
(cd "$STAGE" && "${MIMESET[@]}" -f "apps/pgAdmin4/pgAdmin 4")
# The package is read-only: compile once, and never check the sources again.
"$PYTHON" -m compileall -q -j 0 --invalidation-mode unchecked-hash \
    -s "$STAGE" -p /boot/system "$SITE" > /dev/null
ln -s "../../../../apps/pgAdmin4/pgAdmin 4" "$STAGE/data/deskbar/menu/Applications/pgAdmin 4"
cp "$APP/LICENSE" "$STAGE/data/licenses/pgAdmin"
cat > "$STAGE/.PackageInfo" <<INFO
name			pgadmin4
version			$VERSION-$REVISION
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
	aurora >= 0.3
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
# (a build machine's umask may have left them group-writable)
chmod -R go-w "$STAGE"
mkdir -p "$OUT"
rm -f "$OUT/pgadmin4-$VERSION-$REVISION-$ARCH.hpkg"
"$PACKAGE" create -q -C "$STAGE" "$OUT/pgadmin4-$VERSION-$REVISION-$ARCH.hpkg"
echo "$OUT/pgadmin4-$VERSION-$REVISION-$ARCH.hpkg"
