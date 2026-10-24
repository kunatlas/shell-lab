#!/usr/bin/env bash
set -euo pipefail

# Resolve the checkout independently of the terminal's current directory.
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$project_dir"

if [[ "$(uname -s)" != Linux ]]; then
  printf '本机模式需要 Linux。Windows 请在 WSL2 中运行，macOS 请使用 README 中的 Docker 模式。\n' >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf '请先安装 Node.js 22.12 或更新版本（包含 npm），再运行本脚本。\n' >&2
  exit 1
fi

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)'; then
  printf '当前 Node.js 版本为 %s，需要 22.12 或更新版本。\n' "$(node --version)" >&2
  exit 1
fi

# Keep the API port consistent with Vite's proxy, including when .env exists.
export SHELL_LAB_RUNTIME=local
export NODE_ENV=development
export PORT=3001

if [[ ! -f node_modules/.package-lock.json ]] \
  || [[ package-lock.json -nt node_modules/.package-lock.json ]] \
  || [[ package.json -nt node_modules/.package-lock.json ]] \
  || [[ ! -x node_modules/.bin/vite ]] \
  || [[ ! -x node_modules/.bin/tsx ]] \
  || [[ ! -x node_modules/.bin/concurrently ]]; then
  printf '正在安装项目依赖，首次运行需要联网……\n'
  npm ci --include=dev --no-audit --no-fund
fi

# OpenSSH can run as an ordinary user; prepare project-local binaries if needed.
if ! bash "$project_dir/setup-ssh.sh"; then
  printf 'SSH/SCP 场景暂未就绪，其他场景仍可使用。稍后可单独运行 ./setup-ssh.sh 重试。\n' >&2
fi

# Report occupied ports clearly rather than leaving one half of the app running.
node --input-type=module <<'NODE'
import { createServer } from 'node:net';
for (const port of [3001, 5173]) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error) => {
      console.error(error.code === 'EADDRINUSE'
        ? `端口 ${port} 已被占用，请先关闭之前启动的 ShellLab 或占用该端口的程序。`
        : `无法使用本机端口 ${port}：${error.message}`);
      reject(error);
    });
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  }).catch(() => process.exit(1));
}
NODE

printf '\nShellLab · 本机模式\n'
printf '注意：命令会以你的系统用户执行，可访问本机文件，没有容器隔离。\n'
printf '启动完成后打开：http://127.0.0.1:5173\n'
printf '停止服务：在此终端按 Ctrl+C\n\n'

exec npm run dev
