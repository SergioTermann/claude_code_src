#!/usr/bin/env node

const baseUrl = process.env.WINDRISE_WEB_URL || 'http://127.0.0.1:5002'

const cookie = await login()
let failures = 0

await runConversationCase({
  name: 'retrieval result is reused when user adds farm and brand',
  turns: [
    '轴承温度过高，且反复报错，或异响，震动噪声过大是什么原因造成的',
    '新华风场运达风机',
  ],
  expects: ['新华', '运达', 'WD1500', '轴承温度'],
  rejects: ['查询结果： - 新华风电场', 'SS-0 保险断开'],
})

await runConversationCase({
  name: 'fault-code candidate context is reused when user adds site',
  turns: ['80', '团结风电场'],
  expects: ['80', '未找到与', '镇赉', '同发'],
  rejects: ['查询结果： - 团结风电场', '15824', '5340', '5980', '变流器急停触发'],
})

await runConversationCase({
  name: 'short contextual fault code is treated as code',
  turns: ['报80'],
  expects: ['80', '变频器检测到故障', '镇赉', '同发'],
  rejects: ['0100001', 'SC_塔基急停按钮触发'],
})

await runConversationCase({
  name: 'repair followup keeps recent exact fault code',
  turns: ['303804是什么故障', '怎么复位'],
  expects: ['303804', '24V主电源开关故障', '复位'],
  rejects: ['2 参数读取错误', '参数读取错误'],
})

await runConversationCase({
  name: 'fault-name lookup context is reused for repair followup',
  turns: ['顺时针扭揽超限停机是什么故障码', '这个怎么处理'],
  expects: ['709', '顺时针扭缆超限停机', '解缆'],
  rejects: ['2038', '轴承温度', '齿轮箱高速轴'],
})

await runConversationCase({
  name: 'fault-name direct repair uses local wiki',
  turns: ['顺时针扭缆超限停机怎么处理'],
  expects: ['709', '顺时针扭缆超限停机', '解缆'],
  rejects: ['本地知识库暂未找到', '通用风机运维知识', '±3°'],
})

await runConversationCase({
  name: 'farm model query returns only requested farm',
  turns: ['新华风场有哪些风机机型'],
  expects: ['新华风电场', 'WD1500'],
  rejects: ['同发风电场', '洮北风电场', '内置风场与风机型号对应关系'],
})

await runConversationCase({
  name: 'new component issue after history code clears inherited code',
  turns: ['303804是什么故障', '齿轮箱油温上来了'],
  expects: ['齿轮箱', '油温'],
  rejects: ['303804', '24V主电源开关'],
})

await runConversationCase({
  name: 'model capacity identifier is not treated as fault code',
  turns: ['WD3000机组'],
  expects: ['WD3000', '机组'],
  rejects: ['故障码', '报警', '告警'],
})

await runConversationCase({
  name: 'parameterized fault is retrieval ready',
  turns: ['发电机轴承温度85度且持续上升'],
  expects: ['轴承', '温度', '85'],
  rejects: [],
})

await runConversationCase({
  name: 'fault description explanation uses conversation context',
  turns: ['顺时针扭缆超限停机是什么故障码', '这个是什么意思'],
  expects: ['扭缆'],
  rejects: ['303804', '24V主电源开关'],
})

await runConversationCase({
  name: 'fault description followup expands prior diagnosis context',
  turns: ['齿轮箱油温持续升高怎么办', '下一步怎么排查'],
  expects: ['齿轮箱', '油温'],
  rejects: ['303804', '24V主电源开关'],
})

// ── 跨风场上下文切换测试（验证修复：不同风场之间不应互相污染检索记忆） ──────────────

await runConversationCase({
  name: '[cross-farm] switch from 新华 to 八面 does not bleed xinhua context',
  turns: [
    '新华风场运达 WD1500 主控板通讯故障怎么处理',
    '八面风电场 ZC08 叶片结冰停机怎么处理',
  ],
  expects: ['八面', 'ZC08', '叶片', '结冰'],
  rejects: ['新华风电场', 'WD1500', '主控板通讯'],
})

await runConversationCase({
  name: '[cross-farm] switch from 华能四平一期 to 福林 does not bleed siping context',
  turns: [
    '华能四平风电场一期金风 GW82-1500 偏航故障是什么原因',
    '福林风电场运达 WD200 变频器报警怎么处理',
  ],
  expects: ['福林', '运达', '变频器'],
  rejects: ['华能四平', 'GW82', '偏航'],
})

await runConversationCase({
  name: '[cross-farm] three-farm switch only retains last farm context',
  turns: [
    '新华风场 303804 是什么故障',
    '得胜风电场三一风机主轴轴承温度高怎么处理',
    '八面风电场 ZC01 齿轮箱漏油怎么处理',
  ],
  expects: ['八面', '齿轮箱', '漏油'],
  rejects: ['新华风电场', '303804', '得胜', '三一'],
})

await runConversationCase({
  name: '[cross-farm] follow-up "怎么处理" after farm switch is about new farm',
  turns: [
    '新华风场 WD1500 发电机温度过高告警',
    '福林风电场运达 WD200 偏航轴承异响',
    '怎么处理',
  ],
  expects: ['福林', '偏航', '轴承'],
  rejects: ['新华风电场', '发电机温度', 'WD1500'],
})

// ── 同一风场内追问应保留上下文 ──────────────────────────────────────────────────

await runConversationCase({
  name: '[same-farm] repair followup for same farm retains retrieval context',
  turns: [
    '八面风电场 ZC08 叶片结冰停机是什么故障',
    '如何复位',
  ],
  expects: ['八面', '叶片', '结冰'],
  rejects: ['新华风电场', 'WD1500'],
})

await runConversationCase({
  name: '[same-farm] 下一步 query stays on same wind farm topic',
  turns: [
    '福林风电场 WD200 变桨系统故障怎么排查',
    '下一步要检查哪些部件',
  ],
  expects: ['福林', '变桨'],
  rejects: ['新华风电场', '华能四平', '得胜'],
})

// ── 故障码切换（不同风场故障码互不干扰）────────────────────────────────────────

await runConversationCase({
  name: '[fault-switch] different farm fault codes do not bleed',
  turns: [
    '新华风场报 303804',
    '八面风电场 ZC08 报 E0022',
  ],
  expects: ['八面', 'E0022'],
  rejects: ['303804', '24V主电源开关', '新华风电场'],
})

await runConversationCase({
  name: '[fault-switch] fault lookup then switch to different farm model question',
  turns: [
    '新华风场变频器通讯中断故障怎么处理',
    '八面风电场有哪些机型',
  ],
  expects: ['八面', '中车山东', 'CWT'],
  rejects: ['新华风电场', 'WD1500', '变频器通讯'],
})

if (failures) {
  console.error(`\n${failures} windrise context case(s) failed.`)
  process.exit(1)
}

console.log('\nWindrise context eval passed.')

async function runConversationCase(testCase) {
  const sessionId = await createSession(testCase.name)
  let answer = ''
  for (const turn of testCase.turns) {
    answer = await ask(turn, sessionId)
  }
  const missing = (testCase.expects || []).filter(needle => !answer.includes(needle))
  const bad = (testCase.rejects || []).filter(needle => answer.includes(needle))
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

function clip(text, limit = 900) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized
}
