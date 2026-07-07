#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { stdin as input, stdout as output } from 'node:process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const RUNNER = join(ROOT, 'scripts', 'run-lmstudio-claude.mjs')
const PROVIDER = process.env.ANTHROPIC_MODEL_PROVIDER || 'siliconflow'
const CHAT_MODEL =
  process.env.SILICONFLOW_MODEL ||
  process.env.LMSTUDIO_CHAT_MODEL ||
  process.env.LMSTUDIO_MODEL ||
  'Qwen/Qwen3.6-35B-A3B'
const ENABLE_NETWORK = process.env.WINDRISE_ENABLE_NETWORK !== '0'
const DISABLE_AUTO_LLMWIKI = process.env.WINDRISE_DISABLE_AUTO_LLMWIKI === '1'
const LOCAL_BASE_URL = (
  process.env.SILICONFLOW_BASE_URL ||
  process.env.LMSTUDIO_BASE_URL ||
  'https://api.siliconflow.cn/v1'
).replace(/\/$/, '')
const PROVIDER_LABEL = PROVIDER === 'siliconflow' ? 'SiliconFlow' : 'LM Studio'
const WIND_FARM_MODEL_ENTRIES = JSON.parse(
  readFileSync(join(ROOT, 'src', 'data', 'windFarmModels.json'), 'utf8'),
)
const WIND_DOMAIN_PATTERN = /(风机|风电|机组|变桨|偏航|主控|变流|变频|发电机|齿轮箱|液压|制动|刹车|安全链|电网|箱变|变压器|通信|通讯|水冷|冷却|传动|主轴|主轴承|叶片|轮毂|塔筒|机舱|传感器|风速仪|风向仪|振动|温度|润滑|油脂|SCADA|HMI|PLC|24v|hw2s|华仪)/i

if (PROVIDER !== 'siliconflow' && !isAllowedLocalModelUrl(LOCAL_BASE_URL)) {
  console.error(
    `Windrise: 拒绝 localhost/局域网之外的 ${PROVIDER_LABEL} 地址 ${LOCAL_BASE_URL}。`,
  )
  process.exit(1)
}

const history = [
  {
    role: 'system',
    content: DISABLE_AUTO_LLMWIKI
      ? `${windOpsSystemInstruction()}\n\n直接回答用户问题，不输出推理过程。只有用户消息明确附带本地资料时才基于资料回答。`
      : `${windOpsSystemInstruction()}\n\n直接回答用户问题，不输出推理过程。有本地资料上下文时基于资料回答，否则直接回答。`,
  },
]
const conversationMemory = {
  lastUser: '',
  lastAssistant: '',
  userName: '',
  favoriteColor: '',
  lastFaultCode: '',
  lastFaultName: '',
  lastFaultAnswer: '',
  lastSource: '',
}

function windOpsSystemInstruction() {
  return [
    '你是 Windrise 风电运维智导助手，后端架构按 01_lecture1_wind_ops 的七层路线执行。',
    '核心链路：业务层接收告警/提问；数据层先做故障 Case 标准化；记忆层使用风机画像、故障画像和短期工作记忆；模型应用层由 Planner 拆诊断路径；工具层只读调用 CMS/SCADA/EAM/备件/气象/工作票；模型层按任务路由；反馈层通过工单结果和专家复核沉淀经验。',
    '输出约束：先给结论，再给一个最小下一步；关键结论必须基于本地资料、实时/快照数据或明确标注为待验证；不能编造故障原因、备件型号、复位权限或现场测量值。',
    '安全边界：远程复位、启停机、参数调整、登塔、开柜、带电作业等高风险动作只生成建议和校验项，必须经过作业票、风速、停机状态、权限和人工二次确认。',
  ].join('\n')
}

