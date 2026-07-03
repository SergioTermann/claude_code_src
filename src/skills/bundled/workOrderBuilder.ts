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
  if (has(text, /通信|通讯/)) return '通信系统'
  if (has(text, /水冷/)) return '水冷系统'
  if (has(text, /齿轮箱|油温|滤芯/)) return '齿轮箱系统'
  if (has(text, /发电机轴承|发电机温度/)) return '发电机系统'
  if (has(text, /安全链|急停/)) return '安全链系统'
  if (has(text, /并网|电网|接触器|断路器/)) return '电网/并网系统'
  return '待补充'
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
    '## 3. 最可能判断',
    '',
    `- ${pickLikelyJudgment(text)}`,
    '',
    '## 4. 首个现场动作',
    '',
    `- ${pickFirstAction(text)}`,
    '',
    '## 5. 合格标准',
    '',
    `- ${pickAcceptance(text)}`,
    '',
    '## 6. 需要反馈',
    '',
    `- ${pickFeedback(text)}`,
    '',
    '## 7. 安全注意事项',
    '',
    '- 先确认现场许可和停送电条件，再开始处理。',
    '- 涉及安全链、并网、雷击浪涌或高压回路时，不要盲目复位。',
    '',
    '## 8. 备件与工具',
    '',
    '- 待补充：根据现场确认结果再定。',
    '',
    '## 9. 闭环条件',
    '',
    '- 现场反馈与最可能判断一致，且下一步动作能把问题范围继续缩小。',
    '',
    '## 10. 资料来源',
    '',
    '- 当前用户输入与已知现场反馈',
  ].join('\n')
}
