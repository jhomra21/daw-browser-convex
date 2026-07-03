import { makePersisted, type PersistenceSyncAPI } from "@solid-primitives/storage"
import { createStore, type SetStoreFunction, type Store } from "solid-js/store"
import { canUseLocalStorage } from "~/lib/timeline-storage"
import {
  APP_PREFERENCES_STORAGE_KEY,
  defaultAppPreferences,
  normalizeAppPreferences,
  type AppPreferences
} from "./app-preferences-core"

export * from "./app-preferences-core"

// Solid Primitives `storageSync` scopes updates by full route URL. App preferences are browser-wide,
// so same-origin tabs on different routes should still receive localStorage updates.
const sameOriginLocalStorageSync: PersistenceSyncAPI = [
  (subscriber) => window.addEventListener("storage", (event) => {
    if (event.key === null) return
    subscriber({ key: event.key, newValue: event.newValue, timeStamp: event.timeStamp })
  }),
  () => {}
]

export const loadInitialAppPreferences = (): AppPreferences => {
  if (!canUseLocalStorage()) return defaultAppPreferences

  try {
    const stored = localStorage.getItem(APP_PREFERENCES_STORAGE_KEY)
    if (stored) return normalizeAppPreferences(JSON.parse(stored))
  } catch {
    return defaultAppPreferences
  }
  return defaultAppPreferences
}

export const createPersistedAppPreferencesWithInitial = (
  initialPreferences: AppPreferences
): [
  Store<AppPreferences>,
  SetStoreFunction<AppPreferences>
] => {
  if (!canUseLocalStorage()) return createStore(initialPreferences)

  const [preferences, setPreferences] = makePersisted(createStore(initialPreferences), {
    name: APP_PREFERENCES_STORAGE_KEY,
    storage: localStorage,
    sync: sameOriginLocalStorageSync,
    serialize: JSON.stringify,
    deserialize: (value) => normalizeAppPreferences(JSON.parse(value))
  })
  return [preferences, setPreferences]
}
