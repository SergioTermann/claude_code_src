import type { BetaMessage, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

export type AnyMessageRecord = Record<string, any>

export type AssistantMessage = AnyMessageRecord & {
  type: 'assistant'
  message: BetaMessage
}

export type UserMessage = AnyMessageRecord & {
  type: 'user'
  message: BetaMessageParam
}

export type SystemMessage = AnyMessageRecord & { type: 'system' }
export type AttachmentMessage = AnyMessageRecord & { type: 'attachment' }
export type ProgressMessage = AnyMessageRecord & { type: 'progress' }
export type HookResultMessage = AnyMessageRecord & { type: 'hook' }
export type SystemAPIErrorMessage = AnyMessageRecord & { type: 'system' }
export type SystemInformationalMessage = AnyMessageRecord & { type: 'system' }
export type SystemStopHookSummaryMessage = AnyMessageRecord & { type: 'system' }
export type SystemBridgeStatusMessage = AnyMessageRecord & { type: 'system' }
export type SystemTurnDurationMessage = AnyMessageRecord & { type: 'system' }
export type SystemThinkingMessage = AnyMessageRecord & { type: 'system' }
export type SystemMemorySavedMessage = AnyMessageRecord & { type: 'system' }
export type PartialCompactDirection = AnyMessageRecord
export type NormalizedMessage = AnyMessageRecord
export type NormalizedUserMessage = AnyMessageRecord
export type NormalizedAssistantMessage = AnyMessageRecord
export type RenderableMessage = AnyMessageRecord
export type CollapsedReadSearchGroup = AnyMessageRecord
export type GroupedToolUseMessage = AnyMessageRecord

export type Message =
  | AssistantMessage
  | UserMessage
  | SystemMessage
  | AttachmentMessage
  | ProgressMessage
  | HookResultMessage
  | AnyMessageRecord
