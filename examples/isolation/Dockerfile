# agent-autoloop 接单程序容器：官方 Node 24 镜像，只跑 join 出来的接单程序。
# 构建：docker build -t autoloop-worker .
# 运行：docker run -d --name autoloop-worker -v "$PWD/worker-config.json:/data/config.json:ro" autoloop-worker
FROM node:24-slim

# 固定到带摘要的镜像升级时，把 FROM 换成 node:24-slim@sha256:<摘要>。

ENV AGENT_AUTOLOOP_HOME=/data
WORKDIR /app

# 只拷贝接单程序需要的检出内容；不含本人的密钥、配置或规则。
COPY bin/ ./bin/
COPY worker/ ./worker/
COPY host/ ./host/
COPY kernel/ ./kernel/
COPY protocol/ ./protocol/
COPY plugins/ ./plugins/
COPY cli/ ./cli/
COPY package.json ./

# config.json 由挂载提供：{ "url": "https://hub.example.com", "worker": { "name": "isolated", "key": "..." } }
VOLUME /data

CMD ["node", "--disable-warning=ExperimentalWarning", "bin/agent-autoloop.ts", "join", "https://hub.example.com", "--worker", "isolated", "--no-service"]
