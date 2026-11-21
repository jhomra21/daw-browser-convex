import { For, Show, createSignal, onMount } from "solid-js"
import type { DesktopPluginCatalog } from "~/lib/desktop/attached-host-controller"
import { canUseVst3CatalogAction, vst3TrustDisclosure } from "~/lib/external-plugin-ui"
import { createVst3Trust, notifyPluginCatalogChanged } from "~/lib/desktop/plugin-catalog-session"
import { autoHealStaleVst3Catalog } from "~/lib/desktop/vst3-catalog-auto-heal"
import { DashboardRow, DashboardScrollView, DashboardSection } from "./dashboard-shared"
import { desktopBridge } from "~/lib/runtime"

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

  const trust = createVst3Trust()

  const bridge = desktopBridge()?.pluginCatalog
  let activeUpdate: Promise<void> | undefined
  let activeScan: Promise<void> | undefined

  const update = (
    action: () => ReturnType<NonNullable<typeof bridge>["read"]>,
    autoHeal = false,
  ) => {
    const pluginCatalogBridge = bridge

    if (!pluginCatalogBridge || busy()) return Promise.resolve()
    const shouldAutoHeal = autoHeal && trust.acknowledged()

    const run = async () => {
      setBusy(true)

      try {
        const result = await action()

        if ("catalog" in result) {
          setCatalog(result.catalog)
          setMessage("")
          notifyPluginCatalogChanged()

          if (shouldAutoHeal) {
            const healed = await autoHealStaleVst3Catalog({
              catalog: result.catalog,
              bridge: pluginCatalogBridge,
              trustAcknowledged: true,
              onCatalog: setCatalog,
            })

            if (healed && !healed.ok) setMessage(healed.error)
          }
        } else if (!result.ok) {
          setMessage(result.error)
        }
      } catch {
        setMessage("The plug-in catalog could not be updated.")
      } finally {
        setBusy(false)
      }
    }

    const promise = run()
    activeUpdate = promise
    void promise.finally(() => {
      if (activeUpdate === promise) activeUpdate = undefined
    })

    return promise
  }

  onMount(() => {
    void update(
      () => bridge?.read() ?? Promise.resolve({ ok: false, error: "The desktop plug-in catalog is unavailable." }),
      true,
    )
  })

  const addDirectory = async () => {
    if (!canUseVst3CatalogAction("add-directory", trust.acknowledged())) return
    await update(() => bridge?.chooseDirectory() ?? Promise.resolve({ ok: false, error: "The desktop plug-in catalog is unavailable." }))
  }

  const rescan = async () => {
    if (!canUseVst3CatalogAction("scan", trust.acknowledged())) return

    if (activeScan) return activeScan

    const run = async () => {
      await activeUpdate
      await update(() => bridge?.scan() ?? Promise.resolve({ ok: false, error: "The desktop plug-in catalog is unavailable." }))
    }

    const promise = run()
    activeScan = promise

    try {
      await promise
    } finally {
      if (activeScan === promise) activeScan = undefined
    }
  }

  return (
    <DashboardScrollView>
      <DashboardSection title="VST3 Plug-ins" description="Discovery and preflight are machine-local. Eligible effects can be activated on compatible stereo audio tracks through the native graph; browser playback remains unsupported.">
        <DashboardRow
          label="Plug-in directories"
          value={`${catalog().directories.length} configured`}
          action={<button type="button" class="h-8 border border-border px-3 text-sm disabled:opacity-50" disabled={busy() || !trust.acknowledged()} onClick={() => void addDirectory()}>Add directory</button>}
        />
        <Show when={!trust.acknowledged()}>
          <div class="border-b border-border px-4 py-3 text-xs text-muted-foreground">
            <p class="font-medium text-foreground">{vst3TrustDisclosure.title}</p>
            <p class="mt-1">{vst3TrustDisclosure.body}</p>
            <label class="mt-3 flex items-start gap-2 text-foreground">
              <input
                type="checkbox"
                checked={trust.acknowledged()}
                onChange={(event) => {
                  if (!event.currentTarget.checked) return
                  trust.set(true)
                  void rescan()
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
          action={<button type="button" class="h-8 border border-border px-3 text-sm disabled:opacity-50" disabled={busy() || !trust.acknowledged()} onClick={() => void rescan()}>Rescan</button>}
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
