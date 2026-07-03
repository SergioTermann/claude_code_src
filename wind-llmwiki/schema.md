# Wind Knowledge Graph Schema

## Node Types

- `site`: 风场或场站。
- `brand`: 风机品牌。
- `model`: 风机型号。
- `fault_code`: 故障码。
- `fault_name`: 故障名称。
- `system`: 所属系统。
- `category`: 故障分类。
- `cause`: 故障原因短语。
- `action`: 处理动作短语。
- `component`: 设备部件或关键元件。
- `reset_mode`: 复位方式或复位权限。
- `source_doc`: 来源文档或来源路径。

## Edge Types

- `USES_MODEL`: 场站使用某机型。
- `MADE_BY`: 机型属于某品牌。
- `OCCURS_AT_SITE`: 故障码出现于某场站。
- `OCCURS_ON_MODEL`: 故障码适用于某机型。
- `BELONGS_TO_SYSTEM`: 故障码属于某系统。
- `HAS_CATEGORY`: 故障码属于某分类。
- `MAY_BE_CAUSED_BY`: 故障可能原因。
- `REQUIRES_ACTION`: 故障处理动作。
- `INVOLVES_COMPONENT`: 故障涉及的设备部件或关键元件。
- `HAS_RESET_MODE`: 故障可用的复位方式或复位权限。
- `HAS_SOURCE`: 故障码来源资料。