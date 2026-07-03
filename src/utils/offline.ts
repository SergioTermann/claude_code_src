import { isEnvTruthy } from './envUtils.js'
import { isLocalModelProvider } from './model/providers.js'

export function isOfflineMode(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_OFFLINE) ||
    isLocalModelProvider()
  )
}

export function assertOnlineFeature(featureName: string): void {
  if (!isOfflineMode()) return
  throw new Error(
    `${featureName} is unavailable in offline/local-model mode. Use local tools or disable CLAUDE_CODE_OFFLINE/local provider to use it.`,
  )
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
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

export function assertOnlineOrLoopbackUrl(featureName: string, url: string): void {
  if (!isOfflineMode() || isLoopbackUrl(url)) return
  throw new Error(
    `${featureName} can only access localhost or private LAN URLs in offline/local-model mode.`,
  )
}
