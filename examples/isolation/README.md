# 把接单程序隔离出去

接单程序会执行 Agent 命令。给不该碰中台密钥和本人文件的 Agent 一台「专门的电脑」：单独的系统账号，或一个容器。示例只示范装法，**建账号、授权要你自己用 sudo 做**，这里的文件不进 CI，也不被自动测试执行。

无论哪种装法，接单程序都以 `agent-autoloop join <中台地址> --worker <名字> --key <密钥>` 加入，密钥用中台上 `agent-autoloop key new worker <名字>` 生成；隔离机器上不需要也不应该有本人的密钥。

## systemd（Linux，单独账号）

1. 建账号和中台地址的凭据文件（root 做）：

```sh
sudo useradd --system --home /var/lib/autoloop-worker --shell /usr/sbin/nologin autoloop-worker
sudo -u autoloop-worker mkdir -p /var/lib/autoloop-worker
sudo -u autoloop-worker tee /var/lib/autoloop-worker/config.json >/dev/null <<'EOF'
{ "url": "https://hub.example.com", "worker": { "name": "isolated", "key": "<worker 密钥>" } }
EOF
sudo chmod 700 /var/lib/autoloop-worker
sudo chown -R autoloop-worker /var/lib/autoloop-worker
```

2. 装 `autoloop-worker.service`（本目录示例）到 `/etc/systemd/system/`，把里面的路径换成实际安装位置：

```sh
sudo cp autoloop-worker.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now autoloop-worker
```

## launchd（macOS，单独账号）

macOS 的服务以当前用户跑；要隔离就用一个单独的 macOS 用户账号登录一次完成初始化，然后把这个 `autoloop-worker.plist` 装进那个账号的 `~/Library/LaunchAgents/`：

```sh
sudo /System/Library/CoreServices/ManagedClient.app/Contents/Resources/createaccount 2>/dev/null || true
# 或在系统设置里建一个标准账号 autoworker，登录它执行：
sudo -u autoworker mkdir -p ~autoworker/Library/LaunchAgents
sudo -u autoworker cp autoloop-worker.plist ~autoworker/Library/LaunchAgents/
sudo -u autoworker launchctl load ~autoworker/Library/LaunchAgents/autoloop-worker.plist
```

## 容器（Docker，官方 Node 24 镜像）

`Dockerfile` 只把接单程序需要的文件放进去：中台检出、一个只含 `url` 和 worker 密钥的 `config.json`。密钥用构建时的秘密或挂载文件注入，不要写进镜像层：

```sh
docker build -t autoloop-worker .
docker run -d --name autoloop-worker \
  -v "$PWD/worker-config.json:/data/config.json:ro" \
  autoloop-worker
```

容器里的 Agent 只能碰容器内的文件；要给它限制 CPU 和内存，用 `--cpus`、`--memory`。
