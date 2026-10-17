import type { Task } from './builders.js';
import { Random, equals, quote, write } from './random.js';

const authenticated = "grep -q 'Accepted publickey' .sshd/server.log";
const ssh = 'ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$SSH_KNOWN_HOSTS" -i "$SSH_KEY" -p "$SSH_PORT" "$SSH_USER@$SSH_HOST"';
const scp = 'scp -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$SSH_KNOWN_HOSTS" -i "$SSH_KEY" -P "$SSH_PORT"';

export const remoteBuilders: Record<string, (random: Random, service: string) => Task> = {
  ssh(random, service) {
    const version = `v${random.integer(1, 4)}.${random.integer(0, 15)}`;
    const receipt = `${service} checked ${random.integer(1000, 9999)}\n`;
    const code = random.integer(3, 9);
    return {
      title: '修复密钥权限并执行远程命令',
      brief: `专属 OpenSSH 服务已启动。connection.txt/connection.env 给出实际用户、端口、密钥和主机指纹文件；remote 是该练习服务的家目录。client_key 初始权限过宽，必须先修复。`,
      setup: ['mkdir -p remote', write('remote/release.txt', `${service} ${version}\n`)],
      fixture: { kind: 'ssh', marker: `ssh-${random.seed}`, clientKeyMode: 0o644 },
      goals: [
        { text: '把 client_key 权限改为 600，使用密钥与指定端口登录，将远端 release.txt 内容保存为本地 release-copy.txt；保留主机指纹校验。', check: `test "$(stat -c %a client_key)" = 600 && ${equals('release-copy.txt', `${service} ${version}\n`)} && ${authenticated}` },
        { text: `通过 SSH 在远端创建 checks/result.txt，内容为 ${receipt.trim()}（以换行结尾）。`, check: `${equals('remote/checks/result.txt', receipt)} && ${authenticated}` },
        { text: `让远端命令以 ${code} 退出，把本地 ssh 命令返回的退出码写入 remote-exit.txt，只包含数字与可选空白。`, check: `test -f remote-exit.txt && test "$(tr -d '[:space:]' < remote-exit.txt)" = ${code} && ${authenticated}` },
      ],
      solution: [
        'source connection.env', 'chmod 600 client_key',
        `${ssh} 'cat release.txt' > release-copy.txt`,
        `${ssh} ${quote(`mkdir -p checks; ${write('checks/result.txt', receipt)}`)}`,
        `if ${ssh} 'exit ${code}'; then code=0; else code=$?; fi`,
        'printf \'%s\\n\' "$code" > remote-exit.txt',
      ],
      hint: 'ssh 的端口选项是小写 -p，-i 指定私钥。私钥权限过宽时 OpenSSH 会拒绝使用。远端命令整体加引号；用 if 捕获预期的非零退出码，避免 set -e 提前结束脚本。',
    };
  },
  'ssh-config'(random, service) {
    const alias = `deploy-${service}-${random.integer(10, 99)}`;
    const release = `${service} build-${random.integer(100, 999)}\n`;
    return {
      title: '用 SSH 配置管理部署主机',
      brief: `为练习主机建立别名 ${alias}。实际连接信息在 connection.env 中，client_key 和 known_hosts 已准备好。把配置写入当前目录的 ssh_config，不修改个人 ~/.ssh/config。`,
      setup: ['mkdir -p remote', write('remote/release.txt', release)],
      fixture: { kind: 'ssh', marker: `ssh-config-${random.seed}`, alias },
      goals: [
        { text: `创建 ssh_config，配置 Host ${alias} 的地址、端口、用户、密钥和专属 known_hosts；保持 StrictHostKeyChecking yes，并能通过该别名登录。`, check: `test -f ssh_config && source connection.env && ssh -G -F ssh_config "$SSH_ALIAS" | grep -Eq '^stricthostkeychecking (true|yes)$' && ssh -F ssh_config -o BatchMode=yes -o ConnectTimeout=2 "$SSH_ALIAS" 'cat release.txt' > .alias-verified && ${equals('.alias-verified', release)}` },
        { text: `使用 ssh -F ssh_config ${alias} 执行远程命令，将远端 release.txt 保存到本地 host-release.txt。`, check: `${equals('host-release.txt', release)} && ${authenticated}` },
      ],
      solution: [
        'source connection.env',
        'cat > ssh_config <<EOF\nHost $SSH_ALIAS\n  HostName $SSH_HOST\n  Port $SSH_PORT\n  User $SSH_USER\n  IdentityFile "$SSH_KEY"\n  UserKnownHostsFile "$SSH_KNOWN_HOSTS"\n  StrictHostKeyChecking yes\n  IdentitiesOnly yes\n  BatchMode yes\n  ConnectTimeout 2\nEOF',
        'ssh -F ssh_config "$SSH_ALIAS" \'cat release.txt\' > host-release.txt',
      ],
      hint: 'Host 是别名，HostName 是实际地址。用 ssh -G -F ssh_config 别名查看最终配置，再用 ssh -F 发起真实连接。这里使用独立配置文件，不依赖个人主机配置。',
    };
  },
  scp(random, service) {
    const payload = `${service} package-${random.integer(10000, 99999)}\n`;
    const log = `${service} ${random.pick(['ERROR db_timeout', 'WARN retry_limit', 'INFO release_ready'])}\n`;
    return {
      title: '上传部署文件并下载排障日志',
      brief: '练习主机连接信息在 connection.env 中，client.conf 提供现成的 lab-target 别名。需要分别完成本地到远端和远端到本地的实际传输。',
      setup: ['mkdir -p remote/incoming remote/logs', write('local package.txt', payload), write('remote/logs/app.log', log)],
      fixture: { kind: 'ssh', marker: `scp-${random.seed}` },
      goals: [
        { text: '用 SCP 将本地 local package.txt 上传为远端 incoming/package.txt，内容完整且保留本地文件。', check: `${equals('remote/incoming/package.txt', payload)} && ${equals('local package.txt', payload)} && ${authenticated}` },
        { text: '用 SCP 将远端 logs/app.log 下载为本地 downloaded log.txt，保留远端原文件。', check: `${equals('downloaded log.txt', log)} && ${equals('remote/logs/app.log', log)} && ${authenticated}` },
      ],
      solution: ['source connection.env', `${scp} 'local package.txt' "$SSH_USER@$SSH_HOST:incoming/package.txt"`, 'scp -F client.conf lab-target:logs/app.log "downloaded log.txt"'],
      hint: 'scp 指定端口用大写 -P，ssh 用小写 -p。远端路径格式为 user@host:路径；在右侧表示上传目标，在左侧表示下载来源。给含空格的本地文件名加引号。',
    };
  },
  'scp-tree'(random, service) {
    const timestamp = 1750000000 + random.integer(100, 9000);
    const content = `${service} environment=${random.pick(['staging', 'production'])}\n`;
    const guide = `release guide ${random.integer(100, 999)}\n`;
    return {
      title: '递归传输目录并保留文件属性',
      brief: 'bundle 是待上传目录，远端 reports 是待下载目录。目录内有含空格的文件名和隐藏文件，需要完整传输并保留指定文件的权限、修改时间。使用 client.conf 中的 lab-target。',
      setup: ['mkdir -p bundle/docs remote/uploads remote/reports/nested', write('bundle/app.conf', content), write('bundle/docs/user guide.txt', guide), write('bundle/.release-id', `${random.integer(10000, 99999)}\n`), write('remote/reports/nested/error detail.txt', guide), write('remote/reports/report.conf', content), 'chmod 640 bundle/app.conf remote/reports/report.conf', `touch -d '@${timestamp}' bundle/app.conf remote/reports/report.conf`],
      fixture: { kind: 'ssh', marker: `scp-tree-${random.seed}` },
      goals: [
        { text: '递归上传 bundle 到远端 uploads/bundle，包含隐藏文件和带空格文件；app.conf 的权限、修改时间和内容保持不变。', check: `${equals('remote/uploads/bundle/app.conf', content)} && ${equals('remote/uploads/bundle/docs/user guide.txt', guide)} && cmp -s bundle/.release-id remote/uploads/bundle/.release-id && test "$(stat -c %a remote/uploads/bundle/app.conf)" = 640 && test "$(stat -c %Y remote/uploads/bundle/app.conf)" = ${timestamp} && ${authenticated}` },
        { text: '递归下载远端 reports 目录到本地 downloaded/reports，保留所有文件内容及 report.conf 的权限、修改时间。', check: `${equals('downloaded/reports/report.conf', content)} && ${equals('downloaded/reports/nested/error detail.txt', guide)} && test "$(stat -c %a downloaded/reports/report.conf)" = 640 && test "$(stat -c %Y downloaded/reports/report.conf)" = ${timestamp} && ${authenticated}` },
      ],
      solution: ['scp -F client.conf -rp bundle lab-target:uploads/', 'mkdir -p downloaded', 'scp -F client.conf -rp lab-target:reports downloaded/'],
      hint: 'scp -r 递归复制目录，小写 -p 保留时间和权限。目标目录是否已经存在会影响最终层级，完成后检查 uploads/bundle 和 downloaded/reports。',
    };
  },
  'remote-deploy'(random, service) {
    const version = `v${random.integer(1, 4)}.${random.integer(0, 9)}.${random.integer(1, 20)}`;
    const release = `${service} ${version}\n`;
    const ready = `${service} ${version} ready\n`;
    return {
      title: '通过 SSH/SCP 完成一次远程发布',
      brief: `build/release.tar.gz 已包含 ${version} 的应用产物和可执行健康检查脚本。将它发布到练习主机，并把远端检查日志取回本地。使用 client.conf 中的 lab-target。`,
      setup: ['mkdir -p build/package remote/incoming remote/releases remote/logs', write('build/package/version.txt', release), write('build/package/health.sh', `#!/bin/bash\nprintf '%s' ${quote(ready)}\n`), 'chmod 755 build/package/health.sh', 'tar -czf build/release.tar.gz -C build/package .'],
      fixture: { kind: 'ssh', marker: `remote-deploy-${random.seed}` },
      goals: [
        { text: '将 build/release.tar.gz 上传为远端 incoming/release.tar.gz，内容完整。', check: `cmp -s build/release.tar.gz remote/incoming/release.tar.gz && ${authenticated}` },
        { text: `通过远程命令解压到 releases/${version}，让远端 current 软链接指向该版本，并保留可执行的 health.sh。`, check: `test -L remote/current && test "$(readlink -f remote/current)" = "$(readlink -f remote/releases/${version})" && ${equals(`remote/releases/${version}/version.txt`, release)} && test -x remote/current/health.sh && ${authenticated}` },
        { text: '在远端运行 current/health.sh，将输出保存在远端 logs/deploy.log，再下载为本地 deployment-report.txt；两者应一致。', check: `${equals('remote/logs/deploy.log', ready)} && ${equals('deployment-report.txt', ready)} && ${authenticated}` },
      ],
      solution: ['scp -F client.conf build/release.tar.gz lab-target:incoming/release.tar.gz', `ssh -F client.conf lab-target ${quote(`set -e; mkdir -p releases/${version}; tar -xzf incoming/release.tar.gz -C releases/${version}; ln -sfn releases/${version} current; ./current/health.sh > logs/deploy.log`)}`, 'scp -F client.conf lab-target:logs/deploy.log deployment-report.txt'],
      hint: '先 SCP 上传，再 SSH 执行解压和版本切换，最后 SCP 下载日志。远端多条命令整体加引号，使用 set -e 在发布步骤失败时停止。',
    };
  },
};
