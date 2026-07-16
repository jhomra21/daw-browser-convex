import { runBrowserCharacterization, type BrowserCharacterizationReport } from '@daw-browser/audio-engine/browser-characterization'
import { createFileRoute } from '@tanstack/solid-router'
import { createSignal, onMount, Show } from 'solid-js'

export const Route = createFileRoute('/dsp-characterization')({
  head: () => ({ meta: [{ title: 'DSP Characterization' }] }),
  component: DspCharacterization,
})

function DspCharacterization() {
  const searchParams = new URLSearchParams(window.location.search)
  const diagnosticEnabled = searchParams.get('diagnostic') === 'dsp'
  const [report, setReport] = createSignal<BrowserCharacterizationReport>()
  const [error, setError] = createSignal<string>()
  const [running, setRunning] = createSignal(false)

  const run = async () => {
    setRunning(true)
    setError()
    try {
      setReport(await runBrowserCharacterization())
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    } finally {
      setRunning(false)
    }
  }

  onMount(() => {
    if (diagnosticEnabled && searchParams.get('autorun') === '1') void run()
  })
  return (
    <Show
      when={diagnosticEnabled}
      fallback={
        <main class="flex min-h-screen items-center justify-center bg-neutral-950 text-neutral-400">
          <p>Diagnostic route unavailable.</p>
        </main>
      }
    >
    <main class="min-h-screen bg-neutral-950 p-6 text-neutral-100">
      <div class="mx-auto max-w-4xl">
        <h1 class="text-2xl font-semibold">DSP characterization</h1>
        <p class="mt-2 text-sm text-neutral-400">
          Browser-only baseline for OfflineAudioContext DSP, worklet registration, and native sample-rate conversion.
        </p>
        <button
          type="button"
          class="mt-5 border border-neutral-700 bg-neutral-800 px-4 py-2 text-sm hover:bg-neutral-700 disabled:opacity-50"
          disabled={running()}
          onClick={() => void run()}
        >
          {running() ? 'Running…' : 'Run characterization'}
        </button>
        <Show when={error()}>
          {(message) => <p role="alert" class="mt-4 text-sm text-red-400">{message()}</p>}
        </Show>
        <Show when={report()}>
          {(result) => (
            <pre
              id="dsp-characterization-result"
              data-status="complete"
              class="mt-5 overflow-auto border border-neutral-800 bg-black p-4 text-xs text-neutral-200"
            >
              {JSON.stringify(result(), null, 2)}
            </pre>
          )}
        </Show>
      </div>
    </main>
    </Show>
  )
}
