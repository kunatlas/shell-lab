import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const parent = fileURLToPath(new URL('../', import.meta.url));
const tools = resolve(parent, parent.endsWith('/build/') ? '../.tools/openssh' : '.tools/openssh');
export const sshClientDirectory = () => existsSync(`${tools}/usr/bin/ssh`) ? `${tools}/usr/bin:` : '';
const firstFile = (paths: (string | undefined)[]) => paths.find((path): path is string => Boolean(path && existsSync(path)));

export function sshToolEnvironment(): Record<string, string> {
  const sshd = firstFile([process.env.SHELL_LAB_SSHD, '/usr/sbin/sshd', '/usr/local/sbin/sshd', `${tools}/usr/sbin/sshd`]);
  const sftp = firstFile([process.env.SHELL_LAB_SFTP_SERVER, '/usr/lib/openssh/sftp-server', '/usr/libexec/openssh/sftp-server', '/usr/lib/ssh/sftp-server', `${tools}/usr/lib/openssh/sftp-server`]);
  const architecture = process.arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu';
  const libs = process.env.SHELL_LAB_SSH_LIB_DIR ?? `${tools}/usr/lib/${architecture}:${tools}/lib/${architecture}`;
  return {
    ...(sshd ? { SHELL_LAB_SSHD: sshd } : {}),
    ...(sftp ? { SHELL_LAB_SFTP_SERVER: sftp } : {}),
    ...(sshd?.startsWith(tools) || process.env.SHELL_LAB_SSH_LIB_DIR ? { LD_LIBRARY_PATH: libs } : {}),
  };
}
