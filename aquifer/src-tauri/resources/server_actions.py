"""Fixed server-management operations. Root-owned jobs survive SSH disconnects.

Executed in memory by WinSCP. Only an explicitly started job installs its worker
under /var/lib/wayrill-remote; status/discovery never install anything.
"""
import base64
import contextlib
import fcntl
import glob
import json
import os
import re
import selectors
import shutil
import stat
import subprocess
import sys
import tempfile
import time

BASE = '/var/lib/wayrill-remote'
TERMINAL = ('succeeded', 'failed', 'interrupted')


class ActionError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)


def validate(request):
    if not isinstance(request, dict) or request.get('mode') not in ('start', 'poll', 'preview', 'validateConfig'):
        raise ActionError('ACTION', 'Unknown server action request.')
    if request['mode'] == 'validateConfig':
        path = request.get('path', '')
        if not isinstance(path, str) or not path.startswith('/') or len(path) > 4096 or any(ord(c) < 32 for c in path):
            raise ActionError('CONFIG_FILE', 'Enter an absolute configuration path without control characters.')
        if not isinstance(request.get('uploadPath'), str) or not isinstance(request.get('stage', True), bool):
            raise ActionError('CONFIG_FILE', 'Invalid configuration validation request.')
        if not isinstance(request.get('hasWayrill', False), bool) or (request.get('expectedWayrillSha256') is not None and not re.fullmatch(r'[a-f0-9]{64}', str(request['expectedWayrillSha256']))):
            raise ActionError('CONFIG_FILE', 'Invalid companion source hash.')
        if not re.fullmatch(r'[a-f0-9]{64}', request.get('expectedSha256', '')):
            raise ActionError('CONFIG_FILE', 'Read the server file before validating a draft.')
        if not re.fullmatch(r'[A-Za-z0-9_@.-]{1,180}\.service', request.get('service', '')):
            raise ActionError('CONFIG_TARGET', 'Enter an Xray systemd service name.')
        return
    if request['mode'] == 'preview':
        return
    if not re.fullmatch(r'[a-f0-9]{32}', request.get('id', '')):
        raise ActionError('ACTION', 'Invalid server job identifier.')
    if request['mode'] == 'poll':
        return
    action = request.get('action')
    if action not in ('refreshApt', 'upgradeAll', 'distUpgrade', 'upgradePackage', 'restartXray', 'reboot', 'applyConfig'):
        raise ActionError('ACTION', 'Unknown server action.')
    if action == 'distUpgrade' and not re.fullmatch(r'[a-f0-9]{32}', request.get('planId') or ''):
        raise ActionError('APT_PLAN', 'Full upgrade requires a reviewed package plan.')
    if action == 'applyConfig' and not re.fullmatch(r'[a-f0-9]{32}', request.get('planId') or ''):
        raise ActionError('CONFIG_PLAN', 'Apply requires a validated configuration plan.')
    if action == 'upgradePackage':
        if not re.fullmatch(r'[a-z0-9][a-z0-9+.-]{0,127}(?::[a-z0-9-]{1,32})?', request.get('package', '')):
            raise ActionError('ACTION', 'Invalid package name.')
        if not re.fullmatch(r'[0-9][A-Za-z0-9.+:~_-]{0,255}', request.get('candidateVersion', '')):
            raise ActionError('ACTION', 'Invalid package version.')
    if action == 'restartXray' and not re.fullmatch(r'[A-Za-z0-9_@.-]{1,180}\.service', request.get('service', '')):
        raise ActionError('ACTION', 'Invalid Xray service name.')


def boot_id():
    with open('/proc/sys/kernel/random/boot_id') as handle:
        return handle.read().strip()


def secure_dir(path):
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
        raise ActionError('JOB_STORAGE', 'The server job directory must be owned by root with mode 0700.')


def load(path, limit=256 * 1024):
    with open(path, encoding='utf-8') as handle:
        data = handle.read(limit + 1)
    if len(data) > limit:
        raise ActionError('JOB_STORAGE', 'The server job record exceeded its size limit.')
    return json.loads(data)


def save(path, data):
    temporary = path + '.tmp'
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        json.dump(data, handle, ensure_ascii=True, separators=(',', ':'))
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def safe_line(line):
    # APT may print authenticated repository URLs. Keep useful diagnostics,
    # while dropping URL credentials, queries and control/escape sequences.
    line = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', line)
    line = re.sub(r'([A-Za-z][A-Za-z0-9+.-]*://)[^/\s@]+@', r'\1[redacted]@', line)
    line = re.sub(r'([A-Za-z][A-Za-z0-9+.-]*://[^\s?]+)\?[^\s]*', r'\1?[redacted]', line)
    return ''.join(c for c in line if c >= ' ' or c == '\t')[:500]


