# Schema

## Node Types

- `corpus`: 输入文件或目录。
- `document`: 文档。
- `section`: 文档段落或章节。
- `fault_code`: 故障码。
- `fault_name`: 故障名称。
- `term`: 领域术语。
- `model`: 型号或代码式实体。
- `system`: 系统名称。
- `component`: 部件。
- `causal_factor`: 原因或触发因素。
- `symptom`: 故障表现或结果。
- `diagnostic_signal`: 诊断信号或测点。
- `action`: 处理动作。

## Edge Types

- `HAS_DOCUMENT`
- `HAS_SECTION`
- `MENTIONS_FAULT_CODE`
- `MENTIONS_TERM`
- `MENTIONS_MODEL`
- `BELONGS_TO_SYSTEM`
- `INVOLVES_COMPONENT`
- `STATES_CAUSE`
- `STATES_SYMPTOM`
- `STATES_SIGNAL`
- `CAN_TRIGGER`
- `LEADS_TO`
- `MAY_BE_CAUSED_BY`
- `MANIFESTS_AS`
- `DIAGNOSED_BY`
- `HAS_ACTION`
- `REQUIRES_ACTION`
- `MITIGATED_BY`