export function isContextCollapseEnabled(): boolean {
  return false
}
export function resetContextCollapse(): void {}
export function isWithheldPromptTooLong(): boolean {
  return false
}
export function recoverFromOverflow<T>(value: T): T {
  return value
}
export async function applyCollapsesIfNeeded<T>(value: T): Promise<T> {
  return value
}
