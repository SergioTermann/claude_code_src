# Windrise 风电运维智能助手

<p align="center">
  <img src="https://img.shields.io/badge/Base-Recovered%20Agent-blue.svg" alt="Base">
  <img src="https://img.shields.io/badge/Status-Working-green.svg" alt="Status">
  <img src="https://img.shields.io/badge/Language-TypeScript%20%2F%20Python-blue.svg" alt="Language">
  <img src="https://img.shields.io/badge/UI-Ink%20%2F%20React%20%2F%20Web-orange.svg" alt="UI">
  <img src="https://img.shields.io/badge/Model-Qwen--30B%20(local%20vLLM)-purple.svg" alt="Model">
</p>

> 面向**风电运维场景**的本地化智能助手系统，在还原的终端智能体源码基础上改造而来。
> 保留完整终端智能体能力的同时，新增本地大模型接入、风机故障码知识库、意图路由、知识图谱与专用问答入口。

---

## 项目是什么

本项目有两层：

1. **底层**：从一份终端智能体源码包（约 70 万行）中还原的完整源码树，保留命令系统、终端 UI、MCP、插件等能力。
2. **上层（Windrise）**：在上述源码基础上做的本地化改造，把风电故障码资料、场站/机型/风机映射整理成可检索知识库，接入本地大模型（默认 `Qwen-30B`，OpenAI 兼容接口），提供终端问答与 Web 服务两种入口。

系统的核心原则：

> **能确定性查询的，不交给模型猜；需要专业资料的，先检索再回答；信息不足的，先澄清再检索。**

---

## 核心特性

- **风机故障码检索**：从 12 个品牌、**14,118 条**结构化故障记录中按故障码、名称、现象、厂家、机型、风场进行检索，返回原因、处理、复位方式和来源文件。
- **意图路由**：自动区分天气查询、场站机型查询、纯理论问题、故障/维修查询等，选择最合适的数据与执行路径。
- **场站/机型/风机映射**：28 条风场/机型配置、**1,193 条**风机编号映射，支持“只说场站/风机编号/机型简称”时自动补全检索条件。
- **同码多义消歧**：同一短故障码在不同品牌或机型下含义不同时，归并分组展示，不丢失信息。
- **本地大模型**：默认接入本机 vLLM / LM Studio（OpenAI 兼容），不依赖外部 API，适合内网/离线部署。
- **LLMWiki 知识库**：把非结构化资料整理成 Markdown wiki 页 + 知识图谱（节点/边/三元组），可离线可视化。
- **会话记忆与上下文压缩**：多轮对话中保留风场/机型上下文，长对话自动压缩。
- **Web 服务**：Flask 提供网页入口，含登录、用户管理、关键信息提取、对话记录下载、服务器资源监控。

---

## 快速开始

### 1. 终端 CLI

```bash
# 完整交互界面
./bin/windrise

# 轻量连续问答（按需检索知识库）
./bin/windrise ask

# 单次问答 / 检索
./bin/windrise "303804是什么故障"
./bin/windrise search 偏航 电机

# 联网与工具
./bin/windrise web 最新 风机固件
./bin/windrise fetch https://example.com
./bin/windrise weather 北京

# 诊断与浏览
./bin/windrise doctor
./bin/windrise read wiki/knowledge-graph.md
./bin/windrise tree
```

`windrise` 用法一览：

| 用法 | 说明 |
| --- | --- |
| `windrise` | 启动完整交互界面（代码、文件、命令、MCP、复杂任务 + 风电问答） |
| `windrise ask` | 普通回车对话模式，按需检索知识库 |
| `windrise "问题"` | 单次对话 / 检索并总结 |
| `windrise search <关键词>` | 直接检索多个关键词 |
| `windrise web / fetch / weather` | 联网搜索、抓取网页、查询天气 |
| `windrise read / tree` | 读取 LLMWiki 文件 / 查看目录树 |
| `windrise skills / doctor` | 查看离线 skills / 诊断本地模型与知识库状态 |

默认模型配置（可用环境变量覆盖）：

