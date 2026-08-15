#!/usr/bin/env node

/**
 * Multi-turn context switching tests for Windrise routing.
 * These test scenarios verify that context is properly managed when users
 * switch between different topics, wind farms, and question types.
 *
 * To run: Start the server at http://127.0.0.1:5002, then:
 * node scripts/test-context-switching.mjs
 */

const baseUrl = process.env.WINDRISE_WEB_URL || 'http://127.0.0.1:5002'

let cookie = ''
let failures = 0

async function main() {
  console.log('Windrise 上下文切换测试\n')
  console.log('=' .repeat(80))

  cookie = await login()

  // Test 1: Cross-wind-farm context switching (the original bug scenario)
  await runContextTest({
    name: '跨风场上下文切换（原始bug场景）',
    turns: [
      '八面风场zc09风机偏航回路欠压故障触发条件是什么',
      '轴承温度异常怎么处理',
      '四平风场',
    ],
    expectations: [
      { turn: 1, shouldContain: ['八面', '偏航', 'ZC09'], shouldNotContain: ['四平'] },
      { turn: 2, shouldContain: ['风场', '机型', '补充'], shouldNotContain: ['八面', '偏航'] },
      { turn: 3, shouldContain: ['四平', '多个', '哪个期次', '哪种机型'], shouldNotContain: ['八面'] },
    ],
  })

  // Test 2: Theory → Fault switching
  await runContextTest({
    name: '理论问题 → 故障问题切换',
    turns: [
      '变桨系统的工作原理是什么',
      '新华风场运达WD1500变桨故障怎么处理',
    ],
    expectations: [
      { turn: 1, shouldContain: ['原理', '通用'], shouldNotContain: ['知识库', '检索'] },
      { turn: 2, shouldContain: ['新华', 'WD1500', '变桨'], shouldNotContain: ['工作原理'] },
    ],
  })

  // Test 3: Incomplete → Complete query progression
  await runContextTest({
    name: '不完整查询 → 补充信息 → 完整查询',
    turns: [
      '轴承温度过高怎么处理',
      '新华风场',
      '运达WD1500',
    ],
    expectations: [
      { turn: 1, shouldContain: ['缺少', '风场', '机型'], shouldNotContain: ['LLMWiki'] },
      { turn: 2, shouldContain: ['缺少', '机型'], shouldNotContain: ['检索词'] },
      { turn: 3, shouldContain: ['WD1500', '轴承'], shouldNotContain: ['缺少'] },
    ],
  })

  // Test 4: Multiple fault queries on different wind farms
  await runContextTest({
    name: '多个不同风场的故障查询',
    turns: [
      '新华风场运达WD1500主轴轴承温度高',
      '八面风场中车CWT齿轮箱漏油',
      '得胜风场三一风机偏航异响',
    ],
    expectations: [
      { turn: 1, shouldContain: ['新华', 'WD1500', '轴承'], shouldNotContain: ['八面', '得胜'] },
      { turn: 2, shouldContain: ['八面', 'CWT', '齿轮箱'], shouldNotContain: ['新华', 'WD1500'] },
      { turn: 3, shouldContain: ['得胜', '三一', '偏航'], shouldNotContain: ['八面', '新华'] },
    ],
  })

  // Test 5: Multi-model wind farm disambiguation after fault query
  await runContextTest({
    name: '故障查询后风场消歧',
    turns: [
      '发电机轴承温度85度且持续上升',
      '华能四平风场',
    ],
    expectations: [
      { turn: 1, shouldContain: ['缺少', '风场'], shouldNotContain: [] },
      { turn: 2, shouldContain: ['四平', '多个', '哪个期次'], shouldNotContain: ['检索词'] },
    ],
  })

  // Test 6: Same wind farm follow-up questions
  await runContextTest({
    name: '同一风场连续追问',
    turns: [
      '新华风场运达WD1500偏航故障',
      '这个怎么复位',
      '需要检查哪些部件',
    ],
    expectations: [
      { turn: 1, shouldContain: ['新华', 'WD1500', '偏航'], shouldNotContain: [] },
      { turn: 2, shouldContain: ['复位', '新华'], shouldNotContain: ['缺少'] },
      { turn: 3, shouldContain: ['检查', '部件'], shouldNotContain: ['缺少'] },
    ],
  })

  // Test 7: Theory question doesn't pollute fault context
  await runContextTest({
    name: '理论问题不污染故障上下文',
    turns: [
      '新华风场运达WD1500主轴轴承温度监测',
      '轴承温度的正常范围是多少',
      '八面风场ZC08轴承温度报警',
    ],
    expectations: [
      { turn: 1, shouldContain: ['新华', 'WD1500'], shouldNotContain: [] },
      { turn: 2, shouldContain: ['正常', '范围'], shouldNotContain: ['LLMWiki'] },
      { turn: 3, shouldContain: ['八面', 'ZC08'], shouldNotContain: ['新华'] },
    ],
  })

  console.log('\n' + '='.repeat(80))
  if (failures === 0) {
    console.log('\n✅ 所有上下文切换测试通过')
  } else {
    console.error(`\n❌ ${failures} 个测试失败`)
    process.exit(1)
  }
}

async function runContextTest(test) {
  console.log(`\n测试: ${test.name}`)
  console.log('-'.repeat(80))

  const sessionId = await createSession(test.name)
  const answers = []

  for (let i = 0; i < test.turns.length; i++) {
    const turn = test.turns[i]
    console.log(`\n  Turn ${i + 1}: "${turn}"`)
    const answer = await ask(turn, sessionId)
    answers.push(answer)

    const expectation = test.expectations[i]
    if (expectation) {
      const missing = expectation.shouldContain.filter(needle => !answer.includes(needle))
      const unexpected = expectation.shouldNotContain.filter(needle => answer.includes(needle))

      if (missing.length > 0) {
        console.log(`    ❌ 缺少关键词: ${missing.join(', ')}`)
        failures++
      }
      if (unexpected.length > 0) {
        console.log(`    ❌ 包含不应出现的词: ${unexpected.join(', ')}`)
        failures++
      }
      if (missing.length === 0 && unexpected.length === 0) {
        console.log(`    ✅ 通过`)
      } else {
        console.log(`    回答片段: ${clip(answer, 200)}`)
      }
    }
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

function clip(text, limit = 200) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized
}

main().catch(error => {
  console.error('\n错误:', error.message)
  process.exit(1)
})
