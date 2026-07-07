function has(text: string, pattern: RegExp): boolean {
  return pattern.test(text)
}

function pickRisk(text: string): string {
  if (has(text, /安全链|急停|雷击|浪涌|接地|并网|主轴承|齿轮箱|发电机轴承/)) return '高'
  if (has(text, /变桨|24V|通信|通讯|传感器|水冷|油温|滤芯|接触器反馈/)) return '中'
  return '中（待现场确认）'
}

function pickSystem(text: string): string {
  if (has(text, /变桨/)) return '变桨系统'
  if (has(text, /偏航/)) return '偏航系统'
  if (has(text, /通信|通讯/)) return '通信系统'
  if (has(text, /水冷/)) return '水冷系统'
  if (has(text, /齿轮箱|油温|滤芯/)) return '齿轮箱系统'
  if (has(text, /发电机轴承|发电机温度/)) return '发电机系统'
  if (has(text, /安全链|急停/)) return '安全链系统'
  if (has(text, /并网|电网|接触器|断路器/)) return '电网/并网系统'
  return '待补充'
}

function pickComponent(text: string): string {
  if (has(text, /24V|24\s*v/i)) return '24V 控制电源/反馈回路'
  if (has(text, /传感器|编码器/)) return '传感器/编码器与采集回路'
  if (has(text, /液压|压力|阀|泵|蓄能器/)) return '液压阀组/泵/压力回路'
  if (has(text, /接触器|断路器|开关|反馈/)) return '开关/接触器/断路器反馈回路'
  return '待补充'
}