```text
LMSTUDIO_BASE_URL=http://10.46.161.210:9527
LMSTUDIO_MODEL=Qwen-30B
```

关闭自动 LLMWiki 检索：

```bash
WINDRISE_DISABLE_AUTO_LLMWIKI=1 ./bin/windrise "普通问题"
```

### 2. Web 服务

```bash
./run_web_portable.sh
```

浏览器访问 `http://服务器IP:5002`，默认管理员 `admin / admin`。详见 [`docs/用户使用手册.md`](docs/用户使用手册.md)。

---

## 系统架构

```text
原始风机资料 / 故障表 / 映射数据
                |
                v
       构建脚本清洗、标准化、建索引
                |
                v
   LLMWiki + 故障索引 + 风场/机型/风机映射
                |
                v
用户 -> windrise 入口 -> 使用模式选择 -> 输入预处理
                                      |
                                      v
                         意图识别与领域路由
                 _____________|________________
                |             |                |
                v             v                v
          确定性查询       本地知识检索      通用模型/联网/工具
                |             |                |
                +-------------+----------------+
                              |
                              v
                    答案组织、来源补全、流式输出
                              |
                              v
                    对话记忆、日志和上下文压缩
```

### 意图路由决策树

```
用户查询
  ├─ 天气查询?            → 天气 API
  ├─ 风场机型查询?         → 映射表查询（多机型且有故障上下文则先消歧）
  ├─ 纯理论问题?          → 本地模型通用知识回答
  ├─ 故障/维修查询?       → 完备性检查 → 检索 LLMWiki
  │    ├─ 有故障码/机号         → 直接检索
  │    ├─ 有风场 + 机型         → 直接检索
  │    └─ 缺风场/机型           → 提示补充，不贸然给结论
  └─ 其他                 → 本地模型通用知识回答
```

详见 [`ROUTING_DESIGN.md`](ROUTING_DESIGN.md) 与 [`SYSTEM_WORKFLOW_AND_USER_OPTIMIZATIONS.md`](SYSTEM_WORKFLOW_AND_USER_OPTIMIZATIONS.md)。

---

## 知识数据

### 故障码索引

`风机故障码/fault-index.jsonl`，共 **14,118** 条记录，按品牌分布：

| 品牌 | 记录数 | 品牌 | 记录数 |
| --- | --- | --- | --- |
| 明阳 | 4,309 | 华仪 | 664 |
| 运达 | 2,165 | 湘电 | 615 |
| 上海电气 | 1,878 | 中车山东 | 409 |
| 三一 | 1,575 | 歌美飒 | 187 |
| 远景 | 1,449 | 新誉 | 111 |
| 华锐 | 703 | 金风 | 53 |

每条记录包含：故障码、故障名称、风场、品牌、机型、具体型号、风机编号、描述、原因、处理、复位、程序逻辑、来源位置等字段。

### 知识图谱

`wind-llmwiki/graph/` 下的节点与边：

- **节点类型**：`site`（场站）、`brand`（品牌）、`model`（机型）、`fault_code`、`fault_name`、`system`、`category`、`cause`、`action`、`component`、`reset_mode`、`source_doc`。
- **边类型**：`USES_MODEL`、`MADE_BY`、`OCCURS_AT_SITE`、`OCCURS_ON_MODEL`、`BELONGS_TO_SYSTEM`、`HAS_CATEGORY`、`MAY_BE_CAUSED_BY`、`REQUIRES_ACTION`、`INVOLVES_COMPONENT`、`HAS_RESET_MODE`、`HAS_SOURCE`。

完整 schema 见 [`wind-llmwiki/schema.md`](wind-llmwiki/schema.md)。

---

## 项目结构

