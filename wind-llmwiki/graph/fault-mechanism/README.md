# 故障-机理知识图谱

这是从本地风机故障码资料和公开技术资料建立的第一版故障机理子图。

## 文件

- `knowledge-graph.json`：节点、关系、统计索引。
- `triples.jsonl`：逐行关系记录。
- `nodes.csv` / `edges.csv`：便于导入表格或图数据库。

## 当前规模

- 机理模板：24
- 来源：6
- 本地故障记录：11865
- 已挂接故障记录：3921
- 节点：4519
- 关系：6507

## 主要关系

- `fault_record -> EXPLAINED_BY_MECHANISM -> mechanism`
- `causal_factor -> CAN_TRIGGER -> mechanism`
- `mechanism -> MANIFESTS_AS -> symptom`
- `mechanism -> DIAGNOSED_BY -> diagnostic_signal`
- `mechanism -> MITIGATED_BY -> mitigation`
- `question_pattern -> ROUTES_TO_MECHANISM -> mechanism`
- `mechanism -> SUPPORTED_BY_SOURCE -> source`

## 外部来源

- [Fault Diagnosis and Prognosis Capabilities for Wind Turbine Hydraulic Pitch Systems](https://arxiv.org/abs/2312.09018)：液压变桨系统诊断能力、常见故障和传感器可诊断性。
- [Vibration Fault Diagnosis in Wind Turbines based on Automated Feature Learning](https://arxiv.org/abs/2201.13403)：风机齿轮箱等旋转部件可通过振动测量进行故障状态评估。
- [Digital Twin Framework for Time to Failure Forecasting of Wind Turbine Gearbox](https://arxiv.org/abs/2205.03513)：齿轮箱健康可用 SCADA 时间序列、温度、转速、功率等变量建模。
- [Review for AI-based Open-Circuit Faults Diagnosis Methods in Power Electronics Converters](https://arxiv.org/abs/2209.14058)：电力电子变换器开路类故障特征和智能诊断方法综述。
- [IEC 61400-25 monitoring and control information model](https://webstore.iec.ch/searchform&q=61400-25)：风电场监控通信、信息模型和状态监测逻辑节点标准族。
