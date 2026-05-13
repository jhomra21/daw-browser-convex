import { type Accessor, type Component, For, Show } from 'solid-js'
import { NavUser } from '~/components/nav-user'
import Icon from '~/components/ui/Icon'
import { Button } from '~/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '~/components/ui/dropdown-menu'
import type { InsertSampleInput } from '~/hooks/useTimelineClipImport'
import { useExportsMenuController } from '~/hooks/useExportsMenuController'
import { useProjectsMenuController } from '~/hooks/useProjectsMenuController'
import { useSamplesMenuController } from '~/hooks/useSamplesMenuController'
import { useShareMenuController } from '~/hooks/useShareMenuController'
import { useTransportTempoController } from '~/hooks/useTransportTempoController'
import type { ProjectExportItem } from '~/hooks/useProjectExports'
import type { DefaultSampleListItem, ProjectSampleListItem } from '~/hooks/useProjectSamples'
import type { TimelineProject } from '~/hooks/useTimelineData'
import { cn } from '~/lib/utils'
import type { Track } from '~/types/timeline'

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
  gridEnabled: boolean
  onToggleGrid: () => void
  gridDenominator: number
  onChangeGridDenominator: (n: number) => void
  loopEnabled: boolean
  onToggleLoop: () => void
  isRecording: boolean
  onToggleRecord: () => void
  onJumpToClip: (clipId: string, trackId: Track['id'], startSec: number) => void
  onInsertSample: (input: InsertSampleInput) => void | Promise<void>
  currentRoomId: string
  currentUserId?: string
  projects: TimelineProject[]
  onOpenProject: (roomId: string) => void
  onCreateProject: () => void | Promise<void>
  onDeleteProject: (roomId: string) => void | Promise<void>
  onRenameProject: (roomId: string, name: string) => void | Promise<void>
  onOpenExport: () => void
}

type ProjectsMenuController = {
  currentRoomId: string
  projects: TimelineProject[]
  confirmingProjectId: Accessor<string | null>
  deletingProjectId: Accessor<string | null>
  editingProjectId: Accessor<string | null>
  editingName: Accessor<string>
  renamingProjectId: Accessor<string | null>
  setConfirmingProjectId: (value: string | null) => void
  setEditingName: (value: string) => void
  onCreateProject: () => void | Promise<void>
  onOpenProject: (roomId: string) => void
  beginProjectRename: (roomId: string, name: string) => void
  cancelProjectRename: () => void
  confirmProjectRename: (roomId: string) => Promise<void>
  confirmProjectDelete: (roomId: string) => Promise<void>
  stopPropagation: (event: Event) => void
  stopMenuPress: (event: Event) => void
}

type SamplesMenuController = {
  open: boolean
  onOpenChange: (open: boolean) => void
  isDraggingSample: boolean
  setIsDraggingSample: (value: boolean) => void
  samples: ProjectSampleListItem[]
  defaultSamples: DefaultSampleListItem[]
  confirmingSampleKey: Accessor<string | null>
  deletingSampleKey: Accessor<string | null>
  insertingSampleKey: Accessor<string | null>
  setConfirmingSampleKey: (value: string | null) => void
  onJumpToClip: (clipId: string, trackId: Track['id'], startSec: number) => void
  onStartSampleDrag: (event: DragEvent, sample: InsertSampleInput) => void
  onInsertSample: (sample: InsertSampleInput & { key?: string }) => Promise<void>
  onDeleteSample: (sample: ProjectSampleListItem) => Promise<void>
  formatBytes: (bytes?: number) => string
  copyText: (value?: string) => Promise<void>
}

type ExportsMenuController = {
  open: boolean
  onOpenChange: (open: boolean) => void
  isDraggingSample: boolean
  exports: ProjectExportItem[]
  copyText: (value?: string) => Promise<void>
}

type TransportBarController = {
  isRecording: boolean
  onToggleRecord: () => void
  isPlaying: boolean
  onPlay: () => void
  onPause: () => void
  onStop: () => void
  tempoDraft: Accessor<string>
  setTempoDraft: (value: string) => void
  tempoEditing: Accessor<boolean>
  setTempoEditing: (value: boolean) => void
  commitTempo: () => void
  beginTempoDrag: (event: PointerEvent) => void
  updateTempoDrag: (event: PointerEvent) => void
  endTempoDrag: (event: PointerEvent) => void
  metronomeEnabled: boolean
  onToggleMetronome: () => void
  loopEnabled: boolean
  onToggleLoop: () => void
  gridEnabled: boolean
  onToggleGrid: () => void
  gridDenominator: number
  onChangeGridDenominator: (next: number) => void
  bpm: number
}

type ShareMenuController = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpen: () => Promise<void>
  onClose: () => void
  copied: boolean
  shareUrl: string
  onCopy: () => Promise<void>
}