def environment():
    return dict(os.environ, LC_ALL='C', LANG='C', SYSTEMD_COLORS='0', SYSTEMD_PAGER='cat',
                DEBIAN_FRONTEND='noninteractive', NEEDRESTART_MODE='l', UCF_FORCE_CONFFOLD='1')


def capture(args, timeout=15):
    try:
        return subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, env=environment(), timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        raise ActionError('COMMAND', 'The required server command failed to start or timed out.')


def unit_name(identifier):
    return 'wayrill-remote-' + identifier + '.service'


@contextlib.contextmanager
def dispatch_lock(create=False):
    if create:
        secure_dir(BASE)
    try:
        fd = os.open(BASE + '/dispatch.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    except FileNotFoundError:
        raise ActionError('JOB_NOT_FOUND', 'This job has not been accepted by the server. Retry the same request to start it safely.')
    with os.fdopen(fd, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def poll(identifier):
    # A poll must not classify a job between publication and systemd launch.
    with dispatch_lock():
        return _poll(identifier)


def _poll(identifier):
    path = BASE + '/' + identifier + '/state.json'
    try:
        result = load(path)
    except FileNotFoundError:
        raise ActionError('JOB_NOT_FOUND', 'This job has not been accepted by the server. Retry the same request to start it safely.')
    if result['state'] in TERMINAL:
        return result
    changed_boot = result['bootId'] != boot_id()
    if changed_boot:
        if result['action'] == 'applyConfig':
            recover_config(identifier)
            recovered = load(path)
            if recovered['state'] in TERMINAL:
                return recovered
        result.update(state='succeeded' if result['action'] == 'reboot' else 'interrupted',
                      stage='Server rebooted' if result['action'] == 'reboot' else 'Interrupted by reboot',
                      percent=100 if result['action'] == 'reboot' else None,
                      message='SSH is available after reboot.' if result['action'] == 'reboot' else
                              'The server rebooted before the job finished. Inspect APT/dpkg state before retrying.',
                      updatedAt=int(time.time()))
        save(path, result)
    else:
        check = capture(['systemctl', 'show', '--property=LoadState,ActiveState', '--', unit_name(identifier)])
        values = dict(line.split('=', 1) for line in check.stdout.decode('utf-8', 'replace').splitlines() if '=' in line)
        if values.get('LoadState') == 'not-found' or (check.returncode == 0 and values.get('ActiveState') in ('inactive', 'failed')):
            result = load(path)  # The worker may have finished while systemctl ran.
            if result['state'] in TERMINAL:
                return result
            if result['action'] == 'applyConfig':
                recover_config(identifier)
                recovered = load(path)
                if recovered['state'] in TERMINAL:
                    return recovered
            # Reboot can stop the worker before SSH stops accepting sessions.
            if result['action'] != 'reboot' or time.time() - result['createdAt'] > 180:
                result.update(state='interrupted', stage='Job stopped', percent=None,
                              message='The server job stopped without a completion result. Inspect the server before retrying.',
                              updatedAt=int(time.time()))
                save(path, result)
    return result


def start(request):
    if not shutil.which('systemd-run') or not shutil.which('systemctl'):
        raise ActionError('SYSTEMD', 'Server actions require systemd and systemd-run.')
    with dispatch_lock(create=True):
        directory = BASE + '/' + request['id']
        if os.path.exists(directory + '/request.json'):
            if load(directory + '/request.json') != request:
                raise ActionError('JOB_CONFLICT', 'This job identifier already belongs to another action.')
            return _poll(request['id'])
        try:
            current = load(BASE + '/current.json')['id']
            previous = _poll(current)
            if previous['state'] not in TERMINAL:
                raise ActionError('JOB_BUSY', 'Another Wayrill server action is still running. Reopen its progress before starting another.')
        except FileNotFoundError:
            pass
        if os.path.lexists(directory):
            raise ActionError('JOB_STORAGE', 'An incomplete job record was retained. Start a new action instead of reusing this identifier.')
        result = dict(version=1, id=request['id'], action=request['action'],
                      state='running', stage='Preparing', percent=None, message='', logs=[],
                      createdAt=int(time.time()), updatedAt=int(time.time()), bootId=boot_id())
        # Publish all accepted-job files together. A failed preparation has no
        # receipt and can retry safely; a published identifier is never replayed.
        with tempfile.TemporaryDirectory(prefix='.prepare-', dir=BASE) as preparation:
            fd = os.open(preparation + '/worker.py', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as handle:
                handle.write(SOURCE)
                handle.flush()
                os.fsync(handle.fileno())
            save(preparation + '/state.json', result)
            save(preparation + '/request.json', request)
            deploy_sync(preparation)
            os.rename(preparation, directory)
        save(BASE + '/current.json', {'id': request['id']})
        deploy_sync(BASE)
        guard = []
        if request['action'] == 'applyConfig':
            # Runs even after SIGKILL or RuntimeMaxSec. It is part of the
            # detached job, independent of the UI and its SSH connection.
            guard = ['--property=RuntimeMaxSec=180', '--property=TimeoutStopSec=60',
                     '--property=ExecStopPost={} {} --recover {}'.format(sys.executable, directory + '/worker.py', request['id'])]
        launched = capture(['systemd-run', '--quiet', '--collect', '--service-type=exec',
                            '--unit=' + unit_name(request['id']), '--property=TimeoutStartSec=infinity',
                            '--property=StandardOutput=null', '--property=StandardError=null',
                            *guard, '--', sys.executable, directory + '/worker.py', request['id']])
        if launched.returncode:
            result.update(state='failed', stage='Could not start job',
                          message='systemd could not start the server worker.', updatedAt=int(time.time()))
            save(directory + '/state.json', result)
        trim_history(request['id'])
        return result


def trim_history(current):
    # Optional housekeeping must not hide an already accepted/started job.
    try:
        records = sorted(glob.glob(BASE + '/*/state.json'), key=os.path.getmtime, reverse=True)
    except OSError:
        return
    for old in records[20:]:
        try:
            parent = os.path.dirname(old)
            identifier = os.path.basename(parent)
            if identifier == current or not re.fullmatch(r'[a-f0-9]{32}', identifier):
                continue
            record = load(old)
            if record['state'] not in TERMINAL:
                continue
            if record['logs']:
                record['logs'] = []
                save(old, record)
            if record['action'] == 'applyConfig':
                # A terminal progress receipt can precede ExecStopPost recovery.
                # Keep its executable until the journal and boot guard are safe.
                journal = load(parent + '/deployment.json')
                if journal['phase'] not in ('committed', 'restored', 'aborted'):
                    continue
                if any(os.path.lexists(path) for path in deploy_guard_paths(identifier, journal['guardService'])):
                    continue
            for name in ('worker.py', 'verify-plan', 'approved.json', 'plan-verified.json', 'plan-rejected.json'):
                try:
                    os.unlink(parent + '/' + name)
                except FileNotFoundError:
                    pass
        except (OSError, ValueError, KeyError, TypeError, ActionError):
            continue  # Retain unexpected records for inspection, including recovery code.


def run_apt(request, state, write):
    apt = shutil.which('apt-get')
    if not apt:
        raise ActionError('APT', 'APT is not installed on this server.')
    action = request['action']
    args = [apt, '-o', 'DPkg::Lock::Timeout=120', '-o', 'APT::Color=0',
            '-o', 'Dpkg::Use-Pty=0', '-o', 'Dpkg::Options::=--force-confdef',
            '-o', 'Dpkg::Options::=--force-confold']
    if action == 'refreshApt':
        args += ['-o', 'APT::Update::Error-Mode=any', 'update']
    elif action == 'upgradeAll':
        args += ['--assume-yes', '--no-remove', 'upgrade']
    elif action == 'distUpgrade':
        state.update(stage='Checking reviewed package plan', percent=None)
        write()
        approved = approved_upgrade(request['planId'])
        directory = BASE + '/' + request['id']
        save(directory + '/approved.json', approved)
        hook = directory + '/verify-plan'
        with open(__file__, 'rb') as script:
            source = script.read()
        fd = os.open(hook, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o700)
        with os.fdopen(fd, 'wb') as handle:
            handle.write(('#!' + sys.executable + '\n').encode() + source)
        args += ['-o', 'DPkg::Pre-Install-Pkgs::=' + hook,
                 '-o', 'DPkg::Tools::Options::' + hook + '::Version=3',
                 '--assume-yes', 'dist-upgrade']
    else:
        installed = capture(['dpkg-query', '-W', '-f=${db:Status-Status}', '--', request['package']])
        if installed.returncode or installed.stdout.strip() != b'installed':
            raise ActionError('PACKAGE', 'The selected package is no longer installed. Refresh server status.')
        args += ['--assume-yes', '--no-remove', '--only-upgrade', 'install',
                 request['package'] + '=' + request['candidateVersion']]
    read_fd, write_fd = os.pipe()
    args[1:1] = ['-o', 'APT::Status-Fd=' + str(write_fd)]
    try:
        process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, env=environment(), pass_fds=(write_fd,))
    except Exception:
        os.close(read_fd)
        raise
    finally:
        os.close(write_fd)
    state.update(stage='Refreshing package lists' if action == 'refreshApt' else 'Downloading and installing updates', percent=None)
    write()
    selector = selectors.DefaultSelector()
    progress = os.fdopen(read_fd, 'rb', buffering=0)
    selector.register(progress, selectors.EVENT_READ, 'progress')
    selector.register(process.stdout, selectors.EVENT_READ, 'log')
    buffers = {'progress': b'', 'log': b''}
    last_write = time.monotonic()
    try:
        while selector.get_map():
            for key, _ in selector.select(0.5):
                chunk = os.read(key.fileobj.fileno(), 4096)
                if not chunk:
                    selector.unregister(key.fileobj)
                kind = key.data
                buffers[kind] += chunk
                lines = buffers[kind].split(b'\n')
                buffers[kind] = lines.pop()[-8192:]
                if not chunk and buffers[kind]:
                    lines.append(buffers[kind])
                for raw in lines:
                    line = safe_line(raw.decode('utf-8', 'replace').strip())
                    if kind == 'log' and line:
                        state['logs'] = (state['logs'] + [line[:300]])[-100:]
                    elif kind == 'progress':
                        fields = line.split(':', 3)
                        if len(fields) == 4 and fields[0] in ('dlstatus', 'pmstatus'):
                            try:
                                percent = max(0, min(100, float(fields[2])))
                            except ValueError:
                                continue
                            installing = fields[0] == 'pmstatus'
                            state['stage'] = 'Installing updates' if installing else 'Downloading package lists' if action == 'refreshApt' else 'Downloading updates'
                            state['percent'] = min(99, round(45 + percent * .54 if installing else percent * (.95 if action == 'refreshApt' else .44)))
                            state['message'] = fields[3]
            if time.monotonic() - last_write >= 0.5:
                write()
                last_write = time.monotonic()
        code = process.wait()
    finally:
        selector.close()
        progress.close()
        process.stdout.close()
    if code:
        if action == 'distUpgrade' and os.path.exists(BASE + '/' + request['id'] + '/plan-rejected.json'):
            raise ActionError('PLAN_CHANGED', 'APT’s actual transaction differs from the reviewed preview or could not be verified. Preview the full upgrade again. Package installation/removal was blocked.')
        raise ActionError('APT', 'APT exited with code {}. See the job output; package changes may have partially completed.'.format(code))


def restart_xray(request, state, write):
    service = request['service']
    props = capture(['systemctl', 'show', '--property=ExecStart,MainPID,LoadState', '--', service])
    output = props.stdout.decode('utf-8', 'replace')
    pid = re.search(r'^MainPID=(\d+)$', output, re.M)
    executable = ''
    if pid and pid[1] != '0':
        try:
            executable = os.readlink('/proc/' + pid[1] + '/exe')
        except OSError:
            pass
    if props.returncode or ('xray' not in os.path.basename(executable).lower() and not re.search(r'/xray(?:\s|;|\})', output)):
        raise ActionError('XRAY_SERVICE', 'The selected service is not a detected Xray daemon. Refresh server status.')
    state.update(stage='Restarting Xray', percent=None, message=service)
    write()
    result = capture(['systemctl', 'restart', '--', service], timeout=90)
    if result.returncode or capture(['systemctl', 'is-active', '--quiet', '--', service]).returncode:
        raise ActionError('XRAY_SERVICE', 'Xray did not return to the active state. Inspect its journal on the server.')


def worker(identifier):
    directory = BASE + '/' + identifier
    state = load(directory + '/state.json')
    request = load(directory + '/request.json')
    validate(request)
    def write():
        state['updatedAt'] = int(time.time())
        save(directory + '/state.json', state)
    try:
        if request['action'] in ('refreshApt', 'upgradeAll', 'distUpgrade', 'upgradePackage'):
            run_apt(request, state, write)
        elif request['action'] == 'restartXray':
            restart_xray(request, state, write)
        elif request['action'] == 'applyConfig':
            apply_config(request, state, write)
        else:
            state.update(stage='Waiting for server reboot', percent=95,
                         message='SSH will disconnect. Reconnecting until a new boot is confirmed.')
            write()
            time.sleep(3)
            result = capture(['systemctl', 'reboot'], timeout=30)
            if result.returncode:
                raise ActionError('REBOOT', 'systemd rejected the server reboot request.')
            return  # Success is confirmed by a changed boot ID, never just command acceptance.
        state.update(state='succeeded', stage='Configuration applied' if request['action'] == 'applyConfig' else 'Completed', percent=100, message='')
    except ActionError as error:
        stage = 'Previous configuration restored' if error.code == 'CONFIG_RESTORED' else 'Restoration needs attention' if error.code == 'CONFIG_ROLLBACK' else 'Failed'
        state.update(state='failed', stage=stage, percent=None, message=error.message, errorCode=error.code)
    except Exception:
        state.update(state='failed', stage='Failed', percent=None,
                     message='The server worker failed unexpectedly. Inspect the server before retrying.')
    write()


def dispatch(request):
    validate(request)
    if request['mode'] == 'validateConfig' and 'configText' not in request:
        # Read and remove the private SFTP file before sudo; the configuration
        # then crosses elevation through stdin, never process arguments.
        uploaded = deploy_read_upload(request['uploadPath'])
        if request.get('hasWayrill'):
            try:
                bundle = json.loads(uploaded)
                request = dict(request, configText=bundle['configText'], wayrillText=bundle['wayrillText'])
            except (ValueError, KeyError, TypeError):
                raise ActionError('CONFIG_FILE', 'Invalid graph upload.')
        else:
            request = dict(request, configText=uploaded)
    if os.geteuid() != 0:
        if request['mode'] == 'validateConfig':
            request = dict(request, readerUid=os.geteuid(), readerGid=os.getegid())
        sudo = shutil.which('sudo')
        if not sudo:
            raise ActionError('SUDO', 'This account is not root and sudo is unavailable.')
        # Send code over stdin, never a password or script in a shell command.
        # Noninteractive sudo cannot hang on a password prompt or consume SSH input.
        source = b'REQUEST=' + repr(request).encode() + b'\nSOURCE=' + repr(SOURCE).encode() + b'\n' + SOURCE
        result = subprocess.run([sudo, '-n', '--', sys.executable, '-c',
                                 "import sys;exec(compile(sys.stdin.buffer.read(),'<wayrill>','exec'))"],
                                input=source, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=42)
        if result.returncode or b'WAYRILL_REMOTE_ACTION_V1_BEGIN' not in result.stdout:
            raise ActionError('SUDO', 'sudo could not authorize this action without interaction. Use root or an account configured for noninteractive sudo. No password is saved by Wayrill.')
        sys.stdout.buffer.write(result.stdout)
        return
    if request['mode'] == 'preview':
        respond({'plan': preview_upgrade()})
    elif request['mode'] == 'validateConfig':
        respond({'validation': validate_config(request)})
    else:
        result = start(request) if request['mode'] == 'start' else poll(request['id'])
        respond({'job': result})


def respond(value):
    print('WAYRILL_REMOTE_ACTION_V1_BEGIN')
    print(json.dumps(value, ensure_ascii=True, separators=(',', ':')))
    print('WAYRILL_REMOTE_ACTION_V1_END')


if __name__ == '__main__':
    if 'REQUEST' not in globals():
        if len(sys.argv) == 3 and sys.argv[1] in ('--recover', '--boot-recover') and re.fullmatch(r'[a-f0-9]{32}', sys.argv[2]) and os.geteuid() == 0:
            recover_config(sys.argv[2], before_start=sys.argv[1] == '--boot-recover')
        elif os.path.basename(__file__) == 'verify-plan':
            sys.exit(upgrade_hook(os.path.dirname(os.path.abspath(__file__))))
        elif len(sys.argv) == 2 and re.fullmatch(r'[a-f0-9]{32}', sys.argv[1]) and os.geteuid() == 0:
            worker(sys.argv[1])
    else:
        try:
            dispatch(REQUEST)
        except ActionError as error:
            respond({'error': {'code': error.code, 'message': error.message}})
        except Exception:
            respond({'error': {'code': 'ACTION', 'message': 'The server action could not be completed. Reconnect to inspect its progress before retrying.'}})
