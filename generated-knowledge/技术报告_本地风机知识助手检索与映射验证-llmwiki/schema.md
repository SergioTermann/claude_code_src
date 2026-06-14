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
- `action`: 处理动作。

## Edge Types

- `HAS_DOCUMENT`
- `HAS_SECTION`
- `MENTIONS_FAULT_CODE`
- `MENTIONS_TERM`
- `MENTIONS_MODEL`
- `BELONGS_TO_SYSTEM`
- `HAS_ACTION`
- `REQUIRES_ACTION`