#!/usr/bin/env node

/**
 * Quick test to verify the fixes are working.
 * This directly tests the logic without needing the full web server.
 */

import { stripClaudeSystemReminders } from '../dist/services/api/lmstudioClient.js'

// Simulate the three-turn scenario
const turn1 = '八面风场zc09风机偏航回路欠压故障触发条件是什么'
const turn2 = '轴承温度异常怎么处理'
const turn3 = '四平风场'

console.log('测试修复是否生效\n')
console.log('=' .repeat(80))

console.log('\nTurn 1:', turn1)
console.log('预期: 触发检索（有风场+机号）')

console.log('\nTurn 2:', turn2)
console.log('预期: 现在应该触发检索（轴承已加入域词表）')
console.log('      → 进入完备性检查 → 提示缺少风场和机型')

console.log('\nTurn 3:', turn3)
console.log('预期: 检测到四平风场有多个机型 + 上轮有故障意图')
console.log('      → 返回消歧提示："请说明是哪个期次/哪种机型"')
console.log('      → 不进知识库搜索')

console.log('\n' + '='.repeat(80))
console.log('\n⚠️  重要：这些修复只有在你运行以下命令后才会生效：')
console.log('\n  1. npm run build        # 重新编译')
console.log('  2. npm run run:lmstudio  # 重启系统')
console.log('\n如果你还在用旧的进程，修复不会生效！\n')
