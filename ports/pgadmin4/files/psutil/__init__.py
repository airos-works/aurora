"""The part of psutil pgAdmin uses, for Haiku.

psutil 7 refuses to build on platforms it does not know. pgAdmin only ends
background jobs with psutil.Process(pid).terminate() and catches
NoSuchProcess and Error (pgadmin/misc/bgprocess/processes.py), which POSIX
signals do just as well.
"""

import os
import signal
import time

__version__ = '7.2.2+haiku'
version_info = (7, 2, 2)


class Error(Exception):
    """Base exception of psutil."""


class NoSuchProcess(Error):
    def __init__(self, pid, name=None, msg=None):
        self.pid = pid
        self.name = name
        super().__init__(msg or 'process no longer exists (pid=%s)' % pid)


class AccessDenied(Error):
    def __init__(self, pid=None, name=None, msg=None):
        self.pid = pid
        self.name = name
        super().__init__(msg or 'access denied (pid=%s)' % pid)


class TimeoutExpired(Error):
    def __init__(self, seconds, pid=None, name=None):
        self.seconds = seconds
        self.pid = pid
        super().__init__('timeout after %s seconds (pid=%s)' % (seconds, pid))


def pid_exists(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class Process:
    def __init__(self, pid=None):
        self.pid = os.getpid() if pid is None else int(pid)
        if not pid_exists(self.pid):
            raise NoSuchProcess(self.pid)

    def _signal(self, number):
        try:
            os.kill(self.pid, number)
        except ProcessLookupError:
            raise NoSuchProcess(self.pid)
        except PermissionError:
            raise AccessDenied(self.pid)

    def send_signal(self, number):
        self._signal(number)

    def terminate(self):
        self._signal(signal.SIGTERM)

    def kill(self):
        self._signal(signal.SIGKILL)

    def is_running(self):
        return pid_exists(self.pid)

    def children(self, recursive=False):
        return []

    def wait(self, timeout=None):
        deadline = None if timeout is None else time.monotonic() + timeout
        while pid_exists(self.pid):
            if deadline is not None and time.monotonic() > deadline:
                raise TimeoutExpired(timeout, self.pid)
            time.sleep(0.05)
        return None
