#!/usr/bin/env bash
# Stage pgAdmin 4 for the Haiku build: run on any machine with Node.js,
# Python 3 (PYTHON, default python3, with pip) and curl. The staged folder is
# copied to Haiku, where build-haiku.sh makes the app and its package, or
# cross.sh makes the package on Linux.
#
#   ports/pgadmin4/stage.sh <stage directory> [version]
#
# The runtime comes from the release source (its Electron main process and
# preloads), with the Haiku patches; the server from the PyPI wheel, which
# unlike the source release contains the built web bundle and the manual.
set -euo pipefail
PORT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
STAGE=${1:?usage: stage.sh <stage directory> [version]}
VERSION=${2:-9.18}
DOWNLOADS=${PGADMIN_DOWNLOADS:-$STAGE/downloads}
mkdir -p "$STAGE" "$DOWNLOADS"

tarball="$DOWNLOADS/pgadmin4-$VERSION.tar.gz"
[[ -f $tarball ]] || curl -fsSL -o "$tarball" "https://ftp.postgresql.org/pub/pgadmin/pgadmin4/v$VERSION/source/pgadmin4-$VERSION.tar.gz"
wheel="$DOWNLOADS/pgadmin4-$VERSION-py3-none-any.whl"
[[ -f $wheel ]] || "${PYTHON:-python3}" -m pip download --no-deps --only-binary :all: -d "$DOWNLOADS" "pgadmin4==$VERSION" >&2

rm -rf "$STAGE/runtime" "$STAGE/source"
mkdir -p "$STAGE/source"
tar -xzf "$tarball" -C "$STAGE/source" --strip-components=1 "pgadmin4-$VERSION/runtime" "pgadmin4-$VERSION/requirements.txt" "pgadmin4-$VERSION/LICENSE"
mv "$STAGE/source/runtime" "$STAGE/runtime"
for patch in "$PORT"/patches/*.patch; do
    patch -d "$STAGE" -p1 --quiet < "$patch"
done
# The runtime's own dependencies are plain JavaScript; electron itself is
# Aurora's and is not installed.
(cd "$STAGE/runtime" && npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
rm -f "$STAGE/runtime/yarn.lock" "$STAGE/runtime/dev_config.json.in"

# Requirements for Haiku: psutil is replaced by a shim, gssapi (Kerberos,
# server mode only) and Pillow (only for MFA QR codes) are left out.
grep -vE '^(#|$)' "$STAGE/source/requirements.txt" \
    | grep -vE '^(psutil|gssapi|pywinpty)' \
    | sed -e 's/^qrcode\[pil\]/qrcode/' > "$STAGE/requirements-haiku.txt"
cp "$wheel" "$STAGE/"
cp -r "$PORT/files" "$STAGE/files"
cp "$STAGE/source/LICENSE" "$STAGE/LICENSE-pgAdmin"
echo "$VERSION" > "$STAGE/VERSION"
echo "Staged pgAdmin $VERSION in $STAGE"
