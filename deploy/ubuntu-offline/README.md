# Windrise Ubuntu 离线迁移

目标：把当前 Windrise 项目迁移到一台完全不能联网的 Ubuntu x86_64 电脑，并随包携带 conda 运行环境、Python 依赖、Node.js、npm 依赖和本地知识库文件。

## 重要限制

目标 Ubuntu 不需要网络，也不需要预装 conda、pip、npm、Node.js。目标机安装阶段只会解压文件，不会访问外网。

推荐提前在一台有网的 Ubuntu/Linux x86_64 机器上生成最终离线包。没有 Ubuntu 机器时，也可以在 Mac 上用 `build_on_mac_cross.sh` 跨平台下载 Linux x86_64 依赖并打包；这种方式不能在 Mac 上完整运行验证，最终验证要在目标 Ubuntu 上做。

本包不包含大模型权重或 vLLM 本体。Ubuntu 上需要先启动 OpenAI 兼容的 vLLM 服务，默认地址是 `http://10.46.161.210:9527`，模型名是 `Qwen-30B`。

## 1. 把源码拷到有网 Ubuntu

在当前机器上先打一个源码转运包：

```bash
cd /Users/zinger/claude_code_src
bash deploy/ubuntu-offline/make_source_bundle.sh
```

脚本会生成：

```text
offline-dist/windrise-source-for-online-linux-*.tar.gz
```

把这个源码包拷到有网 Ubuntu，例如：

```bash
scp offline-dist/windrise-source-for-online-linux-*.tar.gz user@ubuntu-online:/tmp/
```

在有网 Ubuntu 上解压：

```bash
mkdir -p ~/windrise-src
tar -xzf /tmp/windrise-source-for-online-linux-*.tar.gz -C ~/windrise-src
cd ~/windrise-src
```

## 2. 在有网 Ubuntu 构建离线包

前提：有网 Ubuntu 已安装 Miniconda/Anaconda、`rsync`、`tar`。

```bash
cd ~/windrise-src
bash deploy/ubuntu-offline/build_bundle.sh
```

脚本会执行：

- 创建/更新 `windrise` conda 环境，含 Python 3.13、Node.js 22、npm、Python Web 服务依赖。
- 重新执行 `npm ci`，生成 Linux x86_64 版 `node_modules`。
- 执行 `npm run build`。
- 用 `conda-pack` 打包 conda 环境。
- 生成 `offline-dist/windrise-ubuntu-offline-YYYYmmdd_HHMMSS.tar.gz`。

## 2B. 没有 Ubuntu 时，在 Mac 上直接构建

Mac 上需要有 conda、npm，并且当前/base Python 里有 `conda-pack`：

```bash
conda install -n base -c conda-forge conda-pack
```

然后在 Mac 上构建 Ubuntu 离线包：

```bash
cd /Users/zinger/claude_code_src
bash deploy/ubuntu-offline/build_on_mac_cross.sh
```

生成：

```text
offline-dist/windrise-ubuntu-offline-YYYYmmdd_HHMMSS.tar.gz
```

## 3. 拷到离线 Ubuntu 并安装

把生成的 `windrise-ubuntu-offline-*.tar.gz` 拷到离线 Ubuntu。

```bash
mkdir -p ~/windrise-offline
tar -xzf windrise-ubuntu-offline-*.tar.gz -C ~/windrise-offline
cd ~/windrise-offline
bash install_offline.sh
```

这一步不需要网络，也不会运行任何在线安装命令。

安装完成后启动 Web 服务：

```bash
./run-web.sh
```

默认访问：

```text
http://10.46.161.210:5002
```

默认管理员账号：

```text
admin / admin
```

## 4. CentOS Docker 一键拷贝和安装

目标机上约定：

- CentOS 宿主机目录 `/0615` 里只放一个最新的 `*.tar.gz` 包。
- Ubuntu 容器 ID 是 `2797b7ba66be`。
- Ubuntu 容器内目标目录是 `/workspace`。
- CentOS 上输入 `d` 可以进入 Ubuntu 容器。

CentOS 宿主机上把这个 alias 写入 `~/.bashrc`：

```bash
alias a='f=/0615/*.tar.gz; if [ ! -e "$f" ]; then echo "ERROR: /0615 下没有 tar.gz 包"; else sudo docker cp "$f" 2797b7ba66be:/workspace/; fi'
```

以后在 CentOS 任意终端输入：

```bash
a
```

进入 Ubuntu 容器后，在 `/workspace` 执行：

```bash
cd /workspace
f=$(find . -maxdepth 1 -type f -name "*.tar.gz" | head -n 1)
workdir="$(basename "$f" .tar.gz)"
mkdir -p "$workdir"
tar -xzf "$f" -C "$workdir"
rm -f "$f"
cd "$workdir"
bash install_offline.sh
./run-web.sh
```

如果你把 `deploy/ubuntu-offline/install_latest_bundle_and_run.sh` 也拷进 Ubuntu 容器，则可以用这一条替代上面的多行命令：

```bash
bash /workspace/install_latest_bundle_and_run.sh
```

## 5. CLI 验证

```bash
source ~/windrise-offline/runtime/conda/bin/activate
cd ~/windrise-offline/windrise
bin/windrise-bash doctor
bin/windrise-bash "303804是什么故障，怎么处理"
```

## 6. 常用配置

默认连接 `10.46.161.210:9527` 上的 vLLM：

```bash
export VLLM_API_URL=http://10.46.161.210:9527/v1/chat/completions
export VLLM_MODEL_NAME=Qwen-30B
./run-web.sh
```

如果 vLLM 的 `--served-model-name` 不是 `Qwen-30B`，把 `VLLM_MODEL_NAME` 改成实际模型名。

如果只想启动 Python Web 服务并让它调用 Windrise：

```bash
export WINDRISE_ENABLED=1
export WINDRISE_BIN=$PWD/windrise/bin/windrise-bash
export WINDRISE_CWD=$PWD/windrise
./run-web.sh
```

## 7. systemd 服务示例

离线 Ubuntu 可新建 `/etc/systemd/system/windrise.service`：

```ini
[Unit]
Description=Windrise Web
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/USER/windrise-offline
ExecStart=/home/USER/windrise-offline/run-web.sh
Restart=always
RestartSec=5
Environment=APP_HOST=0.0.0.0
Environment=VLLM_API_URL=http://10.46.161.210:9527/v1/chat/completions
Environment=VLLM_MODEL_NAME=Qwen-30B

[Install]
WantedBy=multi-user.target
```

替换 `USER` 后执行：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now windrise
sudo systemctl status windrise
```

## 8. 排错

`bin/windrise` 报 `zsh: not found`：使用本包提供的 `bin/windrise-bash`。

`doctor` 连不上模型：确认 Ubuntu 的 vLLM OpenAI 兼容接口已经启动，并且 `VLLM_API_URL` 指向 `http://10.46.161.210:9527/v1/chat/completions`。

`Cannot find module` 或 `sharp` 报错：说明不是在 Linux x86_64 上生成的 `node_modules`，需要回到有网 Ubuntu 重新运行 `build_bundle.sh`。

Web 服务能打开但回答失败：先在离线 Ubuntu 上运行 `bin/windrise-bash doctor`，再看 `run-web.sh` 里 `WINDRISE_BIN`、`WINDRISE_CWD`、`LLMWIKI_PROJECT` 是否正确。
