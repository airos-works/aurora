#!/bin/bash
# Build the pgAdmin 4 app and package on Haiku from a folder made by stage.sh.
#
#   ports/pgadmin4/build-haiku.sh <stage> <app folder> [package output directory]
#
# Needs: python3.12, rust_bin, llvm21_lld, postgresql18_devel and
# postgresql18_server (pg_config), libffi_devel, openssl3_devel, zstd_devel,
# brotli_devel, and a built aurora-host (AURORA_HOST_BINARY).
# Native wheels are kept in $PGADMIN_WHEELHOUSE (default <stage>/wheelhouse)
# so a rebuild does not compile cryptography again.
set -euo pipefail
PORT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
AURORA=$(cd -- "$PORT/../.." && pwd)
STAGE=$(cd -- "${1:?usage: build-haiku.sh <stage> <app folder> [package directory]}" && pwd)
APP=${2:?usage: build-haiku.sh <stage> <app folder> [package directory]}
PACKAGES=${3:-}
PYTHON=${PYTHON:-python3.12}
WHEELS=${PGADMIN_WHEELHOUSE:-$STAGE/wheelhouse}
HOST_BINARY=${AURORA_HOST_BINARY:?set AURORA_HOST_BINARY to a built aurora-host}
VERSION=$(cat "$STAGE/VERSION")

export CARGO_TARGET_X86_64_UNKNOWN_HAIKU_LINKER="$AURORA/tools/haiku-rust-linker"
export PIP_DISABLE_PIP_VERSION_CHECK=1
mkdir -p "$WHEELS" "$APP"
APP=$(cd -- "$APP" && pwd)

echo "== Python environment"
rm -rf "$APP/venv" "$APP/runtime" "$APP/web"
"$PYTHON" -m venv "$APP/venv"
"$APP/venv/bin/pip" install --quiet --upgrade pip wheel
# psycopg-c needs a Haiku case in its byte order shim (python-patches/).
PSYCOPG_C=$(sed -n "s/^psycopg\[c\]==\([0-9.]*\); python_version >= '3.10'.*/\1/p" "$STAGE/requirements-haiku.txt")
if [[ -n $PSYCOPG_C ]] && ! ls "$WHEELS"/psycopg_c-"$PSYCOPG_C"-*.whl >/dev/null 2>&1; then
    SOURCES=$(mktemp -d "${TMPDIR:-/tmp}/psycopg-c.XXXXXX")
    "$APP/venv/bin/pip" download --no-deps --no-binary :all: -d "$SOURCES" "psycopg-c==$PSYCOPG_C"
    tar -xzf "$SOURCES"/psycopg_c-"$PSYCOPG_C".tar.gz -C "$SOURCES"
    "$PYTHON" "$PORT/python-patches/psycopg-c-haiku.py" "$SOURCES/psycopg_c-$PSYCOPG_C"
    "$APP/venv/bin/pip" wheel --no-deps --wheel-dir "$WHEELS" "$SOURCES/psycopg_c-$PSYCOPG_C"
    rm -rf "$SOURCES"
fi
# Build every missing wheel once; binary wheels for Haiku do not exist on PyPI.
"$APP/venv/bin/pip" wheel --wheel-dir "$WHEELS" --find-links "$WHEELS" -r "$STAGE/requirements-haiku.txt"
"$APP/venv/bin/pip" install --no-index --find-links "$WHEELS" -r "$STAGE/requirements-haiku.txt"
"$APP/venv/bin/pip" install --no-deps "$STAGE"/pgadmin4-*.whl
SITE=$("$APP/venv/bin/python" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')
cp -r "$STAGE/files/psutil" "$SITE/"
cp "$STAGE/files/config_distro.py" "$SITE/pgadmin4/config_distro.py"
find "$APP/venv" -name __pycache__ -type d -prune -exec rm -rf {} +
ln -s "${SITE#$APP/}/pgadmin4" "$APP/web"

echo "== Runtime and launcher"
cp -r "$STAGE/runtime" "$APP/runtime"
cp "$STAGE/files/aurora.json" "$APP/aurora.json"
cp "$STAGE/LICENSE-pgAdmin" "$APP/LICENSE"
cp "$HOST_BINARY" "$APP/pgAdmin 4"
rc -I "$PORT/files" -o "$STAGE/pgAdmin4.rsrc" "$PORT/files/pgAdmin4.rdef"
xres -o "$APP/pgAdmin 4" "$STAGE/pgAdmin4.rsrc"
mimeset -f "$APP/pgAdmin 4"
echo "pgAdmin $VERSION is in $APP; run \"$APP/pgAdmin 4\""

if [[ -n $PACKAGES ]]; then
    echo "== Package"
    "$PORT/package-haiku.sh" "$APP" "$VERSION" "$PACKAGES"
fi
