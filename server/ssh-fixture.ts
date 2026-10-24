import type { FixtureSpec } from './exercises.js';

export function sshFixtureProgram(fixture: FixtureSpec): string {
  const options = JSON.stringify({ keyMode: fixture.clientKeyMode ?? 0o600, alias: fixture.alias ?? 'lab-target' });
  return `
import atexit, json, os, pathlib, pwd, shlex, shutil, signal, socket, subprocess, sys, time
options = json.loads(${JSON.stringify(options)})
root = pathlib.Path.cwd()
private = root / '.sshd'
private.mkdir(mode=0o700)
remote = root / 'remote'
remote.mkdir(exist_ok=True)
user = pwd.getpwuid(os.getuid()).pw_name
sshd = os.environ.get('SHELL_LAB_SSHD') or shutil.which('sshd')
sftp = os.environ.get('SHELL_LAB_SFTP_SERVER') or next((p for p in ['/usr/lib/openssh/sftp-server', '/usr/libexec/openssh/sftp-server', '/usr/lib/ssh/sftp-server'] if os.path.isfile(p)), None)
if not sshd or not sftp:
    raise RuntimeError('OpenSSH server or sftp-server is missing')
def config_quote(value):
    return '"' + str(value).replace('\\\\', '\\\\\\\\').replace('"', '\\\\"') + '"'
for key in [private / 'host_key', root / 'client_key']:
    subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key)], check=True, stdout=subprocess.DEVNULL)
os.chmod(root / 'client_key', options['keyMode'])
authorized = private / 'authorized_keys'
authorized.write_text((root / 'client_key.pub').read_text())
os.chmod(authorized, 0o600)
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
known = root / 'known_hosts'
known.write_text('[127.0.0.1]:' + str(port) + ' ' + (private / 'host_key.pub').read_text())
(remote / '.bashrc').write_text("export PS1='remote@shelllab> '\\n")
remote_path = str(pathlib.Path(shutil.which('scp') or '/usr/bin/scp').parent) + ':/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
wrapper = private / 'remote-shell'
wrapper.write_text('export HOME=' + shlex.quote(str(remote)) + '\\n'
    + 'export PATH=' + shlex.quote(remote_path) + '\\n'
    + 'cd -- "$HOME" || exit 1\\n'
    + 'case "$SSH_ORIGINAL_COMMAND" in\\n'
    + '  internal-sftp*) exec ' + shlex.quote(sftp) + ' -d "$HOME" ;;\\n'
    + '  "") exec /bin/bash --noprofile --rcfile "$HOME/.bashrc" -i ;;\\n'
    + '  *) exec /bin/bash --noprofile --norc -c "$SSH_ORIGINAL_COMMAND" ;;\\n'
    + 'esac\\n')
config = private / 'sshd_config'
config.write_text('\\n'.join([
    'ListenAddress 127.0.0.1', 'Port ' + str(port),
    'HostKey ' + config_quote(private / 'host_key'),
    'AuthorizedKeysFile ' + config_quote(authorized),
    'PidFile ' + config_quote(private / 'sshd.pid'),
    'AllowUsers ' + user, 'UsePAM no', 'StrictModes no',
    'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
    'PubkeyAuthentication yes', 'AuthenticationMethods publickey',
    'AllowAgentForwarding no', 'AllowTcpForwarding no', 'X11Forwarding no',
    'PermitUserEnvironment no', 'PermitUserRC no', 'PrintMotd no', 'PrintLastLog no',
    'SetEnv ' + config_quote('HOME=' + str(remote)) + ' LANG=C.UTF-8 LC_ALL=C.UTF-8',
    'Subsystem sftp internal-sftp',
    'ForceCommand /bin/bash ' + shlex.quote(str(wrapper)),
    'LogLevel VERBOSE', 'LoginGraceTime 15', 'MaxSessions 8',
]) + '\\n')
log = open(private / 'server.log', 'a')
child = subprocess.Popen([os.path.abspath(sshd), '-D', '-e', '-f', str(config)], stdout=log, stderr=log)
def cleanup(*_):
    if child.poll() is not None:
        log.close()
        return
    # Include authenticated SSH sessions, which may be in separate process groups.
    parents = {}
    for path in pathlib.Path('/proc').glob('[0-9]*/stat'):
        try:
            fields = path.read_text().rsplit(')', 1)[1].split()
            parents[int(path.parent.name)] = int(fields[1])
        except (OSError, ValueError, IndexError):
            pass
    owned = [child.pid]
    for _ in range(32):
        children = [pid for pid, parent in parents.items() if parent in owned and pid not in owned]
        if not children: break
        owned.extend(children)
    for pid in reversed(owned):
        try: os.kill(pid, signal.SIGKILL)
        except ProcessLookupError: pass
    try: child.wait(timeout=1)
    except subprocess.TimeoutExpired: pass
    log.close()
atexit.register(cleanup)
def terminate(*_):
    sys.exit(0)
signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGINT, terminate)
for attempt in range(100):
    if child.poll() is not None:
        raise RuntimeError('sshd exited: ' + (private / 'server.log').read_text())
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=.1): break
    except OSError:
        time.sleep(.02)
else:
    raise RuntimeError('sshd did not start')
values = {'SSH_HOST':'127.0.0.1', 'SSH_PORT':str(port), 'SSH_USER':user,
    'SSH_KEY':str(root / 'client_key'), 'SSH_KNOWN_HOSTS':str(known),
    'SSH_ALIAS':options['alias'], 'REMOTE_DIR':str(remote)}
(root / 'connection.env').write_text(''.join(k + '=' + shlex.quote(v) + '\\n' for k, v in values.items()))
(root / 'connection.txt').write_text(''.join(k + ': ' + v + '\\n' for k, v in values.items()))
(root / 'client.conf').write_text('\\n'.join([
    'Host lab-target', '  HostName 127.0.0.1', '  Port ' + str(port), '  User ' + user,
    '  IdentityFile ' + config_quote(root / 'client_key'),
    '  UserKnownHostsFile ' + config_quote(known),
    '  StrictHostKeyChecking yes', '  IdentitiesOnly yes', '  BatchMode yes', '  ConnectTimeout 2',
]) + '\\n')
(root / 'server.pid').write_text(str(child.pid) + '\\n')
(root / 'ssh-ready').write_text('ready\\n')
child.wait()
`;
}
