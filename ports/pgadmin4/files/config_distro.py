##########################################################################
#
# pgAdmin 4 on Haiku: settings of the Haiku package. Installed over the
# config_distro.py of the pgAdmin wheel, whose HELP_PATH it keeps.
#
##########################################################################

import os

HELP_PATH = '../../docs/en_US/_build/html/'
MINIFY_HTML = False

# pg_dump, pg_restore, pg_dumpall and psql come from postgresql18_server and
# postgresql18 in /boot/system/bin.
DEFAULT_BINARY_PATHS = {
    'pg': '/boot/system/bin',
    'ppas': ''
}

# Keep the server's data with the app's other settings, not in ~/.pgadmin.
DATA_DIR = os.path.realpath(os.path.expanduser('~/config/settings/pgadmin4/server'))

# Updates come from the Haiku package, not from pgadmin.org.
UPGRADE_CHECK_ENABLED = False
