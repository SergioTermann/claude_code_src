import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'

let esbuild
try {
  esbuild = await import('esbuild')
} catch (error) {
  console.error('Missing build dependency: esbuild')
  console.error('Run `npm install` before `npm run build`.')
  process.exit(1)
}

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const srcRoot = join(root, 'src')
const outFile = join(root, 'dist', 'claude.js')
const version = '2.1.88'
const enabledFeatures = new Set(
  (process.env.CLAUDE_CODE_FEATURES || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean),
)

mkdirSync(dirname(outFile), { recursive: true })

function resolveSourceLike(specifier, resolveDir) {
  let base
  if (specifier.startsWith('src/')) {
    base = join(root, specifier)
  } else if (specifier.startsWith('.')) {
    base = resolve(resolveDir, specifier)
  } else if (isAbsolute(specifier)) {
    base = specifier
  } else {
    return null
  }

  const candidates = []
  const ext = extname(base)
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs') {
    const withoutExt = base.slice(0, -ext.length)
    candidates.push(`${withoutExt}.ts`, `${withoutExt}.tsx`, `${withoutExt}.js`, `${withoutExt}.jsx`, `${withoutExt}.mjs`, `${withoutExt}.cjs`)
  } else if (ext) {
    candidates.push(base)
  } else {
    candidates.push(base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`, `${base}.json`, join(base, 'index.ts'), join(base, 'index.tsx'), join(base, 'index.js'), join(base, 'index.mjs'), join(base, 'index.cjs'), join(base, 'index.json'))
  }

  return candidates.find(candidate => existsSync(candidate) && !statSync(candidate).isDirectory()) ?? null
}

const recoveredSourcePlugin = {
  name: 'recovered-source',
  setup(build) {
    build.onResolve({ filter: /^(src\/|\.{1,2}\/)/ }, args => {
      const resolved = resolveSourceLike(args.path, args.resolveDir || srcRoot)
      return resolved ? { path: resolved } : undefined
    })

    build.onResolve({ filter: /^(bun:bundle)$/ }, () => ({
      path: 'bun:bundle',
      namespace: 'recovered-bun-bundle',
    }))

    build.onResolve({ filter: /^@growthbook\/growthbook$/ }, () => ({
      path: '@growthbook/growthbook',
      namespace: 'recovered-growthbook',
    }))

    build.onResolve({ filter: /^merge-stream$/ }, () => ({
      path: 'merge-stream',
      namespace: 'recovered-merge-stream',
    }))

    build.onResolve({ filter: /^emoji-regex$/ }, () => ({
      path: 'emoji-regex',
      namespace: 'recovered-emoji-regex',
    }))

    build.onResolve({ filter: /^proxy-from-env$/ }, () => ({
      path: join(root, 'node_modules', 'proxy-from-env', 'index.cjs'),
    }))

    build.onResolve({ filter: /^color-diff-napi$/ }, () => ({
      path: join(srcRoot, 'native-ts', 'color-diff', 'index.ts'),
    }))

    build.onResolve({ filter: /^@ant\// }, args => ({
      path: args.path,
      namespace: 'recovered-ant-stub',
    }))

    build.onLoad({ filter: /.*/, namespace: 'recovered-ant-stub' }, () => ({
      contents: `
export const API_RESIZE_PARAMS = {}
export const BROWSER_TOOLS = []
export const DEFAULT_GRANT_FLAGS = {}
export function bindSessionContext() { return async () => ({ content: [] }) }
export function buildComputerUseTools() { return [] }
export function createClaudeForChromeMcpServer() { throw new Error('@ant/claude-for-chrome-mcp is unavailable in recovered builds') }
export function createComputerUseMcpServer() { return { server: { setRequestHandler() {} } } }
export function getSentinelCategory() { return undefined }
export function targetImageSize() { return undefined }
`,
      loader: 'js',
    }))

    build.onLoad({ filter: /.*/, namespace: 'recovered-bun-bundle' }, () => ({
      contents: 'export const feature = () => false\n',
      loader: 'js',
    }))

    build.onLoad({ filter: /.*/, namespace: 'recovered-growthbook' }, () => ({
      contents: `
export class GrowthBook {
  constructor() { this.payload = { features: {} } }
  init() { return Promise.resolve({ source: 'recovered-offline-stub', success: false }) }
  getPayload() { return this.payload }
  setPayload(payload) { this.payload = payload ?? { features: {} }; return Promise.resolve() }
  getFeatures() { return this.payload?.features ?? {} }
  getFeatureValue(_feature, defaultValue) { return defaultValue }
  refreshFeatures() { return Promise.resolve() }
  destroy() {}
}
`,
      loader: 'js',
    }))

    build.onLoad({ filter: /.*/, namespace: 'recovered-merge-stream' }, () => ({
      contents: `
import { PassThrough } from 'node:stream'
export default function mergeStream(...streams) {
  const output = new PassThrough({ objectMode: true })
  let sources = []
  output.setMaxListeners(0)
  output.add = source => {
    if (Array.isArray(source)) {
      source.forEach(output.add)
      return output
    }
    sources.push(source)
    source.once('end', () => {
      sources = sources.filter(item => item !== source)
      if (!sources.length && output.readable) output.end()
    })
    source.once('error', output.emit.bind(output, 'error'))
    source.pipe(output, { end: false })
    return output
  }
  output.isEmpty = () => sources.length === 0
  streams.forEach(output.add)
  return output
}
`,
      loader: 'js',
    }))

    build.onLoad({ filter: /.*/, namespace: 'recovered-emoji-regex' }, () => ({
      contents: 'export default function emojiRegex() { return /\\p{Extended_Pictographic}/gu }',
      loader: 'js',
    }))

    build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, args => {
      let contents = readFileSync(args.path, 'utf8')
      contents = contents.replace(
        /\bfeature\(\s*(['"])([A-Z0-9_]+)\1\s*\)/g,
        (_, _quote, name) => String(enabledFeatures.has(name)),
      )
      return {
        contents,
        loader: args.path.endsWith('x') ? 'tsx' : extname(args.path).includes('ts') ? 'ts' : 'js',
      }
    })

    build.onLoad({ filter: /\.d\.ts$/ }, () => ({
      contents: '',
      loader: 'ts',
    }))
  },
}

await esbuild.build({
  entryPoints: [join(srcRoot, 'entrypoints', 'cli.tsx')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
  },
  define: {
    'process.env.USER_TYPE': JSON.stringify(process.env.USER_TYPE || 'external'),
    'MACRO.VERSION': JSON.stringify(version),
    'MACRO.BUILD_TIME': JSON.stringify(new Date().toISOString()),
    'MACRO.FEEDBACK_CHANNEL': JSON.stringify('https://github.com/anthropics/claude-code/issues'),
    'MACRO.ISSUES_EXPLAINER': JSON.stringify(''),
    'MACRO.NATIVE_PACKAGE_URL': JSON.stringify(''),
    'MACRO.PACKAGE_URL': JSON.stringify(''),
    'MACRO.VERSION_CHANGELOG': JSON.stringify(''),
  },
  external: [
    '@anthropic-ai/bedrock-sdk',
    '@anthropic-ai/foundry-sdk',
    '@anthropic-ai/vertex-sdk',
    '@aws-sdk/*',
    '@azure/*',
    '@smithy/*',
    'google-auth-library',
    'audio-capture-napi',
    'image-processor-napi',
    'modifiers-napi',
    'url-handler-napi',
    '*.node',
  ],
  plugins: [recoveredSourcePlugin],
  loader: {
    '.md': 'text',
    '.txt': 'text',
  },
  logLevel: 'info',
})
