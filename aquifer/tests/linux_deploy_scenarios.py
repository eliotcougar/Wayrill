"""Run only inside a disposable mount/PID/network namespace on Linux.

SOURCE is injected by the test launcher. /tmp is replaced with tmpfs before any
fixture writes. The systemd adapter below owns only fictional fixture processes;
no command reaches the host service manager.
"""
import hashlib
import ctypes
import json
import multiprocessing
import os
import pwd
import signal
import socket
import subprocess
import sys
import time
import types
import uuid

if os.getpid() != 1:
    raise RuntimeError('This scenario requires a private PID namespace.')
libc = ctypes.CDLL(None, use_errno=True)
libc.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_char_p]
def tmpfs(path, readonly=False):
    if libc.mount(b'tmpfs', path.encode(), b'tmpfs', 1 if readonly else 0,
                  b'size=64m,mode=1777' if path == '/tmp' else b'size=1m,mode=0755'):
        raise OSError(ctypes.get_errno(), 'Failed to isolate ' + path)
    if readonly:
        assert os.statvfs(path).f_flag & os.ST_RDONLY
tmpfs('/tmp')
tmpfs('/dev/shm')
# Defense in depth: even an accidental real systemctl call cannot reach host
# IPC, and an incorrect path cannot write live units or persistent job state.
for protected in ('/run', '/etc/systemd/system', '/var/lib'):
    tmpfs(protected, readonly=True)
for name in ('DBUS_SYSTEM_BUS_ADDRESS', 'DBUS_SESSION_BUS_ADDRESS', 'SYSTEMD_HOST'):
    os.environ.pop(name, None)
subprocess.run(['ip', 'link', 'set', 'lo', 'up'], check=True)
lab = '/tmp/wayrill-deployment-lab'
os.mkdir(lab, 0o755)
target = lab + '/config.json'
core = '/usr/local/bin/xray'
account = pwd.getpwnam('xray')
current = multiprocessing.Value('i', 0)
restarts = multiprocessing.Value('i', 0)
reloads = multiprocessing.Value('i', 0)
launches = []
results = []
ns = {'__name__': 'fixture', 'SOURCE': SOURCE}
exec(compile(SOURCE, '<fixed-server-worker>', 'exec'), ns)
ns['BASE'] = lab + '/state'
ns['BOOT_UNITS'] = lab + '/units'
os.mkdir(ns['BOOT_UNITS'], 0o755)
service = 'wayrill-fixture.service'
assert all(path.startswith(lab + '/units/') for path in ns['deploy_guard_paths']('0' * 32, service))


def config(port):
    return json.dumps({'log': {'access': 'none', 'error': 'none'}, 'inbounds': [
        {'tag': 'fixture', 'listen': '127.0.0.1', 'port': port, 'protocol': 'mixed', 'settings': {}}],
        'outbounds': [{'protocol': 'freedom', 'tag': 'direct'}]}, indent=2).encode()


original = config(19080)


def alive(pid):
    try:
        return pid > 0 and open('/proc/{}/stat'.format(pid)).read().rsplit(')', 1)[1].split()[0] != 'Z'
    except OSError:
        return False


def socks(port):
    with socket.create_connection(('127.0.0.1', port), timeout=0.3) as connection:
        connection.sendall(b'\x05\x01\x00')
        return connection.recv(2) == b'\x05\x00'


