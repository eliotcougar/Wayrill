"""Read-only Linux status probe. No package refresh, installation or service changes."""
import glob
import json
import os
import pwd
import re
import shutil
import subprocess
import time


def read_text(path, limit=65536):
    with open(path, 'r', encoding='utf-8', errors='replace') as handle:
        return handle.read(limit)


def command(args, timeout=8):
    env = dict(os.environ, LC_ALL='C', LANG='C', SYSTEMD_COLORS='0', SYSTEMD_PAGER='cat')
    try:
        result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, env=env, timeout=timeout)
        if len(result.stdout) > 1024 * 1024:
            return None, 'The status response exceeded its size limit.'
        error = None if result.returncode == 0 else 'The command failed (exit {}). Check account permissions and server state.'.format(result.returncode)
        return result.stdout.decode('utf-8', 'replace'), error
    except subprocess.TimeoutExpired:
        return None, 'The status check timed out.'
    except OSError:
        return None, 'The status command could not be started.'


def xray_status():
    processes, units = [], {'xray.service'}
    for name in sorted(glob.glob('/proc/[0-9]*/exe')):
        root = os.path.dirname(name)
        try:
            exe = os.readlink(name)
            deleted = exe.endswith(' (deleted)')
            if deleted:
                exe = exe[:-10]
            if 'xray' not in os.path.basename(exe).lower():
                continue
            processes.append({'pid': int(os.path.basename(root)), 'executable': exe,
                              'replacedExecutable': deleted})
            try:
                for line in read_text(root + '/cgroup').splitlines():
                    parts = [part for part in line.split(':', 2)[-1].split('/')
                             if part.endswith('.service') and not part.startswith('-')]
                    if parts:
                        units.add(parts[-1])
            except OSError:
                pass
        except (OSError, ValueError):
            continue
        if len(processes) >= 128:
            break
    binary = shutil.which('xray') or next((p['executable'] for p in processes if os.path.isfile(p['executable'])), None)
    version, version_error = None, None
    if binary:
        output, version_error = command([binary, 'version'], timeout=4)
        match = re.search(r'^Xray\s+(\S+)', output or '', re.M)
        if match:
            version = match[1]
        elif not version_error:
            version_error = 'The installed Xray version could not be recognized.'
    installed = {'installedVersion': version, 'binary': binary, 'versionError': version_error}
    if not shutil.which('systemctl'):
        return dict(installed, processes=processes, services=[],
                    error='systemd service status is unavailable on this server.')
    output, error = command(['systemctl', 'show', '--no-pager',
                             '--property=Id,LoadState,ActiveState,SubState,MainPID,ActiveEnterTimestamp,UnitFileState,NeedDaemonReload',
                             '--'] + sorted(units)[:128])
    services = []
    if output is not None:
        for block in output.strip().split('\n\n'):
            props = dict(line.split('=', 1) for line in block.splitlines() if '=' in line)
            if not props.get('Id') or props.get('LoadState') == 'not-found':
                continue
            pid = props.get('MainPID', '0')
            services.append({'name': props['Id'], 'activeState': props.get('ActiveState', 'unknown'),
                             'subState': props.get('SubState', 'unknown'),
                             'mainPid': int(pid) if pid.isdigit() and int(pid) > 0 else None,
                             'startedAt': props.get('ActiveEnterTimestamp') or None,
                             'unitFileState': props.get('UnitFileState') or None,
                             'needsDaemonReload': props.get('NeedDaemonReload') == 'yes'})
    return dict(installed, processes=processes, services=services, error=error)


def reboot_status():
    try:
        os.stat('/run/reboot-required')
    except FileNotFoundError:
        return {'required': False, 'packages': [], 'error': None}
    except OSError:
        return {'required': None, 'packages': [], 'error': 'The reboot-required marker could not be read.'}
    packages, error = [], None
    try:
        packages = sorted(set(read_text('/run/reboot-required.pkgs').splitlines()))[:512]
    except FileNotFoundError:
        pass
    except OSError:
        error = 'The list of packages requesting a reboot could not be read.'
    return {'required': True, 'packages': packages, 'error': error}


def parse_apt(output):
    summary = re.search(r'^(\d+) upgraded, (\d+) newly installed, (\d+) to remove and (\d+) not upgraded\.$', output, re.M)
    if not summary:
        raise ValueError('APT returned an unrecognized simulation result.')
    packages = []
    for line in output.splitlines():
        if not line.startswith('Inst '):
            continue
        match = re.match(r'^Inst (\S+)(?: \[([^\]]+)\])? \((\S+)(?: (.*))?\)(?: \[[^\]]*\])*$', line)
        if not match:
            raise ValueError('APT returned an unrecognized package entry.')
        packages.append({'name': match.group(1), 'installedVersion': match.group(2),
                         'candidateVersion': match.group(3), 'source': match.group(4) or ''})
    upgraded, installed, removed, held = (int(value) for value in summary.groups())
    if len(packages) != upgraded + installed or len(packages) > 4096 or installed or removed:
        raise ValueError('APT returned an inconsistent upgrade simulation.')
    return {'packages': packages, 'upgraded': upgraded, 'heldBack': held}


def apt_status():
    result = {'available': bool(shutil.which('apt-get')), 'packages': [], 'upgraded': None,
              'heldBack': None, 'indexesUpdatedAt': None, 'error': None}
    if not result['available']:
        result['error'] = 'APT is not installed on this server.'
        return result
    # Use only completed index files; partial downloads and lock-file mtimes
    # do not indicate a successful repository refresh.
    index_times = []
    for name in glob.glob('/var/lib/apt/lists/*_InRelease') + glob.glob('/var/lib/apt/lists/*_Release'):
        try:
            index_times.append(os.stat(name).st_mtime)
        except OSError:
            pass
    if index_times:
        result['indexesUpdatedAt'] = int(max(index_times))
    # Simulation already prevents downloading. --no-download additionally
    # rejects upgrades whose archives are not cached, even in a simulation.
    output, error = command(['apt-get', '--simulate',
                             '-o', 'Debug::NoLocking=true', '-o', 'Dir::Cache::pkgcache=',
                             '-o', 'Dir::Cache::srcpkgcache=', '-o', 'APT::Color=0', 'upgrade'], timeout=18)
    if error:
        result['error'] = error
    else:
        try:
            result.update(parse_apt(output))
        except ValueError as error:
            result['error'] = str(error)
    return result


def collect():
    try:
        user = pwd.getpwuid(os.geteuid()).pw_name
    except (KeyError, OSError):
        user = str(os.geteuid())
    try:
        boot = read_text('/proc/sys/kernel/random/boot_id').strip()
    except OSError:
        boot = None
    return {'version': 1, 'hostname': os.uname().nodename, 'checkedAt': int(time.time()), 'bootId': boot,
            'user': user, 'uid': os.geteuid(), 'reboot': reboot_status(),
            'xray': xray_status(), 'apt': apt_status()}


if __name__ == '__main__':
    print('WAYRILL_REMOTE_STATUS_V1_BEGIN')
    print(json.dumps(collect(), ensure_ascii=True, separators=(',', ':')))
    print('WAYRILL_REMOTE_STATUS_V1_END')
