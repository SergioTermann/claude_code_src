#!/usr/bin/env node

/**
 * Quick test to verify Windrise query routing logic.
 * Run: node scripts/test-routing.mjs
 */

const testCases = [
  {
    category: '理论问题（应走理论路由，不搜索）',
    cases: [
      '变桨系统的工作原理是什么',
      '偏航系统是怎么工作的',
      '齿轮箱的作用是什么',
      '为什么轴承需要冷却',
    ],
  },
  {
    category: '故障问题（应检查完备性）',
    cases: [
      '轴承温度异常怎么处理', // 缺风场+机型
      '新华风场轴承温度异常怎么处理', // 缺机型
      '运达风机轴承温度异常怎么处理', // 缺风场
      '新华风场运达WD1500轴承温度异常怎么处理', // 完整
    ],
  },
  {
    category: '故障码查询（有故障码，应直接搜索）',
    cases: ['303804是什么故障', '报303804', '八面风场ZC09偏航故障'],
  },
  {
    category: '风场多机型（应消歧）',
    cases: [
      // 场景：先问故障，再说"四平风场"
      '四平风场', // 在故障上下文中
    ],
  },
  {
    category: '风场查询（非故障上下文）',
    cases: ['四平风场有哪些机型', '新华风场是什么机型'],
  },
]

console.log('Windrise 路由测试用例\n')
console.log('=' .repeat(60))

for (const group of testCases) {
  console.log(`\n${group.category}:`)
  for (const query of group.cases) {
    console.log(`  - "${query}"`)
  }
}

console.log('\n' + '='.repeat(60))
console.log('\n实际测试需要启动完整系统，这里仅展示测试用例。')
console.log('运行: npm run run:lmstudio 后逐个测试上述查询。\n')
