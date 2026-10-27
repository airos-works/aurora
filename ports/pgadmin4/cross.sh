#!/usr/bin/env bash
# Makes the pgadmin4 package for x86_64 or arm64 on Linux: what build-haiku.sh
# and package-haiku.sh do on Haiku, with cross tools (arm64 air/OS has no
# compiler of its own; air/OS CI builds both architectures this way):
#   ports/pgadmin4/cross.sh ARCH <stage directory> <output directory>
# The stage is stage.sh's, made here when it has no VERSION yet.
#
# The Python packages are requirements-haiku.lock. Pure ones are PyPI's
# wheels; the native ones (NATIVE) are cross-built with crossenv: a Linux
# CPython of the same version runs the builds, and sees the target's Python
# (its sysconfigdata, headers and Makefile) instead of its own. The Rust ones
# (cryptography, bcrypt) build std for the target with a nightly Rust. Their
# wheels are kept in PGADMIN_WHEELHOUSE, so a rebuild only packages.
# Environment:
#   AIROS_SDK          an air/OS cross SDK's env.sh for ARCH (CROSS, SYSROOT,
#                      TRIPLET, UNWIND_SPECS), default /data1/airos/sdk/ARCH/env.sh
#   HAIKU_HOST_TOOLS   a Haiku build's host tools (rc, xres, resattr, mimeset,
#                      package, rm_attrs) and HAIKU_MIME_DB its MIME database;
#                      the tools keep attributes in that build's own store
#   AURORA_HOST_BINARY aurora-host for ARCH (the aurora package's
#                      data/aurora/aurora-host), the launcher
#   TARGET_ROOT        a /boot/system tree for ARCH with CPython 3.12 (bin/,
#                      lib/python3.12 with its _sysconfigdata and config-3.12,
#                      develop/headers/python3.12) and the headers and
#                      libraries of libffi, libpq and OpenSSL 3
#   BUILD_PYTHON       a Linux CPython of the target's version (3.12)
#   RUST_ENV           airos-ci sdk/build-rust.sh's env-ARCH.sh (a nightly
#                      Rust with rust-src; RUST_TARGET)
#   PGADMIN_WHEELHOUSE native wheels (default <stage>/wheels-ARCH)
#   PGADMIN_CARGO_HOME Cargo's crate cache (default <stage>/cargo)
#   PYTHON             for stage.sh: a Python with pip (default BUILD_PYTHON)
# The package requires what package-haiku.sh lists: on arm64, air/OS CI's
# python3.12, libffi and postgresql18 packages provide them.
set -euo pipefail
ARCH=${1:?usage: cross.sh x86_64|arm64 <stage directory> <output directory>}
case $ARCH in
	arm64|x86_64) ;;
	*) echo "unknown architecture $ARCH" >&2; exit 1 ;;
