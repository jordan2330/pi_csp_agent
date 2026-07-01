FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       bash ca-certificates git ripgrep \
       chromium fonts-wqy-zenhei \
  && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=true
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_PATH=/usr/local/lib/node_modules

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent
RUN npm install -g playwright

# 创建非 root 用户的 home 目录，权限开放给任意 UID
RUN mkdir -p /home/agent/.pi/agent && chmod -R 777 /home/agent

ENV HOME=/home/agent

WORKDIR /workspace
ENTRYPOINT ["pi"]
