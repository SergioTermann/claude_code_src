# Claude Code Src Ubuntu Bundle With Bundled Node

This package does not require `node` or `npm` to be installed on Ubuntu.

It includes:

- Full `claude_code_src` project tree
- Linux x64 Node runtime under `runtime/node`
- Linux x64 `node_modules`
- Web startup scripts for port `5002`

Ubuntu still needs:

- `python3`
- `python3-venv`
- pip access for Python packages, unless you install Python deps another way

Install:

```bash
tar -xzf claude-code-src-full-ubuntu-bundled-node-*.tar.gz
cd claude-code-src-full-ubuntu-bundled-node-*
bash install_no_system_node.sh
./run_web_no_system_node.sh
```

Web:

```text
http://<ubuntu-ip>:5002
```

Default admin:

```text
admin / admin
```