function buildWindOpsCase(query) {
  const text = String(query || '')
  const turbineMatch = text.match(/(?:WTG[-_ ]?)?0*(\d+)\s*(?:号机|#|机组)?/i)
  const system =
    /变桨|pitch/i.test(text) ? '变桨系统' :
    /偏航|yaw/i.test(text) ? '偏航系统' :
    /齿轮箱|油温|滤芯|润滑/i.test(text) ? '齿轮箱系统' :
    /发电机|绕组|轴承温度/i.test(text) ? '发电机系统' :
    /液压|制动|刹车|压力/i.test(text) ? '液压/制动系统' :
    /变流|变频|IGBT/i.test(text) ? '变流系统' :
    /通信|通讯|CAN|Profibus|EtherCAT/i.test(text) ? '通信系统' :
    '待识别'
  const component =
    /24\s*v|24V/i.test(text) ? '24V 控制电源/反馈回路' :
    /传感器|编码器/i.test(text) ? '传感器/编码器与采集回路' :
    /阀|泵|蓄能器|压力/i.test(text) ? '液压阀组/泵/压力回路' :
    /接触器|断路器|开关/i.test(text) ? '开关/接触器/断路器反馈回路' :
    '待识别'
  const code = extractCode(text)
  const timeWindow =
    text.match(/近\s*\d+\s*(?:分钟|小时)|last[_ -]?\d+\w*/i)?.[0] ||
    (/昨天|今日|今天|刚才|当前|现在/.test(text) ? '当前/近期窗口' : '待补充')
  const missing = []
  if (!turbineMatch) missing.push('风机ID')
  if (system === '待识别') missing.push('系统/部件')
  if (!code && !/(报警|告警|故障|异常|低压|跳变|压力|温度|振动|反馈)/.test(text)) {
    missing.push('故障码或故障现象')
  }
  if (timeWindow === '待补充') missing.push('运行时间窗')
  if (!/(风速|停机|限功率|复位|作业票|HMI|SCADA|CMS)/i.test(text)) {
    missing.push('运行状态/安全条件')
  }
  return {
    turbineId: turbineMatch ? `WTG-${String(turbineMatch[1]).padStart(3, '0')}` : '待补充',
    system,
    component,
    faultCode: code || '待补充',
    timeWindow,
    missing,
  }
}

function renderWindOpsArchitectureContext(query) {
  const faultCase = buildWindOpsCase(query)
  const missing = faultCase.missing.length ? faultCase.missing.join('、') : '无明显缺口'
  return [
    'WindOps 架构上下文：',
    `- 结构化 Case：风机=${faultCase.turbineId}；系统=${faultCase.system}；部件=${faultCase.component}；故障码=${faultCase.faultCode}；时间窗=${faultCase.timeWindow}；缺失=${missing}。`,
    '- Planner 默认路径：确认告警和运行状态 -> 拉取 CMS/SCADA 趋势 -> 检索手册/SOP/历史工单 -> 通过 Safety Gate -> 输出一个现场动作和工单草稿字段。',
    '- LLMWiki 证据分级：厂家手册/故障码表 > 场站 SOP > 专家知识 > 已关闭历史工单 > 未验证经验。',
    '- Safety Gate：风速、停机状态、作业票、权限、二次确认；高风险控制动作只给建议，不直连执行。',
    '- 反馈闭环：工单关闭后沉淀根因、措施、备件、复发率和专家复核；临时限电/临时旁路/短期天气影响设置 TTL。',
  ].join('\n')
}

function printBanner() {
  console.log(`╭────────────────────────────────────────────╮
│ 🌀  Windrise                               │
│ ⌁⌁⌁ 对话模式 · 按需检索风机故障码知识库      │
╰────────────────────────────────────────────╯
直接输入问题后按回车即可对话。
${DISABLE_AUTO_LLMWIKI ? '自动 LLMWiki 检索已关闭；需要知识库时请输入：llmwiki 303804。' : '风电专业问题、故障码、风机报警、处理建议类问题会自动检索；也可以说：检索 303804。'}
输入 help 查看命令，输入 exit 退出。`)
}

function printHelp() {
  console.log(`命令:
  检索 <内容>       从 LLMWiki 知识库检索并总结
  查询 <内容>       同上
  搜索 <内容>       同上
  查 <内容>         同上
  llmwiki <内容>    明确从 LLMWiki 知识库检索并总结
  trace <内容>      显示问题到故障/元器件/机理的可视证据路径
  read <路径>       读取 LLMWiki 文件
  tree [路径]       查看目录树
  clear             清空对话上下文
  model             查看当前模型路由
  web <关键词>      联网搜索并总结
  fetch <URL>       抓取网页文本
  weather <城市>    查询天气预报
  farm <风场/机型>  查询内置风场与风机型号对应关系
  exit              退出`)
}

function getRetrievalRequest(text) {
  const explicitLlmWiki = parseExplicitLlmWikiRequest(text)
  if (explicitLlmWiki !== undefined) {
    return {
      shouldRetrieve: true,
      query: explicitLlmWiki,
    }
  }

  if (DISABLE_AUTO_LLMWIKI) {
    return { shouldRetrieve: false, query: '' }
  }

  if (shouldRetrieve(text)) {
    return {
      shouldRetrieve: true,
      query: trimTrigger(text),
    }
  }

  if (shouldAutoRetrieve(text)) {
    return {
      shouldRetrieve: true,
      query: normalizeRetrievalQuery(text),
    }
  }

  return { shouldRetrieve: false, query: '' }
}

function parseExplicitLlmWikiRequest(text) {
  const match = text.match(/^\/?(?:llmwiki|wiki)\b\s*(.*)$/i)
  if (!match) return undefined
  return match[1]?.trim() || ''
}

function trimTrigger(text) {
  return text
    .replace(/^(帮我|给我|请)?\s*(检索|查询|搜索|查找|查|search)\s*(一下|下)?[:：]?\s*/i, '')
    .trim()
}

function shouldRetrieve(text) {
  return /^(帮我|给我|请)?\s*(检索|查询|搜索|查找|查|search)(\s|一下|下|[:：]|$)/i.test(
    text,
  )
}

function shouldAutoRetrieve(text) {
  const normalized = text.trim()
  if (!normalized) return false
  if (isPrincipleConsultation(normalized) && !hasFaultKnowledgeSignal(normalized)) {
    return false
  }

  if (/^\s*(故障码|代码|fault\s*code)?\s*[0-9]{3,}\s*([是什么啥含义原因处理复位报警故障逻辑怎么如何？?，,。.、\s]*)?$/i.test(normalized)) {
    return true
  }

  if (
    /[0-9]{3,}/.test(normalized) &&
    /(故障|报警|告警|停机|复位|原因|处理|排查|检查|维修|逻辑|怎么|如何|为什么|是什么|含义)/i.test(
      normalized,
    )
  ) {
    return true
  }

  if (/(故障码|故障代码|报警码|告警码|fault\s*code)/i.test(normalized)) {
    return true
  }

  const hasWindDomainTerm = WIND_DOMAIN_PATTERN.test(normalized)
  const hasKnowledgeIntent =
    /(故障|报警|告警|停机|复位|不可复位|原因|处理|排查|检查|维修|设置值|逻辑|反馈|断开|短路|断路|丢失|原理|机理|机制|工作方式|工作过程|运行方式|运行过程|控制逻辑|结构|组成|作用|用途|区别|关系|解释|介绍|怎么|如何|为什么|是什么|啥意思|含义)/i.test(
      normalized,
    )

  return hasWindDomainTerm && hasKnowledgeIntent
}

function isPrincipleConsultation(text) {
  return /(原理|机理|机制|工作方式|工作过程|运行方式|运行过程|怎么工作|如何工作|为什么能|为什么会|怎样实现|怎么实现|如何实现|结构|组成|作用|用途|区别|关系|解释一下|讲一下|介绍一下|科普|控制逻辑|运行逻辑)/i.test(
    text,
  )
}

function isFieldActionQuery(text) {
  return /(怎么办|怎么处理|如何处理|处理方法|处置|排查|检查|检修|维修|下一步|接下来|继续|后续|怎么修|如何修|复位不了|不可复位|停机后怎么|报警后怎么|告警后怎么|我该怎么做|该怎么做)/i.test(
    text,
  )
}

function hasFaultKnowledgeSignal(text) {
  return (
    /[a-z]?_?[0-9]{3,}/i.test(text) ||
    /(故障码|故障代码|报警码|告警码|fault\s*code)/i.test(text) ||
    isFieldActionQuery(text) ||
    /(短路|断路|丢失|停机|报警|告警|报错)/i.test(text)
  )
}

function normalizeRetrievalQuery(text) {
  const cleaned = text
    .replace(/^(帮我|给我|请|麻烦)?\s*/i, '')
    .replace(/[？?。!！]+$/g, '')
    .trim()
  const code = cleaned.match(/[0-9]{3,}/)?.[0]
  if (code && isBareFaultCodeQuery(cleaned, code)) return code
  return cleaned
}

function extractCode(text) {
  return text.match(/[0-9]{3,}/)?.[0] || ''
}

function isBareFaultCodeQuery(text, code) {
  const withoutCode = text
    .replace(code, '')
    .replace(/(故障码|故障代码|报警码|告警码|代码|fault\s*code|是什么|什么|啥|含义|原因|处理|复位|报警|故障|逻辑|怎么|如何|为什么|的|为|是)/gi, '')
    .replace(/[？?，,。.、:：\s]/g, '')
  return withoutCode.length === 0
}

async function runLlmwiki(args) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [RUNNER, '--print', '--bare', args],
    {
      env: {
        ...process.env,
        ...(process.env.LLMWIKI_PROJECT
          ? { LLMWIKI_PROJECT: process.env.LLMWIKI_PROJECT }
          : {}),
        ...(process.env.LLMWIKI_DIR ? { LLMWIKI_DIR: process.env.LLMWIKI_DIR } : {}),
        ANTHROPIC_MODEL_PROVIDER:
          process.env.ANTHROPIC_MODEL_PROVIDER || 'siliconflow',
        SILICONFLOW_BASE_URL: process.env.SILICONFLOW_BASE_URL || LOCAL_BASE_URL,
        SILICONFLOW_MODEL: process.env.SILICONFLOW_MODEL || CHAT_MODEL,
        LMSTUDIO_MODEL: CHAT_MODEL,
        LMSTUDIO_CHAT_MODEL: CHAT_MODEL,
        LMSTUDIO_BASE_URL: LOCAL_BASE_URL,
      },
      maxBuffer: 10 * 1024 * 1024,
    },
  )
  return stdout.trim()
}

async function searchKnowledge(query) {
  const code = extractCode(query)
  const mechanismSummary = buildMechanismSummaryForQuery(query)
  const architectureContext = renderWindOpsArchitectureContext(query)
  const primary = await runLlmwiki(
    code ? `/llmwiki ask ${code} --limit 4` : `/llmwiki search ${query} --limit 6`,
  )
  const systemPath = systemWikiPathForQuery(query)
  const mechanismContext = shouldAttachMechanismContext(query) && !code
    ? await runLlmwiki('/llmwiki read wiki/fault-mechanisms.md')
    : ''
  if (!systemPath || code) {
    return [
      architectureContext,
      mechanismSummary,
      mechanismContext && !/^LLMWiki error:/i.test(mechanismContext)
        ? [`机理图谱上下文：wiki/fault-mechanisms.md`, mechanismContext, ''].join('\n')
        : '',
      primary,
    ].filter(Boolean).join('\n')
  }

  const systemContext = await runLlmwiki(`/llmwiki read ${systemPath}`)
  const contexts = []
  if (mechanismContext && !/^LLMWiki error:/i.test(mechanismContext)) {
    contexts.push(`机理图谱上下文：wiki/fault-mechanisms.md`, mechanismContext, '')
  }
  if (!systemContext || /^LLMWiki error:/i.test(systemContext)) {
    return [architectureContext, mechanismSummary, ...(contexts.length ? contexts : []), primary].filter(Boolean).join('\n')
  }
  contexts.push(
    `系统上下文：${systemPath}`,
    systemContext,
    '',
    primary,
  )
  return [architectureContext, mechanismSummary, contexts.join('\n')].filter(Boolean).join('\n')
}

function shouldAttachMechanismContext(text) {
  return WIND_DOMAIN_PATTERN.test(text) &&
    /(故障|报警|告警|停机|复位|原因|处理|排查|检查|维修|下一步|原理|机理|机制|为什么|怎么|如何|是什么|跳变|掉线|压力|温度|振动|通信|通讯|水冷|传感器|SCADA|HMI)/i.test(text)
}

function buildMechanismSummaryForQuery(text) {
  const matches = genericMechanismRules()
    .filter(rule => rule.pattern.test(text))
    .slice(0, 3)
  if (!matches.length) return ''
  return [
    '通用机理图谱命中：',
    ...matches.map(rule => [
      `- 机理：${rule.label}`,
      `  系统/部件：${rule.system} / ${rule.component}`,
      `  最可能下一步：${rule.nextAction}`,
      `  需要反馈：${rule.feedback}`,
    ].join('\n')),
    '使用要求：即使没有精确故障码，也先按上述通用机理给一个现场验证动作，不要只回答资料不足。',
    '',
  ].join('\n')
}

