import { registerSW } from 'virtual:pwa-register'

/**
 * Keeps installed copies (home-screen app, cached tabs) on the latest
 * version. An installed app keeps running the version it last loaded
 * until fully restarted, and an older version can disagree with the
 * current Firestore rules — e.g. an old host whose Start is rejected
 * while the new guest waits forever.
 *
 * A new version is downloaded in the background; CameraStage applies it
 * (a quick reload) only while the player is on the main menu, never
 * mid-game or in an online lobby. Updates are checked on launch, every
 * 30 minutes, and whenever the app comes back to the foreground.
 */
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000

let updateReady = false
let applyUpdate: (() => Promise<void>) | null = null
const listeners = new Set<() => void>()

export function isUpdateReady(): boolean {
  return updateReady
}

/** Calls back once a new version has been downloaded and is waiting. */
export function onUpdateReady(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Switches to the waiting version (reloads the page). */
export function applyAppUpdate(): void {
  void applyUpdate?.()
}

export function registerAppUpdates(): void {
  const updateSW = registerSW({
    onNeedRefresh() {
      updateReady = true
      listeners.forEach((listener) => listener())
    },
    onRegisteredSW(_url, registration) {
      if (!registration) return
      const check = () => void registration.update().catch(() => {})
      setInterval(check, UPDATE_CHECK_INTERVAL_MS)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check()
      })
    },
  })
  applyUpdate = () => updateSW(true)
}
