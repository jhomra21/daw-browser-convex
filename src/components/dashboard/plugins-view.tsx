import { For, Show, createSignal, onMount } from "solid-js"
import type { DesktopPluginCatalog } from "~/lib/desktop/attached-host-controller"
import {
  canUseVst3CatalogAction,
  hasVst3TrustAcknowledgement,
  saveVst3TrustAcknowledgement,
  vst3TrustDisclosure,
} from "~/lib/external-plugin-ui"
import { DashboardRow, DashboardScrollView, DashboardSection } from "./dashboard-shared"

const initialCatalog: DesktopPluginCatalog = {
  version: 3,
  directories: [],
  entries: [],
  diagnostics: [],
  scannedAtMs: null,
}

export function DashboardPluginsView() {
  const [catalog, setCatalog] = createSignal(initialCatalog)
  const [busy, setBusy] = createSignal(false)
  const [message, setMessage] = createSignal("")
  const localStorage = (() => {
    try {
      return window.localStorage
    } catch {
      return undefined
    }
  })()
  const [trustAcknowledged, setTrustAcknowledged] = createSignal(
    hasVst3TrustAcknowledgement(localStorage),
  )
  const bridge = window.dawDesktop?.pluginCatalog

  const update = async (action: () => ReturnType<NonNullable<typeof bridge>["read"]>) => {
    if (!bridge || busy()) return
    setBusy(true)
    try {
      const result = await action()
      if ("catalog" in result) {
        setCatalog(result.catalog)
        setMessage("")
        window.dispatchEvent(new Event("daw-plugin-catalog-changed"))
      } else if (!result.ok) {
        setMessage(result.error)
      }
    } catch {
      setMessage("The plug-in catalog could not be updated.")
    } finally {
      setBusy(false)
    }
  }

  onMount(() => {
    void update(() => bridge?.read() ?? Promise.resolve({ ok: false, error: "The desktop plug-in catalog is unavailable." }))
  })

  const addDirectory = async () => {
    if (!canUseVst3CatalogAction("add-directory", trustAcknowledged())) return
    await update(() => bridge?.chooseDirectory() ?? Promise.resolve({ ok: false, error: "The desktop plug-in catalog is unavailable." }))
  }

  const rescan = async () => {
    if (!canUseVst3CatalogAction("scan", trustAcknowledged())) return
    await update(() => bridge?.scan() ?? Promise.resolve({ ok: false, error: "The desktop plug-in catalog is unavailable." }))
  }

  return (
    <DashboardScrollView>
      <DashboardSection title="VST3 Plug-ins" description="Discovery and preflight are machine-local. Eligible effects can be activated on compatible stereo audio tracks through the native graph; browser playback remains unsupported.">
        <DashboardRow
          label="Plug-in directories"
          value={`${catalog().directories.length} configured`}
          action={<button type="button" class="h-8 border border-border px-3 text-sm disabled:opacity-50" disabled={busy() || !trustAcknowledged()} onClick={() => void addDirectory()}>Add directory</button>}
        />
        <Show when={!trustAcknowledged()}>
          <div class="border-b border-border px-4 py-3 text-xs text-muted-foreground">
            <p class="font-medium text-foreground">{vst3TrustDisclosure.title}</p>
            <p class="mt-1">{vst3TrustDisclosure.body}</p>
            <label class="mt-3 flex items-start gap-2 text-foreground">
              <input
                type="checkbox"
                checked={trustAcknowledged()}
                onChange={(event) => {
                  if (!event.currentTarget.checked) return
                  saveVst3TrustAcknowledgement(localStorage)
                  setTrustAcknowledged(true)
                }}
              />
              <span>{vst3TrustDisclosure.acknowledgement}</span>
            </label>
          </div>
        </Show>
        <For each={catalog().directories}>
          {(directory) => (
            <DashboardRow
              label={directory}
              value="Machine-local VST3 search directory"
              action={<button type="button" class="h-8 border border-border px-3 text-sm disabled:opacity-50" disabled={busy()} onClick={() => void update(() => bridge?.removeDirectory(directory) ?? Promise.resolve({ ok: false, error: "The desktop plug-in catalog is unavailable." }))}>Remove</button>}
            />
          )}
        </For>
        <DashboardRow
          label="Catalog scan"
          value={`${catalog().entries.length} VST3 bundle${catalog().entries.length === 1 ? "" : "s"} discovered`}
          action={<button type="button" class="h-8 border border-border px-3 text-sm disabled:opacity-50" disabled={busy() || !trustAcknowledged()} onClick={() => void rescan()}>Rescan</button>}
        />
        <Show when={catalog().diagnostics.length > 0}>
          <div class="border-b border-border px-4 py-3 text-xs text-muted-foreground">
            <For each={catalog().diagnostics}>{(diagnostic) => <p>{diagnostic.directory}: {diagnostic.message}</p>}</For>
          </div>
        </Show>
        <Show when={message()}>{(error) => <p class="px-4 py-2 text-xs text-destructive">{error()}</p>}</Show>
      </DashboardSection>
    </DashboardScrollView>
  )
}
