# Windrise 机理增强知识图谱构建方法

## 目标

传统风电故障知识图谱通常停留在“故障码、部件、现象、处理措施”层面，难以回答现场人员更关心的三个问题：

- 为什么这个故障会发生？
- 为什么要检查这个量？
- 如何验证根因而不是只按经验更换部件？

本方法在故障知识图谱上增加“机理原型层”，把故障案例连接到液压、机械、电气、信号、通信和保护逻辑等底层机理。

## 机理增强 schema

### 节点类型

| 节点类型 | 含义 |
| --- | --- |
| `mechanism_archetype` | 可复用机理原型，例如液压流阻、接触疲劳、信号完整性 |
| `mechanism_layer` | 机理原型内部的层级描述，例如能量转换、介质传递、控制判定 |
| `failure_mode` | 由机理导出的失效模式，例如流阻增大、油膜破裂、屏蔽接地差 |
| `propagation_step` | 故障从底层机理向外部现象传播的中间步骤 |
| `observable` | 能验证机理是否成立的观测量 |
| `verification_test` | 面向现场的验证试验或反事实检查 |
| `control_barrier` | 防止复发的控制屏障或预防措施 |
| `diagnostic_hypothesis` | 多机理竞争时形成的鉴别诊断问题 |
| `discriminating_evidence` | 用于区分竞争机理的关键证据 |
| `counterfactual_test` | 能让竞争机理产生不同结果的反事实试验 |
| `decision_rule` | 根据证据选择机理假设的判别规则 |

### 关系类型

| 关系 | 含义 |
| --- | --- |
| `EXPLAINED_BY_ARCHETYPE` | 故障案例由某个机理原型解释 |
| `HAS_MECHANISM_LAYER` | 机理原型包含某个机理层级 |
| `MECHANISM_RESULTS_IN` | 机理层级形成传播步骤 |
| `MECHANISM_PROPAGATES_TO` | 机理传播链中的前后步骤 |
| `HAS_FAILURE_MODE` | 机理原型包含典型失效模式 |
| `CAN_TRIGGER` | 失效模式可触发具体故障案例 |
| `HAS_OBSERVABLE` | 故障案例应观测某类量 |
| `VALIDATES_ARCHETYPE` | 观测量可验证机理原型 |
| `VERIFIED_BY_TEST` | 故障案例可通过试验验证 |
| `CONTROLLED_BY_BARRIER` | 故障案例可通过控制屏障预防复发 |
| `HAS_COMPETING_HYPOTHESIS` | 故障案例存在需要鉴别的竞争机理假设 |
| `DISCRIMINATES_ARCHETYPE` | 鉴别问题用于区分某个机理原型 |
| `REQUIRES_DISCRIMINATING_EVIDENCE` | 鉴别问题需要补充的关键证据 |
| `RESOLVED_BY_COUNTERFACTUAL_TEST` | 鉴别问题可通过反事实试验解决 |
| `HAS_DECISION_RULE` | 鉴别问题对应的判别规则 |

## 机理原型库

当前内置 6 个机理原型：

1. 液压能量建立与流阻机理
2. 载荷-润滑-接触疲劳机理
3. 电能变换-热应力-绝缘机理
4. 传感-采集-控制反馈机理
5. 通信链路时序与数据一致性机理
6. 保护链与工况边界判定机理

每个原型包含：

- `anchors`：强锚点词，用于防止泛词误匹配
- `keywords`：辅助匹配词
- `layers`：机理层级
- `failureModes`：典型失效模式
- `propagation`：传播步骤
- `observables`：可观测量
- `tests`：验证试验
- `controls`：控制屏障

## 自动挂接算法

对每个故障案例构造上下文：

```text
case_context =
  案例标签
  + 案例别名
  + 系统/部件/摘要
  + 本地故障码样例
  + 一跳相邻节点标签
```

对每个机理原型计算匹配分：

```text
score(case, archetype) =
  sum(keyword_weight)
  + sum(anchor_bonus)
  + archetype_label_bonus
```

其中：

