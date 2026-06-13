import { useCallback, useEffect, useRef } from 'react'

export function useEventCallback<T extends (...args: any[]) => any>(fn: T): T {
  const fnRef = useRef(fn)

  useEffect(() => {
    fnRef.current = fn
  }, [fn])

  return useCallback(((...args: any[]) => fnRef.current(...args)) as T, [])
}
