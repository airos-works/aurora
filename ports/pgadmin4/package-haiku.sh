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

mkdir -p "$STAGE/apps" "$STAGE/data/deskbar/menu/Applications" "$STAGE/data/licenses"
cp -a "$APP" "$STAGE/apps/pgAdmin4"
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
	cmd:node
	python3.12
	postgresql18
	postgresql18_server
	lib:libpq
	lib:libssl
	lib:libcrypto
	lib:libffi
	lib:libzstd
	lib:libbrotlienc
}
INFO
mkdir -p "$OUT"
package create -C "$STAGE" "$OUT/pgadmin4-$VERSION-1-$ARCH.hpkg"
echo "$OUT/pgadmin4-$VERSION-1-$ARCH.hpkg"
