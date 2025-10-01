import { type Component, For, Show, createSignal, createEffect, onCleanup } from 'solid-js'
import { convexApi, convexClient, useConvexQuery } from '~/lib/convex'
import { useSessionQuery } from '~/lib/session'

export type SharedChatProps = {
  isOpen: boolean
  onClose: () => void
  roomId?: string
  userId?: string
  bottomOffsetPx?: number
}

// One row per message from Convex
type MessageRow = {
  _id: string
  roomId: string
  senderUserId: string
  content: string
  createdAt: number
  senderName?: string
}

const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 10_000

const SharedChat: Component<SharedChatProps> = (props) => {
  const session = useSessionQuery()
  const displayName = () => (session()?.data?.user as any)?.name as string | undefined

  // Client-side rate limiter state (timestamps in ms of recent sends)
  let recentSends: number[] = []
  const [rateError, setRateError] = createSignal<string>('')
  let rateErrorTimer: number | null = null

  const [input, setInput] = createSignal('')
  let textareaRef: HTMLTextAreaElement | undefined
  let listRef: HTMLDivElement | undefined
  let bottomAnchorRef: HTMLDivElement | undefined

  // Real-time latest messages for the room (bounded)
  const messagesQ = useConvexQuery(
    (convexApi as any).sharedChat.listLatest,
    () => props.roomId ? ({ roomId: props.roomId, limit: 200 } as any) : null,
    () => ['shared-chat', props.roomId]
  )

  const messages = (): MessageRow[] => {
    const raw = (messagesQ as any).data
    const list = typeof raw === 'function' ? raw() : raw
    return Array.isArray(list) ? list as MessageRow[] : []
  }

  // Focus input when opened
  createEffect(() => {
    if (props.isOpen) {
      queueMicrotask(() => { try { textareaRef?.focus() } catch {} })
    }
  })

  // Auto-scroll to bottom on open and when new messages arrive
  function scrollToBottom() {
    const el = bottomAnchorRef
    if (!el) return
    try { el.scrollIntoView({ behavior: 'auto', block: 'end' }) } catch {}
  }

  createEffect(() => {
    if (!props.isOpen) return
    // Track length to detect additions
    const _len = messages().length
    requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottom()))
  })

  onCleanup(() => {
    if (rateErrorTimer) { clearTimeout(rateErrorTimer); rateErrorTimer = null }
  })

  function canSendNow(): { ok: true } | { ok: false; waitMs: number } {
    const now = Date.now()
    // prune old timestamps
    recentSends = recentSends.filter(t => now - t < RATE_LIMIT_WINDOW_MS)
    if (recentSends.length >= RATE_LIMIT_MAX) {
      const oldest = recentSends[0]
      const waitMs = RATE_LIMIT_WINDOW_MS - (now - oldest)
      return { ok: false, waitMs: Math.max(0, waitMs) }
    }
    return { ok: true }
  }

  async function send() {
    const rid = props.roomId
    const uid = props.userId
    if (!rid || !uid) return
    const content = input().trim()
    if (!content) return

    const gate = canSendNow()
    if (!gate.ok) {
      const secs = Math.ceil(gate.waitMs / 1000)
      setRateError(`Slow down — try again in ${secs}s`)
      if (rateErrorTimer) { clearTimeout(rateErrorTimer); rateErrorTimer = null }
      rateErrorTimer = window.setTimeout(() => setRateError(''), 1500)
      return
    }

    try {
      await convexClient.mutation((convexApi as any).sharedChat.send, {
        roomId: rid,
        senderUserId: uid,
        content,
        senderName: displayName(),
      } as any)
      recentSends.push(Date.now())
      setInput('')
      // Scroll will be driven by subscription update
    } catch {
      setRateError('Failed to send')
      if (rateErrorTimer) { clearTimeout(rateErrorTimer); rateErrorTimer = null }
      rateErrorTimer = window.setTimeout(() => setRateError(''), 1500)
    }
  }

  function onKeyDown(e: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <Show when={props.isOpen}>
      <div
        class="fixed left-[404px] bottom-0 w-[380px] h-[460px] bg-neutral-900 border-t border-l border-neutral-800 flex flex-col z-50 pointer-events-auto"
        style={{ bottom: `${props.bottomOffsetPx ?? 0}px` }}
      >
        <div class="flex items-center justify-between px-3 py-2 border-b border-neutral-800">
          <div class="text-sm font-semibold text-neutral-200">Room Chat</div>
          <div class="flex items-center gap-2">
            <Show when={rateError()}>
              <div class="text-xs text-amber-400">{rateError()}</div>
            </Show>
            <button class="text-neutral-400 hover:text-white" onClick={props.onClose}>✕</button>
          </div>
        </div>
        <div class="flex-1 overflow-y-auto px-3 py-2" ref={el => { listRef = el; try { if (props.isOpen) requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottom())) } catch {} }}>
          <div class="min-h-full flex flex-col justify-end space-y-2">
            <For each={messages()}>{(m) => (
              <div class="text-left">
                <div class="inline-block max-w-[90%] rounded-md px-2 py-1 text-sm bg-neutral-800 text-neutral-100">
                  <div class="text-[10px] text-neutral-400 mb-0.5">{m.senderName || m.senderUserId}</div>
                  <div>{m.content}</div>
                </div>
              </div>
            )}</For>
            <div ref={el => (bottomAnchorRef = el)} />
          </div>
        </div>
        <div class="border-t border-neutral-800 p-2">
          <textarea
            class="w-full h-[72px] resize-none rounded bg-neutral-800 text-neutral-100 p-2 text-sm outline-none"
            placeholder={props.userId ? 'Type a message…' : 'Sign in to chat'}
            disabled={!props.userId}
            value={input()}
            onInput={(e) => setInput(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            ref={el => (textareaRef = el)}
          />
          <div class="flex justify-end pt-2">
            <button
              disabled={!props.userId}
              class="bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 text-white text-sm px-3 py-1 rounded border border-neutral-600"
              onClick={() => void send()}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}

export default SharedChat
