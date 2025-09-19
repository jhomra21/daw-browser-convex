import { type Component, Show } from 'solid-js'
import type { Track } from '~/types/timeline'
import { Button } from '~/components/ui/button'

type EffectsPanelProps = {
  isOpen: boolean
  selectedFXTarget: string
  tracks: Track[]
  onClose: () => void
  onOpen: () => void
}

const EffectsPanel: Component<EffectsPanelProps> = (props) => {
  const targetName = () => {
    const id = props.selectedFXTarget
    if (id === 'master') return 'Master'
    const track = props.tracks.find(t => t.id === id)
    return track?.name ?? 'Track'
  }

  return (
    <>
      <Show when={props.isOpen}>
        <div class="fixed left-0 right-0 bottom-0 border-t border-neutral-800 bg-neutral-900">
          <div class="h-10 px-4 flex items-center justify-between">
            <div class="font-semibold">Effects — {targetName()}</div>
            <div class="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={props.onClose}>Collapse</Button>
            </div>
          </div>
          <div class="px-4 pb-4 text-sm text-neutral-400">
            No effects added yet.
          </div>
        </div>
      </Show>

      <Show when={!props.isOpen}>
        <button
          class="fixed bottom-4 right-4 bg-neutral-800 text-white rounded-md px-3 py-2 border border-neutral-700 hover:bg-neutral-700"
          onClick={props.onOpen}
        >
          Open Effects
        </button>
      </Show>
    </>
  )
}

export default EffectsPanel