#!/usr/bin/env node

const baseUrl = process.env.WINDRISE_WEB_URL || 'http://127.0.0.1:5002'

const cases = [
  {
    id: 1,
    query: '故障码200',
    expects: ['故障码 200', '命中 12 条记录', '覆盖 12 组风场/机型', '同发、镇赉', '团结风电场', '洮北', '华能四平风电场一期、镇赉'],
    rejects: ['匹配到 7 条记录', '没有找到'],
  },
  {
    id: 2,
    query: '故障码200本来应该出来3个不同的风场的结果',
    expects: ['故障码 200', '不同含义', '风场/机型：', '同发、镇赉', '团结风电场', '洮北'],
    rejects: ['故障码 3'],
  },
  {
    id: 3,
    query: '303804是什么故障，怎么处理',
    expects: ['303804', '24V主电源开关故障', '(一期)通榆团结风电场', '团结风电场', '华仪', '检查24V主电源开关线路'],
    rejects: ['让用户再提供故障码'],
  },
  {
    id: 4,
    query: '变桨24V主电源开关怎么处理',
    expects: ['303804', '24V主电源开关故障', '变桨24V主电源开关断开', '检查24V主电源开关线路'],
    rejects: [],
  },
  {
    id: 5,
    query: '风速仪故障的故障码是什么',
    expects: ['按名称/描述「风速仪故障」', '命中', '覆盖', '涉及', '170010：风速仪故障', '5307：风速仪故障', '风场/机型：'],
    rejects: ['没有找到与当前描述精确匹配', '5308：机组冰冻告警', '6504：风轮锁紧'],
  },
  {
    id: 6,
    query: '运达风速仪故障的故障码是什么',
    expects: ['5307：风速仪故障', '运达', 'WD3000 Beckhoff控制器', 'WD2500', 'WD1500', '华能通榆团结D、E风电场', '华能通榆新华风电场'],
    rejects: [],
  },
  {
    id: 7,
    query: '华仪风速仪故障对应哪些故障码',
    expects: ['170010：风速仪故障', '170041', '170042', '华仪', 'HW2S2000(103)型风力发电机', '团结风电场'],
    rejects: [],
  },
  {
    id: 8,
    query: '320是什么故障',
    expects: ['故障码 320', '不同含义', '冰传感器运行不正常', '变桨位置比较偏差大', '变频器检测到故障(EMS)'],
    rejects: ['5320：', 'T_320：'],
  },
  {
    id: 9,
    query: '歌美飒320是什么故障',
    expects: ['320', '冰传感器运行不正常', '歌美飒'],
    anyExpectGroups: [['洮北', '风电场一期']],
    rejects: ['变频器检测到故障(EMS)', '变桨位置比较偏差大'],
  },
  {
    id: 10,
    query: '504是什么故障',
    expects: ['故障码 504', '不同含义', '504：无功电量超出量程', '504：3#变桨91°限位开关损坏'],
    rejects: ['6504：', '5043：', '5044：', '5047：', '5048：'],
  },
  {
    id: 11,
    query: '130是什么故障',
    expects: ['故障码 130', '命中', '发电机转子侧电抗器温度过高', '齿轮箱油位低', '+24V控制电源丢失', '风速仪工作异常'],
    rejects: [],
  },
  {
    id: 12,
    query: '538是什么故障',
    expects: ['故障码 538', '风速仪24V保险', '同发、镇赉', '王玲山', '华锐'],
    anyExpectGroups: [['1#变桨总线急停', '1#变奖总线急停']],
    rejects: [],
  },
  {
    id: 13,
    query: '王玲山538是什么故障',
    expects: ['538', '王玲山', '华锐巴赫曼机组', '风速仪24V保险'],
    rejects: [],
  },
  {
    id: 14,
    query: '团结风电场200是什么故障',
    expects: ['200', '团结风电场', '华仪', '机侧3C相过流'],
    rejects: [],
  },
  {
    id: 15,
    query: '洮北200是什么故障',
    expects: ['200', '洮北', '歌美飒', '液压站温度低'],
    rejects: [],
  },
  {
    id: 16,
    query: '218、219、220～229，230～233分别是什么',
    expects: ['218、219', '220～229', '230～233', 'GSC A/D电流不平衡错误X=1～16', '同发、镇赉', '华锐1.5MW机组'],
    rejects: [],
  },
  {
    id: 17,
    query: '110至112是什么故障',
    expects: ['110', '111', '112', '偏航刹车打压超时', '偏航刹车磨损'],
    rejects: [],
  },
  {
    id: 18,
    query: '偏航电机故障有哪些',
    expects: ['偏航', '故障'],
    rejects: ['泛泛说检查偏航系统'],
  },
  {
    id: 19,
    query: '200能不能远程复位',
    expects: ['故障码 200', '远程', '自动一小时三次远程', '可复位故障'],
    rejects: [],
  },
  {
    id: 20,
    query: '故障码999999是什么',
    expects: ['999999'],
    rejects: ['风场：', '品牌：', '机型：'],
  },
]

