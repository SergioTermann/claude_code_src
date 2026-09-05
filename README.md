# Windrise

## 风电运维智能知识平台

Windrise 面向风电场运行、检修、集控与值班团队，提供可追溯的故障码检索、场站与机型映射、运维知识问答和对话记录管理。系统采用本地知识库与本地大模型优先的部署方式，适合内网、专有云和离线环境。

<p align="center"><img src="logo.png" alt="Windrise" width="96" /></p>

| 项目状态 | 技术栈 | 默认模型接入 | Web 端口 |
| --- | --- | --- | --- |
| 可运行 | TypeScript、Python、Flask、React/Ink | vLLM / LM Studio（OpenAI 兼容接口） | `5002` |

## 产品能力

- **故障码精准检索**：按故障码、名称、现象、厂家、机型和风场检索，返回原因、处理、复位方式与来源文档。
- **查询路由与条件补全**：自动区分天气、资产、理论知识和故障维修问题；信息不足时先提示补充，减少误匹配。
- **风场资产映射**：维护风场、厂家、机型、风机编号关系，支持同码多义场景分组展示。
- **本地模型推理**：兼容 vLLM、LM Studio 等 OpenAI 兼容服务，核心链路可在内网运行。
- **LLMWiki 知识库**：将 Markdown、表格等资料生成可检索 Wiki、索引和知识图谱。
- **Web 管理与审计**：提供登录、用户管理、知识库文件管理、关键字段提取、对话下载、健康检查和资源监控。
- **CLI 自动化入口**：支持问答、检索、天气、联网抓取、诊断和知识库浏览。

> 现场最终判断必须以 HMI/SCADA 报警、趋势数据、就地检查结果和安全规程为准。Windrise 用于辅助检索、整理与复盘，不替代现场处置流程。

## 系统架构

```text
原始资料 / 故障码 / 资产映射
          │
          ▼
   清洗、标准化、构建索引
          │
          ├── 故障码索引（JSONL）
          ├── LLMWiki（Markdown）
          └── 风场/机型/风机映射与知识图谱
          │
          ▼
 CLI / Web ── 查询预处理 ── 意图路由与条件校验
          │
          ├── 确定性检索（故障码、资产、天气）
          ├── 本地知识检索（LLMWiki）
          └── 通用模型问答 / 工具调用
          │
          ▼
   结构化回答、来源补全、会话记录与日志
```

## 快速开始

### 环境要求

- Node.js 20+，npm 10+
- Python 3.10+（Web 服务与离线部署）
- 可选：已启动的 vLLM 或 LM Studio OpenAI 兼容接口

### CLI

```bash
npm install
npm run build
./bin/windrise
./bin/windrise "303804 如何处理"
./bin/windrise search 偏航 电机
./bin/windrise doctor
```

### Web 服务

```bash
bash deploy/ubuntu-portable/run_web_portable.sh
# 或源码环境
bash deploy/ubuntu-source/run_web_ubuntu.sh
```

浏览器访问 `http://<服务器地址>:5002`。首次启动建议设置管理员账号与密码：

```bash
export APP_HOST=0.0.0.0
export APP_PORT=5002
export INIT_ADMIN_USERNAME=admin
export INIT_ADMIN_PASSWORD='change-me-now'
bash deploy/ubuntu-portable/run_web_portable.sh
```

健康检查：`curl http://127.0.0.1:5002/health`。完整操作说明见 [用户使用手册](docs/用户使用手册.md)，部署与维护说明见 [内部维护人员手册](docs/内部维护人员手册.md)。

## 模型与运行配置

```bash
# vLLM
export VLLM_API_URL=http://127.0.0.1:8000/v1/chat/completions
export VLLM_MODEL_NAME=Qwen-30B

# LM Studio
export LMSTUDIO_BASE_URL=http://127.0.0.1:1234
export LMSTUDIO_MODEL=Qwen-30B
```

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `APP_HOST` / `APP_PORT` | Web 监听地址与端口 | `0.0.0.0` / `5002` |
| `VLLM_API_URL` / `VLLM_MODEL_NAME` | vLLM 接口与模型 | 空 |
| `LMSTUDIO_BASE_URL` / `LMSTUDIO_MODEL` | LM Studio 接口与模型 | 空 |
| `WINDRISE_DISABLE_AUTO_LLMWIKI` | 关闭自动知识库检索 | `0` |

不要将 API Key、`.env`、Flask 密钥或临时凭据提交到仓库或打入发布包。

## 知识库与数据资产

| 路径 | 说明 |
| --- | --- |
| `风机故障码/` | 原始故障码资料与结构化索引 |
| `wind-llmwiki/` | LLMWiki、知识图谱与 schema |
| `src/data/` | 风场/机型和风机编号映射 |
| `generated-knowledge/` | 生成后的知识产品 |
| `reports/` | 评测与验证报告 |

资料更新后执行 `npm run build:knowledge`；持续监听变更可运行 `bash scripts/watch-wind-knowledge.sh`。

## 验证与发布

```bash
npm run typecheck
npm run smoke:wind-llmwiki
npm run smoke:lmstudio
npm run eval:faults
npm run eval:windrise
npm run eval:windrise-retrieval
npm run audit:fault-ambiguity
npm run build
bash deploy/ubuntu-portable/make_portable_bundle.sh
```

离线迁移流程见 [deploy/ubuntu-offline/README.md](deploy/ubuntu-offline/README.md)，Ubuntu 源码部署见 [deploy/ubuntu-source/README_UBUNTU_SOURCE.md](deploy/ubuntu-source/README_UBUNTU_SOURCE.md)。

## 项目结构

```text
src/                 核心 CLI、路由、服务、组件与工具
bin/                 windrise CLI 入口
scripts/             构建、评测、冒烟测试与打包脚本
hn/                  Flask Web 服务、静态页面与运行数据
wind-llmwiki/        风电知识库、图谱与 schema
风机故障码/           原始资料与故障索引
deploy/              Ubuntu portable、源码和离线部署方案
docs/                用户手册与内部维护手册
```

## 使用边界

本仓库包含恢复后的通用智能体源码与 Windrise 风电领域增强模块。部署、数据再分发和模型使用请遵守所在组织的安全策略、数据授权和第三方依赖许可证。