def restart():
    pid = current.value
    if alive(pid):
        os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 3
        while alive(pid) and time.monotonic() < deadline:
            time.sleep(0.02)
    process = subprocess.Popen([core, 'run', '-config', target], cwd=lab,
        env={'PATH': '/usr/local/bin:/usr/bin:/bin'}, user=account.pw_uid, group=account.pw_gid,
        extra_groups=[account.pw_gid], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    current.value = process.pid
    restarts.value += 1
    port = json.load(open(target))['inbounds'][0]['port']
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and process.poll() is None:
        try:
            if socks(port):
                return 0
        except OSError:
            pass
        time.sleep(0.03)
    return 1


def capture(args, timeout=15):
    if args == ['systemctl', 'daemon-reload']:
        reloads.value += 1
        return types.SimpleNamespace(returncode=0, stdout=b'', stderr=b'')
    if args[0] == 'systemd-run':
        launches.append(args)
        return types.SimpleNamespace(returncode=0, stdout=b'', stderr=b'')
    if args[:2] == ['systemctl', 'restart'] and args[-1] == service:
        return types.SimpleNamespace(returncode=restart(), stdout=b'', stderr=b'')
    if args[:2] == ['systemctl', 'show'] and args[-1] == service:
        live = alive(current.value)
        props = dict(Id=service, MainPID=str(current.value if live else 0), ActiveState='active' if live else 'failed',
            SubState='running' if live else 'dead', Result='success' if live else 'exit-code',
            ExecStart=core + ' run -config ' + target, User='xray', Group='xray', WorkingDirectory=lab,
            RootDirectory='', RootImage='', NeedDaemonReload='no')
        return types.SimpleNamespace(returncode=0, stdout='\n'.join(k + '=' + v for k, v in props.items()).encode(), stderr=b'')
    raise RuntimeError('Fixture refused command: ' + args[0])


ns['capture'] = capture


def reset():
    with open(target, 'wb') as handle:
        handle.write(original)
    os.chown(target, 0, account.pw_gid)
    os.chmod(target, 0o640)
    assert restart() == 0 and socks(19080)


def plan(data, wayrill=None):
    return ns['validate_config'](dict(path=target, service=service, configText=data.decode(),
        expectedSha256=hashlib.sha256(open(target, 'rb').read()).hexdigest(), stage=True,
        **({} if wayrill is None else dict(wayrillText=wayrill, readerUid=account.pw_uid, readerGid=account.pw_gid, expectedWayrillSha256=ns['deploy_optional_hash'](ns['deploy_companion_read'](lab + '/config.wayrill.json')[0])))))


def job(approved):
    request = dict(mode='start', id=uuid.uuid4().hex, action='applyConfig', planId=approved['id'])
    ns['start'](request)
    return request


def result(request):
    return ns['load'](ns['BASE'] + '/' + request['id'] + '/state.json')


reset()
pid = current.value
bad = plan(b'{invalid json')
assert not bad['valid'] and bad['id'] is None and current.value == pid
results.append({'case': 'invalid draft', 'passed': True, 'daemonUnchanged': True})

approved = plan(config(19082))
assert approved['valid'] and approved['id']
request = job(approved)
ns['worker'](request['id'])
state = result(request)
assert state['state'] == 'succeeded' and socks(19082)
assert open(state['configResult']['backupPath'], 'rb').read() == original
assert os.stat(target).st_uid == 0 and os.stat(target).st_gid == account.pw_gid and os.stat(target).st_mode & 0o777 == 0o640
count = restarts.value
assert ns['start'](request)['state'] == 'succeeded' and restarts.value == count
assert any('ExecStopPost=' in option for option in launches[0])
results.append({'case': 'successful apply, exact backup, file metadata and retry idempotence', 'passed': True})

reset()
blocker = socket.socket()
blocker.bind(('127.0.0.1', 19083))
blocker.listen()
approved = plan(config(19083))
assert approved['valid']  # -test deliberately does not bind listener ports.
request = job(approved)
ns['worker'](request['id'])
state = result(request)
assert state['state'] == 'failed' and state['configResult']['rollback'] == 'succeeded'
assert open(target, 'rb').read() == original and socks(19080)
blocker.close()
results.append({'case': 'real bind failure after validation, automatic rollback and original listener restored', 'passed': True})

reset()
approved = plan(config(19084))
request = job(approved)
ready_read, ready_write = os.pipe()
child = os.fork()
if child == 0:
    os.close(ready_read)
    def stalled_health(*args):
        os.write(ready_write, b'installed')
        time.sleep(120)
    ns['deploy_health'] = stalled_health
    ns['worker'](request['id'])
    os._exit(0)
os.close(ready_write)
import select
assert select.select([ready_read], [], [], 15)[0] and os.read(ready_read, 32) == b'installed'
os.close(ready_read)
os.kill(child, signal.SIGKILL)
os.waitpid(child, 0)
# Invoke the exact recovery function used by the detached unit's ExecStopPost.
ns['recover_config'](request['id'])
state = result(request)
assert state['state'] == 'failed' and state['configResult']['rollback'] == 'succeeded'
assert open(target, 'rb').read() == original and socks(19080)
results.append({'case': 'SIGKILL during apply; ExecStopPost recovery function restores file and real daemon', 'passed': True})

reset()
approved = plan(config(19085))
request = job(approved)
with open(target, 'wb') as handle:
    handle.write(b'{"external":true}')
count = restarts.value
ns['worker'](request['id'])
assert result(request)['errorCode'] == 'CONFIG_CHANGED'
assert open(target, 'rb').read() == b'{"external":true}' and restarts.value == count
results.append({'case': 'external edit after validation is preserved without restart', 'passed': True})

reset()
approved = plan(config(19086))
request = job(approved)
read_end, write_end = os.pipe()
child = os.fork()
if child == 0:
    os.close(read_end)
    def before_power_loss(*args):
        os.write(write_end, b'installed')
        time.sleep(120)
    ns['deploy_health'] = before_power_loss
    ns['worker'](request['id'])
    os._exit(0)
os.close(write_end)
assert select.select([read_end], [], [], 15)[0] and os.read(read_end, 32) == b'installed'
os.close(read_end)
os.kill(child, signal.SIGKILL)
os.waitpid(child, 0)
unit, link = ns['deploy_guard_paths'](request['id'], service)
assert os.path.isfile(unit) and os.path.islink(link) and ('Before=' + service) in open(unit).read()
actual_boot_id = ns['boot_id']
ns['boot_id'] = lambda: 'simulated-new-boot'
count = restarts.value
ns['recover_config'](request['id'], before_start=True)
assert restarts.value == count and open(target, 'rb').read() == original
assert not os.path.exists(unit) and not os.path.lexists(link)
assert restart() == 0 and socks(19080)
ns['boot_id'] = actual_boot_id
results.append({'case': 'boot recovery restores before daemon startup and removes the temporary guard', 'passed': True})

# The supplied documents are compiled by the actual TypeScript graph model.
# Save twice, then re-read through the exact read-only companion probe.
import contextlib
import io
reset()
reloaded_documents = []
for index, document in enumerate(DOCUMENTS[:2]):
    assert document['configText'].encode() == original
    count, pid, inode, reload_count = restarts.value, current.value, os.stat(target).st_ino, reloads.value
    approved = plan(original, document['wayrillText'])
    request = job(approved)
    ns['worker'](request['id'])
    assert result(request)['state'] == 'succeeded'
    assert restarts.value == count and current.value == pid and os.stat(target).st_ino == inode
    assert reloads.value == reload_count
    assert not any(os.path.lexists(path) for path in ns['deploy_guard_paths'](request['id'], service))
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        exec(compile(COMPANION_READ, '<companion-read>', 'exec'), {'PATH': target})
    metadata = json.loads(output.getvalue().split('WAYRILL_REMOTE_COMPANION_V1_BEGIN')[1].split('WAYRILL_REMOTE_COMPANION_V1_END')[0])
    assert metadata['path'] == lab + '/config.wayrill.json' and not metadata.get('error')
    data = open(metadata['path'], 'rb').read()
    assert hashlib.sha256(data).hexdigest() == metadata['sha256']
    assert data.decode() == document['wayrillText']
    assert os.stat(metadata['path']).st_mode & 0o777 == 0o600
    assert os.stat(metadata['path']).st_uid == account.pw_uid
    reader = subprocess.run(['setpriv', '--reuid', str(account.pw_uid), '--regid', str(account.pw_gid), '--clear-groups', sys.executable, '-c', 'PATH=' + repr(target) + '\n' + COMPANION_READ], capture_output=True)
    assert reader.returncode == 0 and metadata['sha256'].encode() in reader.stdout
    reloaded_documents.append(data.decode())
results.append({'case': 'two successive layout saves and fresh reads preserve positions and viewport without restarting Xray', 'passed': True, 'reloads': 2})

previous_companion = open(lab + '/config.wayrill.json', 'rb').read()
blocker = socket.socket()
blocker.bind(('127.0.0.1', 19083))
blocker.listen()
approved = plan(DOCUMENTS[2]['configText'].encode(), DOCUMENTS[2]['wayrillText'])
assert approved['valid']
request = job(approved)
ns['worker'](request['id'])
assert result(request)['state'] == 'failed' and result(request)['configResult']['rollback'] == 'succeeded'
assert open(target, 'rb').read() == original and socks(19080)
assert open(lab + '/config.wayrill.json', 'rb').read() == previous_companion
blocker.close()
results.append({'case': 'real failed restart restores the previous graph document and native config together', 'passed': True})

print(json.dumps({'passed': True, 'cases': results, 'reloadedDocuments': reloaded_documents, 'fixtureServiceUser': account.pw_name,
                  'namespaceInitPid': os.getpid(), 'networkNamespace': os.readlink('/proc/self/ns/net'),
                  'fixtureFilesInTmpfs': True, 'realSystemdMutations': False,
                  'liveSystemdAndStateReadOnly': all(os.statvfs(path).f_flag & os.ST_RDONLY for path in ('/run', '/etc/systemd/system', '/var/lib'))}))
