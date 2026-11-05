"""Offline full-upgrade preview/transaction equivalence tests."""
from pathlib import Path
import types
import tempfile
import unittest
from unittest.mock import patch
from test_server_actions import load_actions


class UpgradeTests(unittest.TestCase):
    def setUp(self):
        self.ns = load_actions()
        path = Path(__file__).resolve().parents[1] / 'src-tauri/resources/apt_upgrade.py'
        exec(compile(path.read_bytes(), str(path), 'exec'), self.ns)
        self.installed = {('curl', 'amd64'): '1.0', ('legacy', 'amd64'): '0.5'}
        self.output = ('Remv legacy [0.5]\nInst new-lib (3.0 Debian:stable [amd64])\n'
                       'Inst curl [1.0] (2.0 Debian:stable [amd64]) []\nConf new-lib (3.0 Debian:stable [amd64])\n'
                       'Conf curl (2.0 Debian:stable [amd64])\n1 upgraded, 1 newly installed, 1 to remove and 2 not upgraded.\n')
        self.plan = self.ns['parse_upgrade_plan'](self.output, self.installed, 'amd64')
        self.protocol = ('VERSION 3\nAPT::Architecture=amd64\n\n'
                         'legacy 0.5 amd64 none > - - none **REMOVE**\n'
                         'new-lib - - none < 3.0 amd64 none /cache/new-lib.deb\n'
                         'curl 1.0 amd64 none < 2.0 amd64 none /cache/curl.deb\n'
                         'new-lib - - none < 3.0 amd64 none **CONFIGURE**\n'
                         'curl 1.0 amd64 none < 2.0 amd64 none **CONFIGURE**\n')

    def test_preview_classifies_versions_and_removals(self):
        self.assertEqual(self.plan['installs'][0]['name'], 'new-lib')
        self.assertEqual(self.plan['upgrades'][0]['installedVersion'], '1.0')
        self.assertEqual(self.plan['removals'][0]['candidateVersion'], None)
        self.assertEqual(self.plan['heldBack'], 2)

    def test_preview_rejects_missing_inconsistent_and_pending_changes(self):
        for output in ['', self.output.replace('1 upgraded', '2 upgraded'),
                       self.output + 'Conf unexpected (1.0 Debian [amd64])\n',
                       self.output.replace('Remv legacy [0.5]', 'Remv legacy [0.6]')]:
            with self.assertRaises(self.ns['ActionError']):
                self.ns['parse_upgrade_plan'](output, self.installed, 'amd64')

    def test_native_all_and_foreign_architectures_remain_distinct(self):
        result = self.ns['parse_upgrade_plan']('Inst pkg:arm64 [1] (2 repo [arm64])\nInst shared [1] (2 repo [all])\n2 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.',
                                              {('pkg', 'arm64'):'1', ('shared', 'all'):'1'}, 'amd64')
        self.assertEqual([p['architecture'] for p in result['upgrades']], ['arm64', 'all'])

    def test_apt_protocol_matches_reviewed_transaction(self):
        self.ns['verify_upgrade_transaction'](self.protocol, self.plan)

    def test_hook_blocks_extra_removals_versions_architectures_and_configures(self):
        for text in [self.protocol.replace('2.0 amd64', '2.1 amd64'),
                     self.protocol.replace('curl 1.0 amd64', 'curl 1.0 arm64'),
                     self.protocol + 'extra 9 amd64 none > - - none **REMOVE**\n',
                     self.protocol + 'extra 1 amd64 none = 1 amd64 none **CONFIGURE**\n',
                     self.protocol.replace('VERSION 3', 'VERSION 2'),
                     self.protocol.replace('/cache/curl.deb', '**ERROR**')]:
            with self.subTest(text=text), self.assertRaises(self.ns['ActionError']):
                self.ns['verify_upgrade_transaction'](text, self.plan)

    def test_expired_or_rebooted_preview_requires_new_confirmation(self):
        saved = dict(self.plan, expiresAt=10, bootId='before')
        with patch.dict(self.ns, load=lambda *args, **kwargs: saved, boot_id=lambda:'after'):
            with self.assertRaises(self.ns['ActionError']) as caught:
                self.ns['approved_upgrade']('a'*32)
        self.assertEqual(caught.exception.code, 'PLAN_EXPIRED')

    def test_changed_simulation_is_rejected_before_apt_starts(self):
        saved = dict(self.plan, expiresAt=10**12, bootId='same', fingerprint='wrong')
        with patch.dict(self.ns, load=lambda *args, **kwargs: saved, boot_id=lambda:'same', simulate_upgrade=lambda:self.plan):
            with self.assertRaises(self.ns['ActionError']) as caught:
                self.ns['approved_upgrade']('a'*32)
        self.assertEqual(caught.exception.code, 'PLAN_CHANGED')

    def test_preview_simulation_has_no_package_mutation(self):
        seen=[]
        def capture(args, timeout=15):
            seen.append(args)
            return types.SimpleNamespace(returncode=0, stdout=b'amd64' if args[0]=='dpkg' else self.output.encode())
        with patch.dict(self.ns, capture=capture, installed_packages=lambda:self.installed), patch('shutil.which',return_value='/usr/bin/apt-get'):
            self.ns['simulate_upgrade']()
        args=seen[-1]
        self.assertIn('--simulate', args)
        self.assertIn('dist-upgrade', args)
        self.assertNotIn('--assume-yes', args)

    def test_dist_upgrade_cannot_start_without_a_preview_id(self):
        for plan_id in [None, '../etc', 'missing']:
            with self.assertRaises(self.ns['ActionError']):
                self.ns['validate']({'mode':'start','action':'distUpgrade','id':'a'*32,'planId':plan_id})

    def test_worker_can_build_its_hook_without_an_ssh_source_global(self):
        with tempfile.TemporaryDirectory() as root:
            directory=Path(root)/('a'*32)
            directory.mkdir()
            script=directory/'worker.py'
            script.write_text('worker source sentinel')
            def capture_popen(*args, **kwargs):
                raise RuntimeError('APT launch captured')
            with patch.dict(self.ns, BASE=root, __file__=str(script), save=lambda *args:None,
                            approved_upgrade=lambda identifier:self.plan), \
                 patch('shutil.which', return_value='/usr/bin/apt-get'), \
                 patch.object(self.ns['os'],'O_NOFOLLOW',0,create=True), \
                 patch('subprocess.Popen',side_effect=capture_popen) as popen:
                self.ns.pop('SOURCE',None)
                with self.assertRaisesRegex(RuntimeError,'APT launch captured'):
                    self.ns['run_apt']({'action':'distUpgrade','id':'a'*32,'planId':'b'*32}, {'logs':[]}, lambda:None)
            self.assertIn(b'worker source sentinel',(directory/'verify-plan').read_bytes())
            args=popen.call_args.args[0]
            self.assertIn('dist-upgrade',args)
            self.assertNotIn('--no-remove',args)
            self.assertTrue(any('Pre-Install-Pkgs' in arg for arg in args))


if __name__ == '__main__':
    unittest.main()
