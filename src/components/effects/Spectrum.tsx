import type { SpectrumParams } from '@daw-browser/shared'
import type { SpectrumFrame } from '@daw-browser/audio-engine/audio-engine'
import EffectShell from '~/components/effects/EffectShell'
import SpectrumView, { SpectrumViewToggle } from '~/components/effects/SpectrumView'

type SpectrumProps = {
  params: SpectrumParams
  frame: SpectrumFrame | null
  onChange: (updates: Partial<SpectrumParams>) => void
  onToggleEnabled: (enabled: boolean) => void
  onReset: () => void
}

export default function Spectrum(props: SpectrumProps) {
  return (
    <EffectShell title="Spectrum" typeLabel="Audio" enabled={props.params.enabled} onToggleEnabled={props.onToggleEnabled} onReset={props.onReset} class="w-96 min-w-96">
      <div class="flex min-h-0 flex-1 flex-col gap-2 px-3 py-3">
        <SpectrumViewToggle view={props.params.view} disabled={!props.params.enabled} onChange={(view) => props.onChange({ view })} />
        <div class="min-h-0 flex-1">
          <SpectrumView frame={props.params.enabled ? props.frame : null} view={props.params.view} />
        </div>
      </div>
    </EffectShell>
  )
}