```
windrise/
├── src/                    # 还原的终端智能体源码（命令、服务、组件、工具）
│   ├── commands/           # 命令系统（llmwiki、lmstudio、mcp、review 等）
│   ├── services/           # 会话记忆、压缩、MCP、鉴权等
│   ├── components/         # React + Ink 终端 UI
│   ├── data/               # windFarmModels.json、turbineMapping.json
│   └── utils/              # 风场机型映射、LLMWiki 发现、模型配置等
├── bin/windrise            # Windrise 入口脚本
├── scripts/                # 构建 / 评测 / 冒烟 / 打包脚本
├── wind-llmwiki/           # 风电知识库与知识图谱
├── 风机故障码/             # 原始故障码资料与索引
├── hn/                     # Flask Web 服务（登录、用户管理、聊天）
├── deploy/                 # Ubuntu portable / offline 打包
├── docs/                   # 用户手册、维护手册
├── generated-knowledge/    # 生成的知识产物
└── reports/                # 评测报告
```

---

## 常用脚本

### 构建知识库

```bash
npm run build:fault-index       # 重建故障码索引
npm run build:wind-llmwiki      # 重建 LLMWiki 知识库
npm run build:wind-farm-models  # 重建风场/机型映射
npm run build:turbine-mapping   # 重建风机编号映射
npm run build:knowledge         # 故障索引 + LLMWiki
npm run build:wind-knowledge    # LLMWiki + 知识图谱可视化
npm run visual:wind-graph       # 生成知识图谱可视化页面
```

维护人员日常新增/修改资料后，直接执行：

```bash
bash scripts/reload-wind-knowledge.sh   # 重建索引与映射
bash scripts/watch-wind-knowledge.sh    # 常驻监听 md/xlsx 变化自动重建
```

### 评测与冒烟

```bash
npm run smoke:wind-llmwiki      # LLMWiki 冒烟测试
npm run smoke:lmstudio          # 本地模型冒烟测试
npm run eval:faults             # 故障码评测
npm run eval:windrise           # Windrise 问答评测
npm run eval:windrise-retrieval # 检索评测
npm run audit:fault-ambiguity   # 短故障码歧义审计
```

### 本地模型

```bash
npm run run:lmstudio            # 通过本地模型运行智能助手
npm run print:lmstudio          # 打印本地模型单次问答
```

---

## 部署

支持 Ubuntu portable 离线部署（无需目标机安装 Node / Python 环境）：

```bash
bash deploy/ubuntu-portable/make_portable_bundle.sh
```

生成包解压后即可运行：

```bash
tar -xzf windrise-ubuntu-portable-*.tar.gz
cd windrise-ubuntu-portable-*
./run_web_portable.sh           # Web 服务（端口 5002）
# 或
./windrise "主断路器异常跳开是什么故障造成的"
```

默认模型接口配置为本机 vLLM：

```text
VLLM_API_URL=http://10.46.161.210:9527/v1/chat/completions
VLLM_MODEL_NAME=Qwen-30B
```

部署与维护细节见 [`docs/内部维护人员手册.md`](docs/内部维护人员手册.md) 与 [`deploy/ubuntu-portable/README_PORTABLE.md`](deploy/ubuntu-portable/README_PORTABLE.md)。

---

## 文档

| 文档 | 说明 |
| --- | --- |
| [`docs/用户使用手册.md`](docs/用户使用手册.md) | 面向风场运行/检修/集控/值班人员的 Web 使用手册 |
| [`docs/内部维护人员手册.md`](docs/内部维护人员手册.md) | 部署、资料维护、用户管理、打包发布 |
| [`SYSTEM_WORKFLOW_AND_USER_OPTIMIZATIONS.md`](SYSTEM_WORKFLOW_AND_USER_OPTIMIZATIONS.md) | 系统完整流程与体验优化说明 |
| [`ROUTING_DESIGN.md`](ROUTING_DESIGN.md) | 问答路由决策树与测试用例 |
| [`wind-llmwiki/schema.md`](wind-llmwiki/schema.md) | 知识图谱 schema |

---

## 免责声明

- **研究用途**：底层终端智能体源码仅用于归档、结构分析与源码阅读；上层 Windrise 为面向风电运维的本地化改造。
- **安全提示**：现场最终判断仍以 HMI/SCADA 原始报警、趋势量、就地检查结果和现场安全规程为准，智能助手仅用于辅助检索、整理与复盘，不替代现场处置流程。

---

## 致谢

感谢风电运维场景对 Windrise 智能助手改造的需求驱动。
