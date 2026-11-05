"""Full-upgrade preview and APT transaction verification. Combined with server_actions.py."""
import hashlib
import uuid


def upgrade_fingerprint(plan):
    changes = {key: plan[key] for key in ('installs', 'upgrades', 'removals')}
    return hashlib.sha256(json.dumps(changes, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def installed_packages():
    result = capture(['dpkg-query', '-W', '-f=${binary:Package}\t${Architecture}\t${Version}\t${db:Status-Status}\n'], timeout=18)
    if result.returncode or len(result.stdout) > 4 * 1024 * 1024:
        raise ActionError('APT_PLAN', 'The installed package inventory could not be read.')
    packages = {}
    for line in result.stdout.decode('utf-8', 'strict').splitlines():
        fields = line.split('\t')
        if len(fields) != 4:
            raise ActionError('APT_PLAN', 'The installed package inventory was not recognized.')
        name, architecture, version, status = fields
        if status not in ('installed', 'config-files', 'not-installed'):
            raise ActionError('APT_PLAN', 'Some packages are not fully configured. Resolve their state before a full upgrade.')
        if status == 'installed':
            packages[(name.split(':', 1)[0], architecture)] = version
    return packages


def parse_upgrade_plan(output, installed, native_arch):
    summary = re.search(r'^(\d+) upgraded, (\d+) newly installed, (\d+) to remove and (\d+) not upgraded\.$', output, re.M)
    if not summary:
        raise ActionError('APT_PLAN', 'APT returned an unsupported full-upgrade plan. No packages were changed.')
    result = dict(installs=[], upgrades=[], removals=[], heldBack=int(summary[4]))
    seen, configured = set(), set()
    def identity(value, architecture=None):
        parts = value.split(':', 1)
        name = parts[0]
        arch = parts[1] if len(parts) == 2 else architecture
        if arch is None:
            arch = native_arch if (name, native_arch) in installed else 'all'
        if not re.fullmatch(r'[a-z0-9][a-z0-9+.-]{0,127}', name) or not re.fullmatch(r'[a-z0-9-]{1,32}', arch):
            raise ActionError('APT_PLAN', 'APT returned an invalid package identifier.')
        return name, arch
    for line in output.splitlines():
        if line.startswith('Inst '):
            match = re.fullmatch(r'Inst (\S+)(?: \[([^\]]+)\])? \((\S+)(?: (.*))?\)(?: \[[^\]]*\])*', line)
            arch = re.search(r'\[([a-z0-9-]+)\]$', match[4] or '') if match else None
            if not match or not arch:
                raise ActionError('APT_PLAN', 'APT returned an unrecognized installation entry.')
            key = identity(match[1], arch[1])
            old, new = match[2], match[3]
            if installed.get(key) != old:
                raise ActionError('PLAN_CHANGED', 'Installed packages changed during preview. Request a new preview.')
            kind = 'upgrades' if old is not None else 'installs'
        elif line.startswith('Remv '):
            match = re.fullmatch(r'Remv (\S+) \[([^\]]+)\](?: \[[^\]]*\])*', line)
            if not match:
                raise ActionError('APT_PLAN', 'APT returned an unrecognized removal entry.')
            key = identity(match[1])
            old, new, kind = match[2], None, 'removals'
            if installed.get(key) != old:
                raise ActionError('PLAN_CHANGED', 'Installed packages changed during preview. Request a new preview.')
        elif line.startswith('Conf '):
            configured.add(line.split()[1].split(':', 1)[0])
            continue
        else:
            continue
        if key in seen:
            raise ActionError('APT_PLAN', 'APT returned duplicate package changes.')
        seen.add(key)
        result[kind].append(dict(name=key[0], architecture=key[1], installedVersion=old, candidateVersion=new))
    if [len(result[k]) for k in ('upgrades', 'installs', 'removals')] != [int(summary[i]) for i in (1, 2, 3)] or len(seen) > 4096:
        raise ActionError('APT_PLAN', 'APT returned inconsistent package counts or too many changes.')
    if configured - {p['name'] for kind in ('installs', 'upgrades') for p in result[kind]}:
        raise ActionError('APT_PLAN', 'APT proposes additional package configuration. Resolve pending package state first.')
    for kind in ('installs', 'upgrades', 'removals'):
        result[kind].sort(key=lambda p: (p['name'], p['architecture']))
    return result


def simulate_upgrade():
    if not shutil.which('apt-get'):
        raise ActionError('APT_PLAN', 'APT is not installed on this server.')
    installed = installed_packages()
    architecture = capture(['dpkg', '--print-architecture']).stdout.decode().strip()
    result = capture(['apt-get', '--simulate', '-o', 'Debug::NoLocking=true',
                      '-o', 'Dir::Cache::pkgcache=', '-o', 'Dir::Cache::srcpkgcache=',
                      '-o', 'APT::Color=0', 'dist-upgrade'], timeout=25)
    if result.returncode or len(result.stdout) > 2 * 1024 * 1024:
        raise ActionError('APT_PLAN', 'APT could not calculate the full-upgrade plan. No packages were changed.')
    return parse_upgrade_plan(result.stdout.decode('utf-8', 'strict'), installed, architecture)


def preview_upgrade():
    plan = simulate_upgrade()
    secure_dir(BASE)
    secure_dir(BASE + '/plans')
    now = int(time.time())
    plan.update(version=1, id=uuid.uuid4().hex, createdAt=now, expiresAt=now + 900,
                bootId=boot_id(), hostname=os.uname().nodename)
    plan['fingerprint'] = upgrade_fingerprint(plan)
    save(BASE + '/plans/' + plan['id'] + '.json', plan)
    for path in glob.glob(BASE + '/plans/*.json'):
        if re.fullmatch(r'[a-f0-9]{32}\.json', os.path.basename(path)) and os.lstat(path).st_mtime < now - 86400:
            os.unlink(path)
    return plan


def approved_upgrade(identifier):
    try:
        plan = load(BASE + '/plans/' + identifier + '.json', limit=2 * 1024 * 1024)
    except FileNotFoundError:
        raise ActionError('PLAN_EXPIRED', 'The full-upgrade preview is no longer available. Preview it again.')
    if plan['expiresAt'] < time.time() or plan['bootId'] != boot_id():
        raise ActionError('PLAN_EXPIRED', 'The full-upgrade preview expired or the server rebooted. Preview it again.')
    if plan['fingerprint'] != upgrade_fingerprint(simulate_upgrade()):
        raise ActionError('PLAN_CHANGED', 'The proposed package changes have changed. Preview the full upgrade again. No packages were changed.')
    return plan


def verify_upgrade_transaction(text, approved):
    lines = text.splitlines()
    if not lines or lines.pop(0) != 'VERSION 3' or '' not in lines:
        raise ActionError('APT_PROTOCOL', 'APT did not provide the required transaction-verification protocol.')
    lines = lines[lines.index('') + 1:]
    actual = dict(installs=[], upgrades=[], removals=[])
    permitted = {(p['name'], p['architecture']): p for kind in ('installs', 'upgrades') for p in approved[kind]}
    seen = set()
    for line in lines:
        if not line:
            continue
        fields = line.split()
        if len(fields) != 9:
            raise ActionError('APT_PROTOCOL', 'APT returned an unrecognized package transaction.')
        name, old, old_arch, _, direction, new, new_arch, _, action = fields
        key = (name, old_arch if action == '**REMOVE**' else new_arch)
        if old != '-' and old_arch != key[1]:
            raise ActionError('PLAN_CHANGED', 'APT proposes an unreviewed architecture change.')
        if action == '**REMOVE**' and new != '-':
            raise ActionError('PLAN_CHANGED', 'APT proposes an unsupported removal/replacement.')
        if action == '**CONFIGURE**':
            if key not in permitted or permitted[key]['candidateVersion'] != new:
                raise ActionError('PLAN_CHANGED', 'APT proposes an unreviewed package configuration.')
            continue
        if key in seen or direction not in ('<', '>'):
            raise ActionError('PLAN_CHANGED', 'APT proposes a duplicate, reinstall or unsupported package change.')
        seen.add(key)
        kind = 'removals' if action == '**REMOVE**' else 'installs' if old == '-' else 'upgrades'
        if kind != 'removals' and (not action.startswith('/') or direction != '<'):
            raise ActionError('PLAN_CHANGED', 'APT proposes an unsupported or downgraded package.')
        actual[kind].append(dict(name=name, architecture=key[1], installedVersion=None if old == '-' else old,
                                 candidateVersion=None if kind == 'removals' else new))
    for kind in actual:
        actual[kind].sort(key=lambda p: (p['name'], p['architecture']))
    if upgrade_fingerprint(actual) != upgrade_fingerprint(approved):
        raise ActionError('PLAN_CHANGED', 'APT’s actual transaction differs from the reviewed preview.')


def upgrade_hook(directory):
    try:
        approved = load(directory + '/approved.json', limit=2 * 1024 * 1024)
        text = sys.stdin.read(2 * 1024 * 1024 + 1)
        if len(text) > 2 * 1024 * 1024:
            raise ActionError('APT_PROTOCOL', 'APT transaction data exceeded its limit.')
        verify_upgrade_transaction(text, approved)
    except Exception:
        save(directory + '/plan-rejected.json', {'code': 'PLAN_CHANGED'})
        print('Wayrill: the APT transaction changed or could not be verified. Preview the full upgrade again.', file=sys.stderr)
        return 1
    save(directory + '/plan-verified.json', {'verified': True})
    return 0
