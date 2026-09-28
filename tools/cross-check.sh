#!/usr/bin/env bash
# Compile-check the native host on the Linux build machine with the Haiku
# x86_64 cross compiler, the fork's headers and Summit's WebKit headers.
# The real build is native (make on Haiku); this only catches mistakes early.
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
CROSS=${AURORA_CROSS:-/mnt/HaikuWork/x399/build/x86_64/cross-tools-x86_64/bin/x86_64-unknown-haiku-g++}
HEADERS=${AURORA_HAIKU_HEADERS:-/mnt/HaikuWork/x399/haiku/headers}
WEBKIT=${AURORA_WEBKIT_SOURCE:-/mnt/HaikuWork/apps/summit/.cache/WebKit/Source/WebKit}
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/WebKit"
for header in UIProcess/API/haiku/WebKitView.h UIProcess/API/haiku/WebKitContext.h \
    UIProcess/API/haiku/WebKitExtensionPermission.h UIProcess/API/haiku/WebKitInfo.h \
    UIProcess/API/haiku/WebKitEmbedding.h Shared/API/c/WKBase.h Shared/API/c/WKDeclarationSpecifiers.h \
    Shared/API/c/haiku/WKBaseHaiku.h; do
    [[ -f $WEBKIT/$header ]] && cp "$WEBKIT/$header" "$STAGE/WebKit/"
done
INCLUDES=(-I"$ROOT/host" -I"$ROOT/host/vendor" -I"$STAGE" -idirafter "$HEADERS/posix" -idirafter "$HEADERS" -idirafter "$HEADERS/config")
for directory in "$HEADERS"/os "$HEADERS"/os/*/ "$HEADERS"/os/add-ons/*/; do INCLUDES+=(-idirafter "$directory"); done
status=0
for source in "$ROOT"/host/*.cpp "$ROOT"/host/tray/*.cpp; do
    echo "== $(basename "$source")"
    "$CROSS" -std=c++20 -fsyntax-only -Wall -Wextra -Wno-multichar -Wno-unused-parameter "${INCLUDES[@]}" "$source" || status=1
done
exit $status