function pickTurbine(text: string): string {
  const match = text.match(/(?:WTG[-_ ]?)?0*(\d+)\s*(?:号机|#|机组)?/i)
  return match ? `WTG-${String(match[1]).padStart(3, '0')}` : '待补充'
}

function pickFaultCode(text: string): string {
  return text.match(/[A-Za-z]?_?[0-9]{3,}/)?.[0] || '待补充'
}

function pickTimeWindow(text: string): string {
  return text.match(/近\s*\d+\s*(?:分钟|小时)|last[_ -]?\d+\w*/i)?.[0] ||
    (has(text, /当前|现在|今天|今日|刚才/) ? '当前/近期窗口' : '待补充')
}

function pickMissingContext(text: string): string {
  const missing: string[] = []
  if (pickTurbine(text) === '待补充') missing.push('风机ID')
  if (pickSystem(text) === '待补充') missing.push('系统/部件')
  if (pickFaultCode(text) === '待补充' && !has(text, /故障|报警|告警|异常|低压|跳变|压力|温度|振动|反馈/)) {
    missing.push('故障码或告警现象')
  }
  if (pickTimeWindow(text) === '待补充') missing.push('运行时间窗')
  if (!has(text, /风速|停机|限功率|复位|作业票|HMI|SCADA|CMS/i)) {
    missing.push('运行状态/安全条件')
  }
  return missing.length ? missing.join('、') : '无明显缺口'
}

function pickFaultPhenomenon(text: string): string {
  const parts = text.split(/[；;。\n]/).map(item => item.trim()).filter(Boolean)
  return parts[0] || text.trim() || '待补充'
}

function pickLikelyJudgment(text: string): string {
  if (has(text, /24V.*反馈.*丢失|反馈.*丢失.*24V/)) return '主电源开关辅助触点或 PLC 反馈回路异常'
  if (has(text, /水冷|压力低/)) return '水冷回路流量或阀门/过滤器异常'
  if (has(text, /传感器|跳变/)) return '传感器测量回路或接地屏蔽异常'
  if (has(text, /齿轮箱|油温|滤芯/)) return '齿轮箱润滑过滤阻力偏大或油液污染'
  if (has(text, /安全链|急停/)) return '安全链中某个串联开关或安全继电器断开'
  if (has(text, /雷雨|雷击|浪涌|SPD|接地/)) return '雷击浪涌后供电或接地保护回路异常'
  if (has(text, /发电机轴承|轴承温度/)) return '测温或冷却异常，需同时排查轴承润滑状态'
  if (has(text, /并网|接触器|断路器/)) return '并网执行回路或反馈回路不一致'
  return '待补充'
}

function pickFirstAction(text: string): string {
  if (has(text, /24V.*反馈.*丢失|反馈.*丢失.*24V/)) return '先量主电源开关两侧 24V，再核对辅助触点到 PLC 输入点的通断'
  if (has(text, /水冷|压力低/)) return '先查水泵运行状态和过滤器压差'
  if (has(text, /传感器|跳变/)) return '先用独立仪表复测现场值，再对比 HMI/SCADA 显示'
  if (has(text, /齿轮箱|油温|滤芯/)) return '先查油冷运行状态、油位和滤芯压差'
  if (has(text, /安全链|急停/)) return '先看急停是否复位，再从安全继电器输入端逐点找断点'
  if (has(text, /雷雨|雷击|浪涌|SPD|接地/)) return '先查 SPD 指示、24V 输出和接地排连接'
  if (has(text, /发电机轴承|轴承温度/)) return '先复核测温探头和冷却风道'
  if (has(text, /并网|接触器|断路器/)) return '先核对三相电压频率和断路器/接触器反馈'
  return '先补充现场现象，再确认一个最可能方向'
}

function pickAcceptance(text: string): string {
  if (has(text, /24V.*反馈.*丢失|反馈.*丢失.*24V/)) return '24V 正常且开关实际位置、辅助触点、PLC 输入状态一致'
  if (has(text, /水冷|压力低/)) return '水泵运行、液位正常后压力能恢复到要求范围'
  if (has(text, /传感器|跳变/)) return '现场实测稳定而 HMI/SCADA 仍跳变时，优先查测量回路'
  if (has(text, /齿轮箱|油温|滤芯/)) return '换滤芯后压差明显下降，油样无明显污染'
  if (has(text, /安全链|急停/)) return '所有串联安全点闭合且安全继电器吸合'
  if (has(text, /雷雨|雷击|浪涌|SPD|接地/)) return 'SPD 未失效、24V 稳定、接地可靠'
  if (has(text, /发电机轴承|轴承温度/)) return '振动平稳且温度探头、冷却通风正常后温度仍持续升高'
  if (has(text, /并网|接触器|断路器/)) return '现场位置与 PLC 反馈一致后再继续并网测试'
  return '结论成立或不成立都要给出下一步'
}

function pickFeedback(text: string): string {
  if (has(text, /24V.*反馈.*丢失|反馈.*丢失.*24V/)) return '24V 实测值、开关实际位置、辅助触点状态、PLC 输入点状态'
  if (has(text, /水冷|压力低/)) return '水泵运行状态、过滤器压差、当前压力/流量'
  if (has(text, /传感器|跳变/)) return '现场实测值、HMI/SCADA 显示值、供电或回路电阻'
  if (has(text, /齿轮箱|油温|滤芯/)) return '油冷运行状态、油位、滤芯压差、油样外观'
  if (has(text, /安全链|急停/)) return '急停状态、安全继电器状态、第一个断点位置'
  if (has(text, /雷雨|雷击|浪涌|SPD|接地/)) return 'SPD 指示状态、24V 输出、接地连接、异常模块范围'
  if (has(text, /发电机轴承|轴承温度/)) return '轴承温度趋势、振动趋势、测温探头状态、冷却风道/风扇状态'
  if (has(text, /并网|接触器|断路器/)) return '接触器/断路器实际位置、辅助触点状态、PLC 输入点状态'
  return '现场验证结果'
}

function pickPlannerPath(text: string): string[] {
  const firstAction = pickFirstAction(text)
  return [
    '确认风机ID、机型、控制器版本、当前停机/限功率状态。',
    '拉取CMS/SCADA时间窗趋势和告警平台伴随告警。',
    '检索故障码表、厂家手册、场站SOP和已关闭历史工单。',
    `现场只执行一个首个动作：${firstAction}`,
    '将验证结果写入工单反馈字段，等待复核后再收敛根因。',
  ]
}

function pickEvidenceSource(text: string): string {
  if (pickFaultCode(text) !== '待补充') return '本地故障码表/LLMWiki 检索结果（待引用具体来源路径）'
  if (has(text, /SOP|手册|厂家|历史工单/)) return '用户提供的手册/SOP/历史工单线索（待核验来源路径）'
  return '当前用户输入与已知现场反馈；需补充厂家手册、场站SOP、历史工单或实时数据来源'
}

function pickLongTermMemory(text: string): string {
  const items = ['已验收根因', '最终处置措施', '复发情况', '停机时长', '专家复核结论']
  if (has(text, /更换|备件|模块|传感器|接触器|阀|泵/)) items.push('确认更换部件和备件型号')
  return items.join('、')
}

function pickShortTermMemory(text: string): string {
  const items = ['当前告警窗口', '近期复位状态', '临时限功率/旁路', '当天风况', '未验收候选原因']
  if (has(text, /天气|风速|临时|旁路|限功率|观察/)) items.push('短期天气或临时运行限制')
  return items.join('、')
}

export function buildSmartWorkOrderMarkdown(args: string): string {
  const text = String(args || '').trim()
  const request = text || '待补充'
  return [
    '# 智能工单',
    '',
    '## 1. 工单摘要',
    '',
    `- 工单类型：${has(text, /报告|整理|总结/) ? '报告整理工单' : '现场处理工单'}`,
    `- 风场/机组：待补充`,
    `- 系统/部件：${pickSystem(text)}`,
    `- 故障现象：${pickFaultPhenomenon(request)}`,
    `- 风险等级：${pickRisk(text)}`,
    `- 当前状态：待现场确认`,
    '',
    '## 2. 已知现场信息',
    '',
    `- ${request}`,
    '',
    '## 3. 结构化故障 Case',
    '',
    `- 风机/机型：${pickTurbine(text)} / 待补充`,
    `- 系统/部件：${pickSystem(text)} / ${pickComponent(text)}`,
    `- 故障码/告警：${pickFaultCode(text)}`,
    `- 时间窗：${pickTimeWindow(text)}`,
    `- 运行状态：待补充`,
    `- 缺失信息：${pickMissingContext(text)}`,
    '',
    '## 4. 证据来源与分级',
    '',
    '- 厂家手册/故障码表：待补充',
    '- 场站 SOP：待补充',
    '- 专家知识/历史工单：待补充',
    '- 实时或快照数据：待补充',
    `- 当前可用来源：${pickEvidenceSource(text)}`,
    '',
    '## 5. Planner 诊断路径',
    '',
    ...pickPlannerPath(text).map((item, index) => `${index + 1}. ${item}`),
    '',
    '## 6. 最可能判断',
    '',
    `- ${pickLikelyJudgment(text)}`,
    '',
    '## 7. Safety Gate',
    '',
    '- 作业票：待补充',
    '- 风速：待补充',
    '- 停机/限功率状态：待补充',
    '- 权限与二次确认：待补充',
    '- 控制类动作边界：复位、启停机、参数调整、登塔、开柜、带电作业只生成建议，不直连执行。',
    '',
    '## 8. 首个现场动作',
    '',
    `- ${pickFirstAction(text)}`,
    '',
    '## 9. 合格标准',
    '',
    `- ${pickAcceptance(text)}`,
    '',
    '## 10. 需要反馈',
    '',
    `- ${pickFeedback(text)}`,
    '',
    '## 11. 备件与工具',
    '',
    '- 待补充：根据现场确认结果再定，不自动编造备件型号。',
    '',
    '## 12. 闭环条件',
    '',
    '- 现场反馈与最可能判断一致，首个动作能把问题范围继续缩小。',
    '- 工单验收后补齐根因、最终措施、停机时长、备件结果和复发情况。',
    '',
    '## 13. 反馈入库',
    '',
    `- 可进入长期画像：${pickLongTermMemory(text)}`,
    `- 仅短期 TTL 记忆：${pickShortTermMemory(text)}`,
    '- 专家复核项：故障根因、处置措施、是否复发、是否更新SOP/图纸/点位字典。',
    '',
    '## 14. 资料来源',
    '',
    '- 当前用户输入与已知现场反馈',
  ].join('\n')
}
