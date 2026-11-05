"""Read-only Linux Xray discovery. Executed in memory through the SSH session."""
import glob
import json
import os
import stat

MAX_FILES = 128
MAX_SIZE = 16 * 1024 * 1024
processes = []
files = {}
warnings = []


def candidate(path, source, running=False, service=None, scanned=False):
    if scanned and path.endswith('.wayrill.json'):
        return
    path = os.path.abspath(path)
    if len(files) >= MAX_FILES and path not in files:
        return
    try:
        info = os.stat(path)
        if not stat.S_ISREG(info.st_mode):
            return
        item = files.setdefault(path, {
            "path": path, "size": info.st_size, "modified": int(info.st_mtime),
            "running": False, "source": source, "readable": os.access(path, os.R_OK),
            "services": [],
        })
        item["running"] = item["running"] or running
        if service and service not in item["services"]:
            item["services"].append(service)
    except (OSError, ValueError):
        pass


for name in sorted(glob.glob('/proc/[0-9]*/exe')):
    root = os.path.dirname(name)
    try:
        exe = os.readlink(name)
        if exe.endswith(' (deleted)'):
            exe = exe[:-10]
        if 'xray' not in os.path.basename(exe).lower():
            continue
        with open(root + '/cmdline', 'rb') as handle:
            args = handle.read(65536).decode('utf-8', 'replace').rstrip('\0').split('\0')
        cwd = os.readlink(root + '/cwd')
        service = None
        try:
            with open(root + '/cgroup', encoding='utf-8') as handle:
                service = next((part for line in handle.read().splitlines()
                                for part in reversed(line.split('/'))
                                if part.endswith('.service')), None)
        except OSError:
            pass
        paths, directories = [], []
        i = 1
        while i < len(args):
            key, sep, value = args[i].partition('=')
            if key in ('-c', '-config', '--config', '-confdir', '--confdir'):
                if not sep and i + 1 < len(args):
                    i += 1
                    value = args[i]
                if value:
                    value = os.path.normpath(value if value.startswith('/') else os.path.join(cwd, value))
                    if key in ('-confdir', '--confdir'):
                        directories.append(value)
                        for path in sorted(glob.glob(os.path.join(value, '*.json'))):
                            candidate(path, 'Running configuration directory', True, service, scanned=True)
                    else:
                        paths.append(value)
                        candidate(value, 'Running process argument', True, service)
            i += 1
        if not paths and not directories:
            for path in (os.path.join(cwd, 'config.json'), os.path.join(os.path.dirname(exe), 'config.json')):
                candidate(path, 'Running process default location', True, service)
        processes.append({"pid": int(os.path.basename(root)), "executable": exe,
                          "configPaths": paths, "configDirectories": directories})
    except (OSError, ValueError):
        continue

for directory in ('/usr/local/etc/xray', '/etc/xray', '/opt/xray', '/etc/v2ray', '/usr/local/etc/v2ray'):
    for path in sorted(glob.glob(directory + '/*.json')):
        candidate(path, 'Known configuration location', scanned=True)
    for path in sorted(glob.glob(directory + '/conf.d/*.json')):
        candidate(path, 'Known fragment location', scanned=True)

if not processes:
    warnings.append('No readable running Xray process was found. Known configuration locations are listed instead.')
if any(p['configDirectories'] or len(p['configPaths']) > 1 for p in processes):
    warnings.append('Xray is loading multiple files. This prototype opens files individually; it does not claim to reconstruct the merged running configuration.')
if len(files) >= MAX_FILES:
    warnings.append('Discovery is limited to 128 files. Enter a path to read a different file.')
print('WAYRILL_REMOTE_DISCOVERY_V1_BEGIN')
standard_paths = ('/usr/local/etc/xray/config.json', '/etc/xray/config.json')
print(json.dumps({"version": 1, "hostname": os.uname().nodename, "processes": processes,
                  "files": sorted(files.values(), key=lambda f: (
                      'xray.service' not in f['services'], f['path'] not in standard_paths,
                      not f['running'], f['path'])),
                  "warnings": warnings}, ensure_ascii=True, separators=(',', ':')))
print('WAYRILL_REMOTE_DISCOVERY_V1_END')