function genericMechanismRules() {
  return [
    {
      pattern: /传感器|测量.*跳变|跳变|漂移|风速仪|风向仪|压力传感器|温度传感器|振动传感器/i,
      label: '传感器测量回路漂移、断线或干扰',
      system: '传感器/主控系统',
      component: '传感器供电、线缆、屏蔽接地、AI/DI通道',
      nextAction: '用独立仪表或相邻测点先做交叉比对，确认是真实物理量变化还是测量回路异常。',
      feedback: '现场实测值、SCADA/HMI显示值、传感器供电或回路电阻。',
    },
    {
      pattern: /水冷|冷却液|水泵|换热器|进阀压力|流量.*低|水压|冷却.*压力/i,
      label: '水冷回路流量、压力或散热能力不足',
      system: '水冷系统',
      component: '水泵、换热器、冷却液、流量/压力开关',
      nextAction: '先确认水泵运行反馈和冷却液液位，不要先改参数。',
      feedback: '水泵是否运行、液位是否正常、当前压力/流量值。',
    },
    {
      pattern: /通信|通讯|CAN|Profibus|EtherCAT|Modbus|光纤|交换机|掉线|超时|节点丢失/i,
      label: '机组通信网络或现场总线中断',
      system: '通信系统',
      component: '总线线缆、终端电阻、光纤、交换机、从站模块',
      nextAction: '先看掉线设备和通讯灯/总线状态，定位是单台设备掉线还是整段总线异常。',
      feedback: '掉线设备、通讯灯状态、总线错误计数。',
    },
    {
      pattern: /变桨.*24\s*V|24\s*V.*变桨|变桨.*主电源|变桨.*开关反馈|变桨.*控制电源/i,
      label: '变桨 24V 控制电源或开关反馈丢失',
      system: '变桨系统',
      component: '24V电源、主电源开关、辅助触点、PLC输入点',
      nextAction: '先量变桨 24V 控制电源输出，再核对主电源开关实际位置和 PLC 反馈。',
      feedback: '24V 实测值、主电源开关位置、辅助触点或 PLC 输入点状态。',
    },
    {
      pattern: /主轴|主轴承|轴承.*剥落|油脂.*金属|低频振动|BPFI|BPFO/i,
      label: '主轴轴承润滑、载荷或密封失效',
      system: '传动系统',
      component: '主轴轴承、密封、润滑脂',
      nextAction: '先看主轴承温度趋势和低频振动，不要只按单点告警判断。',
      feedback: '轴承温度、振动频谱或趋势、油脂状态。',
    },
    {
      pattern: /发电机.*轴承|发电机.*温度|发电机.*过热|轴承温度.*发电机/i,
      label: '发电机轴承温度、润滑或冷却异常',
      system: '发电机系统',
      component: '发电机轴承、PT100、冷却风道、润滑脂',
      nextAction: '先对齐发电机轴承温度趋势和振动趋势，再看冷却通风是否正常。',
      feedback: '发电机轴承温度趋势、振动趋势、冷却风道/风扇状态。',
    },
    {
      pattern: /齿轮箱|齿轮油|油温|滤芯|过滤器.*压差|润滑油.*压差|油冷/i,
      label: '齿轮箱温升或润滑过滤异常',
      system: '齿轮箱系统',
      component: '油冷系统、润滑油、滤芯、油位、油样',
      nextAction: '先确认油冷风扇或水冷是否运行，再看油位、滤芯压差和油样状态。',
      feedback: '油冷运行状态、齿轮箱油位、滤芯压差、油样外观。',
    },
    {
      pattern: /安全链|急停|安全继电器|保护链|塔筒门|机舱门|限位.*安全/i,
      label: '安全链或急停保护链断开',
      system: '安全链系统',
      component: '急停按钮、安全继电器、门锁、限位开关',
      nextAction: '先看急停是否复位，再从安全继电器输入端逐点找第一个断开的安全点。',
      feedback: '急停状态、安全继电器状态、第一个断开的安全点。',
    },
    {
      pattern: /雷击|浪涌|SPD|防雷|接地电阻|屏蔽接地|接地异常/i,
      label: '雷击、浪涌或接地屏蔽异常',
      system: '防雷接地/电气系统',
      component: 'SPD、24V电源、接地排、屏蔽层、通讯模块',
      nextAction: '先查 SPD 指示、24V 电源输出和电柜接地连接，判断是不是保护回路先失效。',
      feedback: 'SPD 指示状态、24V 输出、电柜接地连接、异常模块范围。',
    },
    {
      pattern: /箱变|变压器|并网|电网|频率|电压|断路器|接触器|孤岛|接地/i,
      label: '电网、箱变或并网保护异常',
      system: '电网/变压器系统',
      component: '箱变、断路器、并网接触器、电能质量',
      nextAction: '先核对三相电压频率和断路器/接触器反馈，判断是外部电网还是并网执行回路。',
      feedback: '三相电压频率、断路器反馈、伴随保护记录。',
    },
    {
      pattern: /SCADA|HMI|趋势|数据质量|伴随告警|状态量|阈值|报警关联/i,
      label: 'SCADA数据质量、报警关联或工况边界异常',
      system: '主控系统',
      component: 'SCADA采集、报警逻辑、状态量',
      nextAction: '先导出报警前后趋势和伴随告警，按时间线对齐现场动作。',
      feedback: '报警时间、前后趋势、伴随告警列表。',
    },
  ]
}

function systemWikiPathForQuery(text) {
  const normalized = text.replace(/\s+/g, '')
  const aliasPath = [
    [/箱变|变压器/, '变压器系统'],
    [/传感器|风速仪|风向仪|测量|跳变/, '主控系统'],
    [/主轴|主轴承/, '传动系统'],
    [/润滑|油脂|油位|滤芯/, '液压系统'],
    [/塔筒|机舱|振动|加速度/, '机舱与塔架系统'],
    [/冷却|水冷|换热器|水泵/, '水冷系统'],
    [/通讯|通信|CAN|Profibus|EtherCAT|光纤|交换机/i, '通信系统'],
  ]
  const alias = aliasPath.find(([pattern]) => pattern.test(normalized))
  if (alias) return `wiki/systems/${alias[1]}.md`
  const systems = [
    '变桨系统',
    '偏航系统',
    '主控系统',
    '变流系统',
    '发电机系统',
    '齿轮箱系统',
    '液压系统',
    '制动系统',
    '安全链系统',
    '电网系统',
    '通信系统',
    '水冷系统',
    '电池系统',
    '传动系统',
    '温度系统',
    '变压器系统',
    '机舱与塔架系统',
  ]
  const system = systems.find(name => normalized.includes(name.replace(/\s+/g, '')))
  return system ? `wiki/systems/${system}.md` : ''
}

async function askLocalModel(messages, routeText, forcedModel = '') {
  let answer = ''
  for await (const chunk of streamLocalModel(messages, routeText, forcedModel)) {
    answer += chunk
  }
  return answer.trim()
}

async function* streamLocalModel(messages, routeText, forcedModel = '') {
  const selectedModel = forcedModel || CHAT_MODEL
  if (selectedModel === CHAT_MODEL || process.env.LMSTUDIO_STREAM === '0') {
    const answer = await callLocalModelOnce(selectedModel, messages)
    if (answer) yield answer
    return
  }
  try {
    const response = await fetch(chatCompletionsUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${chatApiKey()}`,
      },
      body: JSON.stringify({
        model: selectedModel,
        messages,
        stream: true,
        temperature: 0.3,
        max_tokens: getLocalMaxTokens(),
        ...noThinkingOptions(),
      }),
      signal: AbortSignal.timeout(120_000),
    })

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`)
    }
    if (!response.body) return

    let emitted = false
    for await (const chunk of parseChatCompletionStream(response.body)) {
      if (!chunk) continue
      emitted = true
      yield chunk
    }
    if (!emitted) {
      const answer = await callLocalModelOnce(selectedModel, messages)
      if (answer) yield answer
    }
  } catch (error) {
    const answer = await callLocalModelOnce(selectedModel, messages)
    if (answer) {
      yield answer
      return
    }
    throw error
  }
}

async function callLocalModelOnce(model, messages) {
  const response = await fetch(chatCompletionsUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${chatApiKey()}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      temperature: 0.3,
      max_tokens: getLocalMaxTokens(),
      ...noThinkingOptions(),
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }
  const data = await response.json()
  const message = data?.choices?.[0]?.message
  const content = (message?.content || '').trim()
  if (content) return normalizeWindriseSourceLabel(content)
  if (isOkHealthCheckQuestion(messages)) {
    return 'OK'
  }
  if (isLocalModelIdentityQuestion(messages)) {
    return localModelIdentityAnswer(model)
  }
  if (isWindrisePrincipleQuestion(messages)) {
    return windrisePrincipleFallback(messages)
  }
  const reasoning = (message?.reasoning_content || '').trim()
  if (reasoning && !looksLikeInternalReasoning(reasoning) && !looksLikeRawKnowledgeEcho(reasoning)) {
    return reasoning
  }
  return ''
}

function normalizeWindriseSourceLabel(value) {
  return value.replace(/来源路径[:：]/g, '来源：')
}

function chatCompletionsUrl() {
  return /\/v1$/i.test(LOCAL_BASE_URL)
    ? `${LOCAL_BASE_URL}/chat/completions`
    : `${LOCAL_BASE_URL}/v1/chat/completions`
}

function chatApiKey() {
  if (PROVIDER === 'siliconflow') {
    return process.env.SILICONFLOW_API_KEY || process.env.OPENAI_COMPAT_API_KEY || ''
  }
  return process.env.LMSTUDIO_API_KEY || 'lm-studio'
}

function isLocalModelIdentityQuestion(messages) {
  const lastUser = [...messages]
    .reverse()
    .find(message => message.role === 'user')
    ?.content ?? ''
  return /(你是什么模型|你是谁|什么模型|当前模型|本地模型|model)/i.test(lastUser)
}

