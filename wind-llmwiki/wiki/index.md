# 风电知识 LLMWiki

这是根据本地风电资料生成的 LLMWiki 和知识图谱项目。

## 数据规模

- 故障记录：11865
- 图谱节点：22680
- 图谱关系：79474
- 风场节点：29
- 品牌节点：13
- 机型节点：66
- 故障码节点：4849
- 系统节点：18

## 推荐入口

- [知识概览](overview.md)
- [知识图谱说明](knowledge-graph.md)
- [图谱质量报告](quality-report.md)
- [高频故障码](faults/top-fault-codes.md)
- [同码多场站/多机型故障码](faults/ambiguous-codes.md)
- [图谱 JSON](../graph/knowledge-graph.json)
- [图谱三元组 JSONL](../graph/triples.jsonl)

## 查询示例

```text
/llmwiki search 新华 SE8715
/llmwiki search 1100007
/llmwiki search 变桨 欠压
/llmwiki read wiki/faults/ambiguous-codes.md
```