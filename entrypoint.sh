#!/bin/bash
set -e

# 目标用户 UID/GID（从宿主机传入，默认 1000）
TARGET_UID="${HOST_UID:-1000}"
TARGET_GID="${HOST_GID:-${TARGET_UID}}"

# 如果目标是 root，直接执行
if [ "$TARGET_UID" = "0" ]; then
  exec "$@"
fi

# 创建用户（容器每次启动时 /etc/passwd 是临时的，所以需要重建）
if ! getent group "$TARGET_GID" > /dev/null 2>&1; then
  groupadd -g "$TARGET_GID" piuser
fi

if ! getent passwd "$TARGET_UID" > /dev/null 2>&1; then
  useradd -u "$TARGET_UID" -g "$TARGET_GID" -d /home/piuser -s /bin/bash piuser 2>/dev/null || true
fi

PI_USER=$(getent passwd "$TARGET_UID" | cut -d: -f1)

# 确保 pi-home 目录归属正确（只改 /home/piuser，不动 /workspace）
# /workspace 是 bind mount，改它会反向影响宿主机文件
mkdir -p /home/piuser/.pi/agent
chown -R "$TARGET_UID:$TARGET_GID" /home/piuser 2>/dev/null || true

# 以降权用户执行命令
exec gosu "$PI_USER" "$@"
