#!/bin/bash
set -e

# 从 /workspace bind mount 自动检测宿主机 UID/GID
# （/workspace 是宿主机目录的 bind mount，它的 owner 就是宿主机当前用户）
TARGET_UID=$(stat -c %u /workspace)
TARGET_GID=$(stat -c %g /workspace)

# 如果目标是 root，直接执行
if [ "$TARGET_UID" = "0" ]; then
  exec "$@"
fi

# 确保 pi-home 目录存在
mkdir -p /home/piuser/.pi/agent

# 修正归属为宿主机用户
chown -R "${TARGET_UID}:${TARGET_GID}" /home/piuser 2>/dev/null || true

# 直接写入 /etc/passwd 和 /etc/group（绕过 useradd 对大 UID 的潜在问题）
# 容器每次启动 /etc/passwd 是临时的，所以每次都要写
if ! getent group "$TARGET_GID" > /dev/null 2>&1; then
  echo "piuser:x:${TARGET_GID}:" >> /etc/group
fi
if ! getent passwd "$TARGET_UID" > /dev/null 2>&1; then
  echo "piuser:x:${TARGET_UID}:${TARGET_GID}:Pi User:/home/piuser:/bin/bash" >> /etc/passwd
fi

# 以宿主机用户身份执行，HOME 显式设为 /home/piuser
exec gosu "${TARGET_UID}:${TARGET_GID}" env HOME=/home/piuser "$@"