function isOkHealthCheckQuestion(messages) {
  return /^\s*(只回答|仅回答|回复|输出)?\s*OK\s*$/i.test(
    lastUserMessageText(messages),
  )
}

function localModelIdentityAnswer(model) {
  return `我是 Windrise，中文助手；当前通过 ${PROVIDER_LABEL} 使用 ${model}。`
}

function localDateTimeAnswer(text) {
  const normalized = text.trim()
  if (!normalized) return ''
  if (/(风机|风电|故障|报警|告警|停机|复位|处理|排查|维修|变桨|偏航|主控|变流|发电机|齿轮箱)/i.test(normalized)) {
    return ''
  }
  const now = new Date()
  const date = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(now)
  const time = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now)
  if (/^(今天)?(是)?(什么日子|几号|日期|星期几|周几)[？?。!！\s]*$/.test(normalized) || /(今天是什么日子|今天几号|今天日期|今天星期几|今天周几)/.test(normalized)) {
    return `今天是 ${date}。`
  }
  if (/^(现在|当前)?(几点|什么时间|时间)[？?。!！\s]*$/.test(normalized) || /(现在几点|当前时间|现在时间)/.test(normalized)) {
    return `现在是 ${date} ${time}。`
  }
  return ''
}

function isWindrisePrincipleQuestion(messages) {
  const text = lastUserMessageText(messages)
  return (
    WIND_DOMAIN_PATTERN.test(text) &&
    /(原理|机理|机制|工作方式|工作过程|运行方式|运行过程|控制逻辑|结构|组成|作用|用途|为什么|怎么工作|如何工作|是什么)/i.test(text)
  )
}

function windrisePrincipleFallback(messages) {
  const text = lastUserMessageText(messages)
  if (/变桨/.test(text)) {
    return [
      '变桨系统通过调节叶片桨距角来控制风轮吸收的气动功率和载荷。',
      '低风速时，叶片通常保持较小桨距角以提高捕风效率；接近或超过额定风速时，控制器驱动变桨电机或液压执行机构增大桨距角，使叶片逐步失速或减小迎角，从而限制输出功率。',
      '同时，变桨系统还参与超速保护、停机和紧急顺桨：当检测到超速、故障或安全链动作时，叶片会向安全角度顺桨，降低风轮扭矩和结构载荷。',
    ].join('\n')
  }
  return [
    '这个系统的核心逻辑是采集现场状态，经过控制器判断后驱动执行机构动作，使风机在安全边界内稳定运行。',
    '回答这类原理问题时，需要结合具体品牌、机型和控制策略；如果要给现场处置建议，还需要补充风场、机型、报警码和实时状态。',
  ].join('\n')
}

function lastUserMessageText(messages) {
  return [...messages]
    .reverse()
    .find(message => message.role === 'user')
    ?.content ?? ''
}

function getLocalMaxTokens() {
  const value = Number.parseInt(
    process.env.LMSTUDIO_MAX_TOKENS || process.env.LMSTUDIO_NUM_PREDICT || '2048',
    10,
  )
  return Number.isFinite(value) && value > 0 ? value : 2048
}

function noThinkingOptions() {
  if (process.env.WINDRISE_ENABLE_THINKING === '1') return {}
  return {
    think: false,
    enable_thinking: false,
    reasoning_effort: 'none',
    reasoning: { effort: 'none', exclude: true },
  }
}

async function* parseChatCompletionStream(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split(/\r?\n\r?\n/)
      buffer = parts.pop() || ''
      for (const part of parts) {
        const chunk = parseChatCompletionStreamPart(part)
        if (chunk !== undefined) yield chunk
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) {
      const chunk = parseChatCompletionStreamPart(buffer)
      if (chunk !== undefined) yield chunk
    }
  } finally {
    reader.releaseLock()
  }
}

function parseChatCompletionStreamPart(part) {
  const payload = part
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trimStart())
    .join('\n')
    .trim()
  if (!payload || payload === '[DONE]') return undefined
  const data = JSON.parse(payload)
  return data?.choices?.map(choice => choice?.delta?.content || '').join('') || ''
}

async function printStreamedWindriseAnswer(messages, routeText) {
  output.write('Windrise: ')
  let answer = ''
  for await (const chunk of streamLocalModel(messages, routeText)) {
    answer += chunk
    output.write(chunk)
  }
  output.write('\n')
  return answer.trim()
}

function shouldAnswerWindFarmModelQuestion(text) {
  const normalized = normalizeWindFarmModelText(text)
  if (!normalized) return false
  const hasMappingIntent =
    /(风场|风电场|机型|型号|风机|品牌|对应|匹配|属于|哪个|哪些|什么|查询|查一下|列出|清单|关系)/i.test(
      text,
    )
  if (!hasMappingIntent) return false

  return (
    /(风场|风电场).*(机型|型号|风机|品牌|对应|关系)|(机型|型号|风机|品牌).*(风场|风电场|对应|属于|哪个|哪些)/i.test(
      text,
    ) ||
    WIND_FARM_MODEL_ENTRIES.some(entry =>
      entrySearchValues(entry).some(value =>
        normalized.includes(normalizeWindFarmModelText(value)),
      ),
    )
  )
}

function lookupWindFarmModels(text) {
  const normalized = normalizeWindFarmModelText(text)
  if (!normalized) return null

  if (/(全部|所有|清单|列表|对应关系|关系表|有哪些风场|风场有哪些)/.test(text)) {
    return { kind: 'all', entries: WIND_FARM_MODEL_ENTRIES }
  }

  const siteMatches = WIND_FARM_MODEL_ENTRIES.filter(entry =>
    siteSearchValues(entry).some(value => {
      const normalizedValue = normalizeWindFarmModelText(value)
      return (
        normalizedValue.length >= 2 &&
        (normalized.includes(normalizedValue) ||
          normalized.includes(normalizedValue.replace(/风电场$/u, '')))
      )
    }),
  )
  if (siteMatches.length > 0) {
    return { kind: 'site', entries: sortSpecificWindFarmMatches(siteMatches) }
  }

  const modelMatches = WIND_FARM_MODEL_ENTRIES.filter(entry =>
    modelSearchValues(entry).some(model => {
      const normalizedModel = normalizeWindFarmModelText(model)
      return normalizedModel.length >= 3 && normalized.includes(normalizedModel)
    }),
  )
  if (modelMatches.length > 0) {
    return { kind: 'model', entries: sortSpecificWindFarmMatches(modelMatches) }
  }

  return null
}

function renderWindFarmModelAnswer(lookup) {
  if (!lookup || lookup.entries.length === 0) {
    return '没有在内置风场机型表中找到匹配项。'
  }

  const title =
    lookup.kind === 'all'
      ? '内置风场与风机型号对应关系：'
      : lookup.kind === 'model'
        ? '该机型对应的风场如下：'
        : '查询结果：'

  return [
    title,
    ...lookup.entries.map(entry => `- ${entry.site}：${entry.models.join('、')}`),
  ].join('\n')
}

async function answerWithWindFarmModel(query) {
  const lookup = lookupWindFarmModels(query)
  const context = renderWindFarmModelAnswer(lookup)
  if (!lookup || lookup.entries.length === 0) {
    console.log(`Windrise: ${context}`)
    return
  }

  const prompt = `下面是系统内置的风场与风机型号对应关系，请只基于这些条目回答用户问题，不要补充表里没有的信息。

${context}

用户问题：${query}

请直接回答，适合现场运维人员快速确认。必须保留表中的标准风场名称和机型全称。`

  try {
    const answer = await askLocalModel([
      {
        role: 'system',
        content:
          '你是 Windrise，负责根据风场与风机型号映射表回答现场查询。只基于给定表格，不要编造；输出必须包含标准风场名称和机型全称。',
      },
      { role: 'user', content: prompt },
    ], `风场机型映射：${query}`, CHAT_MODEL)
    console.log(`Windrise: ${answer || context}`)
  } catch {
    console.log(`Windrise: ${context}`)
  }
}

function sortSpecificWindFarmMatches(entries) {
  return [...entries].sort(
    (a, b) =>
      longestWindFarmSearchValue(b).length - longestWindFarmSearchValue(a).length ||
      a.site.localeCompare(b.site, 'zh-Hans-CN'),
  )
}

function longestWindFarmSearchValue(entry) {
  return entrySearchValues(entry).sort((a, b) => b.length - a.length)[0] || ''
}

function entrySearchValues(entry) {
  return [...siteSearchValues(entry), ...modelSearchValues(entry)]
}

function siteSearchValues(entry) {
  return [entry.site, ...(entry.aliases || [])]
}

function modelSearchValues(entry) {
  return [
    ...entry.models,
    ...entry.models.map(model => model.replace(/^\S+\s+/, '')),
  ].filter(Boolean)
}

