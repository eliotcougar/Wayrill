"""Prepare a private SFTP upload; no credentials are sent in shell arguments."""
import json
import os
import re
import shutil
import stat
import tempfile
import time

for entry in os.scandir('/tmp'):
    if not re.fullmatch(r'wayrill-config-[A-Za-z0-9_-]{6,64}', entry.name) or entry.is_symlink():
        continue
    info = entry.stat(follow_symlinks=False)
    if stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o700 and info.st_mtime < time.time() - 3600:
        shutil.rmtree(entry.path)
directory = tempfile.mkdtemp(prefix='wayrill-config-', dir='/tmp')
os.chmod(directory, 0o700)
path = directory + '/candidate.json'
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
os.close(fd)
print('WAYRILL_REMOTE_UPLOAD_V1_BEGIN')
print(json.dumps({'path': path}))
print('WAYRILL_REMOTE_UPLOAD_V1_END')
