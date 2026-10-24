#!/usr/bin/env bash
set -euo pipefail

# Resolve the checkout independently of the terminal's current directory.
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$project_dir"

if [[ "$(uname -s)" != Linux ]]; then
  printf '桌面版需要 Linux 图形环境。Windows 请在 WSL2 中运行；macOS 请使用 README 中的 Docker 模式。\n' >&2
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

# Builds need dev dependencies; Electron and node-pty must have their native files.
if [[ ! -f node_modules/.package-lock.json ]] \
  || [[ package-lock.json -nt node_modules/.package-lock.json ]] \
  || [[ package.json -nt node_modules/.package-lock.json ]] \
  || [[ ! -x node_modules/.bin/vite ]] \
  || [[ ! -x node_modules/.bin/tsx ]] \
  || [[ ! -x node_modules/electron/dist/electron ]] \
  || [[ ! -f node_modules/node-pty/build/Release/pty.node ]]; then
  printf '正在安装项目依赖，首次运行需要联网……\n'
  npm ci --include=dev --no-audit --no-fund
fi

# Electron 44 的 npm 包不再带 postinstall；显式解压缓存中的本机二进制。
if [[ ! -x node_modules/electron/dist/electron ]]; then
  printf '正在准备 Electron 本机二进制……\n'
  node node_modules/electron/install.js
fi

# npm 11 的 install-scripts 白名单可能跳过 node-pty 的构建脚本。
if [[ ! -f node_modules/node-pty/build/Release/pty.node ]]; then
  printf '正在准备 node-pty 本机二进制……\n'
  if ! npm rebuild node-pty >/dev/null 2>&1; then
    printf 'node-pty 构建脚本被 npm 拦截。请运行 `npm install-scripts approve node-pty` 后重试，或检查 python3/make/g++ 是否可用。\n' >&2
    exit 1
  fi
fi

if [[ ! -x node_modules/electron/dist/electron ]] || [[ ! -f node_modules/node-pty/build/Release/pty.node ]]; then
  printf 'Electron 或 node-pty 的本机二进制仍未就绪。Electron 可尝试重新运行 node node_modules/electron/install.js；node-pty 请检查构建工具。\n' >&2
  exit 1
fi

# SSH/SCP scenarios can use project-local tools when the host lacks them.
if ! bash "$project_dir/setup-ssh.sh"; then
  printf 'SSH/SCP 场景暂未就绪，其他场景仍可使用。稍后可单独运行 ./setup-ssh.sh 重试。\n' >&2
fi

# Prefer the isolated Docker runtime, but fall back to the host Bash when it is not ready.
requested_runtime="${SHELL_LAB_RUNTIME:-auto}"
image="${SHELL_LAB_IMAGE:-shell-lab-sandbox:1}"
docker_cli=false
docker_access=false
docker_ready=false
if command -v docker >/dev/null 2>&1; then
  docker_cli=true
  if timeout 5 docker info >/dev/null 2>&1; then
    docker_access=true
    if timeout 5 docker image inspect "$image" >/dev/null 2>&1; then
      docker_ready=true
    fi
  fi
fi

case "$requested_runtime" in
  auto)
    if $docker_ready; then runtime=docker; else runtime=local; fi
    ;;
  docker)
    if ! $docker_ready; then
      if ! $docker_cli; then
        printf '未找到 docker 命令。请先安装 Docker，或改用 SHELL_LAB_RUNTIME=local。\n' >&2
      elif ! $docker_access; then
        printf '无法访问 Docker。请启动 Docker，或重新登录以应用 docker 组权限。\n' >&2
      else
        printf '练习镜像 %s 尚未构建。请先运行 npm run sandbox:build。\n' "$image" >&2
      fi
      exit 1
    fi
    runtime=docker
    ;;
  local)
    runtime=local
    ;;
  *)
    printf 'SHELL_LAB_RUNTIME 只能是 docker 或 local。\n' >&2
    exit 1
    ;;
esac
export SHELL_LAB_RUNTIME="$runtime"

desktop_port="${SHELL_LAB_DESKTOP_PORT:-3002}"
if ! [[ "$desktop_port" =~ ^[0-9]+$ ]] || (( desktop_port < 1 || desktop_port > 65535 )); then
  printf 'SHELL_LAB_DESKTOP_PORT 必须是 1 到 65535 之间的整数。\n' >&2
  exit 1
fi
export SHELL_LAB_DESKTOP_PORT="$desktop_port"

# Fail before building when the desktop port is already occupied.
node --input-type=module <<'NODE'
import { createServer } from 'node:net';
const port = Number(process.env.SHELL_LAB_DESKTOP_PORT);
await new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', (error) => {
    console.error(error.code === 'EADDRINUSE'
      ? `端口 ${port} 已被占用，请先关闭占用该端口的程序。`
      : `无法使用本机端口 ${port}：${error.message}`);
    reject(error);
  });
  server.listen(port, '127.0.0.1', () => server.close(resolve));
}).catch(() => process.exit(1));
NODE

printf '\nShellLab · 桌面版\n'
if [[ "$runtime" == docker ]]; then
  printf '练习环境：独立 Linux 容器（%s）\n' "$image"
else
  printf '练习环境：本机 Bash · 未隔离\n'
  printf '注意：命令会以你的系统用户执行，可访问本机文件。\n'
  if ! $docker_ready; then
    if ! $docker_cli; then
      printf '提示：未检测到 Docker；安装并构建镜像后可启用隔离模式。\n'
    elif ! $docker_access; then
      printf '提示：Docker 未运行或当前用户无权限；重新登录后再启动即可自动使用 Docker 模式。\n'
    else
      printf '提示：练习镜像 %s 尚未构建；运行 npm run sandbox:build 后可启用 Docker 模式。\n' "$image"
    fi
  fi
fi
printf '关闭窗口即退出 ShellLab。\n\n'

exec npm run desktop -- "$@"