function normalizeWindFarmModelText(text) {
  return String(text)
    .toLowerCase()
    .replace(/[（）]/g, match => (match === '（' ? '(' : ')'))
    .replace(/[.\s_\-—–/\\()（）]/g, '')
    .replace(/风力发电场/g, '风电场')
    .trim()
}

function isNetworkQuery(text) {
  const normalized = text.trim()
  if (!normalized) return false
  if (/^会话上下文[:：]/.test(normalized)) return false
  if (/^(web|search|fetch|url)\b/i.test(normalized)) return true
  if (/(天气|气温|降雨|下雨|空气质量|aqi|预报|新闻|最新|current|latest|today|tomorrow)/i.test(normalized)) {
    return true
  }
  if (
    /^(帮我|给我|请)?\s*(搜索|搜一下|查一下|查找|查|查询)\s*/i.test(normalized) &&
    !shouldAutoRetrieve(normalized)
  ) {
    return true
  }
  return /^(联网|网络|搜索网络|上网|查资料|抓取|打开网页|访问网页)/i.test(
    normalized,
  )
}

function isWeatherQuery(text) {
  return /(天气|气温|降雨|下雨|空气质量|aqi|预报)/i.test(text)
}

function isUrl(text) {
  try {
    const url = new URL(text.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function extractUrl(text) {
  const match = text.match(/https?:\/\/\S+/i)
  return (match?.[0] || text.trim()).replace(/[。)，,)]+$/g, '')
}

async function fetchText(url) {
  if (!ENABLE_NETWORK) {
    throw new Error('Network access is disabled. Set WINDRISE_ENABLE_NETWORK=1 to enable it.')
  }
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }
  return response.text()
}

async function fetchJson(url) {
  if (!ENABLE_NETWORK) {
    throw new Error('Network access is disabled. Set WINDRISE_ENABLE_NETWORK=1 to enable it.')
  }
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }
  return response.json()
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<\/(p|div|li|h\d|tr|section|article|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function truncateText(text, maxChars) {
  const normalized = text.trim()
  return normalized.length > maxChars
    ? `${normalized.slice(0, maxChars)}\n\n[内容过长，已截断]`
    : normalized
}

async function searchWeb(query) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const html = await fetchText(url)
  const text = stripHtml(html)
  const links = [...html.matchAll(/href="([^"]+)"/gi)]
    .map(match => match[1])
    .filter(Boolean)
    .map(value => decodeURIComponent(value.replace(/^.*uddg=/, '').replace(/&rut=.*$/, '')))
    .filter(value => /^https?:\/\//i.test(value))
    .filter((value, index, array) => array.indexOf(value) === index)
    .slice(0, 8)
  return truncateText(
    [
      `联网搜索：${query}`,
      '',
      text,
      links.length ? `\n来源链接：\n${links.map(link => `- ${link}`).join('\n')}` : '',
    ].join('\n'),
    6000,
  )
}

async function fetchWebPage(inputText) {
  const url = extractUrl(inputText)
  if (!isUrl(url)) {
    throw new Error(`Invalid URL: ${url}`)
  }
  const html = await fetchText(url)
  return truncateText([`URL：${url}`, '', stripHtml(html)].join('\n'), 8000)
}

function extractWeatherLocation(text) {
  const normalized = text
    .replace(/^\s*(帮我|给我|请)?\s*(搜索一下|搜一下|搜索|查询|查一下|查|联网|weather)\s*/i, '')
    .replace(/(今天|明天|后天|天气|气温|降雨|下雨|空气质量|aqi|预报|的|怎么样|如何|多少|一下|[？?。!！,，])/gi, ' ')
    .trim()
  return normalized || '北京'
}

function weatherDayOffset(text) {
  if (/后天/.test(text)) return 2
  if (/明天|tomorrow/i.test(text)) return 1
  return 0
}

function weatherCodeText(code) {
  const map = {
    0: '晴',
    1: '大部晴朗',
    2: '局部多云',
    3: '阴',
    45: '雾',
    48: '霜雾',
    51: '小毛毛雨',
    53: '中等毛毛雨',
    55: '大毛毛雨',
    61: '小雨',
    63: '中雨',
    65: '大雨',
    71: '小雪',
    73: '中雪',
    75: '大雪',
    80: '小阵雨',
    81: '中等阵雨',
    82: '强阵雨',
    95: '雷暴',
  }
  return map[code] || `天气代码 ${code}`
}

async function queryWeather(text) {
  const location = extractWeatherLocation(text)
  const offset = weatherDayOffset(text)
  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=zh&format=json`
  const geo = await fetchJson(geoUrl)
  const place = geo?.results?.[0]
  if (!place) {
    throw new Error(`找不到城市：${location}`)
  }

  const days = Math.max(3, offset + 1)
  const forecastUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code` +
    `&timezone=${encodeURIComponent(place.timezone || 'Asia/Shanghai')}&forecast_days=${days}`
  const forecast = await fetchJson(forecastUrl)
  const daily = forecast.daily
  const index = Math.min(offset, Math.max(0, (daily?.time?.length || 1) - 1))

  const date = daily.time[index]
  const max = daily.temperature_2m_max[index]
  const min = daily.temperature_2m_min[index]
  const rain = daily.precipitation_probability_max[index]
  const code = daily.weather_code[index]
  const dayLabel = offset === 1 ? '明天' : offset === 2 ? '后天' : '今天'
  return [
    `${place.name}${place.admin1 ? `（${place.admin1}）` : ''}${dayLabel}天气（${date}）：`,
    `- 天气：${weatherCodeText(code)}`,
    `- 气温：${min}°C - ${max}°C`,
    `- 最高降水概率：${rain}%`,
    '',
    '来源：Open-Meteo',
  ].join('\n')
}

async function answerWithWeb(text) {
  if (isWeatherQuery(text)) {
    console.log(`Windrise: 正在查询天气...`)
    console.log(`Windrise: ${await queryWeather(text)}`)
    return
  }

  const fetchTarget = extractUrl(text)
  let webContext
  if (isUrl(fetchTarget)) {
    console.log(`Windrise: 正在抓取 ${fetchTarget} ...`)
    webContext = await fetchWebPage(fetchTarget)
  } else {
    const query = text.replace(/^\s*(帮我|给我|请)?\s*(联网|网络|搜索网络|上网|搜一下|搜索一下|搜索|查一下|查询|查找|查资料|web\s+search|web|search)\s*/i, '').trim()
    console.log(`Windrise: 正在联网搜索「${query || text}」...`)
    webContext = await searchWeb(query || text)
  }

  const prompt = `用户问题：${text}

下面是联网获取的资料。请基于这些资料用中文回答；如果资料不足，请明确说明。回答末尾列出来源链接。

${webContext}`

  const answer = await printStreamedWindriseAnswer([
    {
        role: 'system',
        content:
          '你是 Windrise，负责把联网搜索或网页抓取结果整理成可靠的中文答案。必须说明来源，不要编造资料中没有的信息。',
    },
    { role: 'user', content: prompt },
  ], `联网资料总结：${text}`)
  if (!answer) console.log(`Windrise: ${webContext}`)
}

function isAllowedLocalModelUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase()
    const ipv4 = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
    if (ipv4) {
      const first = Number(ipv4[1])
      const second = Number(ipv4[2])
      return (
        first === 10 ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168) ||
        first === 127
      )
    }
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      hostname.endsWith('.localhost')
    )
  } catch {
    return false
  }
}

async function answerNormally(text) {
  const fieldAnswer = deterministicFieldAnswer(text)
  if (fieldAnswer) {
    console.log(`Windrise: ${fieldAnswer}`)
    rememberKnowledgeTurn(text, fieldAnswer)
    return
  }

  const messages = [...history, { role: 'user', content: text }]
  try {
    const answer = await printStreamedWindriseAnswer(messages, text)
    if (!answer) {
      console.log('Windrise: 没有收到模型回复。')
      return
    }
    history.push({ role: 'user', content: text })
    history.push({ role: 'assistant', content: answer })
    rememberTurn(text, answer)
    if (history.length > 17) {
      history.splice(1, history.length - 17)
    }
  } catch (error) {
    const fallback = PROVIDER === 'siliconflow'
      ? `SiliconFlow 暂时不可用。请检查 SILICONFLOW_API_KEY、网络或 ${LOCAL_BASE_URL}。\n详情：${error.message}`
      : `本地模型暂时不可用。请先启动 ${PROVIDER_LABEL}，或检查 ${LOCAL_BASE_URL}。\n详情：${error.message}`
    console.log(
      fallback,
    )
    rememberTurn(text, fallback)
  }
}

