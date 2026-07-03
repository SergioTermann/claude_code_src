export type HookEvent = string
export type ExitReason = string
export type ModelUsage = Record<string, unknown>
export type SDKAssistantMessage = Record<string, unknown>
export type SDKAssistantMessageError = Record<string, unknown>
export type SDKControlMessage = Record<string, unknown>
export type SDKMessage = Record<string, unknown>
export type SDKResultMessage = Record<string, unknown>
export type SDKResultSuccess = Record<string, any> & {
  type?: 'result'
  subtype?: 'success'
  session_id?: string
}
export type SDKStatus = Record<string, unknown>
export type SDKUserMessage = Record<string, unknown>
export type SDKUserMessageReplay = Record<string, unknown>
export type HookInput = Record<string, unknown>
export type HookJSONOutput = Record<string, unknown>
export type PermissionResult = Record<string, unknown>
export type PermissionUpdate = Record<string, unknown>
export type McpServerConfigForProcessTransport = Record<string, unknown>
export type McpServerStatus = Record<string, unknown>
export type ModelInfo = Record<string, unknown>
export type RewindFilesResult = Record<string, unknown>
