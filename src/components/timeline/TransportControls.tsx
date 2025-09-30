import { type Component, createSignal, For, onMount, onCleanup, Show, createEffect, on, untrack } from 'solid-js'
import { Button } from '~/components/ui/button'
import Icon from '~/components/ui/Icon'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '~/components/ui/dropdown-menu'
import UserInfoDropdown from '~/components/UserInfoDropdown'
import { useConvexQuery, convexApi, convexClient } from '~/lib/convex'
import { useSessionQuery } from '~/lib/session'
import { useProjectSamples } from '~/hooks/useProjectSamples'

type TransportControlsProps = {
  isPlaying: boolean
  playheadSec: number
  onPlay: () => void
  onPause: () => void
  onStop: () => void
  onAddAudio: () => void
  onMasterFX: () => void
  onShare?: () => void
  bpm: number
  onChangeBpm: (next: number) => void
  metronomeEnabled: boolean
  onToggleMetronome: () => void
  // Grid snapping
  gridEnabled: boolean
  onToggleGrid: () => void
  gridDenominator: number
  onChangeGridDenominator: (n: number) => void
  loopEnabled: boolean
  onToggleLoop: () => void
  isRecording: boolean
  onToggleRecord: () => void
  // Samples controls
  onJumpToClip: (clipId: string, trackId: string, startSec: number) => void
  onInsertSample: (input: { url: string; name?: string; duration?: number }) => void | Promise<void>
  // Projects controls
  currentRoomId: string
  onOpenProject: (roomId: string) => void
  onCreateProject: () => void | Promise<void>
  onDeleteProject: (roomId: string) => void | Promise<void>
  onRenameProject: (roomId: string, name: string) => void | Promise<void>
}