esac
PORT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
STAGE_ARG=${2:?usage: cross.sh ARCH <stage directory> <output directory>}
OUT=${3:?usage: cross.sh ARCH <stage directory> <output directory>}
. "${AIROS_SDK:-/data1/airos/sdk/$ARCH/env.sh}"
TOOLS=${HAIKU_HOST_TOOLS:?a Haiku build's objects/linux/x86_64/release/tools}
MIMEDB=${HAIKU_MIME_DB:?a Haiku build's objects/common/data/mime_db/mime_db}
HOST_BINARY=${AURORA_HOST_BINARY:?aurora-host for ARCH}
ROOT=$(cd -- "${TARGET_ROOT:?a /boot/system tree with the target Python}" && pwd)
BUILD_PYTHON=${BUILD_PYTHON:?a Linux CPython 3.12}
. "${RUST_ENV:?sdk/build-rust.sh env-ARCH.sh}"

if [[ ! -f $STAGE_ARG/VERSION ]]; then
	PYTHON=${PYTHON:-$BUILD_PYTHON} "$PORT/stage.sh" "$STAGE_ARG"
fi
STAGE=$(cd -- "$STAGE_ARG" && pwd)
VERSION=$(cat "$STAGE/VERSION")
WHEELS=${PGADMIN_WHEELHOUSE:-$STAGE/wheels-$ARCH}
export CARGO_HOME=${PGADMIN_CARGO_HOME:-$STAGE/cargo}
PYVERSION=$(sed -n 's/^#define PY_VERSION[[:space:]]*"\(.*\)"/\1/p' "$ROOT/develop/headers/python3.12/patchlevel.h")
[[ $PYVERSION == 3.12.* ]] || { echo "no CPython 3.12 in $ROOT" >&2; exit 1; }
[[ $("$BUILD_PYTHON" -c 'import sys; print("%d.%d" % sys.version_info[:2])') == 3.12 ]] \
	|| { echo "$BUILD_PYTHON is not CPython 3.12" >&2; exit 1; }
WORK=$(mktemp -d "${TMPDIR:-/tmp}/pgadmin-$ARCH.XXXXXX")
trap '"$TOOLS/rm_attrs" -rf "$WORK" 2>/dev/null || rm -rf "$WORK"' EXIT
mkdir -p "$WHEELS" "$CARGO_HOME"
export PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1 PIP_NO_INPUT=1

# The packages native to the target, built here; everything else in the lock
# is pure Python.
NATIVE=(cffi markupsafe brotli backports-zstd pynacl psycopg-c bcrypt cryptography)
pinned() { sed -n "s/^$1==//p" "$PORT/requirements-haiku.lock"; }

echo "== Cross environment (CPython $PYVERSION for $ARCH)"
# The compilers with the SDK's sysroot: Python's build tools take a command
# without arguments.
mkdir -p "$WORK/bin"
printf '#!/bin/sh\nexec %sgcc --sysroot=%s -specs=%s "$@"\n' "$CROSS" "$SYSROOT" "$UNWIND_SPECS" > "$WORK/bin/haiku-cc"
printf '#!/bin/sh\nexec %sg++ --sysroot=%s -specs=%s "$@"\n' "$CROSS" "$SYSROOT" "$UNWIND_SPECS" > "$WORK/bin/haiku-c++"
chmod 755 "$WORK/bin/haiku-cc" "$WORK/bin/haiku-c++"
# crossenv names the target platform by the Makefile's _PYTHON_HOST_PLATFORM
# (sys.platform "haiku"), which only a cross-built Python sets: a copy of the
# target's Python with that set, everything else linked.
python=$WORK/python
mkdir -p "$python/lib/python3.12"
ln -s "$ROOT/bin" "$python/bin"
ln -s "$ROOT/develop" "$python/develop"
for entry in "$ROOT"/lib/*; do
	[[ $(basename "$entry") == python3.12 ]] || ln -s "$entry" "$python/lib/"
done
for entry in "$ROOT"/lib/python3.12/*; do
	[[ $(basename "$entry") == config-3.12 ]] || ln -s "$entry" "$python/lib/python3.12/"
done
cp -r "$ROOT/lib/python3.12/config-3.12" "$python/lib/python3.12/"
sed -i "s/^_PYTHON_HOST_PLATFORM=.*/_PYTHON_HOST_PLATFORM=haiku-1-${TRIPLET%%-*}/" \
	"$python/lib/python3.12/config-3.12/Makefile"
"$BUILD_PYTHON" -m venv "$WORK/tools"
"$WORK/tools/bin/pip" install -q crossenv==1.6.2 installer==0.7.0
"$WORK/tools/bin/python" -m crossenv "$python/bin/python3.12" "$WORK/xenv" \
	--cc "$WORK/bin/haiku-cc" --cxx "$WORK/bin/haiku-c++" --ar "${CROSS}ar" --sysroot "$SYSROOT" \
	--sysconfigdata-file "$(echo "$ROOT"/lib/python3.12/_sysconfigdata_*.py)" 2>&1 | grep -v '^WARNING: No' || true
XENV=$WORK/xenv/bin
# What the builds run on Linux (cffi generates C, maturin drives Cargo); the
# builds go without isolation, which would cross-build cffi itself.
"$XENV/build-pip" install -q setuptools==84.2.1 cffi==2.1.1 pycparser==3.0 maturin==1.15.0 \
	setuptools-rust==1.13.0
"$XENV/cross-expose" cffi pycparser setuptools-rust semantic-version maturin > /dev/null
export PATH=$WORK/xenv/build/bin:$PATH

# sdist NAME VERSION DIRECTORY: unpack PyPI's source release (checked against
# its SHA-256) into DIRECTORY/<name>-<version>.
sdist() {
	"$BUILD_PYTHON" - "$1" "$2" "$3" <<'PY'
import hashlib, json, sys, tarfile, urllib.request
name, version, into = sys.argv[1:]
release = json.load(urllib.request.urlopen(f"https://pypi.org/pypi/{name}/{version}/json"))
url = next(u for u in release["urls"] if u["packagetype"] == "sdist")
data = urllib.request.urlopen(url["url"]).read()
if hashlib.sha256(data).hexdigest() != url["digests"]["sha256"]:
    sys.exit(f"{url['filename']}: checksum mismatch")
path = f"{into}/{url['filename']}"
open(path, "wb").write(data)
tarfile.open(path).extractall(into, filter="data")
PY
	ls -d "$3"/*/ | head -1
}

# The target's libraries and headers (libffi, libpq, OpenSSL) and Python's.
TARGET_CFLAGS="-I$ROOT/develop/headers -I$ROOT/develop/headers/python3.12"
TARGET_LDFLAGS="-L$ROOT/develop/lib -L$ROOT/lib"
triple=${RUST_TARGET//-/_}
build_native() {
	local name=$1 version what
	version=$(pinned "$name")
	[[ -n $version ]] || { echo "$name is not in requirements-haiku.lock" >&2; return 1; }
	if compgen -G "$WHEELS/${name//-/_}-$version-*.whl" > /dev/null; then
		echo "$name $version (kept)"
		return
	fi
	echo "$name $version"
	local log=$WORK/$name.log src=$WORK/src-$name
	mkdir -p "$src"
	(
		export CFLAGS=$TARGET_CFLAGS LDFLAGS=$TARGET_LDFLAGS
		case $name in
		psycopg-c)
			# pg_config of the target's libpq, and the Haiku byte order shim
			what=$(sdist psycopg-c "$version" "$src")
			mkdir -p "$src/bin"
			printf '#!/bin/sh\ncase $1 in --includedir) echo %s ;; --libdir) echo %s ;; *) exit 1 ;; esac\n' \
				"$ROOT/develop/headers" "$ROOT/develop/lib" > "$src/bin/pg_config"
			chmod 755 "$src/bin/pg_config"
			export PATH=$src/bin:$PATH
			"$BUILD_PYTHON" "$PORT/python-patches/psycopg-c-haiku.py" "$what"
			;;
		pynacl)
			# The libsodium it bundles, static: its own build runs configure
			# for the build machine and then libsodium's tests.
			what=$(sdist pynacl "$version" "$src")
			mkdir -p "$src/sodium-build"
			(cd "$src/sodium-build" && CC=$WORK/bin/haiku-cc CFLAGS=-O2 LDFLAGS= \
				"$what/src/libsodium/configure" --host="$TRIPLET" --build="$(uname -m)-pc-linux-gnu" \
				--disable-shared --enable-static --disable-debug --disable-dependency-tracking --with-pic \
				--prefix="$src/sodium" && make -j"$(nproc)" && make install)
			export SODIUM_INSTALL=system CFLAGS="-I$src/sodium/include" LDFLAGS="-L$src/sodium/lib"
			;;
		bcrypt|cryptography)
			# std for the target with the release profile's LTO; PyO3 reads
			# the target's sysconfigdata, the C parts link the target's OpenSSL.
			export CARGO_BUILD_TARGET=$RUST_TARGET CARGO_UNSTABLE_BUILD_STD=std,panic_unwind
			export "CARGO_TARGET_${triple^^}_LINKER=$WORK/bin/haiku-cc" "CC_$triple=$WORK/bin/haiku-cc"
			export "AR_$triple=${CROSS}ar"
			export PYO3_CROSS=1 PYO3_CROSS_LIB_DIR=$ROOT/lib/python3.12 PYO3_CROSS_PYTHON_VERSION=3.12
			export OPENSSL_LIB_DIR=$ROOT/develop/lib OPENSSL_INCLUDE_DIR=$ROOT/develop/headers
			what="$name==$version"
			;;
		*)
			what="$name==$version"
			;;
		esac
		"$XENV/cross-pip" wheel --no-deps --no-build-isolation --no-binary "$name" -w "$WORK/wheels" "$what"
	) > "$log" 2>&1 || { tail -40 "$log"; echo "$name failed (log above)" >&2; return 1; }
	local wheel
	wheel=$(compgen -G "$WORK/wheels/${name//-/_}-$version-*.whl" | head -1) \
		|| { echo "no $name wheel" >&2; return 1; }
	# A build that fell back to pure Python (MarkupSafe does) is no native build.
	[[ $wheel != *-none-any.whl ]] || { tail -20 "$log"; echo "$name built no native code" >&2; return 1; }
	mv "$wheel" "$WHEELS/"
}

echo "== Native wheels ($WHEELS)"
for name in "${NATIVE[@]}"; do
	build_native "$name"
done

echo "== Pure wheels"
PURE=$WORK/pure
mkdir -p "$PURE"
while read -r requirement; do
	name=${requirement%%==*}
	[[ " ${NATIVE[*]} " != *" $name "* ]] || continue
	"$XENV/build-pip" download -q --no-deps --only-binary :all: --platform any --python-version 3.12 \
		--implementation py --abi none -d "$PURE" "$requirement" > /dev/null 2>&1 && continue
	# A few have no wheel: their source release makes a pure one.
	"$XENV/build-pip" wheel -q --no-deps -w "$WORK/sdist-wheels" "$requirement" > "$WORK/pure.log" 2>&1 \
		|| { cat "$WORK/pure.log"; exit 1; }
done < <(grep -v '^#' "$PORT/requirements-haiku.lock")
if compgen -G "$WORK/sdist-wheels/*.whl" > /dev/null; then
	for wheel in "$WORK"/sdist-wheels/*.whl; do
		[[ $wheel == *-none-any.whl ]] || { echo "$(basename "$wheel") is not pure Python" >&2; exit 1; }
	done
	mv "$WORK"/sdist-wheels/*.whl "$PURE/"
fi

echo "== App"
APP=$WORK/app
VENV=$APP/venv
SITE=$VENV/lib/python3.12/site-packages
mkdir -p "$VENV/bin" "$SITE"
ln -s lib "$VENV/lib64"
ln -s /boot/system/bin/python3.12 "$VENV/bin/python3.12"
ln -s python3.12 "$VENV/bin/python3"
ln -s python3.12 "$VENV/bin/python"
cat > "$VENV/pyvenv.cfg" <<CFG
home = /boot/system/bin
include-system-site-packages = false
version = $PYVERSION
executable = /boot/system/bin/python3.12
command = /boot/system/bin/python3.12 -m venv /boot/system/apps/pgAdmin4/venv
CFG
# The wheels as pip installs them, for the venv's Python on Haiku.
native=()
for name in "${NATIVE[@]}"; do
	native+=("$(compgen -G "$WHEELS/${name//-/_}-$(pinned "$name")-*.whl" | head -1)")
done
"$WORK/tools/bin/python" - "$VENV" "$SITE" "${native[@]}" "$PURE"/*.whl "$STAGE"/pgadmin4-*.whl <<'PY'
import sys
from installer import install
from installer.destinations import SchemeDictionaryDestination
from installer.sources import WheelFile
venv, site, wheels = sys.argv[1], sys.argv[2], sys.argv[3:]
destination = SchemeDictionaryDestination(
    {"purelib": site, "platlib": site, "headers": f"{venv}/include/python3.12",
     "scripts": f"{venv}/bin", "data": venv},
    interpreter="/boot/system/apps/pgAdmin4/venv/bin/python3", script_kind="posix",
    bytecode_optimization_levels=())
for wheel in wheels:
    with WheelFile.open(wheel) as source:
        install(source, destination, {"INSTALLER": b"pgadmin4-cross\n"})
print(f"{len(wheels)} wheels")
PY
cp -r "$STAGE/files/psutil" "$SITE/"
cp "$STAGE/files/config_distro.py" "$SITE/pgadmin4/config_distro.py"
find "$VENV" -name __pycache__ -type d -prune -exec rm -rf {} +
ln -s venv/lib/python3.12/site-packages/pgadmin4 "$APP/web"
cp -r "$STAGE/runtime" "$APP/runtime"
cp "$STAGE/files/aurora.json" "$APP/aurora.json"
cp "$STAGE/LICENSE-pgAdmin" "$APP/LICENSE"

echo "== Launcher"
cp "$HOST_BINARY" "$APP/pgAdmin 4"
chmod 755 "$APP/pgAdmin 4"
"$TOOLS/rc/rc" -I "$PORT/files" -o "$WORK/pgAdmin4.rsrc" "$PORT/files/pgAdmin4.rdef"
"$TOOLS/xres" -o "$APP/pgAdmin 4" "$WORK/pgAdmin4.rsrc"

echo "== Package"
ARCH=$ARCH CROSS=$CROSS PYTHON=$BUILD_PYTHON TMPDIR=$WORK "$PORT/package-haiku.sh" "$APP" "$VERSION" "$OUT"
