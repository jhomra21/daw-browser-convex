import { type Component } from 'solid-js'
import { Button } from '~/components/ui/button'

type TransportControlsProps = {
  isPlaying: boolean
  playheadSec: number
  onPlay: () => void
  onPause: () => void
  onStop: () => void
  onAddAudio: () => void
  onMasterFX: () => void
}

const TransportControls: Component<TransportControlsProps> = (props) => {
  return (
    <div class="grid grid-cols-3 items-center gap-2 p-3 border-b border-neutral-800 bg-neutral-900">
      {/* Left: Add Audio */}
      <div class="justify-self-start flex items-center gap-2">
        <Button variant="outline" onClick={props.onAddAudio}>Add Audio</Button>
      </div>

      {/* Center: Transport */}
      <div class="justify-self-center flex items-center gap-2">
        <Button onClick={props.onPlay} disabled={props.isPlaying}>Play</Button>
        <Button onClick={props.onPause} variant="outline" disabled={!props.isPlaying}>Pause</Button>
        <Button onClick={props.onStop} variant="outline">Stop</Button>
      </div>

      {/* Right: Master FX + Playhead */}
      <div class="justify-self-end flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={props.onMasterFX}>Master FX</Button>
        <div class="flex items-center gap-2">
          <span class="text-sm text-neutral-400">Playhead</span>
          <span class="text-sm tabular-nums">{props.playheadSec.toFixed(2)}s</span>
        </div>
      </div>
    </div>
  )
}

export default TransportControls