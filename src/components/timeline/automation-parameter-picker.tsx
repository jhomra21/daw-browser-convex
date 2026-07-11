import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import {
  automationTargetKey,
  getAutomationParameterOptionsForTarget,
  type AutomationEffectInstance,
  type AutomationParameterSelection,
  type AutomationTarget,
} from '@daw-browser/shared'
import { cn } from '~/lib/utils'

type AutomationParameterPickerProps = {
  target: AutomationTarget
  effects: readonly AutomationEffectInstance[]
  value: AutomationParameterSelection
  automatedTargetKeys?: ReadonlySet<string>
  onChange: (selection: AutomationParameterSelection) => void
}

const selectionKey = (target: AutomationTarget, selection: AutomationParameterSelection) => automationTargetKey(
  { ...target, effectInstanceId: selection.effectInstanceId },
  selection.parameterId,
)

const groupParameterOptions = (parameterOptions: ReturnType<typeof getAutomationParameterOptionsForTarget>) => {
  const groups: Array<{ group: string; devices: Array<{ device: string; options: typeof parameterOptions }> }> = []
  for (const option of parameterOptions) {
    let group = groups.find((entry) => entry.group === option.group)
    if (!group) {
      group = { group: option.group, devices: [] }
      groups.push(group)
    }
    let device = group.devices.find((entry) => entry.device === option.device)
    if (!device) {
      device = { device: option.device, options: [] }
      group.devices.push(device)
    }
    device.options.push(option)
  }
  return groups
}

export default function AutomationParameterPicker(props: AutomationParameterPickerProps) {
  const [open, setOpen] = createSignal(false)
  let rootRef: HTMLDivElement | undefined
  const parameterOptions = createMemo(() => getAutomationParameterOptionsForTarget(props.effects))
  const groupedParameterOptions = createMemo(() => groupParameterOptions(parameterOptions()))
  const selectedTargetKey = createMemo(() => selectionKey(props.target, props.value))
  const selectedOption = createMemo(() => parameterOptions().find(
    (option) => selectionKey(props.target, option) === selectedTargetKey(),
  ))

  const close = () => setOpen(false)
  const toggle = () => setOpen((current) => !current)

  const onDocumentPointerDown = (event: PointerEvent) => {
    if (!rootRef || !(event.target instanceof Node) || rootRef.contains(event.target)) return
    close()
  }

  createEffect(() => {
    if (!open()) return
    document.addEventListener('pointerdown', onDocumentPointerDown, true)
    onCleanup(() => document.removeEventListener('pointerdown', onDocumentPointerDown, true))
  })

  return (
    <div
      ref={(element) => {
        rootRef = element
      }}
      class="relative w-full text-[11px]"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        class="flex h-7 w-full items-center justify-between gap-2 rounded border border-red-500/40 bg-background/90 px-2 py-1 text-left text-red-100 outline-none hover:border-red-400/70"
        aria-haspopup="listbox"
        aria-expanded={open()}
        onClick={toggle}
      >
        <span class="min-w-0 truncate">
          {props.automatedTargetKeys?.has(selectedTargetKey()) ? '● ' : ''}
          {selectedOption()?.label ?? 'Unresolved automation target'}
        </span>
        <span class="shrink-0 text-red-200/70">{open() ? '▴' : '▾'}</span>
      </button>
      <Show when={open()}>
        <div class="absolute left-0 top-full z-50 mt-1 max-h-80 w-72 overflow-auto rounded border border-border bg-background p-1 shadow-xl shadow-black/50" role="listbox">
          <For each={groupedParameterOptions()}>
            {(group) => (
              <div class="py-1">
                <div class="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{group.group}</div>
                <For each={group.devices}>
                  {(device) => (
                    <div class="mb-1 rounded border border-border/80 bg-app-surface/50 p-1">
                      <div class="px-1 pb-1 text-[10px] text-muted-foreground">{device.device}</div>
                      <For each={device.options}>
                        {(option) => {
                          const targetKey = () => selectionKey(props.target, option)
                          const automated = () => props.automatedTargetKeys?.has(targetKey()) ?? false
                          return (
                            <button
                              type="button"
                              role="option"
                              aria-selected={targetKey() === selectedTargetKey()}
                              class={cn(
                                'flex h-6 w-full items-center gap-2 rounded px-2 text-left text-foreground hover:bg-red-500/20 hover:text-red-50',
                                targetKey() === selectedTargetKey() && 'bg-red-500/20 text-red-50',
                              )}
                              onClick={() => {
                                props.onChange({
                                  parameterId: option.parameterId,
                                  effectInstanceId: option.effectInstanceId,
                                })
                                close()
                              }}
                            >
                              <span class={cn('h-1.5 w-1.5 shrink-0 rounded-full bg-red-500', !automated() && 'opacity-0')} />
                              <span class="min-w-0 truncate">{option.label}</span>
                            </button>
                          )
                        }}
                      </For>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
