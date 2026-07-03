# Wind LLMWiki

这是从本地风电资料生成的 LLMWiki 项目和知识图谱。

## 目录

- `wiki/`：面向人和 `/llmwiki search/read` 的 Markdown 知识页。
- `graph/knowledge-graph.json`：完整知识图谱。
- `graph/triples.jsonl`：关系三元组，适合导入图数据库。
- `graph/nodes.csv`、`graph/edges.csv`：CSV 版本节点和边。
- `graph/visualization.html`：离线知识图谱可视化页面，运行 `npm run visual:wind-graph` 后生成。
- `wiki/quality-report.md`：图谱抽取质量和覆盖率报告。
- `fault-index.jsonl`：复制自原始风机故障码索引，供 `/llmwiki ask/search` 做结构化故障码检索。
- `.llm-wiki/file-snapshot.json`：LLMWiki 项目索引快照。

## 数据来源

- 标准风场机型映射：`风机故障码/00 表达式规则涉及的要配置的标准化-型号和故障手册.md`。
- 故障码记录：`风机故障码/fault-index.jsonl`。
- 原始资料目录：`风机故障码/`。

## 场站说明

场站机型关系优先使用标准映射文件。故障码资料中如果出现标准表未覆盖的场站或范围名，也会保留为图谱节点，用于追溯来源资料。

## 使用

```text
LLMWIKI_PROJECT=wind-llmwiki node scripts/run-lmstudio-claude.mjs --print --bare --max-turns 1 "/llmwiki search 1100007 --limit 3"
LLMWIKI_PROJECT=wind-llmwiki node scripts/run-lmstudio-claude.mjs --print --bare --max-turns 1 "/llmwiki search 新华 SE8715 --limit 3"
LLMWIKI_PROJECT=wind-llmwiki node scripts/run-lmstudio-claude.mjs --print --bare --max-turns 1 "/llmwiki read wiki/knowledge-graph.md"
```

## 重建

```text
npm run build:wind-llmwiki
npm run visual:wind-graph
npm run smoke:wind-llmwiki
```

也可以一次性重建知识库和可视化：

```text
npm run build:wind-knowledge
```