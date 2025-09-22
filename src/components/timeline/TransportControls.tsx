import { type Component, createSignal, For } from 'solid-js'
import { Button } from '~/components/ui/button'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '~/components/ui/dropdown-menu'
import UserInfoDropdown from '~/components/UserInfoDropdown'
import { useConvexQuery, convexApi } from '~/lib/convex'
import { useSessionQuery } from '~/lib/session'

type TransportControlsProps = {
  isPlaying: boolean
  playheadSec: number
  onPlay: () => void
  onPause: () => void
  onStop: () => void
  onAddAudio: () => void
  onMasterFX: () => void
  onShare?: () => void
  // Projects controls
  currentRoomId: string
  onOpenProject: (roomId: string) => void
  onCreateProject: () => void | Promise<void>
  onDeleteProject: (roomId: string) => void | Promise<void>
}

const TransportControls: Component<TransportControlsProps> = (props) => {
  const [shareOpen, setShareOpen] = createSignal(false)
  const [copied, setCopied] = createSignal(false)

  // Projects data
  const session = useSessionQuery()
  const userId = () => (session()?.data?.user as any)?.id ?? ''
  const myRooms = useConvexQuery(
    convexApi.projects.listMine,
    () => userId() ? ({ userId: userId() }) : null,
    () => ['projects', 'mine', userId()]
  )
  const rooms = () => {
    const raw: any = (myRooms as any).data
    return (typeof raw === 'function' ? raw() : raw) as string[] | undefined
  }

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

      {/* Right: Projects + Share + Master FX + Playhead */}
      <div class="justify-self-end flex items-center gap-3">
        {/* Projects Dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger>
            <Button variant="outline" size="sm">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4 mr-1">
                <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 7h5l2 2h11v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <title>Projects</title>
              </svg>
              Projects
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent class="w-full bg-neutral-900" style={{ width: 'min(92vw, 24rem)' }}>
            <div class="p-2 w-full">
              <div class="flex items-center justify-between px-1 pb-2">
                <span class="text-sm font-semibold text-neutral-100">My Projects</span>
                <Button variant="default" size="sm" onClick={() => props.onCreateProject()}>
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4 mr-1">
                    <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 5v14m-7-7h14" />
                    <title>New</title>
                  </svg>
                  New
                </Button>
              </div>
              <DropdownMenuSeparator />
              <div class="max-h-72 overflow-y-auto">
                <For each={rooms() ?? []}>
                  {(rid) => (
                    <DropdownMenuItem
                      class={`group flex items-center justify-between gap-2 cursor-pointer hover:bg-neutral-800 hover:text-neutral-100 ${props.currentRoomId === rid ? 'text-green-400' : ''}`}
                      onSelect={() => props.onOpenProject(rid)}
                    >
                      <div class="flex items-center gap-2 min-w-0">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4 text-neutral-400 group-hover:text-neutral-200">
                          <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 7h5l2 2h11v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                          <title>Project</title>
                        </svg>
                        <span class={`font-mono text-xs truncate max-w-[14rem] ${props.currentRoomId === rid ? 'text-green-400 group-hover:text-green-300' : 'text-neutral-200 group-hover:text-neutral-400'}`} title={rid}>{rid}</span>
                      </div>
                      <button
                        class="opacity-0 group-hover:opacity-100 transition-opacity text-neutral-400 hover:text-red-500 p-1"
                        aria-label="Delete project"
                        onClick={(ev) => { ev.stopPropagation(); ev.preventDefault(); if (window.confirm(`Delete project \"${rid}\"? This cannot be undone.`)) props.onDeleteProject(rid) }}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                          <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-1 0v14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V6m3 4v8m4-8v8" />
                          <title>Delete</title>
                        </svg>
                      </button>
                    </DropdownMenuItem>
                  )}
                </For>
                {((rooms() ?? []).length === 0) && (
                  <div class="px-2 py-2 text-xs text-neutral-500">No projects yet</div>
                )}
              </div>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
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