- keyword 命中按词长给 4-18 分。
- anchor 命中额外给 14 分。
- 原型标签直接命中给 20 分。
- 只有命中 anchor，或达到较高分且包含具体词，才允许挂接。

最终每个案例最多挂接 2 个机理原型，保留主要机理和必要的跨域耦合机理。

## 推理链形式

机理增强后的标准多跳链路为：

```text
故障案例
-> EXPLAINED_BY_ARCHETYPE 机理原型
-> HAS_MECHANISM_LAYER 机理层级
-> MECHANISM_RESULTS_IN / MECHANISM_PROPAGATES_TO 传播步骤
-> HAS_FAILURE_MODE 失效模式
-> CAN_TRIGGER 故障案例
-> HAS_OBSERVABLE 可观测量
-> VERIFIED_BY_TEST 验证试验
-> CONTROLLED_BY_BARRIER 控制屏障
```

系统在两类场景下生成鉴别诊断链：

1. 当一个故障案例同时匹配两个机理原型时，生成“双机理竞争”鉴别链，用关键证据区分两个候选机理。
2. 当一个故障案例只匹配一个主机理时，生成“单机理反事实”鉴别链，用现场实测、通道倒换、趋势对齐等试验区分真实机理与测量伪因、工况边界或控制时序伪因。

```text
故障案例
-> HAS_COMPETING_HYPOTHESIS 竞争机理假设
-> DISCRIMINATES_ARCHETYPE 候选机理原型
-> REQUIRES_DISCRIMINATING_EVIDENCE 关键鉴别证据
-> RESOLVED_BY_COUNTERFACTUAL_TEST 反事实试验
-> HAS_DECISION_RULE 判别规则
```

示例：

```text
偏航液压系统压力异常
-> 液压能量建立与流阻机理
-> 节流孔/滤芯/阀芯改变流阻和有效流量
-> 压力动态响应变慢
-> 流阻增大导致建压或回压时间延长
-> 观测压力上升/下降时间
-> 旁通/清理节流元件后复测压力恢复速度
-> 把隐蔽节流/阻尼元件纳入图纸和维护项
```

## 评价指标

| 指标 | 定义 |
| --- | --- |
| 机理覆盖率 | 具备机理原型、失效模式、观测量、验证试验、控制屏障的案例比例 |
| 画像完整率 | 案例画像中包含机理词、失效模式词、验证词的比例 |
| 机理路径深度 | 从案例出发沿机理关系可达的最大深度 |
| 验证闭环覆盖率 | 具备 `HAS_OBSERVABLE` 和 `VERIFIED_BY_TEST` 的案例比例 |
| 预防闭环覆盖率 | 具备 `CONTROLLED_BY_BARRIER` 的案例比例 |
| 假设鉴别覆盖率 | 具备竞争假设、鉴别证据、反事实试验和判别规则的案例比例 |

## 当前实验结果

当前构建结果见：

- `generated-knowledge/windrise-mechanism-graph-evaluation.md`
- `generated-knowledge/windrise-mechanism-graph-evaluation.json`
- `generated-knowledge/windrise-mechanism-case-coverage.md`
- `generated-knowledge/windrise-mechanism-case-coverage.csv`

关键结果：

- 节点数：2326
- 边数：3567
- 机理原型数：6
- 机理节点数：1521
- 机理关系数：2436
- 假设鉴别覆盖率：100.0%
- 双机理竞争鉴别案例数：18
- 单机理反事实鉴别案例数：15
- 机理闭环覆盖率：100.0%
- 机理画像完整率：100.0%
- 传统画像完整率：72.7%
- 机理增强画像完整率：100.0%

## 论文可表述贡献

1. 提出一种面向风电故障诊断的机理原型增强知识图谱 schema。
2. 设计基于锚点词和上下文匹配的机理原型自动挂接方法。
3. 构建故障-机理-失效-观测-验证-预防的闭环推理链。
4. 增加“双机理竞争 + 单机理反事实”的诊断假设层，使每个故障案例都能给出可证伪的鉴别证据、反事实试验和判别规则。
5. 在风电故障知识库上验证该方法可提升案例画像完整性和解释深度。
