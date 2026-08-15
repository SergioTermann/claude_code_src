# Claude Code Src Ubuntu Portable Bundle

This package is intended to run on Ubuntu/Linux x86_64 without installing Node, npm, Python venv, or pip packages on the target machine.

It includes:

- Full `claude_code_src` project
- Linux x64 Node runtime
- Linux x64 `node_modules`
- Linux x64 standalone Python 3.12 runtime
- Python site-packages required by the Flask Web service

Run CLI:

```bash
tar -xzf claude-code-src-full-ubuntu-portable-*.tar.gz
cd claude-code-src-full-ubuntu-portable-*
./windrise "主断路器异常跳开是什么故障造成的"
./windrise doctor
```

Run Web:

```bash
tar -xzf claude-code-src-full-ubuntu-portable-*.tar.gz
cd claude-code-src-full-ubuntu-portable-*
./run_web_portable.sh
```

Web:

```text
http://<ubuntu-ip>:5002
```

Default admin:

```text
admin / admin
```

Model endpoint defaults:

```text
WINDRISE_MODEL_MODE=vllm
VLLM_API_URL=http://10.46.161.210:9527/v1/chat/completions
VLLM_MODEL_NAME=Qwen-30B
LLM_PROVIDER_NAME=vLLM
WINDRISE_QUERY_CONSOLIDATOR_TIMEOUT=45
WINDRISE_LLM_RETRY_SECONDS=5
WINDRISE_SINGLE_SEMANTIC_PASS=1
WINDRISE_STREAM_CHUNK_DELAY=0.02
```

If `claude_code_src/hn/.env` is present, startup scripts load it first.
To create the default Ubuntu vLLM config:

```bash
cp claude_code_src/hn/.env.ubuntu-vllm.example claude_code_src/hn/.env
```

Start your vLLM service separately. Default expected endpoint:

```text
http://10.46.161.210:9527/v1/chat/completions
```

If your vLLM service exposes a different model ID, override the model name:

```bash
VLLM_MODEL_NAME=your/model-id ./run_web_portable.sh
```
