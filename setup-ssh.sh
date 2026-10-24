#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
tools_dir="$project_dir/.tools/openssh"

if [[ -x /usr/sbin/sshd && -x /usr/lib/openssh/sftp-server ]] \
  && command -v ssh >/dev/null 2>&1 && command -v scp >/dev/null 2>&1; then
  exit 0
fi

architecture="$(uname -m)-linux-gnu"
library_path="$tools_dir/usr/lib/$architecture:$tools_dir/lib/$architecture"
if [[ -x "$tools_dir/usr/sbin/sshd" && -x "$tools_dir/usr/lib/openssh/sftp-server" && -x "$tools_dir/usr/bin/ssh" ]] \
  && LD_LIBRARY_PATH="$library_path" "$tools_dir/usr/sbin/sshd" -V >/dev/null 2>&1 \
  && LD_LIBRARY_PATH="$library_path" "$tools_dir/usr/bin/ssh" -V >/dev/null 2>&1; then
  exit 0
fi

if ! command -v apt-get >/dev/null 2>&1 || ! command -v dpkg-deb >/dev/null 2>&1; then
  printf '本机 SSH 练习需要 OpenSSH 客户端、sshd 和 sftp-server。请使用系统包管理器安装，或使用 Docker 模式。\n' >&2
  exit 1
fi

printf '准备本机 SSH 练习工具：从系统 APT 软件源下载到项目 .tools 目录，不安装系统服务……\n'
mkdir -p "$project_dir/.tools"
download_dir="$(mktemp -d "$project_dir/.tools/ssh-download.XXXXXX")"
trap 'rm -rf -- "$download_dir"' EXIT
mkdir "$download_dir/root"
(
  cd -- "$download_dir"
  apt-get download openssh-client openssh-server openssh-sftp-server libwrap0
)
for package in "$download_dir"/*.deb; do
  dpkg-deb -x "$package" "$download_dir/root"
done

# Newer distributions with split sshd helper executables need a system install;
# their compiled-in helper paths cannot be relocated by merely unpacking a deb.
if compgen -G "$download_dir/root/usr/lib/openssh/sshd-*" >/dev/null; then
  printf '此版本 OpenSSH 使用固定路径的服务端辅助程序，请安装系统 openssh-server 包或使用 Docker 模式。\n' >&2
  exit 1
fi

stage="$download_dir/root"
if ! LD_LIBRARY_PATH="$stage/usr/lib/$architecture:$stage/lib/$architecture" "$stage/usr/sbin/sshd" -V \
  || ! LD_LIBRARY_PATH="$stage/usr/lib/$architecture:$stage/lib/$architecture" "$stage/usr/bin/ssh" -V; then
  printf 'OpenSSH 运行库未就绪，请安装系统 openssh-server 包或使用 Docker 模式。\n' >&2
  exit 1
fi

mkdir -p "$tools_dir"
cp -a "$stage/." "$tools_dir/"
printf 'SSH 练习工具已就绪。练习只启动专属回环服务，不更改 /etc/ssh 或个人 ~/.ssh。\n'
