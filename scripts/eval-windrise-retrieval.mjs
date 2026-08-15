#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const windrise = join(root, 'bin', 'windrise')

const cases = [
  {
    name: 'fault code 709 returns all meanings and farms',
    args: ['search', '709'],
    expects: [
      '故障码 709',
      '命中 6 条记录',
      '覆盖 7 组风场/机型',
      '顺时针扭缆超限停机',
      '顺时针(CW)扭缆超限',
      '顺时针纽缆',
      '风场：裕民',
      '风场：什花道',
      '风场：新华',
      '风场：团结',
      '风场：洮北',
    ],
  },
  {
    name: 'contextual short fault code uses exact code',
    args: ['search', '报80'],
    expects: [
      '故障码 80',
      '变频器检测到故障',
      '风场：镇赉',
      '风场：同发',
    ],
    rejects: ['0100001', 'SC_塔基急停按钮触发'],
  },
  {
    name: 'exact fault name maps back to code and farms',
    args: ['search', '顺时针扭缆超限停机'],
    expects: [
      '按名称/描述「顺时针扭缆超限停机」',
      '涉及 1 个故障码',
      '709：顺时针扭缆超限停机',
      '风场：裕民',
      '风场：什花道',
      '机型：6.XMW双馈系列、高速系列',
    ],
  },
  {
    name: 'fault name with user wording still hits',
    args: ['search', '输入顺时针扭缆超限停机，查不到'],
    expects: [
      '顺时针扭缆超限停机',
      '故障代码：709',
      '风场：裕民',
      '风场：什花道',
    ],
  },
  {
    name: 'fault name with cable typo still hits',
    args: ['search', '顺时针扭揽超限停机'],
    expects: [
      '顺时针扭缆超限停机',
      '故障代码：709',
      '风场：裕民',
      '风场：什花道',
    ],
  },
  {
    name: 'fault-code lookup with cable typo still hits',
    args: ['search', '顺时针扭揽超限停机的故障码是什么'],
    expects: [
      '按名称/描述「顺时针扭缆超限停机」',
      '709：顺时针扭缆超限停机',
      '风场：裕民',
      '风场：什花道',
    ],
  },
  {
    name: 'description wording maps main breaker trip to status code',
    args: ['search', '主断路器异常跳开是什么故障造成的'],
    expects: [
      '按名称/描述「主断路器异常跳开」',
      '3356：变流器主断故障跳闸',
      '故障描述：状态码（3356）：主断路器异常跳开',
      '风场：裕民',
      '风场：什花道',
      '处理：1. 检查确认主断路器是否跳闸',
    ],
    rejects: ['本地库暂未找到精确记录', 'Matches for "主断路器异常跳开是什么故障造成的"'],
  },
  {
    name: 'contextual charger name lookup returns core charger fault',
    args: ['search', '变桨电池充电器故障的故障码是什么'],
    expects: [
      '按名称/描述「变桨电池充电器故障」',
      '303122：充电器故障',
      '风场：四平',
      '风场：团结',
      '风场：新华',
    ],
  },
  {
    name: 'generic fault name returns related codes and farms',
    args: ['search', '风速仪故障'],
    expects: [
      '按名称/描述「风速仪故障」',
      '涉及',
      '个故障码',
      '5307：风速仪故障',
      '170010：风速仪故障',
      '230：风速仪故障停机',
      '风场：团结',
      '风场：新华',
      '风场：四平',
      '风场：裕民',
    ],
    matches: [
      /涉及\s+\d+\s+个故障码/,
    ],
    rejects: ['没有找到与当前描述精确匹配'],
  },
  {
    name: 'brand-qualified fault name expands all matching farms',
    args: ['search', '运达风速仪故障'],
    expects: [
      '5307',
      '运达',
      'WD2500系列',
      'WD1500系列',
      '风场：团结',
      '风场：新华',
    ],
  },
  {
    name: 'brand-qualified fault-code lookup prefers fault name fields',
    args: ['search', '运达风速仪故障是什么码'],
    expects: [
      '5307',
      '风速仪故障',
      '运达',
      '风场：团结',
      '风场：新华',
    ],
    rejects: ['5301 为「瞬时风速大于切出风速」'],
  },
  {
    name: 'another brand-qualified fault name expands all matching farms',
    args: ['search', '华仪风速仪故障'],
    expects: [
      '170010',
      '华仪',
      '1.5,2.0MW系列',
      'HW2-S2000系列',
      '风场：四平',
      '风场：团结',
      '风场：新华',
    ],
  },
  {
    name: 'another brand-qualified fault-code lookup prefers fault name fields',
    args: ['search', '华仪风速仪故障是什么码'],
    expects: [
      '170010',
      '风速仪故障',
      '华仪',
      '风场：四平',
      '风场：团结',
      '风场：新华',
    ],
    rejects: ['700007 为「机组大风小功率」', '5301'],
  },
  {
    name: 'fault code 303804 returns farms and models',
    args: ['search', '303804'],
    expects: [
      '故障码 303804',
      '24V主电源开关故障',
      '风场：四平',
      '风场：团结',
      '风场：新华',
      '机型：1.5,2.0MW系列',
      '机型：HW2-S2000系列',
    ],
  },
  {
    name: 'farm query returns all known models',
    args: ['farm', '新华风场'],
    expects: [
      '新华风电场',
      '三一 SE8715',
      'HW2/S1500(87)',
      'WD88-1500A',
      '华仪 HW2-S2000系列',
      '运达 WD1500系列',
    ],
  },
  {
    name: 'farm query with another site returns grouped models',
    args: ['farm', '团结风电场'],
    expects: [
      '团结风电场',
      '三一 4.X-6.7MW系列',
      '华仪 HW2-S2000系列',
      '运达 WD2500系列',
      '吉林通榆团结D风电场',
    ],
  },
]

