import type { FixtureSpec } from '../exercises.js';
import { Random, equals, quote, write } from './random.js';
import { remoteBuilders } from './remote-builders.js';
import { operationsBuilders } from './operations-builders.js';
import { everydayBuilders } from './everyday-builders.js';

interface Goal { text: string; check: string }
export interface Task {
  title: string;
  brief: string;
  setup: string[];
  goals: Goal[];
  solution: string[];
  hint: string;
  fixture?: Omit<FixtureSpec, 'directory'>;
}
export type Builder = (random: Random, service: string) => Task;
const lines = (items: string[]) => items.length ? items.join('\n') + '\n' : '';
const sorted = (items: string[]) => lines([...items].sort());
const jsonCheck = (path: string, expected: unknown) => `python3 -c ${quote(`import json; assert json.load(open(${JSON.stringify(path)})) == json.loads(${JSON.stringify(JSON.stringify(expected))})`)}`;

export const builders: Record<string, Builder> = {
  ...remoteBuilders,
  ...operationsBuilders,
  ...everydayBuilders,
  logs(random, service) {
    const level = random.pick(['ERROR', 'WARN']);
    const trace = `req-${random.integer(1000, 9999)}`;
    const traceMode = random.integer(0, 1) === 1;
    const limit = random.integer(3, 7);
    const data = Array.from({ length: random.integer(35, 70) }, (_, i) => {
      const tag = i % 4 === 0 ? trace : `req-${random.integer(100, 999)}`;
      return `2026-03-18T09:${String(i % 60).padStart(2, '0')}:00Z ${i % 3 === 0 ? level : 'INFO'} service=${i % 5 === 0 ? 'gateway' : service} request_id=${tag} code=${random.pick(['DB_TIMEOUT', 'RETRY', 'READY'])}`;
    });
    const selected = traceMode
      ? data.filter((row) => row.includes(`request_id=${trace} `))
      : data.filter((row) => row.split(' ')[1] === level && row.includes(`service=${service} `)).slice(-limit);
    const predicate = traceMode ? `$4=="request_id=${trace}"` : `$2=="${level}" && $3=="service=${service}"`;
    return {
      title: traceMode ? '追踪跨服务请求' : '提取最近的异常日志',
      brief: `app.log 的字段为：时间、级别、service、request_id、code。${traceMode ? `需要追踪请求 ${trace} 的所有日志。` : `${service} 出现异常，需要保留最近 ${limit} 条 ${level} 记录。`}`,
      setup: [write('app.log', lines(data))],
      goals: [
        { text: `将${traceMode ? `request_id=${trace} 的所有` : `${service} 服务最后 ${limit} 条 ${level}`}完整日志按原顺序写入 selected.log；保留原始 app.log。`, check: `${equals('selected.log', lines(selected))} && ${equals('app.log', lines(data))}` },
        { text: '将选中日志的行数写入 count.txt，只包含数字和可选空白。', check: `test -f count.txt && test "$(tr -d '[:space:]' < count.txt)" = ${selected.length}` },
      ],
      solution: [`awk ${quote(predicate)} app.log${traceMode ? '' : ` | tail -n ${limit}`} > selected.log`, 'wc -l < selected.log > count.txt'],
      hint: '先识别字段，再用 awk 同时过滤多个条件。tail -n 可以取最后几条记录；wc -l 统计结果。',
    };
  },
  access(random) {
    const threshold = random.pick([300, 500, 800]);
    const slow = random.integer(0, 1) === 1;
    const data = Array.from({ length: random.integer(30, 60) }, (_, i) => ({
      path: random.pick(['/api/orders', '/api/users', '/health', '/api/payments']),
      status: i % 3 === 0 ? random.pick([500, 502, 503]) : 200,
      latency: random.integer(40, 1200),
    }));
    const rows = data.map((item, i) => `10:00:${String(i % 60).padStart(2, '0')} GET ${item.path} ${item.status} ${item.latency}`);
    const matches = data.filter((item) => slow ? item.latency > threshold : item.status >= 500);
    const counts = new Map<string, number>();
    for (const item of matches) counts.set(item.path, (counts.get(item.path) ?? 0) + 1);
    const expected = lines([...counts].sort(([a], [b]) => a.localeCompare(b)).map(([path, count]) => `${path} ${count}`));
    const condition = slow ? `$5>${threshold}` : '$4>=500';
    return {
      title: slow ? '定位慢接口' : '统计服务端错误',
      brief: 'access.log 是空格分隔的访问日志，字段依次为：时间、方法、路径、HTTP 状态码、耗时（毫秒）。',
      setup: [write('access.log', lines(rows))],
      goals: [
        { text: `统计${slow ? `耗时严格大于 ${threshold} 毫秒` : '状态码大于或等于 500'}的请求，写入 summary.txt：每行“路径 次数”，按路径字典序排列。`, check: equals('summary.txt', expected) },
        { text: '将符合条件的原始日志按原顺序写入 matches.log，保持 access.log 不变。', check: `${equals('matches.log', lines(rows.filter((_, i) => slow ? data[i].latency > threshold : data[i].status >= 500)))} && ${equals('access.log', lines(rows))}` },
      ],
      solution: [`awk ${quote(condition)} access.log > matches.log`, `awk '{print $3}' matches.log | sort | uniq -c | awk '{print $2, $1}' > summary.txt`],
      hint: 'awk 可按数字比较字段。sort | uniq -c 可以聚合路径；再把“次数 路径”调整成要求的“路径 次数”。',
    };
  },
  find(random) {
    const sizeMode = random.integer(0, 1) === 1;
    const threshold = random.pick([100, 180, 250]);
    const files = Array.from({ length: 9 }, (_, i) => ({
      path: `cache/job-${i}.${i % 3 === 0 ? 'log' : 'tmp'}`,
      size: random.integer(40, 420), old: i % 2 === 0,
    }));
    const removed = files.filter((file) => file.path.endsWith('.tmp') && (sizeMode ? file.size > threshold : file.old));
    const remaining = files.filter((file) => !removed.includes(file));
    const predicate = sizeMode ? `-size +${threshold}c` : `! -newermt '2026-01-10'`;
    return {
      title: sizeMode ? '清理过大的临时产物' : '按时间清理临时产物',
      brief: 'cache 中混合存放着临时产物和需要保留的日志。只清理符合条件的普通文件。',
      setup: ['mkdir cache', ...files.flatMap((file) => [write(file.path, 'x'.repeat(file.size)), `touch -d ${quote(file.old ? '2026-01-02 12:00:00 UTC' : '2026-01-18 12:00:00 UTC')} ${quote(file.path)}`])],
      goals: [
        { text: `删除 cache 下${sizeMode ? `大小严格超过 ${threshold} 字节` : '修改时间早于 2026-01-10 00:00:00 UTC'}的 .tmp 普通文件，其他文件和内容保持不变。`, check: [...removed.map((file) => `test ! -e ${quote(file.path)}`), ...remaining.map((file) => equals(file.path, 'x'.repeat(file.size)))].join(' && ') },
        { text: '将 cache 中剩余普通文件的相对路径按字典序写入 remaining.txt，每行一个，以 cache/ 开头。', check: equals('remaining.txt', sorted(remaining.map((file) => file.path))) },
      ],
      solution: [`TZ=UTC find cache -type f -name '*.tmp' ${predicate} -delete`, 'find cache -type f | sort > remaining.txt'],
      hint: '先用 find 查看匹配范围，确认后再删除。-size 的 c 表示字节；设置 TZ=UTC 可以消除日期边界的时区差异。',
    };
  },
  config(random, service) {
    const port = random.integer(8100, 8999);
    const level = random.pick(['info', 'warn', 'error']);
    const cache = random.integer(0, 1) === 1;
    const original = `# ${service} production settings\nAPP_NAME=${service}\nPORT=8080\nLOG_LEVEL=debug\nCACHE_ENABLED=false\nDB_HOST=db.internal\n`;
    const expected = original.replace('PORT=8080', `PORT=${port}`).replace('LOG_LEVEL=debug', `LOG_LEVEL=${level}`).replace('CACHE_ENABLED=false', `CACHE_ENABLED=${cache}`);
    return {
      title: '修复上线配置', brief: `${service} 的 app.env 仍然使用开发设置。修改前先留一份可回滚的备份。`,
      setup: [write('app.env', original)],
      goals: [
        { text: '将原始 app.env 完整备份为 app.env.bak。', check: equals('app.env.bak', original) },
        { text: `将 PORT 改为 ${port}、LOG_LEVEL 改为 ${level}、CACHE_ENABLED 改为 ${cache}；保留其他行、注释与顺序。`, check: equals('app.env', expected) },
      ],
      solution: ['cp app.env app.env.bak', `sed -i -e 's/^PORT=.*/PORT=${port}/' -e 's/^LOG_LEVEL=.*/LOG_LEVEL=${level}/' -e 's/^CACHE_ENABLED=.*/CACHE_ENABLED=${cache}/' app.env`],
      hint: 'cp 保存原始文件，再用 sed 的行首锚点 ^ 精确定位配置键。避免全局替换误改注释。',
    };
  },
  archive(random, service) {
    const excludeLogs = random.integer(0, 1) === 1;
    const files = [
      ['data/app.conf', `service=${service}\n`], ['data/db.dump', `snapshot-${random.integer(100, 999)}\n`],
      ['data/uploads/user note.txt', 'Keep the space in this filename.\n'],
      ['data/cache/temp.bin', 'cache-only\n'], ['data/logs/debug.log', 'debug log\n'],
    ];
    const kept = files.filter(([path]) => !path.startsWith('data/cache/') && !(excludeLogs && path.startsWith('data/logs/')));
    const expectedNames = sorted(kept.map(([path]) => path));
    return {
      title: '制作可校验的备份', brief: 'data 包含应用配置、导出数据、用户上传文件，以及不一定需要备份的运行产物。',
      setup: ['mkdir -p data/uploads data/cache data/logs', ...files.map(([path, content]) => write(path, content))],
      goals: [
        { text: `生成 backup.tar.gz，归档路径以 data/ 开头，排除整个 data/cache${excludeLogs ? ' 和 data/logs' : ''}；其他普通文件及内容完整保留。`, check: `cmp -s <(tar -tzf backup.tar.gz | grep -v '/$' | sort) <(printf '%s' ${quote(expectedNames)}) && ${kept.map(([path, content]) => `cmp -s <(tar -xOf backup.tar.gz ${quote(path)}) <(printf '%s' ${quote(content)})`).join(' && ')}` },
        { text: '生成 backup.sha256，包含 backup.tar.gz 的 SHA-256 校验记录，能用 sha256sum -c 验证。', check: `test -f backup.sha256 && test "$(wc -l < backup.sha256)" -eq 1 && grep -Eq '^[0-9a-f]{64} [ *]backup\.tar\.gz$' backup.sha256 && sha256sum -c backup.sha256` },
      ],
      solution: [`tar --exclude='data/cache'${excludeLogs ? " --exclude='data/logs'" : ''} -czf backup.tar.gz data`, 'sha256sum backup.tar.gz > backup.sha256'],
      hint: 'tar 的 --exclude 放在待打包路径之前。不要把备份文件本身放进 data；用 sha256sum 生成清单。',
    };
  },
  permissions(random, service) {
    const dirMode = random.pick(['700', '750']);
    const scriptMode = random.pick(['700', '750']);
    const secret = `TOKEN=${service}-${random.integer(10000, 99999)}\n`;
    const script = "#!/bin/bash\nprintf 'healthy\\n'\n";
    return {
      title: '收紧敏感配置的权限', brief: '配置与脚本的初始权限不符合部署要求。只调整权限，保留内容。',
      setup: ['mkdir private', write('private/service.env', secret), write('health.sh', script), 'chmod 777 private; chmod 644 private/service.env health.sh'],
      goals: [
        { text: `把 private 目录权限设为 ${dirMode}，private/service.env 设为 600，内容保持不变。`, check: `test "$(stat -c %a private)" = ${dirMode} && test "$(stat -c %a private/service.env)" = 600 && ${equals('private/service.env', secret)}` },
        { text: `把 health.sh 权限设为 ${scriptMode}，确保直接运行输出 healthy，脚本内容保持不变。`, check: `test "$(stat -c %a health.sh)" = ${scriptMode} && ${equals('health.sh', script)} && test "$(./health.sh)" = healthy` },
      ],
      solution: [`chmod ${dirMode} private`, 'chmod 600 private/service.env', `chmod ${scriptMode} health.sh`],
      hint: 'chmod 的三位数字依次对应所有者、所属组和其他用户。用 stat -c %a 查看实际权限。',
    };
  },
  deploy(random, service) {
    const patch = random.integer(2, 20);
    const old = `v1.0.${patch}`;
    const next = `v1.0.${patch + 1}`;
    const oldData = `${service} ${old}\n`;
    const newData = `${service} ${next}\n`;
    return {
      title: random.pick(['切换应用版本', '准备发布与回滚入口']),
      brief: `releases 中已经放好两个版本，current 指向 ${old}。现在发布 ${next}，并保留回滚入口。`,
      setup: [`mkdir -p releases/${old} releases/${next}`, write(`releases/${old}/app.txt`, oldData), write(`releases/${next}/app.txt`, newData), `ln -s releases/${old} current`],
      goals: [
        { text: `让 current 软链接指向 releases/${next}，previous 软链接指向 releases/${old}；两个版本内容保持不变。`, check: `test -L current && test -L previous && test "$(readlink -f current)" = "$(readlink -f releases/${next})" && test "$(readlink -f previous)" = "$(readlink -f releases/${old})" && ${equals(`releases/${old}/app.txt`, oldData)} && ${equals(`releases/${next}/app.txt`, newData)}` },
        { text: '把 current/app.txt 的 SHA-256 校验记录写入 release.sha256，记录中的路径使用 current/app.txt。', check: `grep -Eq '^[0-9a-f]{64} [ *]current/app\.txt$' release.sha256 && test "$(wc -l < release.sha256)" -eq 1 && sha256sum -c release.sha256` },
      ],
      solution: [`ln -sfn releases/${next} current`, `ln -s releases/${old} previous`, 'sha256sum current/app.txt > release.sha256'],
      hint: '用 ln -sfn 更新软链接，用 readlink -f 检查实际指向。保留旧版本目录即可保留回滚材料。',
    };
  },
  batch(random) {
    const from = random.pick(['draft', 'pending']);
    const to = from === 'draft' ? 'txt' : 'done';
    const names = random.shuffle(['daily report', 'release notes', 'job 01', 'job 02', 'customer export']).slice(0, random.integer(3, 5));
    const contents = names.map((name) => `content for ${name}\n`);
    return {
      title: '批量处理带空格的文件名', brief: `incoming 中有一批 .${from} 文件，需要调整为 .${to}；文件名含空格，旁边还有必须保留的 CSV。`,
      setup: ['mkdir incoming', ...names.map((name, i) => write(`incoming/${name}.${from}`, contents[i])), write('incoming/keep.csv', 'id,value\n1,keep\n')],
      goals: [
        { text: `将所有 incoming/*.${from} 重命名为相同主文件名的 .${to}，保留文件内容和 keep.csv。`, check: [...names.flatMap((name, i) => [`test ! -e ${quote(`incoming/${name}.${from}`)}`, equals(`incoming/${name}.${to}`, contents[i])]), equals('incoming/keep.csv', 'id,value\n1,keep\n')].join(' && ') },
        { text: `将重命名后的 .${to} 文件相对路径排序写入 manifest.txt，每行一条，以 incoming/ 开头。`, check: equals('manifest.txt', sorted(names.map((name) => `incoming/${name}.${to}`))) },
      ],
      solution: [`for file in incoming/*.${from}; do mv -- "$file" "\${file%.${from}}.${to}"; done`, `find incoming -type f -name '*.${to}' | sort > manifest.txt`],
      hint: '循环变量始终加双引号；${file%后缀} 可以去掉末尾后缀。文件名含空格时不要用 for file in $(ls)。',
    };
  },
  csv(random) {
    const status = random.pick(['paid', 'refunded']);
    const unique = random.integer(0, 1) === 1;
    const data = Array.from({ length: random.integer(18, 35) }, (_, i) => ({ id: i + 1, user: `user-${random.integer(1, 7)}`, status: i % 3 === 0 ? status : 'cancelled', amount: random.integer(100, 15000) }));
    const header = 'id,user,status,amount_cents';
    const row = (item: typeof data[number]) => `${item.id},${item.user},${item.status},${item.amount}`;
    const selected = data.filter((item) => item.status === status);
    return {
      title: unique ? '整理交易用户清单' : '汇总交易金额',
      brief: 'orders.csv 的字段为 id,user,status,amount_cents；该练习的字段值不包含逗号或引号，金额单位为分。',
      setup: [write('orders.csv', lines([header, ...data.map(row)]))],
      goals: [
        { text: `筛选 status=${status} 的记录写入 selected.csv，保留表头和原始顺序。`, check: equals('selected.csv', lines([header, ...selected.map(row)])) },
        unique
          ? { text: '把筛选结果中的 user 去重后按字典序写入 users.txt，每行一个用户。', check: equals('users.txt', sorted([...new Set(selected.map((item) => item.user))])) }
          : { text: '把筛选结果的 amount_cents 总和写入 total.txt，只包含整数和可选空白。', check: `test -f total.txt && test "$(tr -d '[:space:]' < total.txt)" = ${selected.reduce((sum, item) => sum + item.amount, 0)}` },
      ],
      solution: [`awk -F, ${quote(`NR==1 || $3=="${status}"`)} orders.csv > selected.csv`, unique ? `awk -F, 'NR>1 {print $2}' selected.csv | sort -u > users.txt` : `awk -F, 'NR>1 {sum+=$4} END {print sum+0}' selected.csv > total.txt`],
      hint: 'awk -F, 指定逗号分隔，NR==1 识别表头。只对业务记录统计，不要把表头计入数据。',
    };
  },
  json(random, service) {
    const region = random.pick(['east', 'west']);
    const ready = random.integer(0, 1) === 1;
    const data = Array.from({ length: random.integer(8, 15) }, (_, i) => ({
      host: `${service}-${i}`, region: i % 2 === 0 ? region : 'central', ready: i % 3 === 0 ? ready : !ready, port: random.integer(8000, 9000),
    }));
    const matches = data.filter((item) => item.region === region && item.ready === ready);
    const program = `import json; data=json.load(open("instances.json")); result=[x for x in data["instances"] if x["region"]==${JSON.stringify(region)} and x["ready"] is ${ready ? 'True' : 'False'}]; json.dump(result,open("selected.json","w")); print("\\n".join(sorted(x["host"]+":"+str(x["port"]) for x in result)))`;
    return {
      title: ready ? '提取可用服务实例' : '定位未就绪的实例',
      brief: 'instances.json 的 instances 数组保存实例对象，每个对象有 host、region、ready、port 字段。',
      setup: [write('instances.json', JSON.stringify({ instances: data }, null, 2) + '\n')],
      goals: [
        { text: `把 region=${region} 且 ready=${ready} 的完整实例对象按原顺序保存为 selected.json 数组；JSON 的空白格式不限。`, check: jsonCheck('selected.json', matches) },
        { text: '把选中实例的 host:port 按字典序保存到 endpoints.txt，每行一条。', check: equals('endpoints.txt', sorted(matches.map((item) => `${item.host}:${item.port}`))) },
      ],
      solution: [`python3 -c ${quote(program)} > endpoints.txt`],
      hint: `可以用 jq 的 select(.region == "${region}" and .ready == ${ready})。未安装 jq 时，也可以用 Python 标准库 json；参考写法无需额外依赖。`,
    };
  },
  git(random, service) {
    const branch = `fix/${service}-${random.integer(10, 99)}`;
    const oldContent = 'timeout=5\nretries=1\n';
    const newContent = `timeout=${random.integer(10, 30)}\nretries=${random.integer(3, 8)}\n`;
    return {
      title: '提交修复，保护本地配置', brief: '当前目录是独立 Git 仓库。src/app.conf 已有一份尚未提交的修复，.env.local 是绝不能提交的本地配置。',
      setup: ['git init -q -b main', 'git config user.name ShellLab', 'git config user.email student@shell-lab.invalid', 'mkdir src', write('src/app.conf', oldContent), write('README.md', `# ${service}\n`), write('.gitignore', ''), 'git add src/app.conf README.md .gitignore; git commit -qm initial', write('src/app.conf', newContent), write('.env.local', `LOCAL_TOKEN=practice-${random.integer(1000, 9999)}\n`)],
      goals: [
        { text: `创建并切换到 ${branch} 分支，用一个新提交保存 src/app.conf 的现有修改及忽略规则；保留初始提交，修改后的文件内容不再变化。`, check: `test "$(git branch --show-current)" = ${quote(branch)} && test "$(git rev-list --count HEAD)" -eq 2 && cmp -s <(git show HEAD:src/app.conf) <(printf '%s' ${quote(newContent)}) && ${equals('src/app.conf', newContent)} && git diff --quiet && git diff --cached --quiet` },
        { text: '把 .env.local 加入 .gitignore 并一并提交；.env.local 必须仍在磁盘上，且不被 Git 跟踪。', check: `test -f .env.local && git check-ignore -q .env.local && ! git ls-files --error-unmatch .env.local >/dev/null 2>&1 && git show HEAD:.gitignore | grep -Fxq '.env.local'` },
      ],
      solution: [`git switch -c ${quote(branch)}`, "printf '.env.local\\n' >> .gitignore", "git add src/app.conf .gitignore", "git commit -m 'Fix application settings and ignore local environment'"],
      hint: '先用 git status 和 git diff 检查修改。明确 git add 要提交的路径，避免用 git add . 把本地配置一起提交。',
    };
  },
  scripts(random) {
    const message = `payload-${random.integer(1000, 9999)}\n`;
    const program = '#!/bin/bash\nif [ "$#" -ne 2 ]; then\n  printf \'usage: export.sh SOURCE DEST\\n\' >&2\n  exit 2\nfi\nif [ ! -f "$1" ]; then\n  printf \'source missing\\n\' >&2\n  exit 3\nfi\ncp -- "$1" "$2" || exit 1\nprintf \'copied\\n\'\n';
    return {
      title: '写一个能处理失败的导出脚本', brief: '编写可执行的 export.sh SOURCE DEST，把普通源文件复制到目标位置。文件名可能有空格。',
      setup: [write('source report.txt', message)],
      goals: [
        { text: '成功时返回 0，只向标准输出写一行 copied，目标内容与源文件一致；能处理带空格的路径。', check: `test -x export.sh && test "$(./export.sh 'source report.txt' 'result copy.txt')" = copied && ${equals('result copy.txt', message)}` },
        { text: '参数数量不等于 2 时退出码为 2；源文件不存在时为 3。两种错误都写入标准错误，标准输出为空。', check: `./export.sh >.args.out 2>.args.err; code=$?; test "$code" = 2 && test ! -s .args.out && test -s .args.err || exit 1; ./export.sh nonexistent.txt never-created.txt >.missing.out 2>.missing.err; code=$?; test "$code" = 3 && test ! -s .missing.out && test -s .missing.err && test ! -e never-created.txt` },
      ],
      solution: [`cat > export.sh <<'SHELLLAB_SCRIPT'\n${program}SHELLLAB_SCRIPT`, 'chmod +x export.sh'],
      hint: '$# 是参数数量；>&2 写入标准错误。测试错误码前先保存 $?，否则下一个命令会覆盖它。复制路径时加双引号。',
    };
  },
  http(random, service) {
    const route = random.pick(['/health', '/ready']);
    const payload = { service, status: 'ok', version: `1.${random.integer(0, 9)}.${random.integer(0, 20)}` };
    const marker = `shell-lab-http-${random.seed}-${random.integer(100, 999)}`;
    return {
      title: '检查真实 HTTP 服务', brief: `本地练习服务已启动，endpoint.txt 记录实际地址。${route} 返回健康信息，/not-found 返回 404；不需要访问外网。`,
      setup: [write('server-data.json', JSON.stringify({ route, payload }) + '\n')],
      fixture: { kind: 'http', marker },
      goals: [
        { text: `向服务的 ${route} 发起 GET 请求，将完整响应保存到 response.json。`, check: `${jsonCheck('response.json', payload)} && grep -Fxq ${quote(route)} requests.log` },
        { text: '向 /not-found 发起请求，把 HTTP 状态码 404 保存到 status.txt，响应体不要混入其中。', check: `test -f status.txt && test "$(tr -d '[:space:]' < status.txt)" = 404 && grep -Fxq '/not-found' requests.log` },
      ],
      solution: [`url=$(cat endpoint.txt)`, `curl -fsS "$url${route}" > response.json`, `curl -sS -o /dev/null -w '%{http_code}\\n' "$url/not-found" > status.txt`],
      hint: 'curl -o 保存响应体，-w 输出状态码。不要对预期的 404 使用 -f 后再把失败当成服务无法连接。',
    };
  },
  process(random) {
    const marker = `shell-lab-worker-${random.seed}-${random.integer(100, 999)}`;
    const noWorker = `import glob; marker=${JSON.stringify(marker)}.encode(); found=[]\nfor path in glob.glob("/proc/[0-9]*/cmdline"):\n try:\n  args=open(path,"rb").read().split(b"\\0")\n  if marker in args: found.append(path)\n except (FileNotFoundError,PermissionError,ProcessLookupError): pass\nassert not found, found`;
    return {
      title: '定位并停止后台工作进程', brief: '一个真实的练习 worker 已经启动，PID 保存在 worker.pid。只操作这个练习进程，不要停止其他进程。',
      setup: [], fixture: { kind: 'worker', marker },
      goals: [
        { text: '在停止前用 ps 查询 worker.pid 中的进程，把不带表头和前后空格的进程名写入 process.txt。', check: equals('process.txt', 'python3\n') },
        { text: '向该 worker 发送 SIGTERM，让它退出，然后把 stopped 写入 status.txt（以换行结尾）。', check: `${equals('status.txt', 'stopped\n')} && python3 -c ${quote(noWorker)}` },
      ],
      solution: ['ps -p "$(cat worker.pid)" -o comm= | awk \'{$1=$1; print}\' > process.txt', 'kill -TERM "$(cat worker.pid)"', "printf 'stopped\\n' > status.txt"],
      hint: 'ps -p PID 只检查指定进程。kill 默认发送 SIGTERM；进程可能需要片刻退出。不要直接复制 PID 到另一次重置后的环境。',
    };
  },
};
