declare module 'bun:bundle' {
  export function feature(name: string): boolean
}

declare module 'react/compiler-runtime' {
  export const c: any
}

declare const Bun: any

interface PromiseConstructor {
  withResolvers<T>(): PromiseWithResolvers<T>
}

interface PromiseWithResolvers<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: any) => void
}

declare const MACRO: {
  VERSION: string
  BUILD_TIME: string
  FEEDBACK_CHANNEL: string
  ISSUES_EXPLAINER: string
  NATIVE_PACKAGE_URL: string
  PACKAGE_URL: string
  VERSION_CHANGELOG: string
}

declare module '@ant/*'
declare module 'audio-capture-napi'
declare module 'image-processor-napi'
declare module 'modifiers-napi'
declare module 'url-handler-napi'
declare module 'color-diff-napi'
declare module '*.node'
