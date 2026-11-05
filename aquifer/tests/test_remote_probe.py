"""Exercise Linux discovery without server access or a Python 3.9-only str API."""
import contextlib
import io
import json
from pathlib import Path
import posixpath
import types
import unittest
from unittest.mock import mock_open, patch

PROBE = Path(__file__).resolve().parents[1] / 'src-tauri/resources/remote_probe.py'


class LegacyString(str):
    def removesuffix(self, unused):
        raise AttributeError('Python before 3.9 has no removesuffix')


class ProbeTests(unittest.TestCase):
    def run_probe(self, processes, scanned=()):
        output = io.StringIO()
        def readlink(path):
            return LegacyString('/usr/local/bin/xray (deleted)') if path.endswith('/exe') else '/srv/xray'
        def file_info(path):
            if path != '/srv/xray/конфиг.json' and path not in scanned:
                raise FileNotFoundError(path)
            return types.SimpleNamespace(st_mode=0o100644, st_size=123, st_mtime=100)
        source = PROBE.read_bytes()
        with contextlib.redirect_stdout(output), \
             patch('glob.glob', side_effect=lambda pattern: ['/proc/42/exe'] if processes and pattern == '/proc/[0-9]*/exe' else list(scanned) if pattern == '/usr/local/etc/xray/*.json' else []), \
             patch('os.readlink', side_effect=readlink), \
             patch('os.path', posixpath), \
             patch('os.stat', side_effect=file_info), \
             patch('os.access', return_value=True), \
             patch('os.uname', create=True, return_value=types.SimpleNamespace(nodename='test-server')), \
             patch('builtins.open', side_effect=lambda path, *a, **kw:
                   mock_open(read_data='0::/system.slice/xray.service\n')() if path.endswith('/cgroup')
                   else mock_open(read_data='xray\0run\0-config\0конфиг.json\0'.encode('utf-8'))()):
            exec(compile(source, str(PROBE), 'exec'), {'__name__': '__main__'})
        lines = output.getvalue().splitlines()
        self.assertEqual(lines[0], 'WAYRILL_REMOTE_DISCOVERY_V1_BEGIN')
        self.assertEqual(lines[-1], 'WAYRILL_REMOTE_DISCOVERY_V1_END')
        return json.loads(lines[1])

    def test_deleted_executable_and_unicode_config_work_without_python39_api(self):
        result = self.run_probe(True)
        self.assertEqual(result['processes'][0]['executable'], '/usr/local/bin/xray')
        self.assertEqual(result['files'][0]['path'], '/srv/xray/конфиг.json')
        self.assertTrue(result['files'][0]['running'])
        self.assertEqual(result['files'][0]['services'], ['xray.service'])

    def test_no_accessible_process_still_returns_a_complete_frame(self):
        result = self.run_probe(False)
        self.assertEqual(result['processes'], [])
        self.assertEqual(result['files'], [])
        self.assertTrue(result['warnings'])

    def test_multiple_config_companions_are_not_listed_as_xray_configs(self):
        directory = '/usr/local/etc/xray/'
        names = ('config.json', 'config.wayrill.json', 'xray-vnc.json', 'xray-vnc.wayrill.json')
        result = self.run_probe(False, [directory + name for name in names])
        self.assertEqual([item['path'] for item in result['files']],
                         [directory + 'config.json', directory + 'xray-vnc.json'])
