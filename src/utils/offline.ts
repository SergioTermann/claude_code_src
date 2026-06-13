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
    `${featureName} can only access localhost URLs in offline/local-model mode.`,
  )
}