const TransportControls: Component<TransportControlsProps> = (props) => {
  const [shareOpen, setShareOpen] = createSignal(false)
  const [copied, setCopied] = createSignal(false)

  // Inline confirm state for project deletion
  const [confirmingProjectId, setConfirmingProjectId] = createSignal<string | null>(null)
  const [deletingProjectId, setDeletingProjectId] = createSignal<string | null>(null)
  // Inline rename state
  const [editingProjectId, setEditingProjectId] = createSignal<string | null>(null)
  const [editingName, setEditingName] = createSignal<string>('')
  const [renamingProjectId, setRenamingProjectId] = createSignal<string | null>(null)
  // Samples actions state
  const [confirmingSampleUrl, setConfirmingSampleUrl] = createSignal<string | null>(null)
  const [deletingSampleUrl, setDeletingSampleUrl] = createSignal<string | null>(null)
  const [insertingSampleUrl, setInsertingSampleUrl] = createSignal<string | null>(null)
  const [samplesOpen, setSamplesOpen] = createSignal(false)
  const [isDraggingSample, setIsDraggingSample] = createSignal(false)
  const [tempoDraft, setTempoDraft] = createSignal(String(props.bpm))
  const [tempoEditing, setTempoEditing] = createSignal(false)
  const [tempoDragActive, setTempoDragActive] = createSignal(false)
  let tempoDragStartY = 0
  let tempoDragStartValue = 0

  createEffect(on(() => props.bpm, (value) => {
    if (!untrack(() => tempoEditing())) {
      setTempoDraft(String(value))
    }
  }))

  const sanitizeTempo = (value: number) => {
    if (!Number.isFinite(value)) return props.bpm
    return Math.min(300, Math.max(30, Math.round(value)))
  }

  const commitTempo = () => {
    const raw = tempoDraft().trim()
    if (!raw) {
      setTempoDraft(String(props.bpm))
      return
    }
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) {
      setTempoDraft(String(props.bpm))
      return
    }
    const sanitized = sanitizeTempo(parsed)
    setTempoDraft(String(sanitized))
    if (sanitized !== props.bpm) {
      props.onChangeBpm(sanitized)
    }
  }

  const beginTempoDrag = (event: PointerEvent) => {
    const target = event.currentTarget as HTMLInputElement | null
    if (!target || tempoDragActive()) return
    const parsedDraft = Number(tempoDraft())
    tempoDragStartValue = Number.isFinite(parsedDraft) ? sanitizeTempo(parsedDraft) : props.bpm
    tempoDragStartY = event.clientY
    setTempoDragActive(true)
    setTempoEditing(true)
    try { target.setPointerCapture(event.pointerId) } catch {}
    target.classList.add('cursor-ns-resize')
  }

  const updateTempoDrag = (event: PointerEvent) => {
    if (!tempoDragActive()) return
    event.preventDefault()
    const deltaY = tempoDragStartY - event.clientY
    const sensitivity = event.shiftKey ? 0.2 : 0.8
    const change = deltaY * sensitivity
    const next = sanitizeTempo(tempoDragStartValue + change)
    if (next === props.bpm) return
    setTempoDraft(String(next))
    props.onChangeBpm(next)
  }

  const endTempoDrag = (event: PointerEvent) => {
    if (!tempoDragActive()) return
    const target = event.currentTarget as HTMLInputElement | null
    if (target) {
      try { target.releasePointerCapture(event.pointerId) } catch {}
      target.classList.remove('cursor-ns-resize')
    }
    setTempoDragActive(false)
    commitTempo()
    setTempoEditing(false)
  }

  // Projects data
  const session = useSessionQuery()
  const userId = () => (session()?.data?.user as any)?.id ?? ''
  const myProjects = useConvexQuery(
    // Cast to any until Convex codegen picks up new function
    (convexApi as any).projects.listMineDetailed,
    () => userId() ? ({ userId: userId() }) : null,
    () => ['projects', 'mine_detailed', userId()]
  )
  const projects = () => {
    const raw: any = (myProjects as any).data
    const data = (typeof raw === 'function' ? raw() : raw)
    return Array.isArray(data) ? data as { roomId: string, name: string }[] : undefined
  }

  const samples = useProjectSamples({ roomId: () => props.currentRoomId })
  const samplesList = () => samples.samples()

  const handleInsertSampleItem = async (sample: ReturnType<typeof samplesList>[number]) => {
    if (!sample?.url) return
    setInsertingSampleUrl(sample.url)
    try {
      await Promise.resolve(props.onInsertSample({ url: sample.url, name: sample.name, duration: sample.duration }))
    } finally {
      setInsertingSampleUrl(null)
    }
  }

  const handleDeleteSampleItem = async (sample: ReturnType<typeof samplesList>[number]) => {
    if (!sample?.url) return
    const rid = props.currentRoomId
    const uid = userId()
    if (!rid || !uid) return
    setDeletingSampleUrl(sample.url)
    try {
      await convexClient.mutation((convexApi as any).samples.removeFromRoom, { roomId: rid, url: sample.url, userId: uid })
      setConfirmingSampleUrl(null)
    } finally {
      setDeletingSampleUrl(null)
    }
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

  // Cancel inline confirmation/rename when clicking outside or pressing Esc
  const handleDocMouseDown = (e: MouseEvent) => {
    const cid = confirmingProjectId()
    const eid = editingProjectId()
    const sid = confirmingSampleUrl()
    if (!cid && !eid && !sid) return
    const t = e.target as HTMLElement | null
    if (!t) return
    if (cid && !t.closest(`[data-project-rid="${cid}"]`)) setConfirmingProjectId(null)
    if (eid && !t.closest(`[data-project-rid="${eid}"]`)) setEditingProjectId(null)
    if (sid && !t.closest(`[data-sample-url="${sid}"]`)) setConfirmingSampleUrl(null)
  }
  const handleEscKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (confirmingProjectId()) setConfirmingProjectId(null)
      if (editingProjectId()) setEditingProjectId(null)
      if (confirmingSampleUrl()) setConfirmingSampleUrl(null)
    }
  }
  onMount(() => {
    window.addEventListener('mousedown', handleDocMouseDown, { capture: true })
    window.addEventListener('keydown', handleEscKey, { capture: true })
  })
  onCleanup(() => {
    window.removeEventListener('mousedown', handleDocMouseDown, { capture: true } as EventListenerOptions)
    window.removeEventListener('keydown', handleEscKey, { capture: true } as EventListenerOptions)
  })

  // Ensure input focuses as soon as we enter editing mode
  createEffect(() => {
    const id = editingProjectId()
    if (!id) return
    const tryFocus = () => {
      try {
        const el = document.querySelector(`input[data-project-input="${id}"]`) as HTMLInputElement | null
        if (el) { el.focus(); el.select?.() }
      } catch {}
    }
    if ('requestAnimationFrame' in window) requestAnimationFrame(tryFocus)
    setTimeout(tryFocus, 0)
  })

  return (
    <div class="grid grid-cols-3 items-center gap-2 p-3 border-b border-neutral-800">
      {/* Left: Add Audio + Projects */}
      <div class="justify-self-start flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={props.onAddAudio}>Add Audio</Button>
        {/* Projects Dropdown moved here */}
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
                <Button variant="default" class="text-neutral-100" size="sm" onClick={() => props.onCreateProject()}>
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4 mr-1">
                    <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 5v14m-7-7h14" />
                    <title>New</title>
                  </svg>
                  New
                </Button>
              </div>
              <DropdownMenuSeparator />
              <div class="max-h-72 overflow-y-auto">
                <For each={projects() ?? []}>
                  {(proj) => {
                    const rid = proj.roomId
                    const isEditing = () => editingProjectId() === rid
                    const isConfirmingDelete = () => confirmingProjectId() === rid
                    const isRenaming = () => renamingProjectId() === rid
                    return (
                      <Show when={!isEditing() && !isConfirmingDelete()} fallback={
                        <div
                          data-project-rid={rid}
                          class={`group relative w-full flex items-center justify-between gap-2 pr-12 ${props.currentRoomId === rid ? 'text-green-400' : ''}`}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div class="flex items-center gap-2 min-w-0 flex-1">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4 text-neutral-400">
                              <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 7h5l2 2h11v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                              <title>Project</title>
                            </svg>
                            <Show when={isEditing()} fallback={
                              <span class={`font-mono text-xs truncate max-w-[14rem] ${props.currentRoomId === rid ? 'text-green-400' : 'text-neutral-200'}`} title={proj.name}>{proj.name}</span>
                            }>
                              <form
                                class="flex items-center gap-2 min-w-0 w-full"
                                onSubmit={async (ev) => {
                                  ev.preventDefault()
                                  ev.stopPropagation()
                                  if (renamingProjectId() === rid) return
                                  const name = editingName().trim()
                                  if (!name) { setEditingProjectId(null); return }
                                  setRenamingProjectId(rid)
                                  try { await props.onRenameProject(rid, name) } finally { setRenamingProjectId(null); setEditingProjectId(null) }
                                }}
                              >
                                <input
                                  data-project-input={rid}
                                  value={editingName()}
                                  onInput={(e) => { e.stopPropagation(); setEditingName((e.currentTarget as HTMLInputElement).value) }}
                                  onKeyDown={async (e) => {
                                    e.stopPropagation();
                                    if (e.key === 'Enter' || (e as any).code === 'Enter' || (e as any).code === 'NumpadEnter' || (e as any).keyCode === 13 || (e as any).which === 13) {
                                      e.preventDefault();
                                      if (renamingProjectId() === rid) return
                                      const name = editingName().trim()
                                      if (!name) { setEditingProjectId(null); return }
                                      setRenamingProjectId(rid)
                                      try { await props.onRenameProject(rid, name) } finally { setRenamingProjectId(null); setEditingProjectId(null) }
                                      return
                                    }
                                    if (e.key === 'Escape') {
                                      e.preventDefault();
                                      setEditingProjectId(null)
                                    }
                                  }}
                                  onKeyUp={(e) => e.stopPropagation()}
                                  onPointerUp={(e) => e.stopPropagation()}
                                  onMouseUp={(e) => e.stopPropagation()}
                                  onMouseMove={(e) => e.stopPropagation()}
                                  onPointerMove={(e) => e.stopPropagation()}
                                  class={`bg-neutral-800 text-neutral-100 text-xs px-2 py-1 pr-12 rounded outline-none border border-neutral-700 focus:border-neutral-500 w-full`}
                                  ref={(el) => {
                                    try {
                                      const node = el as HTMLInputElement
                                      if ('requestAnimationFrame' in window) {
                                        requestAnimationFrame(() => { try { node.focus(); node.select?.() } catch {} })
                                      } else {
                                        setTimeout(() => { try { node.focus(); node.select?.() } catch {} }, 0)
                                      }
                                      // Capture-phase: stop propagation for pointer/mouse so dropdown doesn't steal focus
                                      const stopCapture = (ev: Event) => { ev.stopPropagation() }
                                      node.addEventListener('pointermove', stopCapture, { capture: true })
                                      node.addEventListener('mousemove', stopCapture, { capture: true })
                                      node.addEventListener('pointerdown', stopCapture, { capture: true })
                                      node.addEventListener('mousedown', stopCapture, { capture: true })
                                      node.addEventListener('pointerup', stopCapture, { capture: true })
                                      node.addEventListener('mouseup', stopCapture, { capture: true })

                                      // No keydown capture: allow our Solid onKeyDown/Up to run; Kobalte won't close since focus is in input
                                    } catch {}
                                  }}
                                />
                                <div class="flex items-center gap-1 shrink-0" />
                                <button type="submit" tabindex={-1} aria-hidden="true" class="hidden" />
                              </form>
                            </Show>
                          </div>
                          <div class="absolute right-2 top-1/2 -translate-y-1/2" data-project-controls>
                            {/* Delete Confirm/Cancel cluster */}
                            <div class={`absolute right-0 top-1/2 -translate-y-1/2 flex items-center gap-1 transition-opacity duration-150 ${isConfirmingDelete() ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
                              <button
                                class={`p-1 rounded cursor-pointer ${deletingProjectId() === rid ? 'opacity-60 cursor-not-allowed text-neutral-400' : 'text-green-500 hover:text-green-400'}`}
                                aria-label={deletingProjectId() === rid ? 'Deleting…' : 'Confirm delete'}
                                disabled={deletingProjectId() === rid}
                                onPointerDown={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                onMouseDown={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                onPointerUp={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                onMouseUp={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                onClick={async (ev) => { ev.stopPropagation(); ev.preventDefault(); setDeletingProjectId(rid); try { await props.onDeleteProject(rid) } finally { setDeletingProjectId(null); setConfirmingProjectId(null) } }}
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                                  <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m5 12l5 5L20 7" />
                                  <title>Confirm</title>
                                </svg>
                              </button>
                              <button
                                class={`p-1 rounded cursor-pointer ${deletingProjectId() === rid ? 'opacity-60 cursor-not-allowed text-neutral-400' : 'text-neutral-400 hover:text-neutral-300'}`}
                                aria-label="Cancel delete"
                                disabled={deletingProjectId() === rid}
                                onPointerDown={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                onMouseDown={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                onPointerUp={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                onMouseUp={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                onClick={(ev) => { ev.stopPropagation(); ev.preventDefault(); setConfirmingProjectId(null) }}
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                                  <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m7 7l10 10M17 7L7 17" />
                                  <title>Cancel</title>
                                </svg>
                              </button>
                            </div>
                            {/* Rename Confirm/Cancel cluster positioned at far right while editing */}
                            <Show when={isEditing()}>
                              <div class={`absolute right-0 top-1/2 -translate-y-1/2 flex items-center gap-1`}>
                                <button
                                  class={`p-1 rounded cursor-pointer ${isRenaming() ? 'opacity-60 cursor-not-allowed text-neutral-400' : 'text-green-500 hover:text-green-400'}`}
                                  aria-label={isRenaming() ? 'Renaming…' : 'Confirm rename'}
                                  disabled={isRenaming()}
                                  onPointerDown={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                  onMouseDown={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                  onPointerUp={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                  onMouseUp={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                  onClick={async (ev) => {
                                    ev.stopPropagation(); ev.preventDefault();
                                    const name = editingName().trim()
                                    if (!name) { setEditingProjectId(null); return }
                                    setRenamingProjectId(rid)
                                    try { await props.onRenameProject(rid, name) } finally { setRenamingProjectId(null); setEditingProjectId(null) }
                                  }}
                                >
                                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                                    <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m5 12l5 5L20 7" />
                                    <title>Confirm</title>
                                  </svg>
                                </button>
                                <button
                                  class={`p-1 rounded cursor-pointer ${isRenaming() ? 'opacity-60 cursor-not-allowed text-neutral-400' : 'text-neutral-400 hover:text-neutral-300'}`}
                                  aria-label="Cancel rename"
                                  disabled={isRenaming()}
                                  onPointerDown={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                  onMouseDown={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                  onPointerUp={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                  onMouseUp={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                  onClick={(ev) => { ev.stopPropagation(); ev.preventDefault(); setEditingProjectId(null) }}
                                >
                                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                                    <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m7 7l10 10M17 7L7 17" />
                                    <title>Cancel</title>
                                  </svg>
                                </button>
                              </div>
                            </Show>
                          </div>
                        </div>
                      }>
                        <DropdownMenuItem
                          data-project-rid={rid}
                          class={`group relative w-full flex items-center justify-between gap-2 cursor-pointer hover:bg-neutral-800 hover:text-neutral-100 focus:bg-neutral-800 focus:text-neutral-100 data-[highlighted]:bg-neutral-800 data-[highlighted]:text-neutral-100 pr-12 ${props.currentRoomId === rid ? 'text-green-400' : ''}`}
                          onSelect={() => { setConfirmingProjectId(null); props.onOpenProject(rid) }}
                        >
                          <div class="flex items-center gap-2 min-w-0 flex-1">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4 text-neutral-400 group-hover:text-neutral-200">
                              <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 7h5l2 2h11v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                              <title>Project</title>
                            </svg>
                            <span class={`font-mono text-xs truncate max-w-[14rem] ${props.currentRoomId === rid ? 'text-green-400 group-hover:text-green-300' : 'text-neutral-200 group-hover:text-neutral-100'}`} title={proj.name}>{proj.name}</span>
                          </div>
                          <div class="absolute right-2 top-1/2 -translate-y-1/2" data-project-controls>
                            {/* Triggers: Edit + Delete (hidden during rename/delete confirm) */}
                            <div class={`flex items-center gap-1 opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto`}>
                              <button
                                class="p-1 cursor-pointer text-neutral-400 hover:text-neutral-200"
                                aria-label="Edit project name"
                                onPointerDown={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                onMouseDown={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                onPointerUp={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                onMouseUp={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                onClick={(ev) => { ev.stopPropagation(); ev.preventDefault(); setEditingProjectId(rid); setEditingName(proj.name) }}
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                                  <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 20h9" />
                                  <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
                                  <title>Edit</title>
                                </svg>
                              </button>
                              <button
                                class="p-1 cursor-pointer text-neutral-400 hover:text-red-500"
                                aria-label="Delete project"
                                onPointerDown={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                onMouseDown={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                onPointerUp={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                onMouseUp={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                onClick={(ev) => { ev.stopPropagation(); ev.preventDefault(); setConfirmingProjectId(rid) }}
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                                  <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-1 0v14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V6m3 4v8m4-8v8" />
                                  <title>Delete</title>
                                </svg>
                              </button>
                            </div>
                          </div>
                        </DropdownMenuItem>
                      </Show>
                    )
                  }}
                </For>
                {((projects() ?? []).length === 0) && (
                  <div class="px-2 py-2 text-xs text-neutral-500">No projects yet</div>
                )}
              </div>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Samples Dropdown */}
        <DropdownMenu open={samplesOpen()} onOpenChange={setSamplesOpen}>
          <DropdownMenuTrigger>
            <Button variant="outline" size="sm">
              <Icon name="file-audio" class="h-4 w-4 mr-1" />
              Samples
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent class="w-full bg-neutral-900" style={{ width: 'min(92vw, 26rem)', 'pointer-events': isDraggingSample() ? 'none' : undefined }}>
            <div class="p-2 w-full">
              <div class="flex items-center justify-between px-1 pb-2">
                <span class="text-sm font-semibold text-neutral-100">Samples in Project</span>
              </div>
              <DropdownMenuSeparator />
              <div class="max-h-72 overflow-y-auto">
                <For each={samplesList()} fallback={<div class="px-2 py-2 text-xs text-neutral-500">No samples yet</div>}>
                  {(sample) => {
                    const url = sample.url
                    const count = sample.count
                    const earliest = sample.earliestClip
                    const isConfirming = () => confirmingSampleUrl() === url
                    const isDeleting = () => deletingSampleUrl() === url
                    const isInserting = () => insertingSampleUrl() === url
                    return (
                      <DropdownMenuItem
                        data-sample-url={url}
                        class="group relative w-full flex items-center justify-between gap-2 pr-20 cursor-pointer hover:bg-neutral-800 hover:text-neutral-100 focus:bg-neutral-800 focus:text-neutral-100 data-[highlighted]:bg-neutral-800 data-[highlighted]:text-neutral-100"
                        onSelect={() => {
                          if (!earliest) return
                          props.onJumpToClip(earliest.clipId, earliest.trackId, earliest.startSec)
                        }}
                      >
                        <div
                          class="flex items-center gap-2 min-w-0 flex-1"
                          draggable={!!url}
                          onDragStart={(ev) => {
                            try {
                              const payload = JSON.stringify({ url, name: sample.name, duration: sample.duration })
                              ev.dataTransfer?.setData('application/x-mediabunny-sample', payload)
                              if (url) {
                                ev.dataTransfer?.setData('text/uri-list', url)
                                ev.dataTransfer?.setData('text/plain', url)
                              }
                              if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copy'
                            } catch {}
                            setIsDraggingSample(true)
                          }}
                          onDragEnd={() => setIsDraggingSample(false)}
                        >
                          <Icon name="file-audio" class="h-4 w-4 text-neutral-400 group-hover:text-neutral-200" />
                          <span class="font-mono text-xs truncate max-w-[12rem] text-neutral-200 group-hover:text-neutral-100" title={sample.name}>{sample.name}</span>
                          <span class="text-[10px] text-neutral-400 shrink-0">x{count}</span>
                        </div>
                        <div class="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                          <button
                            class="p-1 cursor-pointer text-neutral-400 hover:text-neutral-200 disabled:opacity-50"
                            aria-label="Copy sample URL"
                            disabled={!url}
                            onPointerDown={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                            onMouseDown={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                            onPointerUp={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                            onMouseUp={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                            onClick={async (ev) => {
                              ev.stopPropagation(); ev.preventDefault()
                              if (url && navigator.clipboard?.writeText) {
                                try { await navigator.clipboard.writeText(url) } catch {}
                              }
                            }}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                              <g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <rect width="8" height="8" x="8" y="8" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
                              </g>
                              <title>Copy URL</title>
                            </svg>
                          </button>
                          <button
                            class={`p-1 cursor-pointer text-neutral-400 hover:text-neutral-100 disabled:opacity-50 ${isInserting() ? 'opacity-60 cursor-not-allowed' : ''}`}
                            aria-label="Insert sample"
                            disabled={!url || isInserting()}
                            onPointerDown={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                            onMouseDown={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                            onPointerUp={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                            onMouseUp={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                            onClick={async (ev) => {
                              ev.stopPropagation(); ev.preventDefault()
                              await handleInsertSampleItem(sample)
                            }}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                              <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 11h16M12 4v16" />
                              <title>Insert</title>
                            </svg>
                          </button>
                          <Show when={isConfirming()} fallback={
                            <button
                              class={`p-1 cursor-pointer ${count > 0 ? 'text-neutral-500 cursor-not-allowed' : 'text-red-500 hover:text-red-400'} ${count > 0 ? 'opacity-50' : ''}`}
                              aria-label={count > 0 ? 'Cannot delete sample in use' : 'Delete sample'}
                              disabled={count > 0}
                              onPointerDown={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                              onMouseDown={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                              onPointerUp={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                              onMouseUp={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                              onClick={(ev) => {
                                ev.stopPropagation(); ev.preventDefault()
                                if (count === 0) setConfirmingSampleUrl(url)
                              }}
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                                <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-1 0v14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V6m3 4v8m4-8v8" />
                                <title>Delete</title>
                              </svg>
                            </button>
                          }>
                            <div class="flex items-center gap-1">
                              <button
                                class={`p-1 cursor-pointer ${isDeleting() ? 'opacity-60 cursor-not-allowed text-neutral-400' : 'text-green-500 hover:text-green-400'}`}
                                aria-label={isDeleting() ? 'Deleting…' : 'Confirm delete'}
                                disabled={isDeleting()}
                                onPointerDown={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                onMouseDown={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                onPointerUp={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                onMouseUp={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                onClick={async (ev) => {
                                  ev.stopPropagation(); ev.preventDefault()
                                  await handleDeleteSampleItem(sample)
                                }}
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                                  <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m5 12l5 5L20 7" />
                                  <title>Confirm</title>
                                </svg>
                              </button>
                              <button
                                class="p-1 cursor-pointer text-neutral-400 hover:text-neutral-300"
                                aria-label="Cancel delete"
                                onPointerDown={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                onMouseDown={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                onPointerUp={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                onMouseUp={(ev) => { ev.stopPropagation(); ev.preventDefault() }}
                                onClick={(ev) => {
                                  ev.stopPropagation(); ev.preventDefault()
                                  setConfirmingSampleUrl(null)
                                }}
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                                  <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m7 7l10 10M17 7L7 17" />
                                  <title>Cancel</title>
                                </svg>
                              </button>
                            </div>
                          </Show>
                        </div>
                      </DropdownMenuItem>
                    )
                  }}
                </For>
              </div>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>

      </div>

      {/* Center: Transport */}
      <div class="justify-self-center flex items-center gap-3">
        <Button
          variant={'ghost'}
          size="sm"
          onClick={props.onToggleRecord}
          aria-pressed={props.isRecording}
          aria-label={props.isRecording ? 'Stop recording' : 'Start recording'}
          class="flex items-center gap-2"
        >
          <span
            class={`h-2.5 w-2.5 rounded-full ${props.isRecording ? 'bg-white' : 'bg-red-500 group-hover:bg-red-400'}`}
          />
          <span class="text-xs uppercase tracking-wide">
            {props.isRecording ? 'Stop' : 'Rec'}
          </span>
        </Button>
        <Button variant="ghost" size="sm" onClick={props.onPlay} disabled={props.isPlaying} aria-label="Play">
          <Icon name="play" class="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={props.onPause} disabled={!props.isPlaying} aria-label="Pause">
          <Icon name="pause" class="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={props.onStop} aria-label="Stop">
          <Icon name="stop" class="h-4 w-4" />
        </Button>
        <div class="flex items-center gap-2">
          <label class="flex items-center gap-1 text-xs text-neutral-400">
            <input
              type="text"
              value={tempoDraft()}
              class="w-[5ch] rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 focus:border-neutral-500 focus:outline-none appearance-none"
              inputmode="numeric"
              pattern="[0-9]*"
              onFocus={() => setTempoEditing(true)}
              onBlur={() => {
                if (tempoEditing()) {
                  commitTempo()
                }
                setTempoEditing(false)
              }}
              onInput={(event) => {
                setTempoDraft((event.currentTarget as HTMLInputElement).value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commitTempo()
                  setTempoEditing(false)
                  event.currentTarget.blur()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setTempoDraft(String(props.bpm))
                  setTempoEditing(false)
                  event.currentTarget.blur()
                }
              }}
              onPointerDown={(event) => {
                if (event.button !== 0) return
                beginTempoDrag(event)
              }}
              onPointerMove={updateTempoDrag}
              onPointerUp={endTempoDrag}
              onPointerCancel={endTempoDrag}
            />
            <span class="text-[10px] text-neutral-500">BPM</span>
          </label>
          <Button
            variant='ghost'
            size="sm"
            onClick={props.onToggleMetronome}
            aria-pressed={props.metronomeEnabled}
            aria-label="Toggle metronome"
          >
            <Icon name="metronome" class="h-4 w-4 mr-1" />
          </Button>
          <Button
            variant='ghost'
            size="sm"
            onClick={props.onToggleLoop}
            aria-pressed={props.loopEnabled}
            aria-label="Toggle loop region"
            class={props.loopEnabled ? 'text-green-400' : ''}
          >
            <Icon name="repeat" class="h-4 w-4 mr-1" />
            <span class="text-xs">Loop</span>
          </Button>
          {/* Snap toggle */}
          <Button
            variant="ghost"
            size="sm"
            onClick={props.onToggleGrid}
            aria-pressed={props.gridEnabled}
            aria-label="Toggle snap to grid"
            class={props.gridEnabled ? 'text-green-400' : ''}
          >
            {/* Magnet icon (inline) */}
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4 mr-1">
              <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 15V8a6 6 0 0 1 6-6h0a6 6 0 0 1 6 6v7" />
              <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 15a4 4 0 0 0 4 4m8 0a4 4 0 0 0 4-4" />
              <title>Snap</title>
            </svg>
            <span class="text-xs">Grid</span>
          </Button>
          {/* Grid resolution */}
          <DropdownMenu>
            <DropdownMenuTrigger>
              <Button variant="outline" size="sm" class="px-2 py-1 text-xs">
                {`1/${props.gridDenominator}`}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent class="w-full bg-neutral-900" style={{ width: '10rem' }}>
              <div class="p-1">
                <div class="px-2 pb-1 text-xs text-neutral-400">Grid</div>
                <DropdownMenuItem class="cursor-pointer text-neutral-50" onSelect={() => props.onChangeGridDenominator(2)}>1/2</DropdownMenuItem>
                <DropdownMenuItem class="cursor-pointer text-neutral-50" onSelect={() => props.onChangeGridDenominator(4) }>1/4</DropdownMenuItem>
                <DropdownMenuItem class="cursor-pointer text-neutral-50" onSelect={() => props.onChangeGridDenominator(8) }>1/8</DropdownMenuItem>
                <DropdownMenuItem class="cursor-pointer text-neutral-50" onSelect={() => props.onChangeGridDenominator(12)}>1/12</DropdownMenuItem>
                <DropdownMenuItem class="cursor-pointer text-neutral-50" onSelect={() => props.onChangeGridDenominator(16)}>1/16</DropdownMenuItem>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Right: Share + Master FX + Playhead */}
      <div class="justify-self-end flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={props.onMasterFX}>Master FX</Button>
        <div class="flex items-center gap-2">
          <span class="text-sm text-neutral-400">Playhead</span>
          <span class="text-sm tabular-nums">{props.playheadSec.toFixed(2)}s</span>
        </div>
        <DropdownMenu open={shareOpen()} onOpenChange={onShareMenuOpenChange}>
          <DropdownMenuTrigger>
            <Button variant="default" size="sm" onClick={handleOpenShare}>Share</Button>
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
        {/* User info dropdown at the far right */}
        <UserInfoDropdown />
      </div>
    </div>
  )
}

export default TransportControls