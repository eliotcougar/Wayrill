"""Contract, lifecycle and command-safety tests; no server or host changes."""
from pathlib import Path
import json
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


def load_actions():
    path = Path(__file__).resolve().parents[1] / 'src-tauri/resources/server_actions.py'
    namespace = {'__name__': 'test_actions', 'SOURCE': path.read_bytes(), 'deploy_sync': lambda *args: None}
    fake_fcntl = types.SimpleNamespace(LOCK_EX=2, flock=lambda *args: None)
    with patch.dict(sys.modules, {'fcntl': fake_fcntl}):
        exec(compile(path.read_bytes(), str(path), 'exec'), namespace)
    return namespace


class ActionTests(unittest.TestCase):
    def setUp(self):
        self.ns = load_actions()
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.ns['BASE'] = folder.name
        flags = patch.object(self.ns['os'], 'O_NOFOLLOW', 0, create=True)
        flags.start()
        self.addCleanup(flags.stop)
        self.request = {'mode': 'start', 'id': 'a' * 32, 'action': 'upgradePackage',
                        'package': 'curl:amd64', 'candidateVersion': '1:2.0~rc1-2'}

    def test_arguments_reject_paths_options_shell_and_version_injection(self):
        for field, bad in [('id', '../etc'), ('package', '--help'), ('package', 'curl;reboot'),
                           ('package', '/tmp/pkg.deb'), ('package', 'curl\nx'),
                           ('candidateVersion', '2 --allow-unauthenticated'), ('candidateVersion', '../x')]:
            with self.subTest(field=field, value=bad), self.assertRaises(self.ns['ActionError']):
                self.ns['validate'](dict(self.request, **{field: bad}))
        self.ns['validate'](self.request)

    def test_service_name_cannot_inject_options(self):
        for service in ['--all', '../ssh.service', 'xray.service\nreboot', 'a;reboot.service']:
            with self.assertRaises(self.ns['ActionError']):
                self.ns['validate'](dict(self.request, action='restartXray', service=service))

    def test_logs_remove_repository_credentials_queries_and_escape_codes(self):
        result = self.ns['safe_line']('\x1b[31mhttps://user:secret@repo.test/index?token=secret\x1b[0m')
        self.assertNotIn('secret', result)
        self.assertNotIn('\x1b', result)
        self.assertNotIn('secret', self.ns['safe_line']('ftp://user:secret@repo/index?auth=secret'))
        self.assertLessEqual(len(self.ns['safe_line']('a' * 3000)), 500)

    def test_apt_uses_real_locks_preserves_configs_and_disallows_removal(self):
        class Captured(Exception):
            pass
        state = {'logs': []}
        with patch('shutil.which', return_value='/usr/bin/apt-get'), \
             patch.dict(self.ns, capture=lambda *args, **kwargs: types.SimpleNamespace(returncode=0, stdout=b'installed')), \
             patch('subprocess.Popen', side_effect=Captured) as popen:
            with self.assertRaises(Captured):
                self.ns['run_apt'](self.request, state, lambda: None)
        args = popen.call_args.args[0]
        self.assertIn('--only-upgrade', args)
        self.assertIn('--no-remove', args)
        self.assertIn('curl:amd64=1:2.0~rc1-2', args)
        self.assertIn('DPkg::Lock::Timeout=120', args)
        self.assertIn('Dpkg::Options::=--force-confold', args)
        self.assertNotIn('Debug::NoLocking=true', args)
        self.assertNotIn('--force-yes', args)
        self.assertEqual(popen.call_args.kwargs['env']['NEEDRESTART_MODE'], 'l')

    def test_nonroot_uses_noninteractive_sudo_and_stdin(self):
        request = dict(self.request, mode='poll')
        with patch('os.geteuid', return_value=1000, create=True), \
             patch('shutil.which', return_value='/usr/bin/sudo'), \
             patch('subprocess.run', return_value=types.SimpleNamespace(returncode=1, stdout=b'', stderr=b'password required')) as run:
            with self.assertRaises(self.ns['ActionError']) as error:
                self.ns['dispatch'](request)
        self.assertEqual(error.exception.code, 'SUDO')
        self.assertEqual(run.call_args.args[0][:3], ['/usr/bin/sudo', '-n', '--'])
        self.assertNotIn('password', str(run.call_args.args[0]))
        self.assertIn(b'REQUEST=', run.call_args.kwargs['input'])

    def test_root_dispatch_never_calls_sudo(self):
        seen = []
        with patch('os.geteuid', return_value=0, create=True), \
             patch.dict(self.ns, start=lambda request: {'id': request['id']}, respond=seen.append), \
             patch('subprocess.run') as run:
            self.ns['dispatch'](self.request)
        run.assert_not_called()
        self.assertEqual(seen[0]['job']['id'], self.request['id'])

    def test_graph_save_keeps_the_connected_account_readable_after_sudo(self):
        request = dict(mode='validateConfig', path='/etc/xray/config.json', service='xray.service',
                       configText='{}', wayrillText='{}', uploadPath='/unused', expectedSha256='a' * 64,
                       readerUid=9999, readerGid=9999)
        with patch('os.geteuid', return_value=1000, create=True), \
             patch('os.getegid', return_value=100, create=True), \
             patch('shutil.which', return_value='/usr/bin/sudo'), \
             patch('subprocess.run', return_value=types.SimpleNamespace(returncode=1, stdout=b'', stderr=b'')) as run:
            with self.assertRaises(self.ns['ActionError']):
                self.ns['dispatch'](request)
        elevated = run.call_args.kwargs['input'].split(b'\nSOURCE=', 1)[0]
        self.assertIn(b"'readerUid': 1000", elevated)
        self.assertIn(b"'readerGid': 100", elevated)
        self.assertNotIn(b'9999', elevated)

    def test_reboot_success_requires_new_boot(self):
        record = dict(id='a' * 32, action='reboot', bootId='before', state='running', createdAt=100, logs=[])
        written = []
        with patch.dict(self.ns, load=lambda path: record.copy(), boot_id=lambda: 'after', save=lambda path, value: written.append(value)):
            result = self.ns['poll']('a' * 32)
        self.assertEqual(result['state'], 'succeeded')
        self.assertEqual(result['percent'], 100)
        self.assertEqual(len(written), 1)

    def test_unexpected_reboot_does_not_report_upgrade_success(self):
        record = dict(id='a' * 32, action='upgradeAll', bootId='before', state='running', createdAt=100, logs=[])
        with patch.dict(self.ns, load=lambda path: record.copy(), boot_id=lambda: 'after', save=lambda *args: None):
            self.assertEqual(self.ns['poll']('a' * 32)['state'], 'interrupted')

    def test_poll_cannot_overwrite_concurrent_completion(self):
        before = dict(id='a' * 32, action='upgradeAll', bootId='same', state='running', createdAt=100, logs=[])
        after = dict(before, state='succeeded')
        records = iter([before, after])
        def unexpected_save(*args):
            self.fail('A completed result must not be overwritten')
        with patch.dict(self.ns, load=lambda path: next(records), boot_id=lambda: 'same', save=unexpected_save,
                        capture=lambda *args: types.SimpleNamespace(returncode=0, stdout=b'LoadState=loaded\nActiveState=inactive\n')):
            self.assertEqual(self.ns['poll']('a' * 32)['state'], 'succeeded')

    def test_same_request_is_idempotent_and_cannot_change_action(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / self.request['id']
            path.mkdir()
            (path / 'request.json').write_text(json.dumps(self.request))
            with patch.dict(self.ns, BASE=root, secure_dir=lambda *args: None,
                            _poll=lambda identifier: {'id': identifier, 'state': 'succeeded'}), \
                 patch('shutil.which', return_value='/usr/bin/systemctl'), \
                 patch.object(self.ns['os'], 'O_NOFOLLOW', 0, create=True), \
                 patch('subprocess.run') as run:
                self.assertEqual(self.ns['start'](self.request)['state'], 'succeeded')
                run.assert_not_called()
                with self.assertRaises(self.ns['ActionError']) as error:
                    self.ns['start'](dict(self.request, action='reboot'))
                self.assertEqual(error.exception.code, 'JOB_CONFLICT')

    def test_no_second_action_while_a_job_is_running(self):
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / 'current.json').write_text(json.dumps({'id': 'b' * 32}))
            with patch.dict(self.ns, BASE=root, secure_dir=lambda *args: None,
                            _poll=lambda identifier: {'id': identifier, 'state': 'running'}), \
                 patch('shutil.which', return_value='/usr/bin/systemctl'), \
                 patch.object(self.ns['os'], 'O_NOFOLLOW', 0, create=True):
                with self.assertRaises(self.ns['ActionError']) as error:
                    self.ns['start'](self.request)
                self.assertEqual(error.exception.code, 'JOB_BUSY')

    def test_failed_preparation_does_not_accept_or_launch_a_job_and_same_id_can_retry(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / self.request['id']
            original_save = self.ns['save']
            def interrupted_save(path, data):
                if path.endswith('/state.json'):
                    raise OSError('synthetic disk failure')
                original_save(path, data)
            def captured(*args, **kwargs):
                return types.SimpleNamespace(returncode=0, stdout=b'')
            with patch.dict(self.ns, BASE=root, secure_dir=lambda path: Path(path).mkdir(exist_ok=True), boot_id=lambda: 'boot', capture=captured), \
                 patch('shutil.which', return_value='/usr/bin/systemctl'), \
                 patch.object(self.ns['os'], 'O_NOFOLLOW', 0, create=True):
                with patch.dict(self.ns, save=interrupted_save), self.assertRaises(OSError):
                    self.ns['start'](self.request)
                self.assertFalse((target / 'request.json').exists(), 'A partial preparation must not be an accepted job')
                self.assertFalse((Path(root) / 'current.json').exists())
                result = self.ns['start'](self.request)
                self.assertEqual(result['state'], 'running')
                self.assertTrue((target / 'request.json').is_file())
                self.assertTrue((target / 'state.json').is_file())
                self.assertTrue((target / 'worker.py').is_file())

    def test_missing_collected_unit_finishes_an_orphaned_job_even_when_systemctl_returns_nonzero(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / self.request['id']
            target.mkdir()
            state = dict(id=self.request['id'], action='refreshApt', state='running', bootId='boot', createdAt=0, updatedAt=0, logs=[])
            (target / 'state.json').write_text(json.dumps(state), encoding='utf-8')
            with patch.dict(self.ns, BASE=root, boot_id=lambda: 'boot', capture=lambda *args, **kwargs: types.SimpleNamespace(returncode=1, stdout=b'LoadState=not-found\nActiveState=inactive\n')), \
                 patch.object(self.ns['os'], 'O_NOFOLLOW', 0, create=True):
                result = self.ns['poll'](self.request['id'])
            self.assertEqual(result['state'], 'interrupted')

    def test_history_trimming_preserves_unfinished_recovery_and_current_job_but_cleans_safe_workers(self):
        root = Path(self.ns['BASE'])
        folders = []
        for index in range(24):
            folder = root / format(index, '032x')
            folder.mkdir()
            (folder / 'state.json').write_text(json.dumps(dict(state='failed', action='applyConfig', logs=[])), encoding='utf-8')
            (folder / 'worker.py').write_text('recovery', encoding='utf-8')
            (folder / 'deployment.json').write_text(json.dumps(dict(phase='committed', guardService='xray.service')), encoding='utf-8')
            folders.append(folder)
        (folders[1] / 'deployment.json').write_text(json.dumps(dict(phase='installed', guardService='xray.service')), encoding='utf-8')
        guard = root / 'boot-guard'
        guard.touch()
        current = folders[0].name
        def guard_paths(identifier, service):
            return [str(guard)] if identifier == folders[2].name else []
        with patch.dict(self.ns, deploy_guard_paths=guard_paths), \
             patch('glob.glob', return_value=[str(folder / 'state.json') for folder in reversed(folders)]), \
             patch('os.path.getmtime', return_value=0):
            self.ns['trim_history'](current)
            self.assertTrue((folders[0] / 'worker.py').exists(), 'Keep the current worker even after commit')
            self.assertTrue((folders[1] / 'worker.py').exists(), 'Keep incomplete rollback code')
            self.assertTrue((folders[2] / 'worker.py').exists(), 'Keep code referenced by an installed boot guard')
            self.assertFalse((folders[3] / 'worker.py').exists(), 'Remove an old completed worker with no recovery guard')
            guard.unlink()
            self.ns['trim_history'](current)
            self.assertFalse((folders[2] / 'worker.py').exists())

    def test_corrupt_history_does_not_fail_a_started_action(self):
        def corrupt_record(*args, **kwargs):
            raise ValueError('synthetic corruption')
        for read in [corrupt_record, lambda *args, **kwargs: None, lambda *args, **kwargs: []]:
            with self.subTest(read=read), \
                 patch.dict(self.ns, load=read), \
                 patch('glob.glob', return_value=[str(Path(self.ns['BASE']) / ('b' * 32) / 'state.json')] * 21), \
                 patch('os.path.getmtime', return_value=0):
                self.ns['trim_history']('a' * 32)


if __name__ == '__main__':
    unittest.main()
