# Windrise Ubuntu Source Deployment

This package is for Ubuntu/Linux deployment with dependencies installed on the target machine.

Requirements on Ubuntu:

- Python 3.10+
- Node.js 22+
- npm
- A local or LAN OpenAI-compatible vLLM server, default `http://10.46.161.210:9527`

Install and run:

```bash
tar -xzf windrise-ubuntu-source-*.tar.gz
cd windrise-ubuntu-source-*
bash install_ubuntu.sh
./run_web_ubuntu.sh
```

`install_ubuntu.sh` creates `windrise/hn/.env` from the bundled Ubuntu vLLM
template when no existing configuration is present. Edit that file if the
model endpoint or served model name differs from the defaults.

Web UI:

```text
http://<ubuntu-ip>:5002
```

Default admin:

```text
admin / admin
```

If the model endpoint or model name is different:

```bash
export WINDRISE_MODEL_MODE=vllm
export LMSTUDIO_BASE_URL=http://10.46.161.210:9527
export LMSTUDIO_MODEL=Qwen-30B
./run_web_ubuntu.sh
```

For systemd, copy `windrise-web.service.example` to `/etc/systemd/system/windrise-web.service`, edit `User`, `WorkingDirectory`, `ExecStart`, and environment values, then run:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now windrise-web
```
