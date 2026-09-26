#!/usr/bin/env python3
"""Teach psycopg-c's byte order shim about Haiku, whose <endian.h> defines
BYTE_ORDER but not be64toh() and friends. Patches both the Cython source and
the generated C of an unpacked psycopg-c sdist:

    python3 psycopg-c-haiku.py <psycopg_c source directory>
"""
import pathlib
import sys

BLOCK = '''#elif defined(__HAIKU__)

#   include <endian.h>

#   ifndef be64toh
#     if BYTE_ORDER == LITTLE_ENDIAN
#       define htobe16(x) __builtin_bswap16(x)
#       define htole16(x) (x)
#       define be16toh(x) __builtin_bswap16(x)
#       define le16toh(x) (x)
#       define htobe32(x) __builtin_bswap32(x)
#       define htole32(x) (x)
#       define be32toh(x) __builtin_bswap32(x)
#       define le32toh(x) (x)
#       define htobe64(x) __builtin_bswap64(x)
#       define htole64(x) (x)
#       define be64toh(x) __builtin_bswap64(x)
#       define le64toh(x) (x)
#     else
#       define htobe16(x) (x)
#       define htole16(x) __builtin_bswap16(x)
#       define be16toh(x) (x)
#       define le16toh(x) __builtin_bswap16(x)
#       define htobe32(x) (x)
#       define htole32(x) __builtin_bswap32(x)
#       define be32toh(x) (x)
#       define le32toh(x) __builtin_bswap32(x)
#       define htobe64(x) (x)
#       define htole64(x) __builtin_bswap64(x)
#       define be64toh(x) (x)
#       define le64toh(x) __builtin_bswap64(x)
#     endif
#   endif

'''

source = pathlib.Path(sys.argv[1])
patched = 0
for name in ('psycopg_c/_psycopg.c', 'psycopg_c/_psycopg/endian.pxd'):
    path = source / name
    if not path.exists():
        continue
    text = path.read_text()
    if '__HAIKU__' in text:
        patched += 1
        continue
    marker = '#elif defined(__sun)'
    if marker not in text:
        sys.exit(f'{path}: no {marker} to patch before')
    path.write_text(text.replace(marker, BLOCK + marker, 1))
    patched += 1
print(f'patched {patched} files in {source}')
