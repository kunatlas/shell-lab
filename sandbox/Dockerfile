FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash coreutils findutils grep sed gawk less nano tree procps util-linux \
    git curl jq python3 tar gzip diffutils iproute2 openssh-client openssh-server openssh-sftp-server \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /bin/bash student

COPY bashrc /etc/shell-lab.bashrc
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=xterm-256color
USER student
WORKDIR /home/student/workspace
CMD ["sleep", "infinity"]
