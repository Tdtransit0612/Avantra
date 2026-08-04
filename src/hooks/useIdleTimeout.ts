import { useEffect, useRef, useCallback } from 'react'

interface UseIdleTimeoutOptions {
  timeoutMs?: number       // total idle time before logout (default 30 min)
  warningMs?: number       // how long before timeout to show warning (default 2 min)
  onWarn?: () => void      // called when warning threshold is reached
  onTimeout?: () => void   // called when idle timeout fires
}

const ACTIVITY_EVENTS = [
  'mousedown', 'mousemove', 'keydown',
  'scroll', 'touchstart', 'click', 'wheel',
]

export function useIdleTimeout({
  timeoutMs  = 30 * 60 * 1000,   // 30 minutes
  warningMs  = 2  * 60 * 1000,   // 2 minutes
  onWarn,
  onTimeout,
}: UseIdleTimeoutOptions = {}) {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const warningRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const warnFiredRef = useRef(false)

  const clearTimers = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    if (warningRef.current) clearTimeout(warningRef.current)
  }, [])

  const resetTimers = useCallback(() => {
    clearTimers()
    warnFiredRef.current = false

    // Schedule warning
    warningRef.current = setTimeout(() => {
      warnFiredRef.current = true
      onWarn?.()
    }, timeoutMs - warningMs)

    // Schedule logout
    timeoutRef.current = setTimeout(() => {
      onTimeout?.()
    }, timeoutMs)
  }, [timeoutMs, warningMs, onWarn, onTimeout, clearTimers])

  useEffect(() => {
    resetTimers()

    ACTIVITY_EVENTS.forEach(evt =>
      window.addEventListener(evt, resetTimers, { passive: true })
    )

    return () => {
      clearTimers()
      ACTIVITY_EVENTS.forEach(evt =>
        window.removeEventListener(evt, resetTimers)
      )
    }
  }, [resetTimers, clearTimers])
}