let failures = 0
for (const testCase of cases) {
  const stdout = await runWindrise(testCase.args)
  const missing = (testCase.expects || []).filter((needle) => !stdout.includes(needle))
  const missingMatches = (testCase.matches || []).filter((pattern) => !pattern.test(stdout))
  const rejected = (testCase.rejects || []).filter((needle) => stdout.includes(needle))
  const ok = missing.length === 0 && missingMatches.length === 0 && rejected.length === 0
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${testCase.name}`)
  if (!ok) {
    if (missing.length) console.log(`  missing: ${missing.join(' | ')}`)
    if (missingMatches.length) console.log(`  regex missing: ${missingMatches.map(String).join(' | ')}`)
    if (rejected.length) console.log(`  rejected present: ${rejected.join(' | ')}`)
    console.log(`  answer: ${clip(stdout)}`)
  }
}

if (failures) {
  console.error(`\n${failures} windrise retrieval case(s) failed.`)
  process.exit(1)
}

console.log('\nWindrise retrieval eval passed.')

async function runWindrise(args) {
  const { stdout } = await execFileAsync(windrise, args, {
    cwd: root,
    env: {
      ...process.env,
      LLMWIKI_PROJECT: join(root, '风机故障码'),
      ANTHROPIC_MODEL_PROVIDER: process.env.ANTHROPIC_MODEL_PROVIDER || 'lmstudio',
      WINDRISE_MODEL_MODE: process.env.WINDRISE_MODEL_MODE || 'lmstudio',
      LMSTUDIO_BASE_URL: process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234',
      LMSTUDIO_MODEL: process.env.LMSTUDIO_MODEL || 'qwen/qwen3.5-9b',
      LMSTUDIO_CHAT_MODEL: process.env.LMSTUDIO_CHAT_MODEL || process.env.LMSTUDIO_MODEL || 'qwen/qwen3.5-9b',
      WINDRISE_ENABLE_THINKING: '0',
      MAX_THINKING_TOKENS: '0',
      DISABLE_INSTALLATION_CHECKS: '1',
    },
    maxBuffer: 20 * 1024 * 1024,
    timeout: 120_000,
  })
  return stdout
}

function clip(text) {
  return text.replace(/\s+/g, ' ').slice(0, 1200)
}
