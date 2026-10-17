import type { Builder } from './builders.js';
import { equals, quote, write } from './random.js';

const pythonCheck = (program: string) => `python3 -c ${quote(program)}`;
const scriptSolution = (path: string, body: string) => [write(path, `#!/bin/bash\n${body}\n`), `chmod +x ${quote(path)}`];

export const operationsBuilders: Record<string, Builder> = {
  network(random, service) {
    const host = `${service}.test`;
    const route = random.pick(['/ready', '/health', '/api/status']);
    const requestId = `diag-${random.integer(10000, 99999)}`;
    const payload = { service, status: 'ok', revision: random.integer(100, 999) };
    return {
      title: '排查域名映射与 HTTP 响应',
      brief: `练习服务只监听本地回环网络，端口在 port.txt。它只对 Host 为 ${host} 的 ${route} 请求返回 200，直接使用 IP 请求会得到 404。该 .test 域名无需外部 DNS；请只为本次 curl 请求设置到 127.0.0.1 的映射，不修改系统 hosts。`,
      setup: [write('server-data.json', JSON.stringify({ route, payload, host, requestId }))],
      fixture: { kind: 'http', marker: `shell-lab-network-${random.seed}` },
      goals: [
        { text: `请求 http://${host}:端口${route}，把成功响应的 JSON 正文保存到 body.json。`, check: pythonCheck(`import json\nassert json.load(open('body.json')) == ${JSON.stringify(payload)}\nport = open('port.txt').read().strip()\nassert any(r['host'] == '${host}:' + port and r['path'] == '${route}' for r in map(json.loads, open('requests.jsonl')))` ) },
        { text: `将同一次成功请求的响应头单独保存为 headers.txt，包含状态码 200、X-Service: ${service} 和 X-Request-Id: ${requestId}。`, check: pythonCheck(`import re\ntext = open('headers.txt').read()\nassert re.search(r'^HTTP/\\S+ 200(?: |$)', text, re.M)\nassert re.search(r'^X-Service:\\s*${service}\\s*$', text, re.M | re.I)\nassert re.search(r'^X-Request-Id:\\s*${requestId}\\s*$', text, re.M | re.I)\nassert '${route}' in open('requests.log').read().splitlines()`) },
      ],
      solution: ['port=$(cat port.txt)', `curl --noproxy '*' --connect-timeout 2 --max-time 2 --resolve "${host}:$port:127.0.0.1" -fsS -D headers.txt -o body.json "http://${host}:$port${route}"`],
      hint: 'curl --resolve 主机:端口:地址 为指定主机提供本次请求的地址映射，并保留 URL 中的 Host。-D 保存响应头，-o 保存正文；--noproxy 避免代理干扰本地请求。',
    };
  },
  ports(random, service) {
    const route = random.pick(['/health', '/ready']);
    const payload = { service, status: 'ok' };
    return {
      title: '定位监听端口及其所属进程',
      brief: `某个真实的练习服务正在监听端口，port.txt 给出端口号，endpoint.txt 给出回环地址。请观察监听套接字和所属进程，保持服务运行，并检查 ${route}。无需 root，不要停止其他进程。`,
      setup: [write('server-data.json', JSON.stringify({ route, payload }))],
      fixture: { kind: 'http', marker: `shell-lab-ports-${random.seed}` },
      goals: [
        { text: '将该端口的 TCP LISTEN 记录写入 listener.txt，不带表头，包含 127.0.0.1:端口、python3 和 PID 信息；仅保留该端口的记录。', check: pythonCheck(`import re, os\nport = open('port.txt').read().strip()\npid = int(open('server.pid').read())\nos.kill(pid, 0)\nrows = open('listener.txt').read().splitlines()\nassert len(rows) == 1\nassert re.search(r'\\bLISTEN\\b', rows[0])\nassert '127.0.0.1:' + port in rows[0].split()\nassert 'python3' in rows[0] and re.search(r'pid=' + str(pid) + r'[,)]', rows[0])`) },
        { text: `将所属进程的“PID 进程名”写入 owner.txt（允许多余空白），并请求 ${route}，把成功响应保存到 response.json。`, check: pythonCheck(`import json\nassert open('owner.txt').read().split() == [open('server.pid').read().strip(), 'python3']\nassert json.load(open('response.json')) == ${JSON.stringify(payload)}\nassert '${route}' in open('requests.log').read().splitlines()`) },
      ],
      solution: ['port=$(cat port.txt)', 'ss -H -ltnp "sport = :$port" > listener.txt', `pid=$(grep -oE 'pid=[0-9]+' listener.txt | cut -d= -f2)`, 'ps -p "$pid" -o pid=,comm= > owner.txt', `curl -fsS --max-time 2 "$(cat endpoint.txt)${route}" > response.json`],
      hint: 'ss -ltnp 查看监听 TCP 端口与所属进程，-H 去掉表头；sport = :端口 精确筛选本地端口。ps -p PID -o pid=,comm= 输出 PID 和进程名。',
    };
  },
  disk(random) {
    const threshold = random.pick([96, 128, 192]) * 1024;
    const files = ['data/logs/app.log', 'data/logs/old trace.log', 'data/cache/build.bin', 'data/cache/index.bin', 'data/uploads/user note.txt', 'data/uploads/blob.bin'].map((path, i) => ({ path, size: (i % 2 ? random.integer(200, 350) : random.integer(12, 90)) * 1024, char: String.fromCharCode(65 + i) }));
    const expected = files.filter((f) => f.size > threshold).sort((a, b) => b.size - a.size || a.path.localeCompare(b.path)).map((f) => `${f.size}\t${f.path}\n`).join('');
    const unchanged = `from pathlib import Path\nfiles = ${JSON.stringify(files)}\nfor f in files:\n assert Path(f['path']).read_bytes() == f['char'].encode() * f['size']`;
    return {
      title: '找出大文件与占用最多的目录',
      brief: 'data 中有日志、缓存和用户上传文件，包含带空格的文件名。请先统计，不删除或修改数据。文件的字节大小和 du 统计的实际磁盘占用可能不同。',
      setup: [`python3 -c ${quote(`from pathlib import Path\nfiles = ${JSON.stringify(files)}\nfor f in files:\n p = Path(f['path']); p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(f['char'].encode() * f['size'])`)}`],
      goals: [
        { text: `将 data 下严格大于 ${threshold} 字节的普通文件写入 large.txt，每行“字节数<Tab>相对路径”，按字节数降序，同大小按路径字典序；路径以 data/ 开头，原数据保持不变。`, check: `${equals('large.txt', expected)} && ${pythonCheck(unchanged)}` },
        { text: '用 du -sk 统计 data 的三个直接子目录，将结果写入 usage.txt，按 KiB 占用数降序，同占用按路径字典序（允许空格或 Tab 分隔）。', check: pythonCheck(`import subprocess\nexpected = [line.split() for line in subprocess.check_output(['du', '-sk', 'data/cache', 'data/logs', 'data/uploads'], text=True).splitlines()]\nexpected.sort(key=lambda r: (-int(r[0]), r[1]))\nactual = [line.split() for line in open('usage.txt') if line.strip()]\nassert actual == expected\n${unchanged}`) },
      ],
      solution: [`find data -type f -size +${threshold}c -printf '%s\\t%p\\n' | sort -k1,1nr -k2,2 > large.txt`, 'du -sk data/* | sort -k1,1nr -k2,2 > usage.txt'],
      hint: 'find 的 -size +Nc 按字节过滤，-printf 可输出大小与路径。sort -k1,1nr 按第一列数值降序。du -sk 汇总的是实际占用，不应把它当作文件字节数。',
    };
  },
  retry(random) {
    const failures = random.integer(1, 3);
    const code = random.integer(10, 30);
    const payload = `ready ${random.integer(100, 999)}`;
    const probe = `import sys, time\nfrom pathlib import Path\np = Path(sys.argv[1]); n = int(p.read_text()) + 1 if p.exists() else 1\np.write_text(str(n))\nif len(sys.argv) > 5: time.sleep(float(sys.argv[5]))\nif n <= int(sys.argv[2]): sys.exit(int(sys.argv[3]))\nprint(sys.argv[4])\n`;
    const prelude = `import subprocess, tempfile\nfrom pathlib import Path\nassert Path('retry.sh').stat().st_mode & 0o111\nwith tempfile.TemporaryDirectory(prefix='retry check ', dir='.') as tmp:\n counter = str(Path(tmp) / 'attempt count')\n`;
    return {
      title: '给不稳定命令增加超时和重试',
      brief: `编写可执行的 retry.sh ATTEMPTS SECONDS COMMAND [ARGS...]。ATTEMPTS 是包含首次执行的总尝试次数，SECONDS 是每次超时时间（可为小数）。probe.py COUNTER FAILURES CODE MESSAGE [DELAY] 提供真实测试命令：先失败指定次数，再输出 MESSAGE；每次调用递增 COUNTER。`,
      setup: [write('probe.py', probe), write('requirements.txt', `示例：./retry.sh ${failures + 1} 1 python3 probe.py attempts.txt ${failures} ${code} '${payload}'\n`) ],
      goals: [
        { text: '命令失败后重试，成功立即停止并返回 0，保留命令输出和带空格的参数；参数不足或 ATTEMPTS 不是正整数时返回 2。', check: pythonCheck(`${prelude} r = subprocess.run(['./retry.sh', '${failures + 2}', '1', 'python3', 'probe.py', counter, '${failures}', '${code}', '${payload}'], capture_output=True, text=True, timeout=2)\n assert r.returncode == 0 and r.stdout == '${payload}\\n'\n assert Path(counter).read_text() == '${failures + 1}'\n for args in [[], ['0', '1', 'true'], ['bad', '1', 'true']]:\n  assert subprocess.run(['./retry.sh'] + args, capture_output=True, timeout=0.5).returncode == 2`) },
        { text: `重试耗尽时返回最后一次失败码（示例 ${code}）；单次执行超时后也应重试，耗尽返回 timeout 的 124。不允许无限等待或超过指定次数。`, check: pythonCheck(`${prelude} r = subprocess.run(['./retry.sh', '2', '1', 'python3', 'probe.py', counter, '99', '${code}', 'never'], capture_output=True, timeout=1)\n assert r.returncode == ${code} and Path(counter).read_text() == '2'\n Path(counter).unlink()\n r = subprocess.run(['./retry.sh', '2', '0.2', 'python3', 'probe.py', counter, '0', '${code}', 'slow', '10'], capture_output=True, timeout=1.5)\n assert r.returncode == 124 and Path(counter).read_text() == '2'`) },
      ],
      solution: scriptSolution('retry.sh', `if [ "$#" -lt 3 ] || [[ ! "$1" =~ ^[1-9][0-9]*$ ]]; then exit 2; fi\nattempts=$1\nseconds=$2\nshift 2\nfor ((i=0; i<attempts; i++)); do\n  if timeout --kill-after=0.1 "$seconds" "$@"; then exit 0; else code=$?; fi\ndone\nexit "$code"`),
      hint: '用 "$@" 保留命令和各参数的边界。把 timeout 放在 if 条件里，失败分支立即保存 $?，避免 set -e 提前退出。超时通常返回 124；重试次数包含首次调用。',
    };
  },
  atomic(random, service) {
    const failure = random.integer(10, 30);
    const payload = `${service} report ${random.integer(1000, 9999)}\n`;
    const processor = `#!/bin/bash\n[ -f "$1" ] || exit 3\nprintf 'partial\\n' > "$2"\nif [ "\${JOB_FAIL:-0}" = 1 ]; then exit ${failure}; fi\ntr '[:lower:]' '[:upper:]' < "$1" > "$2"\n`;
    const prelude = `import os, subprocess, tempfile\nfrom pathlib import Path\nassert Path('publish.sh').stat().st_mode & 0o111\nwith tempfile.TemporaryDirectory(prefix='publish check ', dir='.') as tmp:\n source = Path(tmp) / 'source report.txt'; source.write_text(${JSON.stringify(payload)})\n dest = Path(tmp) / 'latest report.txt'; dest.write_text('previous valid report\\n')\n`;
    return {
      title: '避免失败任务破坏已有结果',
      brief: `processor.sh INPUT OUTPUT 将输入转大写，但 JOB_FAIL=1 时会写入半成品并返回 ${failure}。编写可执行的 publish.sh INPUT OUTPUT，先处理到输出文件同目录的临时文件（名称为 OUTPUT.tmp.随机后缀），处理成功后再用 mv 替换正式结果。使用 trap 在退出时清理临时文件。`,
      setup: [write('processor.sh', processor), 'chmod +x processor.sh', write('source report.txt', payload), write('latest report.txt', 'previous valid report\n')],
      goals: [
        { text: '成功时返回 0，正式文件包含完整大写结果，输入保持不变，支持带空格的路径；退出后没有残留的 OUTPUT.tmp.* 临时文件。', check: pythonCheck(`${prelude} env = dict(os.environ, JOB_FAIL='0')\n r = subprocess.run(['./publish.sh', str(source), str(dest)], env=env, capture_output=True, timeout=1)\n assert r.returncode == 0 and dest.read_text() == source.read_text().upper()\n assert source.read_text() == ${JSON.stringify(payload)}\n assert not list(Path(tmp).glob('latest report.txt.tmp.*'))`) },
        { text: `处理器失败时保留原正式文件，返回处理器退出码 ${failure}；输入不存在时返回 3。失败同样清理临时文件，参数数量不等于 2 时返回 2。`, check: pythonCheck(`${prelude} for name, env, code in [(str(source), dict(os.environ, JOB_FAIL='1'), ${failure}), (str(Path(tmp) / 'missing'), dict(os.environ, JOB_FAIL='0'), 3)]:\n  r = subprocess.run(['./publish.sh', name, str(dest)], env=env, capture_output=True, timeout=0.6)\n  assert r.returncode == code and dest.read_text() == 'previous valid report\\n'\n  assert not list(Path(tmp).glob('latest report.txt.tmp.*'))\n assert subprocess.run(['./publish.sh'], capture_output=True, timeout=0.5).returncode == 2`) },
      ],
      solution: scriptSolution('publish.sh', `[ "$#" -eq 2 ] || exit 2\nstage=$(mktemp -- "$2.tmp.XXXXXX") || exit 1\ntrap 'rm -f -- "$stage"' EXIT\n./processor.sh "$1" "$stage" || exit $?\nmv -f -- "$stage" "$2"`),
      hint: '先用 mktemp 在目标旁边建临时文件，trap 在 EXIT 时清理；处理成功才 mv。不要先截断正式文件。处理失败后立即保存或返回退出码。',
    };
  },
  locking(random, service) {
    const payload = `${service} backup ${random.integer(1000, 9999)}\n`;
    const prelude = `import fcntl, subprocess, tempfile\nfrom pathlib import Path\nassert Path('backup.sh').stat().st_mode & 0o111\nwith tempfile.TemporaryDirectory(prefix='lock check ', dir='.') as tmp:\n source = Path(tmp) / 'source data.txt'; source.write_text(${JSON.stringify(payload)})\n dest = Path(tmp) / 'backup data.txt'\n`;
    return {
      title: '防止定时备份任务重叠执行',
      brief: '编写可执行的 backup.sh SOURCE DEST，将普通源文件复制到目标，并生成 DEST.sha256（可用 sha256sum -c 验证）。所有本题备份调用共用当前任务目录的 backup.lock；锁被占用时立即退出 75，不等待、不修改输出。锁文件可以保留，不要通过删除锁文件解锁。',
      setup: [write('source data.txt', payload)],
      goals: [
        { text: '未占锁时备份成功返回 0，目标与源一致且校验记录有效，支持带空格路径；完成后立即释放锁。参数数量不等于 2 时返回 2。', check: pythonCheck(`${prelude} for i in range(2):\n  r = subprocess.run(['./backup.sh', str(source), str(dest)], capture_output=True, timeout=0.7)\n  assert r.returncode == 0 and dest.read_bytes() == source.read_bytes()\n  assert subprocess.run(['sha256sum', '-c', str(dest) + '.sha256'], capture_output=True, timeout=0.3).returncode == 0\n with open('backup.lock', 'a') as lock:\n  fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)\n assert subprocess.run(['./backup.sh'], capture_output=True, timeout=0.3).returncode == 2`) },
        { text: '另一个进程持有 backup.lock 排他锁时，脚本立即返回 75，既不覆盖既有备份及校验文件，也不创建原本不存在的备份；锁释放后可再次执行。', check: pythonCheck(`${prelude} dest.write_text('keep backup\\n')\n checksum = Path(str(dest) + '.sha256'); checksum.write_text('keep checksum\\n')\n with open('backup.lock', 'a') as lock:\n  fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)\n  inode = Path('backup.lock').stat().st_ino\n  for target in [dest, Path(tmp) / 'new backup.txt']:\n   r = subprocess.run(['./backup.sh', str(source), str(target)], capture_output=True, timeout=0.5)\n   assert r.returncode == 75\n  assert Path('backup.lock').stat().st_ino == inode\n  assert dest.read_text() == 'keep backup\\n' and checksum.read_text() == 'keep checksum\\n'\n  assert not (Path(tmp) / 'new backup.txt').exists()\n  assert not (Path(tmp) / 'new backup.txt.sha256').exists()\n r = subprocess.run(['./backup.sh', str(source), str(dest)], capture_output=True, timeout=0.5)\n assert r.returncode == 0 and dest.read_bytes() == source.read_bytes()`) },
      ],
      solution: scriptSolution('backup.sh', `[ "$#" -eq 2 ] || exit 2\nexec 9>backup.lock\nflock -n -E 75 9 || exit $?\ncp -- "$1" "$2" || exit $?\nsha256sum -- "$2" > "$2.sha256"`),
      hint: 'exec 9>backup.lock 打开锁文件，flock -n -E 75 9 非阻塞获取排他锁，冲突返回 75。保持文件描述符打开到任务结束，进程退出时系统释放锁；不要删除仍被持有的锁文件。',
    };
  },
};
