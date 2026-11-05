"""Read-only metadata for the graph next to the canonical Xray file."""
import hashlib
import json
import os
import stat

path = os.path.splitext(os.path.realpath(PATH))[0] + '.wayrill.json'
result = dict(path=path, sha256=None)
try:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 16 * 1024 * 1024:
            raise ValueError('Use a regular Wayrill file of at most 16 MiB, without links.')
        data = handle.read(16 * 1024 * 1024 + 1)
        if len(data) > 16 * 1024 * 1024:
            raise ValueError('The Wayrill file exceeds 16 MiB.')
    result['sha256'] = hashlib.sha256(data).hexdigest()
except FileNotFoundError:
    pass
except (OSError, ValueError):
    result['error'] = 'Could not read the companion graph. Check its permissions, file type and size.'
print('WAYRILL_REMOTE_COMPANION_V1_BEGIN')
print(json.dumps(result, ensure_ascii=True))
print('WAYRILL_REMOTE_COMPANION_V1_END')
