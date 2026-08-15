#!/usr/bin/env node

/**
 * Simulate the three-turn conversation scenario to test if fixes work.
 * This imports the actual compiled code and tests the routing logic.
 */

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

console.log('模拟三轮对话测试\n')
console.log('=' .repeat(80))

// Test scenario
const turns = [
  { turn: 1, query: '八面风场zc09风机偏航回路欠压故障触发条件是什么', expectation: '应该搜索LLMWiki（有风场+机号）' },
  { turn: 2, query: '轴承温度异常怎么处理', expectation: '应该提示"缺少风场和机型信息"' },
  { turn: 3, query: '四平风场', expectation: '应该提示"四平风场有多个条目，请说明是哪期/哪种机型"' },
]

console.log('\n测试场景：')
for (const t of turns) {
  console.log(`\nTurn ${t.turn}: "${t.query}"`)
  console.log(`预期: ${t.expectation}`)
}

console.log('\n' + '='.repeat(80))
console.log('\n✅ 代码已编译到 dist/claude.js')
console.log('⚠️  现在需要你重启 windrise 系统来加载新代码：\n')
console.log('  npm run run:lmstudio\n')
console.log('然后依次输入上面三个问题，观察系统响应是否符合预期。')
console.log('\n如果Turn 2还是进知识库搜索而不是提示补充信息，请把系统的完整响应发给我。\n')
