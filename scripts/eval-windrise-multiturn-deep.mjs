#!/usr/bin/env node

const baseUrl = process.env.WINDRISE_WEB_URL || 'http://127.0.0.1:5002'

const cookie = await login()
let failures = 0

const cases = [
  {
    name: 'fault code action followups stay on 303804',
    turns: ['303804是什么故障', '怎么处理', '怎么复位'],
    finalExpects: ['303804', '24V主电源开关故障', '复位'],
    finalRejects: ['参数读取错误', '顺时针扭缆', '风速仪'],
  },
  {
    name: 'fault code then farm narrows or reports no match without switching subject',
    turns: ['80是什么故障', '团结风电场'],
    finalExpects: ['80', '未找到与', '镇赉', '同发'],
    finalRejects: ['查询结果：', '机型清单', '5980', '偏航刹车打压超时'],
  },
  {
    name: 'short contextual code works in conversation',
    turns: ['报80', '哪些风场有'],
    finalExpects: ['80', '镇赉', '同发'],
    finalRejects: ['0100001', 'SC_塔基急停按钮触发'],
  },
  {
    name: 'fault-name typo maps to code and repair followup',
    turns: ['顺时针扭揽超限停机是什么故障码', '这个怎么处理'],
    finalExpects: ['709', '顺时针扭缆', '解缆'],
    finalRejects: ['2038', '轴承温度', '24V主电源'],
  },
  {
    name: 'new explicit fault code overrides previous fault context',
    turns: ['303804是什么故障', '709是什么故障', '怎么处理'],
    finalExpects: ['709', '顺时针', '扭缆'],
    finalRejects: ['303804', '24V主电源开关故障', '参数读取错误'],
  },
  {
    name: 'new explicit fault name overrides previous code context',
    turns: ['303804是什么故障', '华仪风速仪故障是什么码', '怎么处理'],
    finalExpects: ['170010', '风速仪故障', '检查'],
    finalRejects: ['303804', '24V主电源开关故障', '顺时针扭缆'],
  },
  {
    name: 'brand-qualified wind-speed fault code stays brand filtered',
    turns: ['运达风速仪故障是什么码', '有哪些风场', '怎么复位'],
    finalExpects: ['5307', '运达', 'MR'],
    finalRejects: ['170010', '华仪', '700007 为'],
  },
  {
    name: 'brand switch between similar fault names is honored',
    turns: ['运达风速仪故障是什么码', '华仪风速仪故障是什么码', '这个怎么处理'],
    finalExpects: ['170010', '华仪', '风速仪故障'],
    finalRejects: ['5307 为', '运达风速仪', '瞬时风速大于切出风速'],
  },
  {
    name: 'retrieval result memory narrows bearing temperature by farm and brand',
    turns: [
      '轴承温度过高，且反复报错，或异响，震动噪声过大是什么原因造成的',
      '新华风场运达风机',
    ],
    finalExpects: ['新华', '运达', 'WD1500', '轴承温度'],
    finalRejects: ['查询结果： - 新华风电场', 'SS-0 保险断开'],
  },
  {
    name: 'farm model query remains model mapping and does not inherit fault',
    turns: ['303804是什么故障', '新华风场有哪些风机机型'],
    finalExpects: ['新华风电场', 'WD1500'],
    finalRejects: ['303804', '24V主电源开关故障', '同发风电场'],
  },
  {
    name: 'after farm model query a fault followup still uses latest fault if explicit pronoun',
    turns: ['303804是什么故障', '新华风场有哪些风机机型', '刚才那个故障怎么复位'],
    finalExpects: ['303804', '24V主电源开关故障', '复位'],
    finalRejects: ['查询结果：', '同发风电场', '参数读取错误'],
  },
  {
    name: 'unknown fault code does not borrow previous known code',
    turns: ['303804是什么故障', '999999是什么故障'],
    finalExpects: ['999999'],
    finalRejects: ['303804', '24V主电源开关故障', '风场：', '品牌：', '机型：'],
  },
  {
    name: 'nonsense fault name should not overmatch to a real fault',
    turns: ['不存在的扭缆超级故障是什么码'],
    finalExpects: ['未找到'],
    finalRejects: ['800017', '709：', '顺时针扭缆超限停机'],
  },
  {
    name: 'code coverage followup uses recent code only',
    turns: ['709是什么故障', '这个码哪些风场有'],
    finalExpects: ['709', '裕民', '什花道', '新华', '洮北'],
    finalRejects: ['303804', '24V主电源'],
  },
  {
    name: 'dimension miss for code reports known sites instead of unrelated match',
    turns: ['80', '团结'],
    finalExpects: ['80', '未找到与', '镇赉', '同发'],
    finalRejects: ['5980', '5340', '查询结果：'],
  },
  {
    name: 'direct repair by fault name retrieves local wiki',
    turns: ['顺时针扭缆超限停机怎么处理'],
    finalExpects: ['709', '顺时针扭缆', '解缆'],
    finalRejects: ['本地知识库暂未找到', '通用风机运维知识'],
  },
  {
    name: 'short code with explicit site does not suffix-match unrelated long code',
    turns: ['团结风电场80是什么故障'],
    finalExpects: ['80', '未找到与', '镇赉', '同发'],
    finalRejects: ['5980', '15824', '变流器急停触发'],
  },
  {
    name: 'two independent sessions do not share context',
    turns: ['怎么复位'],
    finalExpects: [],
    finalRejects: ['303804', '709', '170010', '24V主电源开关故障'],
  },
]

for (const testCase of cases) {
  await runConversationCase(testCase)
}

if (failures) {
  console.error(`\n${failures} windrise deep multiturn case(s) failed.`)
  process.exit(1)
}

console.log('\nWindrise deep multiturn eval passed.')

async function runConversationCase(testCase) {
  const sessionId = await createSession(testCase.name)
  let answer = ''
  for (const turn of testCase.turns) {
    answer = await ask(turn, sessionId)
  }
  const missing = (testCase.finalExpects || []).filter(needle => !answer.includes(needle))
  const bad = (testCase.finalRejects || []).filter(needle => answer.includes(needle))
  const ok = missing.length === 0 && bad.length === 0
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${testCase.name}`)
  if (!ok) {
    if (missing.length) console.log(`  missing: ${missing.join(' | ')}`)
    if (bad.length) console.log(`  rejected present: ${bad.join(' | ')}`)
    console.log(`  answer: ${clip(answer)}`)
  }
}

async function login() {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  })
  if (!response.ok) throw new Error(`login failed: ${response.status}`)
  const setCookie = response.headers.get('set-cookie')
  if (!setCookie) throw new Error('login did not return a session cookie')
  return setCookie.split(';')[0]
}

async function createSession(title) {
  const response = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify({ title }),
  })
  if (!response.ok) throw new Error(`create session failed: ${response.status}`)
  const payload = await response.json()
  if (!payload.success || !payload.session_id) {
    throw new Error(`create session returned invalid payload: ${JSON.stringify(payload)}`)
  }
  return payload.session_id
}

async function ask(message, sessionId) {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify({
      message,
      response_mode: 'blocking',
      user: 'admin',
      session_id: sessionId,
    }),
  })
  if (!response.ok) throw new Error(`chat failed for ${message}: ${response.status}`)
  const payload = await response.json()
  return String(payload.answer || '')
}

function clip(text, limit = 1000) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized
}