async function answerWithRetrieval(text) {
  const query = getRetrievalRequest(text).query
  if (!query) {
    console.log('Windrise: 请输入要检索的内容，例如：303804 或 变桨24V主电源开关故障')
    return
  }

  console.log(`Windrise: 正在检索「${query}」...`)
  let hits
  try {
    hits = await searchKnowledge(query)
  } catch (error) {
    console.log(`Windrise: 检索失败：${error.message}`)
    return
  }

  if (!hits || hits.startsWith('No matches')) {
    console.log(`Windrise: 没找到相关内容。\n${hits}`)
    return
  }

  const fieldAnswer = deterministicFieldAnswer(text, hits, query)
  if (fieldAnswer) {
    console.log(`Windrise: ${fieldAnswer}`)
    const sourceLine = missingSourceLine(fieldAnswer, hits)
    if (sourceLine) console.log(sourceLine)
    rememberKnowledgeTurn(text, [fieldAnswer, sourceLine].filter(Boolean).join('\n'), hits, query)
    return
  }

  const actionQuery = isFieldActionQuery(text)
  const principleQuery = isPrincipleConsultation(text)
  const codeOnlyQuery = !!extractCode(text) && !actionQuery && !principleQuery

  const prompt = actionQuery
    ? `以下是本地 LLMWiki 检索到的相关资料和 WindOps 架构上下文，只作为回答依据，不要原样复述。

${hits}

用户问题：${text}

请直接回答用户问题，组织成现场工程人员能直接使用的中文答案。
必须遵守：
1. 像导航一样直接：该停机就说停机，该测压力就说测压力，该看哪个页面就说哪个页面。
2. 开头直接写“结论：...”，不要铺垫。
3. 第二段写“下一步只做一件事：...”，只能给一个动作，不要同时列多个建议。
4. 第三段写“请反馈：...”，最多要 1 到 3 个现场结果，不要一次要一串清单。
5. 如果涉及复位、启停机、参数调整、登塔、开柜或带电作业，必须先写 Safety Gate 校验项，且只生成建议，不说已经执行。
6. 不主动解释长篇原理；用户追问为什么时再解释。
7. 不输出思考过程、检索过程、证据分析或内部判断依据。`
    : principleQuery || codeOnlyQuery
      ? `以下是本地 LLMWiki 检索到的相关资料，只作为回答依据，不要原样复述。

${hits}

用户问题：${text}

请用正常中文回答，像给现场同事解释一样清楚直接。
如果是故障码查询，说明故障名称、含义、复位方式、结构化 Case 缺口和来源；如果是原理/机理/工作方式提问，就按原理说明，不要强行改成排障指令。
不要输出思考过程、检索过程或内部判断依据。`
      : `以下是本地 LLMWiki 检索到的相关资料，只作为回答依据，不要原样复述。

${hits}

用户问题：${text}

请正常回答，保持简洁清楚。不要输出思考过程、检索过程或内部判断依据。`

  try {
    let answer = await askLocalModel([
      {
        role: 'system',
        content: actionQuery
          ? `${windOpsSystemInstruction()}\n面向一线运维人员，像导航一样给明确指令：结论优先，一次只给一个下一步动作，要求用户反馈最多 1 到 3 个明确结果。不要输出思考过程、检索结果、系统上下文或 Matches for 列表。`
          : `${windOpsSystemInstruction()}\n请用正常中文解释问题，保持简洁清楚，不要输出思考过程、检索结果、系统上下文或 Matches for 列表。`,
      },
      { role: 'user', content: prompt },
    ], `故障知识库总结：${query}`, CHAT_MODEL)

    if (!answer || looksLikeRawKnowledgeEcho(answer)) {
      answer = await askLocalModel([
        {
          role: 'system',
          content: actionQuery
            ? '你是 Windrise，负责结合本地风电知识库和自身专业能力回答现场问题。只输出给客户看的最终指令，不要输出思考过程或检索原文。'
            : '你是 Windrise，负责结合本地风电知识库和自身专业能力回答现场问题。只输出给客户看的正常中文回答，不要输出思考过程或检索原文。',
        },
        {
          role: 'user',
          content: actionQuery
            ? `本地知识库压缩上下文：\n${compactKnowledgeContext(hits)}\n\n${renderWindOpsArchitectureContext(text)}\n\n用户问题：${text}\n\n请直接回答用户问题。格式固定为：结论；下一步只做一件事；请反馈。只给一个动作，请反馈最多 1 到 3 个结果；涉及高风险动作时先写 Safety Gate 校验项，不解释思考过程。`
            : `本地知识库压缩上下文：\n${compactKnowledgeContext(hits)}\n\n用户问题：${text}\n\n请直接回答用户问题，正常解释含义、原理或故障信息，不要强行改成指令式排障。`,
        },
      ], `故障知识库压缩总结：${query}`, CHAT_MODEL)
    }

    if (answer) console.log(`Windrise: ${answer}`)
    const sourceLine = answer ? missingSourceLine(answer, hits) : ''
    if (sourceLine) console.log(sourceLine)
    if (answer) rememberKnowledgeTurn(text, [answer, sourceLine].filter(Boolean).join('\n'), hits, query)
    if (!answer) {
      const fallback = `本地模型没有返回整理答案。下面是压缩后的本地知识摘要：\n${compactKnowledgeContext(hits)}`
      console.log(`Windrise: ${fallback}`)
      rememberKnowledgeTurn(text, fallback, hits, query)
    }
  } catch (error) {
    const fallback = `本地模型暂时不可用，先给你原始检索结果。\n详情：${error.message}\n\n${hits}`
    console.log(`Windrise: ${fallback}`)
    rememberKnowledgeTurn(text, fallback, hits, query)
  }
}

function deterministicFieldAnswer(query, hits = '', retrievalQuery = '') {
  const userText = String(query || '')
  const lookupText = retrievalQuery || userText
  const text = `${userText}\n${hits}`
  const actionQuery = isFieldActionQuery(userText)
  const genericAction = deterministicGenericMechanismAnswer(userText)
  if (genericAction) return genericAction
  if (isYawHydraulicMotorOnceFollowUp(userText)) {
    return [
      '结论：先不处理常闭电磁换向阀。',
      '',
      '下一步只做一件事：保持所有换向阀在初始状态，测量主回路压力和液压泵电流。',
      '',
      '请反馈：主回路压力多少 bar、液压泵电流多少 A。',
    ].join('\n')
  }

  if (isYawHydraulicMotorFrequentFollowUp(userText)) {
    return [
      '结论：恢复过程中频繁补压，优先按偏航回路内泄或保压失败处理。',
      '',
      '下一步只做一件事：恢复刹车后保持静止，记录压力从150bar降到135bar所用时间。',
      '',
      '请反馈：降压用时。',
    ].join('\n')
  }

  if (isYawHydraulicMotorNoActionFollowUp(userText)) {
    return [
      '结论：先按液压站电机未启动处理，不要先拆液压阀。',
      '',
      '下一步只做一件事：恢复刹车时测液压站电机接触器线圈是否得电。',
      '',
      '请反馈：接触器线圈是否得电。',
    ].join('\n')
  }

  if (isYawHydraulicBrakeRestoredWithoutNumbers(userText)) {
    return [
      '结论：动作完成，但现在还不能判断故障点。',
      '',
      '下一步只做一件事：重新看这一轮恢复刹车的压力曲线。',
      '',
      '请反馈：最低压力、恢复到150bar用时、液压站电机动作次数。',
    ].join('\n')
  }

  if (isYawHydraulicPressureCannotBuild(userText)) {
    return [
      '结论：这是风力发电机偏航液压制动回路建压异常，不是汽车刹车问题。',
      '',
      '下一步只做一件事：恢复刹车时只观察液压站电机是否启动。',
      '',
      '请反馈：电机是“动作一次”“频繁动作”还是“不动作”。',
    ].join('\n')
  }

  if (isYawScadaPressureAbnormal(userText)) {
    return [
      '结论：先按偏航液压压力恢复异常处理，不要先判断为传感器误报。',
      '',
      '下一步只做一件事：手动释放刹车，再恢复刹车。',
      '',
      '请反馈：最低压力、恢复到150bar用时、液压站电机动作次数。',
    ].join('\n')
  }

  if (isYawHydraulicInitialQuestion(userText)) {
    return [
      '结论：先按偏航回路建压异常排查，暂时不要拆阀或更换液压泵。',
      '',
      '下一步只做一件事：手动释放刹车，再恢复刹车。',
      '',
      '请反馈：最低压力、恢复到150bar用时、液压站电机动作次数。',
    ].join('\n')
  }

  if (isYawHydraulicLongContext(userText)) {
    return [
      '结论：主回路先放过，下一步只验证偏航回路常开电磁换向阀。',
      '',
      '操作：液压站断电并释放内部压力，将偏航回路常开电磁换向阀与高速制动回路同型号电磁换向阀调换。',
      '',
      '请反馈：调换后偏航回路压力恢复时间是否恢复正常；若仍然很慢，直接反馈“调换后仍慢”。',
    ].join('\n')
  }

  if (!actionQuery && /变桨.*24\s*v.*(主电源|电源开关)|24\s*v.*主电源开关/i.test(userText)) {
    return [
      '变桨24V主电源开关，是给变桨控制回路提供24V直流电源的主开关。',
      '',
      '它通常影响变桨PLC、通讯模块、传感器反馈、继电器线圈等低压控制回路。这个开关或24V电源异常时，容易出现变桨通讯异常、反馈丢失、控制回路掉电等现象。',
      '',
      '如果你要现场处理，请直接问“变桨24V主电源开关怎么处理”，我会按一步一步的现场动作回答。',
    ].join('\n')
  }

  if (actionQuery && /齿轮箱.*(过热|过温|温度高|油温高)|(?:过热|过温|温度高|油温高).*齿轮箱/.test(userText)) {
    return [
      '结论：先按齿轮箱真实温升处理，不要先等故障码。',
      '',
      '下一步只做一件事：先确认油冷散热是否有效。检查油冷风扇/水冷回路是否运行，散热器是否堵塞，并记录当前齿轮箱油温。',
      '',
      '请反馈：油冷系统是否正常运行、当前油温数值。',
    ].join('\n')
  }

  if (actionQuery && /偏航.*(压力传感器|传感器|hmi|机械表).*?(不一致|不准|偏差|对不上)|(?:机械表|hmi).*?(偏航|压力).*?(不一致|不准|偏差|对不上)/i.test(userText)) {
    return [
      '结论：先按偏航压力采集回路异常排查，不要先判断液压本体故障。',
      '',
      '下一步只做一件事：在同一时刻记录机械表压力和HMI偏航压力读数。',
      '',
      '请反馈：机械表读数、HMI读数、是否伴随T_228/T_229告警。',
    ].join('\n')
  }

  const code = extractCode(lookupText) || extractCode(userText)
  if (code && (lookupText.trim() === code || /(故障|报警|告警|处理|怎么|如何|复位|含义|是什么)/.test(userText))) {
    const name = extractKnowledgeField(text, /(?:中文名称|故障名称|名称)[:：]\s*([^，。\n]+)/) ||
      extractKnowledgeField(text, new RegExp(`${code}\\s*为[「"“]?([^」"”。\\n]+)`))
    const reset = extractKnowledgeField(text, /复位[:：]\s*([^，。\n]+)/)
    const logic = extractKnowledgeField(text, /逻辑[:：]\s*([^。\n]+)/)
    const solution = extractKnowledgeField(text, /(?:故障处理指导|解决方案|处理方法)[:：]\s*([^。\n]+)/)
    const source = extractFirstSource(text)
    if (!actionQuery) {
      return [
        `结论：${code}${name ? ` 为「${name}」` : ' 已命中本地故障码资料'}。`,
        reset ? `复位：${reset}。` : '',
        logic ? `逻辑：${logic}。` : '',
        source ? `来源：${source}` : '',
      ].filter(Boolean).join('\n')
    }
    const firstAction = solution ||
      (name.includes('高速轴刹车温度高')
        ? '确认高速轴刹车温度是否真实偏高，记录SCADA温度值，并现场复核温度传感器接线和测温值是否一致。'
        : '先核对故障码对应页面、当前状态和伴随告警，再决定是否复位。')
    return [
      `结论：${code}${name ? ` 为「${name}」` : ' 已命中本地故障码资料'}。`,
      reset ? `复位：${reset}。` : '',
      `下一步只做一件事：${firstAction}`,
      name.includes('高速轴刹车温度高')
        ? '请反馈：SCADA温度值、现场复核温度值、传感器接线是否正常。'
        : '请反馈：当前状态、伴随告警、复位是否成功。',
      source ? `来源：${source}` : '',
    ].filter(Boolean).join('\n')
  }

  return ''
}