const cookie = await login()
let failures = 0

for (const testCase of cases) {
  const answer = await ask(cookie, testCase.query)
  const missing = (testCase.expects || []).filter((needle) => !answer.includes(needle))
  const bad = (testCase.rejects || []).filter((needle) => answer.includes(needle))
  const missingAny = (testCase.anyExpectGroups || []).filter(
    (group) => !group.some((needle) => answer.includes(needle)),
  )
  const ok = missing.length === 0 && bad.length === 0 && missingAny.length === 0
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${testCase.id}. ${testCase.query}`)
  if (!ok) {
    if (missing.length) console.log(`  missing: ${missing.join(' | ')}`)
    if (missingAny.length) console.log(`  missing any of: ${missingAny.map((g) => g.join(' / ')).join(' | ')}`)
    if (bad.length) console.log(`  rejected present: ${bad.join(' | ')}`)
    console.log(`  answer: ${clip(answer)}`)
  }
}

{
  const sessionId = await createSession(cookie, '80 候选选择回归')
  await askWithConversation(cookie, '80', { sessionId })
  const second = await askWithConversation(cookie, '团结风电场', { sessionId })
  const answer = second.answer
  const expects = ['80', '团结风电场', '华仪', '网侧', '相环流故障']
  const rejects = ['故障代码：513', '故障代码：515', '故障代码：516', '匹配到 20 条记录', '偏航刹车打压超时']
  const missing = expects.filter((needle) => !answer.includes(needle))
  const bad = rejects.filter((needle) => answer.includes(needle))
  const ok = missing.length === 0 && bad.length === 0
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} 21. 80 后选择团结风电场`)
  if (!ok) {
    if (missing.length) console.log(`  missing: ${missing.join(' | ')}`)
    if (bad.length) console.log(`  rejected present: ${bad.join(' | ')}`)
    console.log(`  answer: ${clip(answer)}`)
  }
}

if (failures) {
  console.error(`\n${failures} web fault-table case(s) failed.`)
  process.exit(1)
}

console.log('\nAll web fault-table cases passed.')

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

async function ask(cookie, message) {
  return (await askWithConversation(cookie, message)).answer
}

async function createSession(cookie, title) {
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

async function askWithConversation(cookie, message, options = {}) {
  const conversationId = options.conversationId || ''
  const sessionId = options.sessionId || ''
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
      ...(conversationId ? { conversation_id: conversationId } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
    }),
  })
  if (!response.ok) throw new Error(`chat failed for ${message}: ${response.status}`)
  const payload = await response.json()
  return {
    answer: String(payload.answer || ''),
    conversationId: String(payload.conversation_id || conversationId || ''),
  }
}

function clip(text, limit = 520) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized
}
