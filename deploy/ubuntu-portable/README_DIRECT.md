# Windrise Ubuntu Direct-Run Package

Target: Ubuntu/Linux x86_64.

Node.js, Python, Linux native modules, application dependencies, and the local
knowledge base are included. The target machine does not need Node.js, npm,
Python, pip, conda, or internet access.

## Start Web UI

```bash
tar -xzf windrise-ubuntu-x86_64-direct-*.tar.gz
cd windrise-ubuntu-x86_64-direct-*

chmod +x run-web.sh windrise
./run-web.sh
```

Open:

```text
http://<ubuntu-ip>:5002
```

Default administrator account:

```text
admin / admin
```

## Model service (vLLM)

默认直接调用 `http://10.46.161.210:9527/v1/chat/completions`，模型名 `Qwen-30B`。
无需额外 shell 配置；如需修改，在 `app/hn/.env` 中设置 `VLLM_API_URL` / `VLLM_MODEL_NAME`。

## Run CLI

```bash
./windrise doctor
./windrise "303804是什么故障，怎么处理"
```

The first command automatically adapts the bundled runtime to the extracted
path. No installation command is required. Do not move the extracted directory
after its first run; re-extract the archive if a different path is needed.