const ProjectsMenu: Component<{ projects: ProjectsMenuController }> = (props) => {
  const menu = () => props.projects

  return (
    <DropdownMenu>
      <DropdownMenuTrigger>
        <Button variant="outline" size="sm">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="mr-1 h-4 w-4">
            <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 7h5l2 2h11v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <title>Projects</title>
          </svg>
          Projects
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent class="w-full bg-neutral-900" style={{ width: 'min(92vw, 24rem)' }}>
        <div class="w-full p-2">
          <div class="flex items-center justify-between px-1 pb-2">
            <span class="text-sm font-semibold text-neutral-100">My Projects</span>
            <Button variant="default" class="text-neutral-100" size="sm" onClick={() => void menu().onCreateProject()}>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="mr-1 h-4 w-4">
                <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 5v14m-7-7h14" />
                <title>New</title>
              </svg>
              New
            </Button>
          </div>
          <DropdownMenuSeparator />
          <div class="max-h-72 overflow-y-auto">
            <For each={menu().projects}>
              {(project) => {
                const roomId = project.roomId
                const isEditing = () => menu().editingProjectId() === roomId
                const isConfirmingDelete = () => menu().confirmingProjectId() === roomId
                const isRenaming = () => menu().renamingProjectId() === roomId

                return (
                  <Show
                    when={!isEditing() && !isConfirmingDelete()}
                    fallback={
                      <div
                        data-project-rid={roomId}
                        class={cn('group relative flex w-full items-center justify-between gap-2 pr-12', menu().currentRoomId === roomId && 'text-green-400')}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <div class="flex min-w-0 flex-1 items-center gap-2">
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4 text-neutral-400">
                            <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 7h5l2 2h11v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                            <title>Project</title>
                          </svg>
                          <Show
                            when={isEditing()}
                            fallback={<span class={cn('max-w-56 truncate font-mono text-xs', menu().currentRoomId === roomId ? 'text-green-400' : 'text-neutral-200')} title={project.name}>{project.name}</span>}
                          >
                            <form
                              class="flex min-w-0 w-full items-center gap-2"
                              onSubmit={async (event) => {
                                event.preventDefault()
                                event.stopPropagation()
                                await menu().confirmProjectRename(roomId)
                              }}
                            >
                              <input
                                data-project-input={roomId}
                                value={menu().editingName()}
                                onInput={(event) => {
                                  menu().stopPropagation(event)
                                  menu().setEditingName(event.currentTarget.value)
                                }}
                                onKeyDown={async (event) => {
                                  menu().stopPropagation(event)
                                  if (event.key === 'Enter' || event.code === 'Enter' || event.code === 'NumpadEnter') {
                                    event.preventDefault()
                                    await menu().confirmProjectRename(roomId)
                                    return
                                  }
                                  if (event.key === 'Escape') {
                                    event.preventDefault()
                                    menu().cancelProjectRename()
                                  }
                                }}
                                onKeyUp={menu().stopPropagation}
                                onPointerUp={menu().stopPropagation}
                                onMouseUp={menu().stopPropagation}
                                onMouseMove={menu().stopPropagation}
                                onPointerMove={menu().stopPropagation}
                                class="w-full rounded border border-neutral-700 bg-neutral-800 px-2 py-1 pr-12 text-xs text-neutral-100 outline-none focus:border-neutral-500"
                                ref={(element) => {
                                  try {
                                    const stopCapture = (event: Event) => {
                                      event.stopPropagation()
                                    }
                                    element.addEventListener('pointermove', stopCapture, { capture: true })
                                    element.addEventListener('mousemove', stopCapture, { capture: true })
                                    element.addEventListener('pointerdown', stopCapture, { capture: true })
                                    element.addEventListener('mousedown', stopCapture, { capture: true })
                                    element.addEventListener('pointerup', stopCapture, { capture: true })
                                    element.addEventListener('mouseup', stopCapture, { capture: true })
                                  } catch {}
                                }}
                              />
                              <div class="shrink-0" />
                              <button type="submit" tabindex={-1} aria-hidden="true" class="hidden" />
                            </form>
                          </Show>
                        </div>
                        <div class="absolute right-2 top-1/2 -translate-y-1/2" data-project-controls>
                          <div class={cn('absolute right-0 top-1/2 flex -translate-y-1/2 items-center gap-1 transition-opacity duration-150', isConfirmingDelete() ? 'opacity-100' : 'pointer-events-none opacity-0')}>
                            <button
                              class={cn('rounded p-1', menu().deletingProjectId() === roomId ? 'cursor-not-allowed text-neutral-400 opacity-60' : 'cursor-pointer text-green-500 hover:text-green-400')}
                              aria-label={menu().deletingProjectId() === roomId ? 'Deleting…' : 'Confirm delete'}
                              disabled={menu().deletingProjectId() === roomId}
                              onPointerDown={menu().stopMenuPress}
                              onMouseDown={menu().stopMenuPress}
                              onPointerUp={menu().stopMenuPress}
                              onMouseUp={menu().stopMenuPress}
                              onClick={async (event) => {
                                menu().stopMenuPress(event)
                                await menu().confirmProjectDelete(roomId)
                              }}
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                                <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m5 12l5 5L20 7" />
                                <title>Confirm</title>
                              </svg>
                            </button>
                            <button
                              class={cn('rounded p-1', menu().deletingProjectId() === roomId ? 'cursor-not-allowed text-neutral-400 opacity-60' : 'cursor-pointer text-neutral-400 hover:text-neutral-300')}
                              aria-label="Cancel delete"
                              disabled={menu().deletingProjectId() === roomId}
                              onPointerDown={menu().stopMenuPress}
                              onMouseDown={menu().stopMenuPress}
                              onPointerUp={menu().stopMenuPress}
                              onMouseUp={menu().stopMenuPress}
                              onClick={(event) => {
                                menu().stopMenuPress(event)
                                menu().setConfirmingProjectId(null)
                              }}
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                                <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m7 7l10 10M17 7L7 17" />
                                <title>Cancel</title>
                              </svg>
                            </button>
                          </div>
                          <Show when={isEditing()}>
                            <div class="absolute right-0 top-1/2 flex -translate-y-1/2 items-center gap-1">
                              <button
                                class={cn('rounded p-1', isRenaming() ? 'cursor-not-allowed text-neutral-400 opacity-60' : 'cursor-pointer text-green-500 hover:text-green-400')}
                                aria-label={isRenaming() ? 'Renaming…' : 'Confirm rename'}
                                disabled={isRenaming()}
                                onPointerDown={menu().stopMenuPress}
                                onMouseDown={menu().stopMenuPress}
                                onPointerUp={menu().stopMenuPress}
                                onMouseUp={(event) => {
                                  event.stopPropagation()
                                  event.preventDefault()
                                }}
                                onClick={async (event) => {
                                  menu().stopMenuPress(event)
                                  await menu().confirmProjectRename(roomId)
                                }}
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                                  <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m5 12l5 5L20 7" />
                                  <title>Confirm</title>
                                </svg>
                              </button>
                              <button
                                class={cn('rounded p-1', isRenaming() ? 'cursor-not-allowed text-neutral-400 opacity-60' : 'cursor-pointer text-neutral-400 hover:text-neutral-300')}
                                aria-label="Cancel rename"
                                disabled={isRenaming()}
                                onPointerDown={menu().stopMenuPress}
                                onMouseDown={menu().stopMenuPress}
                                onPointerUp={menu().stopMenuPress}
                                onMouseUp={menu().stopMenuPress}
                                onClick={(event) => {
                                  menu().stopMenuPress(event)
                                  menu().cancelProjectRename()
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
                      </div>
                    }
                  >
                    <DropdownMenuItem
                      data-project-rid={roomId}
                      class={cn(
                        'group relative flex w-full cursor-pointer items-center justify-between gap-2 pr-12 hover:bg-neutral-800 hover:text-neutral-100 focus:bg-neutral-800 focus:text-neutral-100 data-[highlighted]:bg-neutral-800 data-[highlighted]:text-neutral-100',
                        menu().currentRoomId === roomId && 'text-green-400',
                      )}
                      onSelect={() => {
                        menu().setConfirmingProjectId(null)
                        menu().onOpenProject(roomId)
                      }}
                    >
                      <div class="flex min-w-0 flex-1 items-center gap-2">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4 text-neutral-400 group-hover:text-neutral-200">
                          <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 7h5l2 2h11v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                          <title>Project</title>
                        </svg>
                        <span class={cn('max-w-56 truncate font-mono text-xs', menu().currentRoomId === roomId ? 'text-green-400 group-hover:text-green-300' : 'text-neutral-200 group-hover:text-neutral-100')} title={project.name}>{project.name}</span>
                      </div>
                      <div class="absolute right-2 top-1/2 -translate-y-1/2" data-project-controls>
                        <div class="pointer-events-none flex items-center gap-1 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100">
                          <button
                            class="cursor-pointer p-1 text-neutral-400 hover:text-neutral-200"
                            aria-label="Edit project name"
                            onPointerDown={menu().stopMenuPress}
                            onMouseDown={menu().stopMenuPress}
                            onPointerUp={menu().stopMenuPress}
                            onMouseUp={menu().stopMenuPress}
                            onClick={(event) => {
                              menu().stopMenuPress(event)
                              menu().beginProjectRename(roomId, project.name)
                            }}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                              <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 20h9" />
                              <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
                              <title>Edit</title>
                            </svg>
                          </button>
                          <button
                            class="cursor-pointer p-1 text-neutral-400 hover:text-red-500"
                            aria-label="Delete project"
                            onPointerDown={menu().stopMenuPress}
                            onMouseDown={menu().stopMenuPress}
                            onPointerUp={menu().stopMenuPress}
                            onMouseUp={menu().stopMenuPress}
                            onClick={(event) => {
                              menu().stopMenuPress(event)
                              menu().setConfirmingProjectId(roomId)
                            }}
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
            <Show when={menu().projects.length === 0}>
              <div class="px-2 py-2 text-xs text-neutral-500">No projects yet</div>
            </Show>
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const SamplesMenu: Component<{ samples: SamplesMenuController }> = (props) => {
  const menu = () => props.samples
  const hasProjectSamples = () => menu().samples.length > 0
  const hasDefaultSamples = () => menu().defaultSamples.length > 0

  return (
    <DropdownMenu open={menu().open} onOpenChange={menu().onOpenChange}>
      <DropdownMenuTrigger>
        <Button variant="outline" size="sm">
          <Icon name="file-audio" class="mr-1 h-4 w-4" />
          Samples
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent class="w-full bg-neutral-900" style={{ width: 'min(92vw, 26rem)', 'pointer-events': menu().isDraggingSample ? 'none' : undefined }}>
        <div class="w-full p-2">
          <div class="flex items-center justify-between px-1 pb-2">
            <span class="text-sm font-semibold text-neutral-100">Samples in Project</span>
          </div>
          <DropdownMenuSeparator />
          <div class="max-h-72 overflow-y-auto">
            <Show when={menu().samples.length + menu().defaultSamples.length > 0} fallback={<div class="px-2 py-2 text-xs text-neutral-500">No samples yet</div>}>
              <Show when={hasProjectSamples()}>
                <For each={menu().samples}>
                  {(sample) => {
                    const sampleKey = sample.key
                    const isConfirming = () => menu().confirmingSampleKey() === sampleKey
                    const isDeleting = () => menu().deletingSampleKey() === sampleKey
                    const isInserting = () => menu().insertingSampleKey() === sampleKey

                    return (
                      <DropdownMenuItem
                        data-sample-key={sampleKey}
                        class="group relative flex w-full cursor-pointer items-center justify-between gap-2 pr-20 hover:bg-neutral-800 hover:text-neutral-100 focus:bg-neutral-800 focus:text-neutral-100 data-[highlighted]:bg-neutral-800 data-[highlighted]:text-neutral-100"
                        onSelect={() => {
                          if (!sample.earliestClip) return
                          menu().onJumpToClip(sample.earliestClip.clipId, sample.earliestClip.trackId, sample.earliestClip.startSec)
                        }}
                      >
                        <div
                          class="flex min-w-0 flex-1 items-center gap-2"
                          draggable={!!sample.url}
                          onDragStart={(event) => menu().onStartSampleDrag(event, sample)}
                          onDragEnd={() => menu().setIsDraggingSample(false)}
                        >
                          <Icon name="file-audio" class="h-4 w-4 text-neutral-400 group-hover:text-neutral-200" />
                          <span class="max-w-48 truncate font-mono text-xs text-neutral-200 group-hover:text-neutral-100" title={sample.name}>{sample.name}</span>
                          <span class="shrink-0 text-xs text-neutral-400">x{sample.count}</span>
                        </div>
                        <div class="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                          <button
                            class="cursor-pointer p-1 text-neutral-400 hover:text-neutral-200 disabled:opacity-50"
                            aria-label="Copy sample URL"
                            disabled={!sample.url}
                            onPointerDown={(event) => {
                              event.stopPropagation()
                              event.preventDefault()
                            }}
                            onMouseDown={(event) => {
                              event.stopPropagation()
                              event.preventDefault()
                            }}
                            onPointerUp={(event) => {
                              event.stopPropagation()
                              event.preventDefault()
                            }}
                            onMouseUp={(event) => {
                              event.stopPropagation()
                              event.preventDefault()
                            }}
                            onClick={async (event) => {
                              event.stopPropagation()
                              event.preventDefault()
                              await menu().copyText(sample.url)
                            }}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                              <g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <rect width="8" height="8" x="8" y="8" rx="2" />
                                <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
                              </g>
                              <title>Copy URL</title>
                            </svg>
                          </button>
                          <button
                            class={cn('cursor-pointer p-1 text-neutral-400 hover:text-neutral-100 disabled:opacity-50', isInserting() && 'cursor-not-allowed opacity-60')}
                            aria-label="Insert sample"
                            disabled={!sample.url || isInserting()}
                            onPointerDown={(event) => {
                              event.stopPropagation()
                              event.preventDefault()
                            }}
                            onMouseDown={(event) => {
                              event.stopPropagation()
                              event.preventDefault()
                            }}
                            onPointerUp={(event) => {
                              event.stopPropagation()
                              event.preventDefault()
                            }}
                            onMouseUp={(event) => {
                              event.stopPropagation()
                              event.preventDefault()
                            }}
                            onClick={async (event) => {
                              event.stopPropagation()
                              event.preventDefault()
                              await menu().onInsertSample(sample)
                            }}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                              <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 11h16M12 4v16" />
                              <title>Insert</title>
                            </svg>
                          </button>
                          <Show
                            when={isConfirming()}
                            fallback={
                              <button
                                class={cn('cursor-pointer p-1', sample.count > 0 ? 'cursor-not-allowed text-neutral-500 opacity-50' : 'text-red-500 hover:text-red-400')}
                                aria-label={sample.count > 0 ? 'Cannot delete sample in use' : 'Delete sample'}
                                disabled={sample.count > 0}
                                onPointerDown={(event) => {
                                  event.stopPropagation()
                                  event.preventDefault()
                                }}
                                onMouseDown={(event) => {
                                  event.stopPropagation()
                                  event.preventDefault()
                                }}
                                onPointerUp={(event) => {
                                  event.stopPropagation()
                                  event.preventDefault()
                                }}
                                onMouseUp={(event) => {
                                  event.stopPropagation()
                                  event.preventDefault()
                                }}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  event.preventDefault()
                                  if (sample.count === 0) {
                                    menu().setConfirmingSampleKey(sampleKey)
                                  }
                                }}
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                                  <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-1 0v14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V6m3 4v8m4-8v8" />
                                  <title>Delete</title>
                                </svg>
                              </button>
                            }
                          >
                            <div class="flex items-center gap-1">
                              <button
                                class={cn('cursor-pointer p-1', isDeleting() ? 'cursor-not-allowed text-neutral-400 opacity-60' : 'text-green-500 hover:text-green-400')}
                                aria-label={isDeleting() ? 'Deleting…' : 'Confirm delete'}
                                disabled={isDeleting()}
                                onPointerDown={(event) => {
                                  event.stopPropagation()
                                  event.preventDefault()
                                }}
                                onMouseDown={(event) => {
                                  event.stopPropagation()
                                  event.preventDefault()
                                }}
                                onPointerUp={(event) => {
                                  event.stopPropagation()
                                  event.preventDefault()
                                }}
                                onMouseUp={(event) => {
                                  event.stopPropagation()
                                  event.preventDefault()
                                }}
                                onClick={async (event) => {
                                  event.stopPropagation()
                                  event.preventDefault()
                                  await menu().onDeleteSample(sample)
                                }}
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                                  <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m5 12l5 5L20 7" />
                                  <title>Confirm</title>
                                </svg>
                              </button>
                              <button
                                class="cursor-pointer p-1 text-neutral-400 hover:text-neutral-300"
                                aria-label="Cancel delete"
                                onPointerDown={(event) => {
                                  event.stopPropagation()
                                  event.preventDefault()
                                }}
                                onMouseDown={(event) => {
                                  event.stopPropagation()
                                  event.preventDefault()
                                }}
                                onPointerUp={(event) => {
                                  event.stopPropagation()
                                  event.preventDefault()
                                }}
                                onMouseUp={(event) => {
                                  event.stopPropagation()
                                  event.preventDefault()
                                }}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  event.preventDefault()
                                  menu().setConfirmingSampleKey(null)
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
              </Show>
              <Show when={hasProjectSamples() && hasDefaultSamples()}>
                <DropdownMenuSeparator class="my-2" />
              </Show>
              <Show when={hasDefaultSamples()}>
                <div class="px-2 pb-2 pt-1 text-xs uppercase tracking-wide text-neutral-500">Default Samples</div>
                <For each={menu().defaultSamples}>
                  {(sample) => {
                    const isInserting = () => menu().insertingSampleKey() === sample.key
                    const size = () => menu().formatBytes(sample.sizeBytes)

                    return (
                      <DropdownMenuItem
                        data-sample-key={sample.key}
                        class="group relative flex w-full cursor-pointer items-center justify-between gap-2 pr-16 hover:bg-neutral-800 hover:text-neutral-100 focus:bg-neutral-800 focus:text-neutral-100 data-[highlighted]:bg-neutral-800 data-[highlighted]:text-neutral-100"
                        onSelect={() => {}}
                      >
                        <div
                          class="flex min-w-0 flex-1 items-center gap-2"
                          draggable={!!sample.url}
                          onDragStart={(event) => menu().onStartSampleDrag(event, sample)}
                          onDragEnd={() => menu().setIsDraggingSample(false)}
                        >
                          <Icon name="file-audio" class="h-4 w-4 text-neutral-400 group-hover:text-neutral-200" />
                          <span class="max-w-48 truncate font-mono text-xs text-neutral-200 group-hover:text-neutral-100" title={sample.name}>{sample.name}</span>
                          <Show when={size()}>
                            <span class="shrink-0 text-xs text-neutral-400">{size()}</span>
                          </Show>
                        </div>
                        <div class="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                          <button
                            class="cursor-pointer p-1 text-neutral-400 hover:text-neutral-200 disabled:opacity-50"
                            aria-label="Copy sample URL"
                            disabled={!sample.url}
                            onPointerDown={(event) => {
                              event.stopPropagation()
                              event.preventDefault()
                            }}
                            onMouseDown={(event) => {
                              event.stopPropagation()
                              event.preventDefault()
                            }}
                            onPointerUp={(event) => {
                              event.stopPropagation()
                              event.preventDefault()
                            }}
                            onMouseUp={(event) => {
                              event.stopPropagation()
                              event.preventDefault()
                            }}
                            onClick={async (event) => {
                              event.stopPropagation()
                              event.preventDefault()
                              await menu().copyText(sample.url)
                            }}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                              <g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <rect width="8" height="8" x="8" y="8" rx="2" />
                                <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
                              </g>
                              <title>Copy URL</title>
                            </svg>
                          </button>
                          <button
                            class={cn('cursor-pointer p-1 text-neutral-400 hover:text-neutral-100 disabled:opacity-50', isInserting() && 'cursor-not-allowed opacity-60')}
                            aria-label="Insert default sample"
                            disabled={!sample.url || isInserting()}
                            onPointerDown={(event) => {
                              event.stopPropagation()
                              event.preventDefault()
                            }}
                            onMouseDown={(event) => {
                              event.stopPropagation()
                              event.preventDefault()
                            }}
                            onPointerUp={(event) => {
                              event.stopPropagation()
                              event.preventDefault()
                            }}
                            onMouseUp={(event) => {
                              event.stopPropagation()
                              event.preventDefault()
                            }}
                            onClick={async (event) => {
                              event.stopPropagation()
                              event.preventDefault()
                              await menu().onInsertSample(sample)
                            }}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                              <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 11h16M12 4v16" />
                              <title>Insert</title>
                            </svg>
                          </button>
                        </div>
                      </DropdownMenuItem>
                    )
                  }}
                </For>
              </Show>
            </Show>
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const ExportsMenu: Component<{ exportsMenu: ExportsMenuController }> = (props) => {
  const menu = () => props.exportsMenu

  return (
    <DropdownMenu open={menu().open} onOpenChange={menu().onOpenChange}>
      <DropdownMenuTrigger>
        <Button variant="outline" size="sm">
          <Icon name="file-audio" class="mr-1 h-4 w-4" />
          Exports
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent class="w-full bg-neutral-900" style={{ width: 'min(92vw, 26rem)', 'pointer-events': menu().isDraggingSample ? 'none' : undefined }}>
        <div class="w-full p-2">
          <div class="flex items-center justify-between px-1 pb-2">
            <span class="text-sm font-semibold text-neutral-100">Project Exports</span>
          </div>
          <DropdownMenuSeparator />
          <div class="max-h-72 overflow-y-auto">
            <Show when={menu().exports.length > 0} fallback={<div class="px-2 py-2 text-xs text-neutral-500">No exports yet</div>}>
              <For each={menu().exports}>
                {(item) => (
                  <DropdownMenuItem
                    class="group relative flex w-full cursor-pointer items-center justify-between gap-2 pr-16 hover:bg-neutral-800 hover:text-neutral-100 focus:bg-neutral-800 focus:text-neutral-100 data-[highlighted]:bg-neutral-800 data-[highlighted]:text-neutral-100"
                    onSelect={() => {
                      if (item.url) {
                        window.open(item.url, '_blank')
                      }
                    }}
                  >
                    <div class="flex min-w-0 flex-1 items-center gap-2">
                      <Icon name="file-audio" class="h-4 w-4 text-neutral-400 group-hover:text-neutral-200" />
                      <span class="max-w-48 truncate font-mono text-xs text-neutral-200 group-hover:text-neutral-100" title={item.name}>{item.name}</span>
                      <span class="shrink-0 text-xs uppercase text-neutral-400">{item.format}</span>
                    </div>
                    <div class="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                      <button
                        class="cursor-pointer p-1 text-neutral-400 hover:text-neutral-200 disabled:opacity-50"
                        aria-label="Copy export URL"
                        disabled={!item.url}
                        onPointerDown={(event) => {
                          event.stopPropagation()
                          event.preventDefault()
                        }}
                        onMouseDown={(event) => {
                          event.stopPropagation()
                          event.preventDefault()
                        }}
                        onPointerUp={(event) => {
                          event.stopPropagation()
                          event.preventDefault()
                        }}
                        onMouseUp={(event) => {
                          event.stopPropagation()
                          event.preventDefault()
                        }}
                        onClick={async (event) => {
                          event.stopPropagation()
                          event.preventDefault()
                          await menu().copyText(item.url)
                        }}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                          <g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <rect width="8" height="8" x="8" y="8" rx="2" />
                            <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
                          </g>
                          <title>Copy URL</title>
                        </svg>
                      </button>
                      <button class="cursor-pointer p-1 text-neutral-400 hover:text-neutral-100 disabled:opacity-50" aria-label="Insert export" disabled>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                          <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 11h16M12 4v16" />
                          <title>Insert</title>
                        </svg>
                      </button>
                    </div>
                  </DropdownMenuItem>
                )}
              </For>
            </Show>
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const TransportBar: Component<{ transport: TransportBarController }> = (props) => {
  const transport = () => props.transport

  return (
    <div class="justify-self-center flex items-center gap-3">
      <Button
        variant="ghost"
        size="sm"
        onClick={transport().onToggleRecord}
        aria-pressed={transport().isRecording}
        aria-label={transport().isRecording ? 'Stop recording' : 'Start recording'}
        class="flex items-center gap-2"
      >
        <span class={cn('h-2.5 w-2.5 rounded-full', transport().isRecording ? 'bg-white' : 'bg-red-500 group-hover:bg-red-400')} />
        <span class="text-xs uppercase tracking-wide">{transport().isRecording ? 'Stop' : 'Rec'}</span>
      </Button>
      <Button variant="ghost" size="sm" onClick={transport().onPlay} disabled={transport().isPlaying} aria-label="Play">
        <Icon name="play" class="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="sm" onClick={transport().onPause} disabled={!transport().isPlaying} aria-label="Pause">
        <Icon name="pause" class="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="sm" onClick={transport().onStop} aria-label="Stop">
        <Icon name="stop" class="h-4 w-4" />
      </Button>
      <div class="flex items-center gap-2">
        <label class="flex items-center gap-1 text-xs text-neutral-400">
          <input
            type="text"
            value={transport().tempoDraft()}
            size={Math.max((transport().tempoDraft().length ?? 0) + 1, 2)}
            class="w-auto appearance-none rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 focus:border-neutral-500 focus:outline-none"
            inputmode="numeric"
            pattern="[0-9]*"
            onFocus={() => transport().setTempoEditing(true)}
            onBlur={() => {
              if (transport().tempoEditing()) {
                transport().commitTempo()
              }
              transport().setTempoEditing(false)
            }}
            onInput={(event) => transport().setTempoDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                transport().commitTempo()
                transport().setTempoEditing(false)
                event.currentTarget.blur()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                transport().setTempoDraft(String(transport().bpm))
                transport().setTempoEditing(false)
                event.currentTarget.blur()
              }
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return
              transport().beginTempoDrag(event)
            }}
            onPointerMove={transport().updateTempoDrag}
            onPointerUp={transport().endTempoDrag}
            onPointerCancel={transport().endTempoDrag}
          />
          <span class="text-xs text-neutral-500">BPM</span>
        </label>
        <Button variant="ghost" size="sm" onClick={transport().onToggleMetronome} aria-pressed={transport().metronomeEnabled} aria-label="Toggle metronome">
          <Icon name="metronome" class="mr-1 h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={transport().onToggleLoop}
          aria-pressed={transport().loopEnabled}
          aria-label="Toggle loop region"
          class={transport().loopEnabled ? 'text-green-400' : ''}
        >
          <Icon name="repeat" class="mr-1 h-4 w-4" />
          <span class="text-xs">Loop</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={transport().onToggleGrid}
          aria-pressed={transport().gridEnabled}
          aria-label="Toggle snap to grid"
          class={transport().gridEnabled ? 'text-green-400' : ''}
        >
          <Icon name="grid" class="mr-1 h-4 w-4" />
          <span class="text-xs">Grid</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger>
            <Button variant="ghost" size="sm" class="px-2 py-1 text-xs">
              {`1/${transport().gridDenominator}`}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent class="w-full bg-neutral-900" style={{ width: '10rem' }}>
            <div class="p-1">
              <div class="px-2 pb-1 text-xs text-neutral-400">Grid</div>
              <DropdownMenuItem class="cursor-pointer text-neutral-50" onSelect={() => transport().onChangeGridDenominator(2)}>1/2</DropdownMenuItem>
              <DropdownMenuItem class="cursor-pointer text-neutral-50" onSelect={() => transport().onChangeGridDenominator(4)}>1/4</DropdownMenuItem>
              <DropdownMenuItem class="cursor-pointer text-neutral-50" onSelect={() => transport().onChangeGridDenominator(8)}>1/8</DropdownMenuItem>
              <DropdownMenuItem class="cursor-pointer text-neutral-50" onSelect={() => transport().onChangeGridDenominator(12)}>1/12</DropdownMenuItem>
              <DropdownMenuItem class="cursor-pointer text-neutral-50" onSelect={() => transport().onChangeGridDenominator(16)}>1/16</DropdownMenuItem>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

const ShareMenu: Component<{ share: ShareMenuController }> = (props) => {
  const share = () => props.share

  return (
    <DropdownMenu open={share().open} onOpenChange={share().onOpenChange}>
      <DropdownMenuTrigger>
        <Button variant="default" size="sm" onClick={() => void share().onOpen()}>
          Share
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent class="w-full bg-neutral-900" style={{ width: 'min(92vw, 24rem)' }}>
        <div class="w-full p-3">
          <div class="mb-3 flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="text-sm font-semibold text-neutral-200">Share this room</span>
            </div>
            <button
              type="button"
              class="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
              aria-label="Close"
              onClick={share().onClose}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m7 7l10 10M17 7L7 17" />
                <title>Close</title>
              </svg>
            </button>
          </div>
          <div class="flex w-full items-center gap-2">
            <div class="min-w-0 w-full max-w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-200 shadow-inner">
              <div class="font-mono" style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{share().shareUrl}</div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label={share().copied ? 'Copied' : 'Copy URL'}
              class={cn('shrink-0', share().copied ? 'text-green-500' : 'text-neutral-400')}
              onClick={() => void share().onCopy()}
            >
              <Show
                when={share().copied}
                fallback={
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                    <g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <rect width="8" height="8" x="8" y="8" rx="2" />
                      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
                    </g>
                    <title>Copy</title>
                  </svg>
                }
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4">
                  <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m5 12l5 5L20 7" />
                  <title>Copied</title>
                </svg>
              </Show>
            </Button>
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const TransportControls: Component<TransportControlsProps> = (props) => {
  const currentRoomId = () => props.currentRoomId
  const currentUserId = () => props.currentUserId
  const projectsMenu = useProjectsMenuController({
    onDeleteProject: props.onDeleteProject,
    onRenameProject: props.onRenameProject,
  })
  const samplesMenu = useSamplesMenuController({
    currentRoomId,
    currentUserId,
    onInsertSample: props.onInsertSample,
    onJumpToClip: props.onJumpToClip,
  })
  const exportsMenu = useExportsMenuController({
    currentRoomId,
  })
  const shareMenu = useShareMenuController({
    onShare: props.onShare,
    roomId: currentRoomId,
  })
  const tempo = useTransportTempoController({
    bpm: () => props.bpm,
    onChangeBpm: props.onChangeBpm,
  })

  return (
    <div class="grid grid-cols-3 items-center gap-2 border-b border-neutral-800 p-3">
      <div class="justify-self-start flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={props.onAddAudio}>Add Audio</Button>
        <Button size="sm" variant="outline" onClick={props.onOpenExport}>Export</Button>
        <ProjectsMenu
          projects={{
            currentRoomId: props.currentRoomId,
            projects: props.projects,
            confirmingProjectId: projectsMenu.confirmingProjectId,
            deletingProjectId: projectsMenu.deletingProjectId,
            editingProjectId: projectsMenu.editingProjectId,
            editingName: projectsMenu.editingName,
            renamingProjectId: projectsMenu.renamingProjectId,
            setConfirmingProjectId: projectsMenu.setConfirmingProjectId,
            setEditingName: projectsMenu.setEditingName,
            onCreateProject: props.onCreateProject,
            onOpenProject: props.onOpenProject,
            beginProjectRename: projectsMenu.beginProjectRename,
            cancelProjectRename: projectsMenu.cancelProjectRename,
            confirmProjectRename: projectsMenu.confirmProjectRename,
            confirmProjectDelete: projectsMenu.confirmProjectDelete,
            stopPropagation: projectsMenu.stopPropagation,
            stopMenuPress: projectsMenu.stopMenuPress,
          }}
        />
        <SamplesMenu
          samples={{
            open: samplesMenu.open(),
            onOpenChange: samplesMenu.onOpenChange,
            isDraggingSample: samplesMenu.isDraggingSample(),
            setIsDraggingSample: samplesMenu.setIsDraggingSample,
            samples: samplesMenu.samples(),
            defaultSamples: samplesMenu.defaultSamples(),
            confirmingSampleKey: samplesMenu.confirmingSampleKey,
            deletingSampleKey: samplesMenu.deletingSampleKey,
            insertingSampleKey: samplesMenu.insertingSampleKey,
            setConfirmingSampleKey: samplesMenu.setConfirmingSampleKey,
            onJumpToClip: samplesMenu.onJumpToClip,
            onStartSampleDrag: samplesMenu.onStartSampleDrag,
            onInsertSample: samplesMenu.onInsertSample,
            onDeleteSample: samplesMenu.onDeleteSample,
            formatBytes: samplesMenu.formatBytes,
            copyText: samplesMenu.copyText,
          }}
        />
        <ExportsMenu
          exportsMenu={{
            open: exportsMenu.open(),
            onOpenChange: exportsMenu.onOpenChange,
            isDraggingSample: samplesMenu.isDraggingSample(),
            exports: exportsMenu.exports(),
            copyText: exportsMenu.copyText,
          }}
        />
      </div>

      <TransportBar
        transport={{
          isRecording: props.isRecording,
          onToggleRecord: props.onToggleRecord,
          isPlaying: props.isPlaying,
          onPlay: props.onPlay,
          onPause: props.onPause,
          onStop: props.onStop,
          tempoDraft: tempo.tempoDraft,
          setTempoDraft: tempo.setTempoDraft,
          tempoEditing: tempo.tempoEditing,
          setTempoEditing: tempo.setTempoEditing,
          commitTempo: tempo.commitTempo,
          beginTempoDrag: tempo.beginTempoDrag,
          updateTempoDrag: tempo.updateTempoDrag,
          endTempoDrag: tempo.endTempoDrag,
          metronomeEnabled: props.metronomeEnabled,
          onToggleMetronome: props.onToggleMetronome,
          loopEnabled: props.loopEnabled,
          onToggleLoop: props.onToggleLoop,
          gridEnabled: props.gridEnabled,
          onToggleGrid: props.onToggleGrid,
          gridDenominator: props.gridDenominator,
          onChangeGridDenominator: props.onChangeGridDenominator,
          bpm: props.bpm,
        }}
      />

      <div class="justify-self-end flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={props.onMasterFX}>Master FX</Button>
        <div class="flex items-center gap-2">
          <span class="text-sm text-neutral-400">Playhead</span>
          <span class="text-sm tabular-nums">{props.playheadSec.toFixed(2)}s</span>
        </div>
        <ShareMenu
          share={{
            open: shareMenu.open(),
            onOpenChange: shareMenu.onOpenChange,
            onOpen: shareMenu.onOpen,
            onClose: shareMenu.onClose,
            copied: shareMenu.copied(),
            shareUrl: shareMenu.shareUrl(),
            onCopy: shareMenu.onCopy,
          }}
        />
        <NavUser />
      </div>
    </div>
  )
}

export default TransportControls
