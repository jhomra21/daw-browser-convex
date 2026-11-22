import { makePersisted, type PersistenceSyncAPI } from "@solid-primitives/storage"
import { createStore, type StoreSetter, type Store } from "solid-js"
import { canUseLocalStorage, createStoredValue } from "~/lib/stored-value"
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

const storedAppPreferences = createStoredValue<AppPreferences>({
  key: () => APP_PREFERENCES_STORAGE_KEY,
  fallback: () => defaultAppPreferences,
  parse: (raw) => normalizeAppPreferences(JSON.parse(raw)),
  serialize: JSON.stringify,
})

export const loadInitialAppPreferences = (): AppPreferences => storedAppPreferences.read("")

export const createPersistedAppPreferencesWithInitial = (
  initialPreferences: AppPreferences
): [
  Store<AppPreferences>,
  StoreSetter<AppPreferences>
] => {
  const [preferences, setPreferences] = createStore(initialPreferences)

  const store: [Store<AppPreferences>, StoreSetter<AppPreferences>] = [
    preferences,
    setPreferences,
  ]

  if (!canUseLocalStorage()) return store

  const [persistedPreferences, setPersistedPreferences] = makePersisted(store, {
    name: APP_PREFERENCES_STORAGE_KEY,
    storage: localStorage,
    sync: sameOriginLocalStorageSync,
    serialize: JSON.stringify,
    deserialize: (value) => normalizeAppPreferences(JSON.parse(value))
  })

  return [persistedPreferences, setPersistedPreferences]
}
