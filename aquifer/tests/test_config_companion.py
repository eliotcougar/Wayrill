import contextlib
import io
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = (Path(__file__).resolve().parents[1] / 'src-tauri/resources/config_companion.py').read_text(encoding='utf-8')


class CompanionReadTests(unittest.TestCase):
    def probe(self, path):
        output = io.StringIO()
        with patch.object(os, 'O_NOFOLLOW', getattr(os, 'O_NOFOLLOW', 0), create=True), contextlib.redirect_stdout(output):
            exec(compile(SOURCE, '<read-companion>', 'exec'), {'PATH': str(path)})
        return json.loads(output.getvalue().split('WAYRILL_REMOTE_COMPANION_V1_BEGIN')[1].split('WAYRILL_REMOTE_COMPANION_V1_END')[0])

    def test_config_names_and_directories_have_independent_companions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ('server-a', 'server-b'):
                directory = root / name
                directory.mkdir()
                for config in ('config', 'xray-vnc'):
                    target = directory / (config + '.json')
                    target.write_text('{}', encoding='utf-8')
                    companion = directory / (config + '.wayrill.json')
                    companion.write_text(json.dumps({'server': name, 'config': config}), encoding='utf-8')
                    result = self.probe(target)
                    self.assertEqual(Path(result['path']), companion)
                    self.assertEqual(result['sha256'], hashlib.sha256(companion.read_bytes()).hexdigest())
                    self.assertNotIn('error', result)

    def test_missing_companion_is_normal_and_changes_no_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / 'config.json'
            target.write_text('{}', encoding='utf-8')
            result = self.probe(target)
            self.assertIsNone(result['sha256'])
            self.assertNotIn('error', result)
            self.assertEqual(list(root.iterdir()), [target])

    def test_unreadable_companion_is_distinct_from_missing(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / 'config.json'
            target.write_text('{}', encoding='utf-8')
            (Path(temporary) / 'config.wayrill.json').mkdir()
            result = self.probe(target)
            self.assertIsNone(result['sha256'])
            self.assertIn('error', result)
