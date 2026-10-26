// Decides whether the landing page at `/` should show. It is meant for first-time
// visitors only: an installed PWA, or anyone who already used the app, goes
// straight to the app.
const USED_KEY = 'cs2d:app-used'
// Written by the library before the landing existed, so existing users count as
// returning without having to visit again.
const LEGACY_USED_KEYS = ['cs2dv:recent-demos', 'demo-viewer-locale']

/** True when running as an installed PWA (or iOS home-screen app). */
export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: window-controls-overlay)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** True once the visitor has opened the app (or used it before the landing existed). */
export function hasUsedApp(): boolean {
  return read(USED_KEY) === '1' || LEGACY_USED_KEYS.some((k) => read(k) !== null)
}

export function markAppUsed(): void {
  try {
    localStorage.setItem(USED_KEY, '1')
  } catch {
    // Storage blocked: the landing may show again, which is harmless.
  }
}