function deterministicGenericMechanismAnswer(text) {
  const rule = genericMechanismRules().find(item => item.pattern.test(text))
  if (!rule || !isFieldActionQuery(text)) return ''
  return [
    `结论：先按「${rule.label}」处理。`,
    '',
    'Safety Gate：确认作业票、停机/限功率状态、风速、人员权限和二次确认；如涉及复位、启停机或参数调整，只生成建议，不直连执行。',
    '',
    `下一步只做一件事：${rule.nextAction}`,
    '',
    `请反馈：${rule.feedback}`,
  ].join('\n')
}

function isYawHydraulicInitialQuestion(text) {
  return /偏航/.test(text) &&
    /液压|压力/.test(text) &&
    /欠压|压力异常|压力波动|建压/.test(text) &&
    /尚未拆阀|未拆阀|未更换液压泵|没换泵|不要拆阀|下一步|先做/.test(text)
}

function isYawHydraulicDomain(text) {
  return /(风力发电机|风机|风电|机组|偏航|液压站|SCADA|HMI|150\s*bar|主回路|换向阀|建压|恢复刹车|释放刹车)/i.test(text)
}

function latestUserFeedback(text) {
  return text.match(/用户(?:当前|最新)反馈[:：]\s*([^\n]+)/)?.[1]?.trim() || text.trim()
}

function isYawHydraulicMotorOnceFollowUp(text) {
  const feedback = latestUserFeedback(text)
  return /^(1次|一次|动作一次|电机动作一次)$/i.test(feedback) && (
    !/^会话上下文[:：]/.test(text) ||
    isYawHydraulicDomain(text)
  ) ||
    isYawHydraulicDomain(text) &&
    /电机动作次数|液压站电机|恢复到150\s*bar|恢复至150\s*bar/i.test(text) &&
    /^(1次|一次|动作一次|电机动作一次)$/i.test(feedback)
}

function isYawHydraulicMotorFrequentFollowUp(text) {
  const feedback = latestUserFeedback(text)
  return /^(频繁动作|多次动作|反复动作)$/i.test(feedback) ||
    isYawHydraulicDomain(text) &&
    /电机动作次数|液压站电机|恢复到150\s*bar|恢复至150\s*bar/i.test(text) &&
    /频繁动作|多次动作|反复动作/i.test(feedback)
}

function isYawHydraulicMotorNoActionFollowUp(text) {
  const feedback = latestUserFeedback(text)
  return /^(不动作|没有动作|未动作|没动作)$/i.test(feedback) ||
    isYawHydraulicDomain(text) &&
    /电机动作次数|液压站电机|恢复到150\s*bar|恢复至150\s*bar/i.test(text) &&
    /不动作|没有动作|未动作|没动作/i.test(feedback)
}

function isYawHydraulicBrakeRestoredWithoutNumbers(text) {
  const feedback = latestUserFeedback(text)
  return isYawHydraulicDomain(text) &&
    /已按要求|手动释放.*恢复刹车|释放并恢复刹车|恢复刹车/i.test(feedback) &&
    !/(?:\d+\s*bar|\d+\s*s|\d+\s*秒|1次|一次|频繁动作|不动作)/i.test(feedback)
}

function isYawHydraulicPressureCannotBuild(text) {
  const feedback = latestUserFeedback(text)
  return (isYawHydraulicDomain(text) || /刹车|制动|压力|液压/.test(feedback)) &&
    /(释放刹车|恢复刹车|刹车|制动)/.test(feedback) &&
    /(压力上不来|压力不上来|建压不上来|建压失败|无法建压|压力升不上去)/.test(feedback)
}

function isYawScadaPressureAbnormal(text) {
  return /偏航/.test(text) &&
    /SCADA|HMI/i.test(text) &&
    /压力异常|压力异|压力报警|压力告警|压力波动/.test(text)
}

function isYawHydraulicLongContext(text) {
  return /偏航/.test(text) &&
    /液压|压力/.test(text) &&
    /151\s*bar/i.test(text) &&
    /27\s*bar/i.test(text) &&
    /150\s*bar/i.test(text) &&
    /300\s*s|300秒/i.test(text) &&
    /电机.*动作一次|动作一次.*电机/.test(text) &&
    /主回路.*280\s*bar|280\s*bar.*主回路/i.test(text) &&
    /2\.5\s*A/i.test(text)
}

function extractKnowledgeField(text, pattern) {
  return text.match(pattern)?.[1]?.trim().replace(/[；;，,]$/, '') || ''
}

function extractFirstSource(text) {
  return text.match(/来源[:：]\s*([^\n]+)/)?.[1]?.trim() ||
    text.match(/source[:：]\s*([^\n]+)/i)?.[1]?.trim() ||
    ''
}

