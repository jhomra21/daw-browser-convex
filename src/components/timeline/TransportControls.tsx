import { type Component, createSignal } from 'solid-js'
import { Button } from '~/components/ui/button'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } from '~/components/ui/dropdown-menu'
import UserInfoDropdown from '~/components/UserInfoDropdown'

type TransportControlsProps = {
  isPlaying: boolean
  playheadSec: number
  onPlay: () => void
  onPause: () => void
  onStop: () => void
  onAddAudio: () => void
  onMasterFX: () => void
  onShare?: () => void
}

const TransportControls: Component<TransportControlsProps> = (props) => {
  const [shareOpen, setShareOpen] = createSignal(false)
  const [copied, setCopied] = createSignal(false)

  const handleOpenShare = async () => {
    try {
      // Allow parent to ensure roomId is present in URL first
      await props.onShare?.()
    } catch {}
    setShareOpen(true)
  }

  const copyUrl = async () => {
    try {
      const url = window.location.href
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url)
      }
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {}
  }

  const onShareMenuOpenChange = (open: boolean) => {
    setShareOpen(open)
    if (!open) setCopied(false)
  }

  return (
    <div class="grid grid-cols-3 items-center gap-2 p-3 border-b border-neutral-800">
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

      {/* Right: Share + Master FX + Playhead */}
      <div class="justify-self-end flex items-center gap-3">
        <DropdownMenu open={shareOpen()} onOpenChange={onShareMenuOpenChange}>
          <DropdownMenuTrigger>
            <Button variant="outline" size="sm" onClick={handleOpenShare}>Share</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent class="w-full bg-neutral-900" style={{ width: 'min(92vw, 24rem)' }}>
            <div class="p-3 w-full">
              <div class="flex items-center justify-between mb-3">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-semibold text-neutral-200">Share this room</span>
                </div>
                <button
                  type="button"
                  class="rounded p-1 text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800"
                  aria-label="Close"
                  onClick={() => setShareOpen(false)}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                    <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m7 7l10 10M17 7L7 17" />
                    <title>Close</title>
                  </svg>
                </button>
              </div>
              <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 w-full">
                <div class="min-w-0 max-w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-200 shadow-inner w-full">
                  <div class="font-mono" style={{ "overflow": "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>{window.location.href}</div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={copied() ? 'Copied' : 'Copy URL'}
                  class={`shrink-0 ${copied() ? 'text-green-500' : 'text-neutral-400'}`}
                  onClick={copyUrl}
                >
                  {copied() ? (
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                      <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m5 12l5 5L20 7" />
                      <title>Copied</title>
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                      <g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect width="8" height="8" x="8" y="8" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
                      </g>
                      <title>Copy</title>
                    </svg>
                  )}
                </Button>
              </div>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="outline" size="sm" onClick={props.onMasterFX}>Master FX</Button>
        <div class="flex items-center gap-2">
          <span class="text-sm text-neutral-400">Playhead</span>
          <span class="text-sm tabular-nums">{props.playheadSec.toFixed(2)}s</span>
        </div>
        {/* User info dropdown at the far right */}
        <UserInfoDropdown />
      </div>
    </div>
  )
}

export default TransportControls