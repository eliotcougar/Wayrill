"""Validated, optimistic-concurrency Xray config deployment.

Loaded before server_actions.py in the fixed management worker. Validation can
run without saving a plan. Apply uses a root-private plan and detached systemd
job; ExecStopPost recovers an unfinished transaction if its worker dies.
"""
import base64
import contextlib
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
import time
import uuid

CONFIG_LIMIT = 16 * 1024 * 1024
CONFIG_PLAN_SECONDS = 15 * 60
BOOT_UNITS = '/etc/systemd/system'


def deploy_guard_paths(identifier, service):
    name = 'wayrill-remote-recover-' + identifier + '.service'
    return BOOT_UNITS + '/' + name, BOOT_UNITS + '/' + service + '.wants/' + name


def deploy_arm_boot_guard(identifier, service):
    unit, link = deploy_guard_paths(identifier, service)
    worker = BASE + '/' + identifier + '/worker.py'
    content = ('[Unit]\nDescription=Recover unfinished Wayrill config apply\nDefaultDependencies=no\n'
               'After=local-fs.target\nBefore=' + service + '\n'
               '[Service]\nType=oneshot\nExecStart=' + json.dumps(sys.executable) + ' ' + json.dumps(worker) + ' --boot-recover ' + identifier + '\n')
    deploy_write_private(unit, content.encode())
    try:
        os.makedirs(os.path.dirname(link), mode=0o755, exist_ok=True)
        os.symlink('../' + os.path.basename(unit), link)
        deploy_sync(os.path.dirname(link))
        if capture(['systemctl', 'daemon-reload']).returncode:
            raise ActionError('CONFIG_GUARD', 'Could not arm reboot recovery. The configuration was left unchanged.')
    except BaseException:
        deploy_disarm_boot_guard(identifier, service)
        raise


def deploy_disarm_boot_guard(identifier, service, reload=True):
    unit, link = deploy_guard_paths(identifier, service)
    changed = False
    try:
        # These names are transaction-specific. Preserve any outside replacement.
        if os.path.islink(link) and os.readlink(link) == '../' + os.path.basename(unit):
            os.unlink(link)
            changed = True
            deploy_sync(os.path.dirname(link))
        if os.path.isfile(unit) and not os.path.islink(unit):
            with open(unit, 'rb') as handle:
                content = handle.read(8192)
            if (BASE + '/' + identifier + '/worker.py').encode() in content:
                os.unlink(unit)
                changed = True
                deploy_sync(BOOT_UNITS)
        if reload and changed:
            capture(['systemctl', 'daemon-reload'])
    except (OSError, ActionError):
        # A completed journal makes a leftover guard a no-op; do not undo a
        # successful apply merely because unit-file cleanup failed.
        pass


def deploy_read_upload(path):
    if not re.fullmatch(r'/tmp/wayrill-config-[A-Za-z0-9_-]{6,64}/candidate\.json', path):
        raise ActionError('CONFIG_FILE', 'Invalid private upload path.')
    directory = os.path.dirname(path)
    parent = os.lstat(directory)
    info = os.lstat(path)
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.geteuid() or stat.S_IMODE(parent.st_mode) != 0o700 or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise ActionError('CONFIG_FILE', 'The SFTP upload must remain private to the connected account.')
    try:
        data, _ = deploy_read(path, 64 * 1024 * 1024)
        return data.decode('utf-8', 'strict')
    finally:
        os.unlink(path)
        os.rmdir(directory)


def deploy_digest(data):
    return hashlib.sha256(data).hexdigest()


def deploy_read(path, limit=CONFIG_LIMIT):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit or info.st_nlink != 1:
            raise ActionError('CONFIG_FILE', 'Use a single regular file within its size limit, without hard links.')
        data = handle.read(limit + 1)
    if len(data) > limit:
        raise ActionError('CONFIG_FILE', 'The file exceeds its size limit.')
    stamp = [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns,
             info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)]
    return data, stamp


