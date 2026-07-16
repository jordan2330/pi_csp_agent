FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       bash ca-certificates git ripgrep gosu \
  && rm -rf /var/lib/apt/lists/* \
  && gosu nobody true  # 验证 gosu 安装正确

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=true
ENV NODE_PATH=/usr/local/lib/node_modules

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent
RUN npm install -g playwright
RUN npm install -g pg

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /workspace
ENTRYPOINT ["entrypoint.sh"]
CMD ["pi"]
