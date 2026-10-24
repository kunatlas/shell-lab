import type { Builder } from './builders.js';
import { equals, quote, write } from './random.js';

const text = (items: string[]) => `${items.join('\n')}\n`;
const sorted = (items: string[]) => text([...items].sort());
const pythonCheck = (program: string) => `python3 -c ${quote(program)}`;

export const everydayBuilders: Record<string, Builder> = {
  ps(random) {
    const marker = `labps${random.integer(100000, 999999)}`;
    const auxCheck = `import os, pathlib, pwd
rows = pathlib.Path('aux.txt').read_text().splitlines()
assert rows and rows[0].split()[:11] == ['USER','PID','%CPU','%MEM','VSZ','RSS','TTY','STAT','START','TIME','COMMAND']
assert len(rows) == 2
fields = rows[1].split(None, 10)
pid = pathlib.Path('worker.pid').read_text().strip()
marker = pathlib.Path('marker.txt').read_text().strip()
assert fields[0] == pwd.getpwuid(os.getuid()).pw_name
assert fields[1] == pid and fields[7] and marker in fields[10]
os.kill(int(pid), 0)`;
    const efCheck = `import pathlib
rows = pathlib.Path('ef.txt').read_text().splitlines()
assert rows and rows[0].split()[:8] == ['UID','PID','PPID','C','STIME','TTY','TIME','CMD']
assert len(rows) == 2
fields = rows[1].split(None, 7)
pid = pathlib.Path('worker.pid').read_text().strip()
marker = pathlib.Path('marker.txt').read_text().strip()
ppid = next(line.split()[1] for line in pathlib.Path(f'/proc/{pid}/status').read_text().splitlines() if line.startswith('PPid:'))
assert fields[1] == pid and fields[2] == ppid and marker in fields[7]`;
    return {
      title: '用 ps 查看进程清单',
      brief: `一个练习 worker 正在运行。marker.txt 里是它的命令行标记。请用 ps aux 和 ps -ef 各保存一份清单，不要停止这个进程。`,
      setup: [write('marker.txt', `${marker}\n`)],
      fixture: { kind: 'worker', marker },
      goals: [
        { text: '把 ps aux 的表头和这个 worker 的那一行写入 aux.txt。只保留这一条进程，行内要能看到标记、用户和 PID。', check: pythonCheck(auxCheck) },
        { text: '把 ps -ef 的表头和这个 worker 的那一行写入 ef.txt。PID 与 aux 中相同，PPID 必须是该进程的真实父进程。', check: pythonCheck(efCheck) },
      ],
      solution: [
        'marker=$(cat marker.txt)',
        `ps aux | awk -v m="$marker" 'NR==1 || (index($0, m) && index($0, "awk") == 0)' > aux.txt`,
        `pid=$(awk 'NR==2 {print $2}' aux.txt)`,
        `ps -ef | awk -v pid="$pid" 'NR==1 || $2==pid' > ef.txt`,
      ],
      hint: 'ps aux 是 BSD 写法，没有横线，列里有 USER、%CPU、%MEM 和 STAT。ps -ef 是 UNIX 写法，第三列是 PPID。ps -aux 多写了横线，procps 会警告后再按 ps aux 执行。筛选时去掉 awk 自己那一行。',
    };
  },
  context(random) {
    const before = random.integer(1, 2);
    const after = random.integer(1, 2);
    const pattern = 'code=(DB|NET)_TIMEOUT$';
    const rows = [
      'INFO startup',
      'ERROR code=DB_TIMEOUT extra',
      'INFO ready',
      'ERROR code=DB_TIMEOUT',
      'INFO after db',
      'WARN code=OK',
      'ERROR code=NET_TIMEOUT',
      'INFO after net',
      'INFO idle',
    ];
    const log = text(rows);
    const expected = (output: string, args: string) => `grep ${args} -- ${quote(pattern)} app.log > .grep.expected && cmp -s ${quote(output)} .grep.expected && ${equals('app.log', log)}`;
    return {
      title: '用 grep 保留匹配和上下文',
      brief: 'app.log 里有超时错误，也有看起来相似、但不该命中的行。用 grep 的扩展正则取出精确匹配，并另存未命中的行。',
      setup: [write('app.log', log)],
      goals: [
        { text: `把扩展正则 ${pattern} 的匹配写入 context.txt，带行号，并保留匹配前 ${before} 行和后 ${after} 行；app.log 保持不变。`, check: expected('context.txt', `-n -E -B ${before} -A ${after}`) },
        { text: `把不匹配 ${pattern} 的原始行按原顺序写入 other.txt，不要行号。`, check: expected('other.txt', '-v -E') },
      ],
      solution: [
        `grep -n -E -B ${before} -A ${after} -- ${quote(pattern)} app.log > context.txt`,
        `grep -v -E -- ${quote(pattern)} app.log > other.txt`,
      ],
      hint: 'grep -E 使用扩展正则，-n 带行号，-B 和 -A 保留上下文，-v 反过来保留未命中的行。行尾的 $ 可以避开“只是包含这段文字”的相似行。',
    };
  },
  df(random, service) {
    const payload = `${service} report ${random.integer(100, 999)}\n`;
    return {
      title: '查看文件系统和目录占用',
      brief: 'data/report.txt 是要保留的报告。请分别记录当前目录所在文件系统，以及 data 目录本身的占用。两者不是同一个数。',
      setup: ['mkdir data', write('data/report.txt', payload)],
      goals: [
        { text: '用 df -P -k . 把文件系统、1024-blocks 总量和挂载点写入 df.txt，三列用空白分隔，不要表头。', check: `df -P -k . | awk 'NR==2 {print $1, $2, $NF}' > .df.expected && awk '{print $1, $2, $3}' df.txt > .df.actual && cmp -s .df.expected .df.actual` },
        { text: '用 du -sk 把 data 的占用写入 du.txt，两列是 KiB 数和路径 data；报告内容保持不变。', check: `du -sk data | awk '{print $1, $2}' > .du.expected && awk '{print $1, $2}' du.txt > .du.actual && cmp -s .du.expected .du.actual && ${equals('data/report.txt', payload)}` },
      ],
      solution: [
        `df -P -k . | awk 'NR==2 {print $1, $2, $NF}' > df.txt`,
        `du -sk data | awk '{print $1, $2}' > du.txt`,
      ],
      hint: 'df 看的是文件系统还有多少空间，du 看的是某个目录占了多少。df -h 适合人读；df -P -k 的列位置固定，适合保存。-P 不会把长文件系统名折成两行。',
    };
  },
  pipeline(random) {
    const token = `token-${random.integer(1000, 9999)}`;
    const limit = random.integer(2, 3);
    const files = [
      ['data/notes/daily report.txt', true],
      ['data/notes/readme.txt', false],
      ['data/job 01.log', true],
      ['data/archive/keep.txt', false],
      ['data/archive/old note.txt', true],
    ] as const;
    const paths = files.map(([path]) => path);
    const hits = files.filter(([, hit]) => hit).map(([path]) => path);
    return {
      title: '分流输出并批量搜索',
      brief: `data 里有带空格的文件名。其中一部分文件包含 ${token}。先列出全部文件，再只留下命中的路径。`,
      setup: ['mkdir -p data/notes data/archive', ...files.map(([path, hit]) => write(path, hit ? `keep ${token}\n` : 'plain note\n'))],
      goals: [
        { text: `把包含 ${token} 的文件相对路径排序写入 hits.txt，每行一个。`, check: equals('hits.txt', sorted(hits)) },
        { text: `把 data 下全部普通文件的相对路径排序写入 all.txt，并把前 ${limit} 行写入 head.txt。`, check: `${equals('all.txt', sorted(paths))} && ${equals('head.txt', text([...paths].sort().slice(0, limit)))}` },
      ],
      solution: [
        `find data -type f -print0 | xargs -0 grep -lF -- ${quote(token)} | sort > hits.txt`,
        `find data -type f | sort | tee all.txt | head -n ${limit} > head.txt`,
      ],
      hint: '文件名含空格时，用 find -print0 配合 xargs -0，避免按空格拆开路径。tee 把同一份输出写入文件并继续传给下一个命令；head -n 只留前面几行。',
    };
  },
  diff(random, service) {
    const port = random.integer(8100, 8999);
    const before = `# ${service}\nPORT=8080\nLOG_LEVEL=debug\n`;
    const after = `# ${service}\nPORT=${port}\nLOG_LEVEL=info\n`;
    const unchanged = `${equals('before.txt', before)} && ${equals('after.txt', after)}`;
    return {
      title: '比较两份配置的差异',
      brief: `before.txt 是当前配置，after.txt 是准备发布的版本。端口将改为 ${port}，日志级别改为 info。请留下差异，不要修改这两个文件。`,
      setup: [write('before.txt', before), write('after.txt', after)],
      goals: [
        { text: '把 before.txt 与 after.txt 的 unified diff 写入 changes.diff。', check: `diff -u before.txt after.txt > .diff.expected || [ $? -eq 1 ]; awk 'NR<=2 {sub(/\\t.*/, "")} {print}' .diff.expected > .diff.norm; awk 'NR<=2 {sub(/\\t.*/, "")} {print}' changes.diff > .diff.actual; cmp -s .diff.norm .diff.actual && ${unchanged}` },
        { text: '用 diff -q 把一句差异说明写入 brief.txt。', check: `diff -q before.txt after.txt > .brief.expected || [ $? -eq 1 ]; cmp -s brief.txt .brief.expected && ${unchanged}` },
      ],
      solution: [
        'diff -u before.txt after.txt > changes.diff || [ $? -eq 1 ]',
        'diff -q before.txt after.txt > brief.txt || [ $? -eq 1 ]',
      ],
      hint: 'diff -u 输出带上下文的差异，文件不同时退出码是 1，不一定是命令写错。diff -q 只说明两个文件是否不同。表头里的时间会变化，比较时可以不看它。',
    };
  },
};