def deploy_sync(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def deploy_save(path, value):
    save(path, value)
    deploy_sync(os.path.dirname(path))


def deploy_write_private(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    deploy_sync(os.path.dirname(path))


def deploy_args(args, cwd):
    paths = []
    index = 1
    while index < len(args):
        option, separator, value = args[index].partition('=')
        if option in ('-confdir', '--confdir'):
            raise ActionError('CONFIG_TARGET', 'Directory/merged configurations cannot be replaced as a single file. Open a service using one explicit config file.')
        if option in ('-c', '-config', '--config'):
            if not separator:
                index += 1
                value = args[index] if index < len(args) else ''
            if not value or value == 'stdin:' or '://' in value:
                raise ActionError('CONFIG_TARGET', 'The service must load one explicit local configuration file.')
            paths.append(os.path.realpath(os.path.join(cwd, value)))
        index += 1
    if len(paths) != 1:
        raise ActionError('CONFIG_TARGET', 'The service must load one explicit config file; merged and implicit configurations are not deployed.')
    return paths[0]


def deploy_target(service, path):
    result = capture(['systemctl', 'show', '--no-pager',
                      '--property=Id,MainPID,ActiveState,SubState,ExecStart,User,Group,WorkingDirectory,RootDirectory,RootImage,NeedDaemonReload',
                      '--', service])
    props = dict(line.split('=', 1) for line in result.stdout.decode('utf-8', 'replace').splitlines() if '=' in line)
    if result.returncode or props.get('ActiveState') != 'active' or props.get('SubState') != 'running':
        raise ActionError('CONFIG_TARGET', 'Start the selected Xray service before validating its execution context.')
    if props.get('NeedDaemonReload') == 'yes' or props.get('RootDirectory') or props.get('RootImage'):
        raise ActionError('CONFIG_TARGET', 'Reload changed systemd units first. Chroot/image-based services require a separate deployment workflow.')
    pid = props.get('MainPID', '')
    if not pid.isdigit() or int(pid) <= 0:
        raise ActionError('CONFIG_TARGET', 'The Xray service has no running main process.')
    root = '/proc/' + pid
    executable = os.readlink(root + '/exe')
    if os.path.basename(executable).lower() != 'xray' or not os.path.isfile(executable):
        raise ActionError('CONFIG_TARGET', 'The service must run the installed Xray binary directly. Restart it first if its binary was replaced.')
    cwd = os.readlink(root + '/cwd')
    with open(root + '/cmdline', 'rb') as handle:
        args = os.fsdecode(handle.read(65536)).rstrip('\0').split('\0')
    target = os.path.realpath(path)
    if deploy_args(args, cwd) != target:
        raise ActionError('CONFIG_TARGET', 'The selected service does not load this file. Choose its owning Xray service.')
    host_file = os.stat(target)
    service_file = os.stat(root + '/root' + path)
    if (host_file.st_dev, host_file.st_ino) != (service_file.st_dev, service_file.st_ino):
        raise ActionError('CONFIG_TARGET', 'The service sees a different file through a private mount. Deploy its actual source file instead.')
    with open(root + '/environ', 'rb') as handle:
        raw_environment = handle.read(256 * 1024 + 1)
    if len(raw_environment) > 256 * 1024:
        raise ActionError('CONFIG_TARGET', 'The service environment exceeded its limit.')
    env = dict(item.split('=', 1) for item in os.fsdecode(raw_environment).split('\0') if '=' in item)
    with open(root + '/status', encoding='utf-8') as handle:
        identity = dict(line.split(':', 1) for line in handle.read(65536).splitlines() if ':' in line)
    uid, gid = int(identity['Uid'].split()[1]), int(identity['Gid'].split()[1])
    groups = [int(value) for value in identity.get('Groups', '').split()]
    with open(root + '/stat', encoding='utf-8') as handle:
        start_ticks = handle.read(65536).rsplit(')', 1)[1].split()[19]
    context = dict(service=props.get('Id', service), path=path, target=target, pid=int(pid),
                   executable=executable, cwd=cwd, uid=uid, gid=gid, groups=groups,
                   startTicks=start_ticks, environment=env, properties=props, args=args)
    binary = os.stat(executable)
    context['executableStamp'] = [binary.st_dev, binary.st_ino, binary.st_size, binary.st_mtime_ns]
    context['fingerprint'] = deploy_digest(json.dumps(context, sort_keys=True, ensure_ascii=True).encode())
    return context


def deploy_scrub(output, text):
    secrets = set()
    def collect(value):
        if isinstance(value, str) and len(value) > 2 and value not in ('none', 'auto'):
            secrets.add(value)
            secrets.add(json.dumps(value, ensure_ascii=True)[1:-1])
        elif isinstance(value, dict):
            for item in value.values():
                collect(item)
        elif isinstance(value, list):
            for item in value:
                collect(item)
    def visit(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if any(part in key.lower() for part in ('password', 'privatekey', 'secret', 'token', 'auth', 'preshared')) or key.lower() in ('id', 'ids', 'uuid', 'email', 'shortid', 'shortids', 'seed', 'pass', 'psk', 'key', 'keys', 'decryption', 'encryption'):
                    collect(item)
                visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)
    try:
        visit(json.loads(text))
    except (ValueError, TypeError):
        # Syntax errors can echo arbitrary source fragments. Keep only a summary.
        return ['Detailed core diagnostics were omitted because the source is not strict JSON.']
    for secret in sorted(secrets, key=len, reverse=True):
        output = output.replace(secret, '[redacted]')
    return [safe_line(line) for line in output.splitlines() if line.strip()][-40:]


def deploy_test(context, data):
    import resource
    if not shutil.which('setpriv'):
        raise ActionError('CONFIG_TOOLS', 'Validation requires the server’s setpriv utility (util-linux).')
    args = []
    if os.readlink('/proc/self/ns/mnt') != os.readlink('/proc/{}/ns/mnt'.format(context['pid'])):
        if not shutil.which('nsenter'):
            raise ActionError('CONFIG_TOOLS', 'Validation of this service requires nsenter (util-linux).')
        args = [shutil.which('nsenter'), '--target', str(context['pid']), '--mount', '--']
    args += [shutil.which('setpriv'), '--reuid=' + str(context['uid']), '--regid=' + str(context['gid'])]
    args += ['--groups=' + ','.join(map(str, context['groups']))] if context['groups'] else ['--clear-groups']
    args += ['--', context['executable'], 'run', '-test', '-format', 'json', '-config', 'stdin:']
    def limits():
        resource.setrlimit(resource.RLIMIT_FSIZE, (512 * 1024, 512 * 1024))
        resource.setrlimit(resource.RLIMIT_CPU, (20, 20))
    # Anonymous memory-backed output; rejected configs and credentials never
    # become a world-readable temporary file or a journal command line.
    with os.fdopen(os.memfd_create('wayrill-validation', os.MFD_CLOEXEC), 'w+b') as output:
        try:
            result = subprocess.run(args, input=data, stdout=output, stderr=subprocess.STDOUT,
                                    cwd='/proc/{}/cwd'.format(context['pid']), env=context['environment'],
                                    timeout=25, preexec_fn=limits)
            code = result.returncode
        except subprocess.TimeoutExpired:
            code = -1
        output.seek(0)
        diagnostic = output.read(512 * 1024).decode('utf-8', 'replace')
    lines = deploy_scrub(diagnostic, data.decode('utf-8'))
    if code == -1:
        lines.append('Validation timed out; the running service was not changed.')
    version = re.search(r'^Xray\s+(\S+)', diagnostic, re.M)
    return code == 0, lines, version[1] if version else None


def deploy_companion_read(path):
    try:
        return deploy_read(path)
    except FileNotFoundError:
        return None, None


def deploy_optional_hash(data):
    return deploy_digest(data) if data is not None else None


def deploy_check_companion(plan):
    if 'companionTarget' not in plan:
        return None
    data, stamp = deploy_companion_read(plan['companionTarget'])
    if deploy_optional_hash(data) != plan['companionSourceSha256'] or stamp != plan['companionSourceStamp']:
        raise ActionError('CONFIG_CHANGED', 'The Wayrill file changed after it was read or validated. Reconnect before applying.')
    return data


def deploy_companion_restore_check(journal):
    companion = journal.get('companion')
    if not companion:
        return
    data, _ = deploy_companion_read(companion['target'])
    if deploy_optional_hash(data) not in (companion['sourceSha256'], companion['configSha256']):
        raise ActionError('CONFIG_ROLLBACK_CONFLICT', 'The Wayrill file changed outside Wayrill. Both backups were retained for review.')
    if companion['sourceSha256'] is not None:
        original, _ = deploy_read(os.path.dirname(journal['result']['backupPath']) + '/wayrill.backup')
        if deploy_digest(original) != companion['sourceSha256']:
            raise ActionError('CONFIG_BACKUP', 'The Wayrill backup failed its integrity check.')


def deploy_companion_restore(directory, journal):
    companion = journal.get('companion')
    if not companion:
        return
    data, _ = deploy_companion_read(companion['target'])
    if deploy_optional_hash(data) == companion['sourceSha256']:
        return
    if companion['sourceSha256'] is None:
        os.unlink(companion['target'])
        deploy_sync(os.path.dirname(companion['target']))
    else:
        original, _ = deploy_read(directory + '/wayrill.backup')
        if deploy_digest(original) != companion['sourceSha256']:
            raise ActionError('CONFIG_BACKUP', 'The Wayrill backup failed its integrity check.')
        deploy_replace(companion['target'], original, companion['metadata'])


def validate_config(request):
    path, service, text = request['path'], request['service'], request['configText']
    data = text.encode('utf-8')
    if not data or len(data) > CONFIG_LIMIT:
        raise ActionError('CONFIG_FILE', 'The draft must be a UTF-8 config of at most 16 MiB.')
    context = deploy_target(service, path)
    original, stamp = deploy_read(context['target'])
    if deploy_digest(original) != request['expectedSha256']:
        raise ActionError('CONFIG_CHANGED', 'The server file changed since it was read. Read it again before applying your draft.')
    companion_plan = {}
    companion_data = None
    if request.get('wayrillText') is not None:
        if not isinstance(request['wayrillText'], str):
            raise ActionError('CONFIG_FILE', 'Invalid Wayrill document.')
        companion_data = request['wayrillText'].encode('utf-8')
        if not companion_data or len(companion_data) > CONFIG_LIMIT:
            raise ActionError('CONFIG_FILE', 'The Wayrill document exceeds 16 MiB.')
        try:
            document = json.loads(companion_data)
            if document['format'] != 'wayrill.remote' or document['version'] != 1 or not isinstance(document['graph'], dict):
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            raise ActionError('CONFIG_FILE', 'Invalid Wayrill Remote document.')
        companion_target = os.path.splitext(context['target'])[0] + '.wayrill.json'
        previous, previous_stamp = deploy_companion_read(companion_target)
        if deploy_optional_hash(previous) != request.get('expectedWayrillSha256'):
            raise ActionError('CONFIG_CHANGED', 'The Wayrill file changed since it was read. Reconnect before applying.')
        companion_plan = dict(companionTarget=companion_target, companionSourceSha256=deploy_optional_hash(previous),
                              companionSourceStamp=previous_stamp, companionSha256=deploy_digest(companion_data),
                              readerUid=request.get('readerUid', os.geteuid()), readerGid=request.get('readerGid', os.getegid()))
    valid, lines, core_version = deploy_test(context, data)
    now = int(time.time())
    plan = dict(version=1, id=None, valid=valid, path=path, service=service,
                configSha256=deploy_digest(data), sourceSha256=deploy_digest(original),
                coreVersion=core_version, checkedAt=now, expiresAt=now + CONFIG_PLAN_SECONDS,
                logs=lines, message='Validated as the running service user.' if valid else 'Xray rejected the draft. The server configuration is unchanged.')
    if valid and request.get('stage', True):
        secure_dir(BASE)
        secure_dir(BASE + '/config-plans')
        identifier = uuid.uuid4().hex
        directory = BASE + '/config-plans/' + identifier
        secure_dir(directory)
        deploy_write_private(directory + '/candidate.json', data)
        if companion_data is not None:
            deploy_write_private(directory + '/candidate.wayrill.json', companion_data)
        plan['id'] = identifier
        deploy_save(directory + '/plan.json', dict(plan, contextHash=context['fingerprint'],
                                                  sourceStamp=stamp, target=context['target'], bootId=boot_id(), **companion_plan))
        for entry in os.scandir(BASE + '/config-plans'):
            if re.fullmatch(r'[a-f0-9]{32}', entry.name) and not entry.is_symlink() and entry.stat().st_mtime < time.time() - 86400:
                shutil.rmtree(entry.path)
    return plan


def deploy_metadata(path):
    info = os.stat(path, follow_symlinks=False)
    return dict(uid=info.st_uid, gid=info.st_gid, mode=stat.S_IMODE(info.st_mode),
                xattrs={name: base64.b64encode(os.getxattr(path, name, follow_symlinks=False)).decode()
                        for name in os.listxattr(path, follow_symlinks=False)})


def deploy_replace(path, data, metadata):
    directory = os.path.dirname(path)
    fd, temporary = tempfile.mkstemp(prefix='.wayrill-', suffix='.tmp', dir=directory)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data)
            os.fchown(handle.fileno(), metadata['uid'], metadata['gid'])
            os.fchmod(handle.fileno(), metadata['mode'])
            for name, value in metadata['xattrs'].items():
                os.setxattr(handle.fileno(), name, base64.b64decode(value))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        deploy_sync(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def deploy_health(service, seconds=5):
    deadline = time.monotonic() + seconds
    first_pid = None
    while True:
        result = capture(['systemctl', 'show', '--property=ActiveState,SubState,MainPID,Result', '--', service])
        values = dict(line.split('=', 1) for line in result.stdout.decode('utf-8', 'replace').splitlines() if '=' in line)
        pid = values.get('MainPID', '0')
        if result.returncode or values.get('ActiveState') != 'active' or values.get('SubState') != 'running' or pid == '0' or values.get('Result') != 'success':
            raise ActionError('CONFIG_HEALTH', 'Xray did not remain active after restart.')
        if first_pid is not None and first_pid != pid:
            raise ActionError('CONFIG_HEALTH', 'Xray restarted again during the health check.')
        first_pid = pid
        if time.monotonic() >= deadline:
            return
        time.sleep(0.5)


def deploy_restart(service):
    if capture(['systemctl', 'restart', '--', service], timeout=40).returncode:
        raise ActionError('CONFIG_RESTART', 'Xray could not restart with the applied configuration.')
    deploy_health(service)


def deploy_restore(directory, journal, before_start=False):
    current, _ = deploy_read(journal['target'])
    current_hash = deploy_digest(current)
    if os.path.realpath(journal['path']) != journal['target'] or current_hash not in (journal['configSha256'], journal['sourceSha256']):
        raise ActionError('CONFIG_ROLLBACK_CONFLICT', 'The configuration changed outside Wayrill. It was left unchanged; restore the retained backup after reviewing the external changes.')
    deploy_companion_restore_check(journal)
    original, _ = deploy_read(directory + '/config.backup')
    if deploy_digest(original) != journal['sourceSha256']:
        raise ActionError('CONFIG_BACKUP', 'The saved backup failed its integrity check. Automatic restoration was stopped.')
    if current_hash != journal['sourceSha256']:
        deploy_replace(journal['target'], original, journal['metadata'])
    deploy_companion_restore(directory, journal)
    restart_needed = journal.get('restartRequired', True) and (current_hash != journal['sourceSha256'] or journal['phase'] != 'prepared')
    journal['phase'] = 'file-restored'
    deploy_save(directory + '/deployment.json', journal)
    # The original bytes are durable before removing the boot guard. Removing
    # it before restart also avoids a dependency waiting on our transaction lock.
    deploy_disarm_boot_guard(os.path.basename(directory), journal['guardService'], reload=not before_start)
    if not before_start and restart_needed:
        try:
            deploy_restart(journal['service'])
        except Exception as error:
            raise ActionError('CONFIG_ROLLBACK', 'The backup file was restored, but Xray did not return to a healthy running state. The backup was retained.') from error
    journal['phase'] = 'restored'
    deploy_save(directory + '/deployment.json', journal)


@contextlib.contextmanager
def deploy_lock():
    fd = os.open(BASE + '/config.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def recover_config(identifier, before_start=False):
    if before_start:
        try:
            journal = load(BASE + '/' + identifier + '/deployment.json')
            if journal['bootId'] == boot_id():
                return  # Never wait for the apply lock during its normal restart.
        except FileNotFoundError:
            return
        fd = os.open(BASE + '/config.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as lock:
            deadline = time.monotonic() + 60
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    # A reconnect may already have restored the durable file
                    # and now be waiting for this Before=Xray unit to finish.
                    checkpoint = load(BASE + '/' + identifier + '/deployment.json')
                    if checkpoint['phase'] in ('file-restored', 'restored', 'committed', 'aborted', 'needs-attention'):
                        return
                    if time.monotonic() >= deadline:
                        raise ActionError('CONFIG_RECOVERY_BUSY', 'Another recovery operation did not finish in time.')
                    time.sleep(0.1)
            _recover_config(identifier, True)
        return
    with deploy_lock():
        _recover_config(identifier, before_start)


def _recover_config(identifier, before_start):
    directory = BASE + '/' + identifier
    try:
        journal = load(directory + '/deployment.json')
    except FileNotFoundError:
        return
    if before_start and journal['bootId'] == boot_id():
        return  # The normal restart inside this transaction must use the draft.
    state = load(directory + '/state.json')
    state['configResult'] = dict(journal['result'])
    if journal['phase'] in ('committed', 'restored', 'needs-attention', 'aborted'):
        deploy_disarm_boot_guard(identifier, journal['guardService'], reload=not before_start)
        if state['state'] != 'running':
            return
        committed = journal['phase'] == 'committed'
        state.update(state='succeeded' if committed else 'failed', stage='Configuration applied' if committed else 'Apply stopped',
                     percent=100 if committed else None, updatedAt=journal.get('committedAt', int(time.time())))
        state['configResult']['rollback'] = 'succeeded' if journal['phase'] == 'restored' else 'failed' if journal['phase'] == 'needs-attention' else 'not-needed'
        deploy_save(directory + '/state.json', state)
        return
    try:
        deploy_restore(directory, journal, before_start)
        state.update(stage='Previous configuration restored', message='The backup was restored before Xray startup.' if before_start else 'The apply worker stopped; its backup was restored and Xray is running.', errorCode='CONFIG_RECOVERED')
        state['configResult']['rollback'] = 'succeeded'
    except Exception as error:
        state.update(stage='Restoration needs attention', message=error.message if isinstance(error, ActionError) else 'Automatic restoration failed. The backup was retained.', errorCode='CONFIG_ROLLBACK')
        state['configResult']['rollback'] = 'failed'
        journal['phase'] = 'needs-attention'
        deploy_save(directory + '/deployment.json', journal)
    state.update(state='failed', percent=None, updatedAt=int(time.time()))
    deploy_save(directory + '/state.json', state)
    deploy_disarm_boot_guard(identifier, journal['guardService'], reload=not before_start)


def apply_config(request, state, write):
    with deploy_lock():
        _apply_config(request, state, write)


def _apply_config(request, state, write):
    directory = BASE + '/' + request['id']
    plan_dir = BASE + '/config-plans/' + request['planId']
    plan = load(plan_dir + '/plan.json')
    if plan.get('bootId') != boot_id() or plan['expiresAt'] <= time.time():
        raise ActionError('CONFIG_EXPIRED', 'The configuration validation expired or the server rebooted. Validate again.')
    context = deploy_target(plan['service'], plan['path'])
    original, stamp = deploy_read(context['target'])
    if context['fingerprint'] != plan['contextHash'] or context['target'] != plan['target'] or stamp != plan['sourceStamp'] or deploy_digest(original) != plan['sourceSha256']:
        raise ActionError('CONFIG_CHANGED', 'The file or service changed after validation. Read/validate it again; nothing was replaced.')
    candidate, _ = deploy_read(plan_dir + '/candidate.json')
    if deploy_digest(candidate) != plan['configSha256']:
        raise ActionError('CONFIG_PLAN', 'The validated draft failed its integrity check. Validate again.')
    companion_original = deploy_check_companion(plan)
    companion_candidate = None
    if 'companionTarget' in plan:
        companion_candidate, _ = deploy_read(plan_dir + '/candidate.wayrill.json')
        if deploy_digest(companion_candidate) != plan['companionSha256']:
            raise ActionError('CONFIG_PLAN', 'The Wayrill draft failed its integrity check. Validate again.')
    state.update(stage='Revalidating configuration', percent=15)
    write()
    valid, lines, _ = deploy_test(context, candidate)
    state['logs'] = lines
    if not valid:
        raise ActionError('CONFIG_VALIDATION', 'Xray no longer accepts this draft. The original configuration is unchanged.')
    if deploy_target(plan['service'], plan['path'])['fingerprint'] != context['fingerprint']:
        raise ActionError('CONFIG_CHANGED', 'The service changed during validation. Validate again; nothing was replaced.')
    if candidate == original and companion_candidate == companion_original:
        state.update(stage='Configuration already current', percent=100)
        return
    state.update(stage='Backing up configuration', percent=35)
    write()
    deploy_write_private(directory + '/config.backup', original)
    journal = dict(phase='prepared', path=plan['path'], target=plan['target'], service=plan['service'],
                   sourceSha256=plan['sourceSha256'], configSha256=plan['configSha256'], metadata=deploy_metadata(plan['target']),
                   bootId=boot_id(), guardService=context['service'], restartRequired=candidate != original)
    state['configResult'] = dict(path=plan['path'], service=plan['service'], planId=request['planId'],
                                backupPath=directory + '/config.backup', originalSha256=plan['sourceSha256'],
                                installedSha256=plan['configSha256'], rollback='not-needed')
    if companion_candidate is not None:
        companion_metadata = deploy_metadata(plan['companionTarget']) if companion_original is not None else deploy_metadata(plan['target'])
        # The companion contains credentials and disabled users too; owner-only.
        journal['companion'] = dict(target=plan['companionTarget'], sourceSha256=plan['companionSourceSha256'],
                                    configSha256=plan['companionSha256'], metadata=companion_metadata)
        if companion_original is not None:
            deploy_write_private(directory + '/wayrill.backup', companion_original)
        state['configResult']['wayrillSha256'] = plan['companionSha256']
    journal['result'] = dict(state['configResult'])
    deploy_save(directory + '/deployment.json', journal)
    write()
    armed = False
    try:
        state.update(stage='Arming reboot recovery' if journal['restartRequired'] else 'Preparing graph save', percent=45)
        write()
        if journal['restartRequired']:
            deploy_arm_boot_guard(request['id'], journal['guardService'])
        latest, latest_stamp = deploy_read(plan['target'])
        if os.path.realpath(plan['path']) != plan['target'] or latest_stamp != stamp or latest != original:
            journal['phase'] = 'aborted'  # No mutation or restart occurred.
            deploy_save(directory + '/deployment.json', journal)
            raise ActionError('CONFIG_CHANGED', 'The file changed while preparing its backup. It was left unchanged.')
        deploy_check_companion(plan)
        armed = True
        state.update(stage='Installing configuration', percent=50)
        write()
        if companion_candidate is not None:
            deploy_replace(plan['companionTarget'], companion_candidate, dict(journal['companion']['metadata'], uid=plan.get('readerUid', 0), gid=plan.get('readerGid', 0), mode=0o600))
        if journal['restartRequired']:
            deploy_replace(plan['target'], candidate, journal['metadata'])
        journal['phase'] = 'installed'
        deploy_save(directory + '/deployment.json', journal)
        state.update(stage='Restarting Xray and checking health' if journal['restartRequired'] else 'Verifying saved graph', percent=70)
        write()
        if journal['restartRequired']:
            deploy_restart(plan['service'])
        current_context = deploy_target(plan['service'], plan['path'])
        for key in ('executableStamp', 'args', 'uid', 'gid', 'groups', 'cwd'):
            if current_context.get(key) != context.get(key):
                raise ActionError('CONFIG_CHANGED', 'The service execution settings changed during restart.')
        installed, _ = deploy_read(plan['target'])
        if deploy_digest(installed) != plan['configSha256']:
            raise ActionError('CONFIG_CHANGED', 'The configuration changed during its health check.')
        if companion_candidate is not None:
            installed_companion, _ = deploy_companion_read(plan['companionTarget'])
            if deploy_optional_hash(installed_companion) != plan['companionSha256']:
                raise ActionError('CONFIG_CHANGED', 'The Wayrill file changed during apply.')
        journal['phase'] = 'committed'
        journal['committedAt'] = int(time.time())
        deploy_save(directory + '/deployment.json', journal)
    except BaseException as error:
        if not armed:
            journal['phase'] = 'aborted'
            deploy_save(directory + '/deployment.json', journal)
            raise
        state.update(stage='Restoring previous configuration', percent=85)
        write()
        try:
            deploy_restore(directory, journal)
            state['configResult']['rollback'] = 'succeeded'
        except Exception as rollback_error:
            state['configResult']['rollback'] = 'failed'
            journal['phase'] = 'needs-attention'
            deploy_save(directory + '/deployment.json', journal)
            raise ActionError('CONFIG_ROLLBACK', rollback_error.message if isinstance(rollback_error, ActionError) else 'Automatic restoration failed. The backup was retained.') from rollback_error
        raise ActionError('CONFIG_RESTORED', 'Apply failed. The previous configuration was restored and Xray is running.') from error
    finally:
        if journal['phase'] in ('committed', 'restored', 'needs-attention', 'aborted') or not armed:
            deploy_disarm_boot_guard(request['id'], journal['guardService'])
