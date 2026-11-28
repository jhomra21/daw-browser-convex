import { createSignal, onCleanup, onSettled } from 'solid-js'

export const useDevicePixelRatio = () => {
  const [devicePixelRatio, setDevicePixelRatio] = createSignal(1)
  let mediaQuery: MediaQueryList | undefined
  let listener: (() => void) | undefined

  const arm = () => {
    mediaQuery?.removeEventListener('change', listener ?? (() => undefined))
    const next = window.devicePixelRatio || 1
    setDevicePixelRatio(next)
    mediaQuery = window.matchMedia(`(resolution: ${next}dppx)`)
    listener = () => arm()
    mediaQuery.addEventListener('change', listener)
  }

  onSettled(arm)
  onCleanup(() => {
    mediaQuery?.removeEventListener('change', listener ?? (() => undefined))
  })

  return devicePixelRatio
}