function looksLikeRawKnowledgeEcho(answer) {
  return /(^|\n)(Windrise:\s*)?(系统上下文：|Matches for "|# wiki\/|LLMWiki commands:)/.test(answer)
}

function looksLikeInternalReasoning(answer) {
  return /Thinking Process|We need answer|我们需要|用户问/.test(answer.slice(0, 300))
}

function compactKnowledgeContext(hits) {
  const lines = hits.split(/\r?\n/)
  const systemLine = lines.find(line => line.startsWith('系统上下文：')) || ''
  const titleLine = lines.find(line => /^#\s+.+系统/.test(line)) || ''
  const faultExamples = lines
    .filter(line => /^-\s*\d+：/.test(line))
    .slice(0, 10)
  const matchedRecords = lines
    .filter(line => /故障代码|故障名称|故障原因|故障处理|故障逻辑|复位/.test(line))
    .slice(0, 8)
  const sources = lines
    .filter(line => /\.md:\d+/.test(line))
    .slice(0, 5)
  return [
    systemLine,
    titleLine,
    faultExamples.length ? `相关故障示例：\n${faultExamples.join('\n')}` : '',
    matchedRecords.length ? `检索命中摘要：\n${matchedRecords.join('\n')}` : '',
    sources.length ? `来源：\n${sources.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 4000)
}

function missingSourceLine(answer, hits) {
  if (/来源[:：]/.test(answer)) return ''
  const sourceLine = hits.match(/^来源[:：]\s*(.+)$/m)?.[1]
  if (sourceLine) return `来源：${sourceLine}`
  const firstSupplement = hits.match(/^- (.+:\d+)$/m)?.[1]
  return firstSupplement ? `来源：${firstSupplement}` : ''
}

function rememberTurn(user, assistant, metadata = {}) {
  const userText = String(user || '').trim()
  conversationMemory.lastUser = userText
  conversationMemory.lastAssistant = String(assistant || '').trim()
  updateGeneralMemory(userText)
  if (metadata.faultCode) conversationMemory.lastFaultCode = String(metadata.faultCode)
  if (metadata.faultName) conversationMemory.lastFaultName = String(metadata.faultName)
  if (metadata.faultAnswer) conversationMemory.lastFaultAnswer = String(metadata.faultAnswer).trim()
  if (metadata.source) conversationMemory.lastSource = String(metadata.source).trim()
}

function updateGeneralMemory(text) {
  const userText = String(text || '').trim()
  const nameMatch = userText.match(/(?:我叫|我的名字(?:是|叫)?|叫我)\s*([^，,。.!！?？\s]{1,24})/)
  if (nameMatch?.[1]) conversationMemory.userName = nameMatch[1]
  const colorMatch = userText.match(/我(?:喜欢|最喜欢|爱)\s*([^，,。.!！?？\s]{1,16})(?:色|颜色)?/)
  if (colorMatch?.[1]) {
    conversationMemory.favoriteColor = /色$/.test(colorMatch[1]) ? colorMatch[1] : `${colorMatch[1]}色`
  }
}

function rememberKnowledgeTurn(user, answer, hits = '', retrievalQuery = '') {
  const code = extractCode(retrievalQuery) || extractCode(user) || extractCode(answer) || extractCode(hits)
  const name = extractKnowledgeField(`${answer}\n${hits}`, /(?:中文名称|故障名称|名称)[:：]\s*([^，。\n]+)/) ||
    extractKnowledgeField(`${answer}\n${hits}`, code ? new RegExp(`${code}\\s*为[「"“]?([^」"”。\\n]+)`) : /$^/) ||
    extractKnowledgeField(answer, /为[「"“]?([^」"”。\n]+)[」"”]?/)
  const source = extractFirstSource(answer) || extractFirstSource(hits)
  rememberTurn(user, answer, {
    faultCode: code,
    faultName: name,
    faultAnswer: answer,
    source,
  })
}

function deterministicConversationAnswer(text) {
  const normalized = String(text || '').trim()
  if (!normalized) return ''
  if (/(刚才|上一轮|上一个|这个|该|它).*(故障|故障码|报警|告警)|这个故障|该故障/i.test(normalized) && conversationMemory.lastFaultCode) {
    return answerFaultFollowUpFromMemory(normalized)
  }
  if (/刚才.*(说|问)|我.*刚才.*(说|问)|上一句|上一个问题/i.test(normalized)) {
    return conversationMemory.lastUser
      ? `你刚才说的是：“${conversationMemory.lastUser}”。`
      : '你刚才还没有提出具体问题。'
  }
  if (/总结|概括|归纳/i.test(normalized) && conversationMemory.lastAssistant) {
    return `目前这段对话主要是：${conversationMemory.lastUser}。`
  }
  if (/(我.*(?:叫|名字)|(?:叫|名字).*什么)/.test(normalized) && conversationMemory.userName) {
    return `你叫${conversationMemory.userName}。`
  }
  if (/我.*喜欢.*(?:颜色|什么)|喜欢.*(?:颜色|什么)/.test(normalized) && conversationMemory.favoriteColor) {
    return `你喜欢${conversationMemory.favoriteColor}。`
  }
  if (/^(你好|您好|hello|hi)$/i.test(normalized)) return '你好，有什么我可以帮你的吗？'
  return ''
}

function answerFaultFollowUpFromMemory(text) {
  const code = conversationMemory.lastFaultCode
  const name = conversationMemory.lastFaultName
  const source = conversationMemory.lastSource
  if (/怎么|如何|处理|处置|排查|下一步|怎么办|复位/i.test(text)) {
    return [
      `结论：继续按 ${code}${name ? `「${name}」` : ''} 处理。`,
      '下一步只做一件事：先核对故障码对应页面、当前状态和伴随告警，再决定是否复位。',
      '请反馈：当前状态、伴随告警、复位是否成功。',
      source ? `来源：${source}` : '',
    ].filter(Boolean).join('\n')
  }
  return [
    `你刚才问的是 ${code}${name ? `「${name}」` : ''}。`,
    conversationMemory.lastFaultAnswer || '',
  ].filter(Boolean).join('\n')
}

async function handleLine(line) {
  const text = line.trim()
  if (!text) return true

  if (/^(exit|quit|q|退出)$/i.test(text)) return false
  if (/^(help|帮助)$/i.test(text)) {
    printHelp()
    return true
  }
  if (/^clear$/i.test(text)) {
    history.splice(1)
    rememberTurn('', '', {
      faultCode: '',
      faultName: '',
      faultAnswer: '',
      source: '',
    })
    conversationMemory.lastFaultCode = ''
    conversationMemory.lastFaultName = ''
    conversationMemory.lastFaultAnswer = ''
    conversationMemory.lastSource = ''
    conversationMemory.userName = ''
    conversationMemory.favoriteColor = ''
    console.log('Windrise: 对话上下文已清空。')
    return true
  }
  if (/^model$/i.test(text)) {
    console.log(`Windrise: model=${CHAT_MODEL}`)
    return true
  }
  const dateAnswer = localDateTimeAnswer(text)
  if (dateAnswer) {
    console.log(`Windrise: ${dateAnswer}`)
    rememberTurn(text, dateAnswer)
    return true
  }
  const contextAnswer = deterministicConversationAnswer(text)
  if (contextAnswer) {
    console.log(`Windrise: ${contextAnswer}`)
    rememberTurn(text, contextAnswer, {
      faultCode: conversationMemory.lastFaultCode,
      faultName: conversationMemory.lastFaultName,
      faultAnswer: conversationMemory.lastFaultAnswer,
      source: conversationMemory.lastSource,
    })
    return true
  }
  if (/^farm\b/i.test(text) || shouldAnswerWindFarmModelQuestion(text)) {
    const query = text.replace(/^farm\s*/i, '').trim() || text
    await answerWithWindFarmModel(query)
    return true
  }
  const immediateFieldAnswer = /^会话上下文[:：]/.test(text) || !extractCode(text)
    ? deterministicFieldAnswer(text)
    : ''
  if (immediateFieldAnswer) {
    console.log(`Windrise: ${immediateFieldAnswer}`)
    rememberKnowledgeTurn(text, immediateFieldAnswer)
    return true
  }
  if (/^(web|search)\s+/i.test(text) || isNetworkQuery(text) || isUrl(text)) {
    try {
      await answerWithWeb(text)
    } catch (error) {
      console.log(`Windrise: 联网功能失败：${error.message}`)
    }
    return true
  }
  if (/^tree\b/i.test(text)) {
    const path = text.replace(/^tree\s*/i, '').trim()
    console.log(
      await runLlmwiki(
        path
          ? `/llmwiki tree ${path} --depth 2 --limit 50`
          : '/llmwiki tree --depth 2 --limit 50',
      ),
    )
    return true
  }
  if (/^read\b/i.test(text)) {
    const path = text.replace(/^read\s*/i, '').trim()
    if (!path) {
      console.log('Windrise: 用法：read <LLMWiki路径>')
      return true
    }
    console.log(await runLlmwiki(`/llmwiki read ${path}`))
    return true
  }
  if (/^trace\b/i.test(text)) {
    const query = text.replace(/^trace\s*/i, '').trim()
    if (!query) {
      console.log('Windrise: 用法：trace <问题/故障码/元器件>')
      return true
    }
    console.log(await runLlmwiki(`/llmwiki trace ${query} --limit 6`))
    return true
  }
  if (getRetrievalRequest(text).shouldRetrieve) {
    await answerWithRetrieval(text)
    return true
  }

  await answerNormally(text)
  return true
}

printBanner()

const rl = createInterface({ input, output, prompt: '\nwindrise> ' })
try {
  if (input.isTTY) rl.prompt()
  for await (const line of rl) {
    const keepGoing = await handleLine(line)
    if (!keepGoing) break
    if (input.isTTY) rl.prompt()
  }
} finally {
  rl.close()
}
