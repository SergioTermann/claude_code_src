export const DEFAULT_UPLOAD_CONCURRENCY = 4
export const FILE_COUNT_LIMIT = 1000
export const OUTPUTS_SUBDIR = 'outputs'

export type FailedPersistence = Record<string, unknown>
export type FilesPersistedEventData = Record<string, unknown>
export type PersistedFile = Record<string, unknown>
export type TurnStartTime = number
