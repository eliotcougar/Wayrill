"""Transactional config tests. Real file operations; no host/server services."""
from pathlib import Path
import json
import os
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch


def load_deployment():
    root = Path(__file__).resolve().parents[1] / 'src-tauri/resources'
    source = (root / 'config_deploy.py').read_bytes() + b'\n' + (root / 'server_actions.py').read_bytes()
    namespace = {'__name__': 'test_deploy', 'SOURCE': source}
    with patch.dict(sys.modules, {'fcntl': types.SimpleNamespace(LOCK_EX=2, LOCK_NB=4, flock=lambda *args: None)}):
        exec(compile(source, '<deployment-tests>', 'exec'), namespace)
    return namespace


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.ns = load_deployment()
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        # deploy_target returns canonical paths, including on short-alias TEMP roots.
        self.base = Path(self.folder.name).resolve()
        self.target = self.base / 'config.json'
        self.original = b'{"outbounds":[{"protocol":"freedom"}]}\r\n'
        self.candidate = b'{"outbounds":[{"protocol":"blackhole"}]}'
        self.target.write_bytes(self.original)
        self.context = dict(path=str(self.target), target=str(self.target), fingerprint='context', service='xray.service')
        self.identifier = 'a' * 32
        self.plan_id = 'b' * 32
        self.directory = self.base / self.identifier
        self.directory.mkdir()
        self.plan_dir = self.base / 'config-plans' / self.plan_id
        self.plan_dir.mkdir(parents=True)
        (self.plan_dir / 'candidate.json').write_bytes(self.candidate)
        self.patch_globals = patch.dict(self.ns, BASE=str(self.base), boot_id=lambda: 'boot',
            deploy_sync=lambda *args: None, deploy_target=lambda *args: self.context,
            deploy_metadata=lambda *args: dict(uid=0, gid=0, mode=0o600, xattrs={}),
            deploy_test=lambda *args: (True, ['accepted'], '26.10.29'), deploy_restart=lambda *args: None,
            deploy_arm_boot_guard=lambda *args: None, deploy_disarm_boot_guard=lambda *args, **kwargs: None)
        self.patch_globals.start()
        self.addCleanup(self.patch_globals.stop)
        for name, value in [('O_NOFOLLOW', 0), ('fchown', lambda *args: None), ('fchmod', lambda *args: None)]:
            p = patch.object(os, name, value, create=True)
            p.start()
            self.addCleanup(p.stop)
        self.plan = dict(path=str(self.target), target=str(self.target), service='xray.service',
                         contextHash='context', bootId='boot', expiresAt=time.time() + 900,
                         sourceSha256=self.ns['deploy_digest'](self.original),
                         configSha256=self.ns['deploy_digest'](self.candidate),
                         sourceStamp=self.ns['deploy_read'](str(self.target))[1])
        self.write_plan()
        self.state = dict(id=self.identifier, action='applyConfig', state='running', logs=[], createdAt=int(time.time()), bootId='boot')
        self.request = dict(mode='start', id=self.identifier, action='applyConfig', planId=self.plan_id)

    def write_plan(self):
        (self.plan_dir / 'plan.json').write_text(json.dumps(self.plan), encoding='utf-8')

    def apply(self):
        def write():
            (self.directory / 'state.json').write_text(json.dumps(self.state), encoding='utf-8')
        self.ns['apply_config'](self.request, self.state, write)

    def test_success_keeps_exact_backup_and_commits_candidate(self):
        self.apply()
        self.assertEqual(self.target.read_bytes(), self.candidate)
        self.assertEqual((self.directory / 'config.backup').read_bytes(), self.original)
        journal = json.loads((self.directory / 'deployment.json').read_text(encoding='utf-8'))
        self.assertEqual(journal['phase'], 'committed')
        self.assertEqual(self.state['configResult']['rollback'], 'not-needed')
        with patch.dict(self.ns, deploy_restart=lambda *args: self.fail('Committed deployment must not be recovered')):
            self.ns['recover_config'](self.identifier)

    def test_failed_restart_restores_bytes_and_restarts_original(self):
        restarted = []
        def restart(service):
            restarted.append(self.target.read_bytes())
            if len(restarted) == 1:
                raise self.ns['ActionError']('CONFIG_RESTART', 'synthetic failure')
        with patch.dict(self.ns, deploy_restart=restart), self.assertRaises(self.ns['ActionError']) as error:
            self.apply()
        self.assertEqual(error.exception.code, 'CONFIG_RESTORED')
        self.assertEqual(restarted, [self.candidate, self.original])
        self.assertEqual(self.target.read_bytes(), self.original)
        self.assertEqual(self.state['configResult']['rollback'], 'succeeded')

    def test_unexpected_exception_also_restores_original(self):
        calls = []
        def restart(service):
            calls.append(service)
            if len(calls) == 1:
                raise RuntimeError('fixture')
        with patch.dict(self.ns, deploy_restart=restart), self.assertRaises(self.ns['ActionError']):
            self.apply()
        self.assertEqual(self.target.read_bytes(), self.original)

    def test_external_edit_after_install_is_not_overwritten_by_rollback(self):
        def restart(service):
            self.target.write_bytes(b'{"manual":true}')
            raise RuntimeError('fixture')
        with patch.dict(self.ns, deploy_restart=restart), self.assertRaises(self.ns['ActionError']) as error:
            self.apply()
        self.assertEqual(error.exception.code, 'CONFIG_ROLLBACK')
        self.assertEqual(self.target.read_bytes(), b'{"manual":true}')
        self.assertEqual((self.directory / 'config.backup').read_bytes(), self.original)

    def test_file_or_service_changes_expired_plans_and_reboot_block_apply(self):
        for change in ('file', 'service', 'expiry', 'boot'):
            with self.subTest(change=change):
                self.target.write_bytes(self.original)
                self.plan['sourceStamp'] = self.ns['deploy_read'](str(self.target))[1]
                self.plan.update(contextHash='context', bootId='boot', expiresAt=time.time() + 900)
                if change == 'file':
                    self.target.write_bytes(b'{}')
                elif change == 'service':
                    self.plan['contextHash'] = 'another'
                elif change == 'expiry':
                    self.plan['expiresAt'] = time.time() - 1
                else:
                    self.plan['bootId'] = 'previous-boot'
                self.write_plan()
                expected = self.target.read_bytes()
                with self.assertRaises(self.ns['ActionError']):
                    self.apply()
                self.assertEqual(self.target.read_bytes(), expected)
                self.assertFalse((self.directory / 'config.backup').exists())

    def test_revalidation_failure_does_not_backup_replace_or_restart(self):
        with patch.dict(self.ns, deploy_test=lambda *args: (False, ['invalid'], None),
                        deploy_restart=lambda *args: self.fail('Must not restart')), self.assertRaises(self.ns['ActionError']):
            self.apply()
        self.assertEqual(self.target.read_bytes(), self.original)
        self.assertFalse((self.directory / 'config.backup').exists())

    def test_external_edit_while_backing_up_is_preserved_without_restart(self):
        write = self.ns['deploy_write_private']
        def racing_write(path, data):
            write(path, data)
            self.target.write_bytes(b'{"manual":true}')
        with patch.dict(self.ns, deploy_write_private=racing_write, deploy_restart=lambda *args: self.fail('Must not restart')), self.assertRaises(self.ns['ActionError']):
            self.apply()
        self.assertEqual(self.target.read_bytes(), b'{"manual":true}')

    def test_recovery_after_worker_exit_restores_once(self):
        self.apply()
        journal_path = self.directory / 'deployment.json'
        journal = json.loads(journal_path.read_text(encoding='utf-8'))
        journal['phase'] = 'installed'
        journal_path.write_text(json.dumps(journal), encoding='utf-8')
        self.ns['recover_config'](self.identifier)
        self.assertEqual(self.target.read_bytes(), self.original)
        result = json.loads((self.directory / 'state.json').read_text(encoding='utf-8'))
        self.assertEqual(result['state'], 'failed')
        self.assertEqual(result['configResult']['rollback'], 'succeeded')
        with patch.dict(self.ns, deploy_restart=lambda *args: self.fail('Must not repeat recovery')):
            self.ns['recover_config'](self.identifier)

    def test_prepared_but_uninstalled_transaction_does_not_restart(self):
        self.apply()
        self.target.write_bytes(self.original)
        journal_path = self.directory / 'deployment.json'
        journal = json.loads(journal_path.read_text(encoding='utf-8'))
        journal['phase'] = 'prepared'
        journal_path.write_text(json.dumps(journal), encoding='utf-8')
        with patch.dict(self.ns, deploy_restart=lambda *args: self.fail('Untouched service must not restart')):
            self.ns['recover_config'](self.identifier)

    def test_validation_without_staging_leaves_no_plan_or_backup(self):
        request = dict(path=str(self.target), service='xray.service', configText=self.candidate.decode(),
                       expectedSha256=self.plan['sourceSha256'], stage=False)
        before = sorted(str(path.relative_to(self.base)) for path in self.base.rglob('*'))
        result = self.ns['validate_config'](request)
        self.assertTrue(result['valid'])
        self.assertIsNone(result['id'])
        self.assertEqual(before, sorted(str(path.relative_to(self.base)) for path in self.base.rglob('*')))
        self.assertEqual(self.target.read_bytes(), self.original)

    def test_validation_scrubs_credentials_and_caps_output(self):
        text = json.dumps({'id': 'fictional-id', 'password': 'fictional-password', 'privateKey': 'fictional-key'})
        result = self.ns['deploy_scrub']('fictional-id fictional-password fictional-key\n' + ('line\n' * 100), text)
        self.assertNotIn('fictional', '\n'.join(result))
        self.assertEqual(len(result), 40)

    def test_validation_scrubs_password_aliases_inline_keys_and_escaped_lists(self):
        values = {'pass': 'socks-pass', 'key': ['inline-key\nsecond-line'], 'shortIds': ['abcd1234'], 'decryption': 'fictional-private-mlkem'}
        diagnostic = json.dumps(values)
        result = '\n'.join(self.ns['deploy_scrub'](diagnostic, json.dumps(values)))
        for secret in ('socks-pass', 'inline-key', 'abcd1234', 'fictional-private-mlkem'):
            self.assertNotIn(secret, result)

    def test_corrupted_candidate_is_rejected_before_replacement(self):
        (self.plan_dir / 'candidate.json').write_bytes(b'corrupt')
        with self.assertRaises(self.ns['ActionError']) as error:
            self.apply()
        self.assertEqual(error.exception.code, 'CONFIG_PLAN')
        self.assertEqual(self.target.read_bytes(), self.original)

    def test_same_boot_start_guard_does_not_wait_for_the_apply_lock(self):
        self.apply()
        with patch.dict(self.ns, deploy_lock=lambda: self.fail('Normal restart must not reacquire the apply lock')):
            self.ns['recover_config'](self.identifier, before_start=True)

    def test_boot_guard_restores_file_without_starting_its_dependency(self):
        self.apply()
        journal_path = self.directory / 'deployment.json'
        journal = json.loads(journal_path.read_text(encoding='utf-8'))
        journal['phase'] = 'installed'
        journal_path.write_text(json.dumps(journal), encoding='utf-8')
        with patch.dict(self.ns, boot_id=lambda: 'next-boot', deploy_restart=lambda *args: self.fail('Boot guard must let systemd start Xray after it exits')):
            self.ns['recover_config'](self.identifier, before_start=True)
        self.assertEqual(self.target.read_bytes(), self.original)

    def test_crash_between_commit_marker_and_result_is_reported_as_success(self):
        self.apply()
        # The last progress checkpoint is still running; the durable commit
        # marker already records the successful health check.
        self.ns['recover_config'](self.identifier)
        result = json.loads((self.directory / 'state.json').read_text(encoding='utf-8'))
        self.assertEqual(result['state'], 'succeeded')
        self.assertEqual(self.target.read_bytes(), self.candidate)

    def test_recovery_reconstructs_receipt_if_worker_dies_before_progress_save(self):
        self.apply()
        journal_path = self.directory / 'deployment.json'
        journal = json.loads(journal_path.read_text(encoding='utf-8'))
        journal['phase'] = 'installed'
        journal_path.write_text(json.dumps(journal), encoding='utf-8')
        (self.directory / 'state.json').write_text(json.dumps(dict(self.state, configResult=None)), encoding='utf-8')
        self.ns['recover_config'](self.identifier)
        result = json.loads((self.directory / 'state.json').read_text(encoding='utf-8'))
        self.assertEqual(os.path.normpath(result['configResult']['backupPath']), os.path.normpath(str(self.directory / 'config.backup')))
        self.assertEqual(result['configResult']['rollback'], 'succeeded')

    def add_companion(self, existing=b'{"previous":"layout"}'):
        self.companion = self.target.with_name('config.wayrill.json')
        if existing is not None:
            self.companion.write_bytes(existing)
        data, stamp = self.ns['deploy_companion_read'](str(self.companion))
        self.companion_candidate = b'{"new":"layout"}'
        (self.plan_dir / 'candidate.wayrill.json').write_bytes(self.companion_candidate)
        self.plan.update(companionTarget=str(self.companion), companionSourceSha256=self.ns['deploy_optional_hash'](data),
                         companionSourceStamp=stamp, companionSha256=self.ns['deploy_digest'](self.companion_candidate))
        self.write_plan()
        return existing

    def test_success_installs_both_files_and_keeps_exact_backups(self):
        previous = self.add_companion()
        self.apply()
        self.assertEqual(self.companion.read_bytes(), self.companion_candidate)
        self.assertEqual((self.directory / 'wayrill.backup').read_bytes(), previous)
        self.assertEqual(self.state['configResult']['wayrillSha256'], self.plan['companionSha256'])

    def test_layout_only_save_keeps_config_inode_and_daemon(self):
        self.add_companion()
        self.plan['configSha256'] = self.plan['sourceSha256']
        (self.plan_dir / 'candidate.json').write_bytes(self.original)
        self.write_plan()
        inode = self.target.stat().st_ino
        with patch.dict(self.ns, deploy_restart=lambda *args: self.fail('Layout changes must not restart Xray')):
            self.apply()
        self.assertEqual(self.target.stat().st_ino, inode)
        self.assertEqual(self.target.read_bytes(), self.original)
        self.assertEqual(self.companion.read_bytes(), self.companion_candidate)

    def check_companion_rollback(self, previous):
        self.add_companion(previous)
        calls = []
        def restart(*args):
            calls.append(True)
            if len(calls) == 1:
                raise RuntimeError('failed restart')
        with patch.dict(self.ns, deploy_restart=restart), self.assertRaises(self.ns['ActionError']):
            self.apply()
        self.assertEqual(self.target.read_bytes(), self.original)
        self.assertEqual(self.companion.read_bytes() if self.companion.exists() else None, previous)

    def test_failed_restart_restores_existing_companion(self):
        self.check_companion_rollback(b'{"old":"layout"}')

    def test_failed_restart_removes_new_companion(self):
        self.check_companion_rollback(None)

    def test_companion_change_after_validation_is_preserved(self):
        self.add_companion()
        self.companion.write_bytes(b'{"external":true}')
        with self.assertRaises(self.ns['ActionError']) as error:
            self.apply()
        self.assertEqual(error.exception.code, 'CONFIG_CHANGED')
        self.assertEqual(self.target.read_bytes(), self.original)
        self.assertEqual(self.companion.read_bytes(), b'{"external":true}')

    def test_new_companion_appearing_after_validation_is_preserved(self):
        self.add_companion(None)
        self.companion.write_bytes(b'{"external":true}')
        with self.assertRaises(self.ns['ActionError']):
            self.apply()
        self.assertEqual(self.target.read_bytes(), self.original)
        self.assertEqual(self.companion.read_bytes(), b'{"external":true}')

    def test_crash_between_companion_and_xray_writes_restores_both(self):
        previous = self.add_companion()
        self.apply()
        # Simulate a kill after the first replace, before config.json or the
        # installed marker. Recovery must inspect bytes, not rely on the phase.
        self.target.write_bytes(self.original)
        journal_path = self.directory / 'deployment.json'
        journal = json.loads(journal_path.read_text(encoding='utf-8'))
        journal['phase'] = 'prepared'
        journal_path.write_text(json.dumps(journal), encoding='utf-8')
        with patch.dict(self.ns, deploy_restart=lambda *args: self.fail('The native config was never installed')):
            self.ns['recover_config'](self.identifier)
        self.assertEqual(self.target.read_bytes(), self.original)
        self.assertEqual(self.companion.read_bytes(), previous)

    def test_external_companion_edit_during_failed_apply_preserves_both_for_review(self):
        self.add_companion()
        def restart(*args):
            self.companion.write_bytes(b'{"external":true}')
            raise RuntimeError('failed restart')
        with patch.dict(self.ns, deploy_restart=restart), self.assertRaises(self.ns['ActionError']):
            self.apply()
        self.assertEqual(self.companion.read_bytes(), b'{"external":true}')
        self.assertEqual(self.target.read_bytes(), self.candidate)
        self.assertEqual((self.directory / 'config.backup').read_bytes(), self.original)

    def test_merged_and_implicit_service_configs_are_rejected(self):
        for args in (['xray', 'run'], ['xray', '-c', 'a', '-c', 'b'], ['xray', '-confdir', '/etc/xray'], ['xray', '-c', 'stdin:']):
            with self.assertRaises(self.ns['ActionError']):
                self.ns['deploy_args'](args, '/etc/xray')
        self.assertEqual(self.ns['deploy_args'](['xray', 'run', '-config=/etc/config.json'], '/'), os.path.realpath('/etc/config.json'))


if __name__ == '__main__':
    unittest.main()
