export const isDesktopRenderer = () => import.meta.env.VITE_DESKTOP === 'true'

export const desktopBridge = () => globalThis.window?.dawDesktop

export const isMacDesktop = () => desktopBridge() !== undefined && /Macintosh/.test(navigator.userAgent)
