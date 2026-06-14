# 知识图谱说明

本知识图谱以风电运维问答为目标，将本地故障资料和风场机型标准化表抽取为实体与关系。

## 图谱文件

- `graph/knowledge-graph.json`：完整节点、关系、统计索引。
- `graph/triples.jsonl`：逐行关系记录，适合导入图数据库或检索系统。
- `graph/nodes.csv`：节点表。
- `graph/edges.csv`：边表。

## 典型路径

- 风场 -> `USES_MODEL` -> 机型 -> `MADE_BY` -> 品牌
- 故障码 -> `OCCURS_ON_MODEL` -> 机型
- 故障码 -> `BELONGS_TO_SYSTEM` -> 系统
- 故障码 -> `MAY_BE_CAUSED_BY` -> 原因
- 故障码 -> `REQUIRES_ACTION` -> 处理动作
- 故障码 -> `INVOLVES_COMPONENT` -> 部件
- 故障码 -> `HAS_RESET_MODE` -> 复位方式

## 当前规模

- 节点：22680
- 关系：79474