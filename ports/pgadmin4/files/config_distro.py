##########################################################################
#
# pgAdmin 4 on Haiku: settings of the Haiku package. Installed over the
# config_distro.py of the pgAdmin wheel, whose HELP_PATH it keeps.
#
##########################################################################

import os

HELP_PATH = '../../docs/en_US/_build/html/'
MINIFY_HTML = False

# pg_dump, pg_restore, pg_dumpall (postgresql18_server) and psql (postgresql18)
# are in /boot/system/bin; the package requires them.
DEFAULT_BINARY_PATHS = {
    'pg': '/boot/system/bin',
    'ppas': ''
}

# Keep the server's data with the app's other settings, not in ~/.pgadmin.
DATA_DIR = os.path.realpath(os.path.expanduser('~/config/settings/pgadmin4/server'))
# pgAdmin creates DATA_DIR itself, but not its parent.
os.makedirs(os.path.dirname(DATA_DIR), exist_ok=True)

# Updates come from the Haiku package, not from pgadmin.org.
UPGRADE_CHECK_ENABLED = False
