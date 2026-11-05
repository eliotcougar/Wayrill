"""Offline Linux status-probe cases; no remote commands or Windows settings."""
from pathlib import Path
import subprocess
import types
import unittest
from unittest.mock import patch


def load_probe():
    path = Path(__file__).resolve().parents[1] / 'src-tauri/resources/server_status.py'
    namespace = {'__name__': 'test_probe'}
    with patch.dict('sys.modules', {'pwd': types.SimpleNamespace(getpwuid=lambda uid: types.SimpleNamespace(pw_name='tester'))}):
        exec(compile(path.read_bytes(), str(path), 'exec'), namespace)
    return types.SimpleNamespace(**namespace)


class StatusTests(unittest.TestCase):
    def setUp(self):
        self.probe = load_probe()

    def test_apt_versions_multiarch_and_kept_back(self):
        result = self.probe.parse_apt('Inst curl [7.1] (7.2 Debian:stable [amd64])\n'
                                     'Inst libx:amd64 [1:2.0] (1:2.1 Debian:stable-security [amd64]) []\n'
                                     '2 upgraded, 0 newly installed, 0 to remove and 3 not upgraded.\n')
        self.assertEqual(result['upgraded'], 2)
        self.assertEqual(result['heldBack'], 3)
        self.assertEqual(result['packages'][1]['installedVersion'], '1:2.0')
        self.assertEqual(result['packages'][1]['candidateVersion'], '1:2.1')

    def test_bad_apt_results_are_not_reported_as_no_updates(self):
        for output in ['Permission denied', '', 'Inst foo [1] (2 repo)\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.',
                       '1 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.',
                       '0 upgraded, 1 newly installed, 0 to remove and 0 not upgraded.']:
            with self.assertRaises(ValueError):
                self.probe.parse_apt(output)

    def test_empty_upgrade_plan_is_valid(self):
        result = self.probe.parse_apt('0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n')
        self.assertEqual(result['packages'], [])
        self.assertEqual(result['upgraded'], 0)

    def test_simulation_has_no_locks_downloads_or_cache_writes(self):
        completed = types.SimpleNamespace(returncode=0, stdout=b'0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n', stderr=b'')
        with patch('shutil.which', return_value='/usr/bin/apt-get'), patch('glob.glob', return_value=[]), \
             patch('subprocess.run', return_value=completed) as run:
            status = self.probe.apt_status()
        args = run.call_args.args[0]
        self.assertIn('--simulate', args)
        self.assertNotIn('--no-download', args)
        self.assertIn('Debug::NoLocking=true', args)
        self.assertIn('Dir::Cache::pkgcache=', args)
        self.assertNotIn('update', args)
        self.assertEqual(run.call_args.kwargs['env']['LC_ALL'], 'C')
        self.assertEqual(run.call_args.kwargs['stdin'], subprocess.DEVNULL)
        self.assertEqual(status['upgraded'], 0)

    def test_apt_not_installed_is_explicit(self):
        with patch('shutil.which', return_value=None), patch('subprocess.run') as run:
            status = self.probe.apt_status()
        self.assertFalse(status['available'])
        self.assertIsNone(status['upgraded'])
        self.assertTrue(status['error'])
        run.assert_not_called()

    def test_apt_failure_is_not_empty_success(self):
        with patch('shutil.which', return_value='/usr/bin/apt-get'), patch('glob.glob', return_value=[]), \
             patch('subprocess.run', return_value=types.SimpleNamespace(returncode=100, stdout=b'', stderr=b'private error')):
            status = self.probe.apt_status()
        self.assertIsNone(status['upgraded'])
        self.assertIn('exit 100', status['error'])
        self.assertNotIn('private error', status['error'])

    def test_missing_or_unreadable_reboot_marker(self):
        for error, expected in [(FileNotFoundError(), False), (PermissionError(), None)]:
            with patch('os.stat', side_effect=error):
                result = self.probe.reboot_status()
            self.assertIs(result['required'], expected)

    def test_reboot_packages_are_deduplicated(self):
        with patch('os.stat'), patch.dict(self.probe.reboot_status.__globals__, {'read_text': lambda path: 'linux-image\nlibc6\nlinux-image\n'}):
            result = self.probe.reboot_status()
        self.assertTrue(result['required'])
        self.assertEqual(result['packages'], ['libc6', 'linux-image'])

    def test_custom_xray_unit_survives_missing_default_unit(self):
        data = ('Id=xray.service\nLoadState=not-found\nActiveState=inactive\n\n'
                'Id=custom-xray.service\nLoadState=loaded\nActiveState=active\nSubState=running\nMainPID=42\nNeedDaemonReload=yes\n')
        calls = []
        def command(args, timeout=8):
            calls.append(args)
            return ('Xray 26.10.17 (Xray)' if 'version' in args else data), 'One unit is missing.'
        with patch('glob.glob', return_value=['/proc/42/exe']), \
             patch('os.readlink', return_value='/usr/bin/xray (deleted)'), \
             patch('shutil.which', return_value='/usr/bin/systemctl'), \
             patch.dict(self.probe.xray_status.__globals__, {'command': command, 'read_text': lambda path: '0::/user.slice/user@1000.service/custom-xray.service\n'}):
            status = self.probe.xray_status()
        self.assertEqual(status['services'][0]['name'], 'custom-xray.service')
        self.assertEqual(status['services'][0]['mainPid'], 42)
        self.assertTrue(status['processes'][0]['replacedExecutable'])
        self.assertNotIn('user@1000.service', calls[-1])
        self.assertEqual(status['installedVersion'], '26.10.17')

    def test_command_timeout_is_bounded(self):
        with patch('subprocess.run', side_effect=subprocess.TimeoutExpired('apt-get', 18)):
            output, error = self.probe.command(['apt-get', '--simulate', 'upgrade'])
        self.assertIsNone(output)
        self.assertIn('timed out', error)
