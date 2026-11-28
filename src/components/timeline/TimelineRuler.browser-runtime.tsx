import { createMemo, createRoot, createSignal, flush, untrack } from 'solid-js'
import { render } from '@solidjs/web'

import { buildGroupClipOverviews } from '~/lib/timeline-track-layout'
import type { Track } from '@daw-browser/timeline-core/types'
import TimelineRuler from './TimelineRuler'

const scenarios: Record<string, boolean> = {}

// The fixture drives the ruler from the page, like input does: each event settles before the next read.
const send = (target: EventTarget, event: Event) => {
  target.dispatchEvent(event)
  flush()
}

const rulerOf = (host: Element) => {
  const ruler = host.firstElementChild

  if (!(ruler instanceof HTMLElement)) throw new Error('The ruler did not render an element.')

  return ruler
}

const runGesture = (
  endType: 'pointercancel' | 'escape' | 'blur' | 'pointerup',
  mode: 'create' | 'resize-start' | 'resize-end' | 'move',
  escapeOwner?: 'dialog' | 'menu',
  absentBaseline = false,
) => {
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:0;top:0;width:1000px;height:24px'
  document.body.append(host)

  const [loop, setLoop] = createSignal({
    startSec: absentBaseline ? undefined : 1,
    endSec: absentBaseline ? undefined : 3,
  })

  let commits = 0
  let disposeRuler = () => {}

  const dispose = createRoot((cleanup) => {
    disposeRuler = render(() => (
      <TimelineRuler
        durationSec={20}
        bpm={120}
        denom={4}
        gridEnabled={false}
        pixelsPerSecond={100}
        visibleRange={{ startSec: 0, endSec: 10 }}
        viewportWidthPx={1000}
        timeToX={(seconds) => seconds * 100}
        xToTime={(pixels) => pixels / 100}
        onPointerDown={() => {}}
        loopEnabled
        loopStartSec={loop().startSec}
        loopEndSec={loop().endSec}
        onSetLoopRegion={(startSec, endSec) => { commits += 1; setLoop({ startSec, endSec }) }}
      />
    ), host)

    return cleanup
  })

  flush()

  {
    const ruler = rulerOf(host)

    const x = mode === 'create' ? 500
      : mode === 'resize-start' ? 100
      : mode === 'resize-end' ? 300
      : 200

    send(ruler, new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: x,
      clientY: 5,
      pointerId: 1,
    }))
    send(window, new PointerEvent('pointermove', {
      clientX: mode === 'create' ? 700
        : mode === 'resize-start' ? 200
        : mode === 'resize-end' ? 400
        : 250,
      pointerId: 1,
    }))
    scenarios[`${endType}-${mode}-preview-only`] = commits === 0

    if (endType === 'pointercancel') {
      send(window, new PointerEvent('pointercancel', { pointerId: 1 }))
    } else if (endType === 'escape') {
      send(window, new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    } else if (endType === 'blur') {
      send(window, new Event('blur'))
    } else {
      if (escapeOwner) {
        const dialog = document.createElement('div')
        dialog.setAttribute('role', escapeOwner)
        const target = document.createElement('button')
        dialog.append(target)
        document.body.append(dialog)

        const escape = new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        })

        send(target, escape)
        scenarios[`${escapeOwner}-escape-not-consumed`] = !escape.defaultPrevented
        send(window, new PointerEvent('pointermove', { clientX: 800, pointerId: 1 }))
        dialog.remove()
      }

      send(window, new PointerEvent('pointerup', { pointerId: 1 }))
      send(window, new PointerEvent('pointermove', { clientX: 300, pointerId: 1 }))
    }

    const current = untrack(loop)
    const retained = endType === 'pointerup'
    scenarios[`${endType}-${mode}-commit-count`] = commits === (retained ? 1 : 0)

    const expected = mode === 'create'
      ? { startSec: 5, endSec: escapeOwner ? 8 : 7 }
      : mode === 'resize-start'
      ? { startSec: 2, endSec: 3 }
      : mode === 'resize-end'
      ? { startSec: 1, endSec: 4 }
      : { startSec: 1.5, endSec: 3.5 }

    scenarios[`${endType}-${mode}${escapeOwner ? `-${escapeOwner}-escape` : ''}`] = retained
      ? current.startSec === expected.startSec && current.endSec === expected.endSec
      : absentBaseline
      ? current.startSec === undefined && current.endSec === undefined
      : current.startSec === 1 && current.endSec === 3

    if (endType === 'escape') {
      send(ruler, new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 500,
        clientY: 5,
        pointerId: 2,
      }))
      send(window, new PointerEvent('pointermove', { clientX: 700, pointerId: 2 }))
      send(window, new PointerEvent('pointerup', { pointerId: 2 }))
      const afterNextGesture = untrack(loop)
      scenarios['subsequent-gesture-after-escape'] =
        afterNextGesture.startSec === 5 && afterNextGesture.endSec === 7
    }

    disposeRuler()
    dispose()
    host.remove()
  }
}

const runUnmountCancellation = () => {
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:0;top:0;width:1000px;height:24px'
  document.body.append(host)
  let disposeRuler = () => {}
  const [loop, setLoop] = createSignal({ startSec: 1, endSec: 3 })

  const dispose = createRoot((cleanup) => {
    disposeRuler = render(() => (
      <TimelineRuler
        durationSec={20}
        bpm={120}
        denom={4}
        gridEnabled={false}
        pixelsPerSecond={100}
        visibleRange={{ startSec: 0, endSec: 10 }}
        viewportWidthPx={1000}
        timeToX={(seconds) => seconds * 100}
        xToTime={(pixels) => pixels / 100}
        onPointerDown={() => {}}
        loopEnabled
        loopStartSec={loop().startSec}
        loopEndSec={loop().endSec}
        onSetLoopRegion={(startSec, endSec) => setLoop({ startSec, endSec })}
      />
    ), host)

    return cleanup
  })

  flush()
  const ruler = rulerOf(host)
  send(ruler, new PointerEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: 500,
    clientY: 5,
    pointerId: 3,
  }))
  send(window, new PointerEvent('pointermove', { clientX: 700, pointerId: 3 }))
  disposeRuler()
  dispose()
  flush()
  const current = untrack(loop)
  scenarios['unmount-cancel'] = current.startSec === 1 && current.endSec === 3
  host.remove()
}

runGesture('pointercancel', 'create')

runGesture('escape', 'create')

runGesture('blur', 'create')

runGesture('pointercancel', 'resize-start')

runGesture('escape', 'resize-start')

runGesture('blur', 'resize-start')

runGesture('pointerup', 'create')

runGesture('pointerup', 'resize-start')

runGesture('pointerup', 'resize-end')

runGesture('pointerup', 'move')

runGesture('pointerup', 'create', 'dialog')

runGesture('pointerup', 'create', 'menu')

runGesture('escape', 'create', undefined, true)

runUnmountCancellation()

const overviewTrack = (
  id: string,
  groupId: string | undefined,
  startSec: number,
  duration: number,
  color: string,
  channelRole?: Track['channelRole'],
): Track => ({
  id,
  name: id,
  volume: 1,
  clips: duration > 0 ? [{ id: `${id}:clip`, name: id, startSec, duration, color }] : [],
  groupId,
  channelRole,
})

const overviewTracks = [
  overviewTrack('outer', undefined, 0, 0, '', 'group'),
  overviewTrack('inner', 'outer', 0, 0, '', 'group'),
  overviewTrack('first', 'inner', 0, 2, 'blue'),
  overviewTrack('second', 'inner', 1, 2, 'blue'),
  overviewTrack('third', 'outer', 4, 1, 'red'),
  overviewTrack('outside', undefined, 6, 2, 'green'),
]

const nestedOverviews = buildGroupClipOverviews(overviewTracks, new Set(['outer', 'inner']))

scenarios['nested-group-output'] =
  JSON.stringify(nestedOverviews.get('outer')) === JSON.stringify([
    { startSec: 0, endSec: 3, color: 'blue' },
    { startSec: 4, endSec: 5, color: 'red' },
  ])
  && JSON.stringify(nestedOverviews.get('inner')) === JSON.stringify([
    { startSec: 0, endSec: 3, color: 'blue' },
  ])

scenarios['expanded-group-not-aggregated'] =
  buildGroupClipOverviews(overviewTracks, new Set(['outer'])).has('inner') === false

{
  const [tracks, setTracks] = createSignal(overviewTracks)
  const [collapsedGroupIds, setCollapsedGroupIds] = createSignal(new Set<Track['id']>(['outer']))

  const { dispose, mountedOverviews } = createRoot((cleanup) => {
    const overviews = createMemo(() => buildGroupClipOverviews(tracks(), collapsedGroupIds()))

    return { dispose: cleanup, mountedOverviews: overviews }
  })

  flush()
  const beforeUpdate = untrack(() => mountedOverviews().get('outer')?.length ?? 0)
  const currentTracks = untrack(tracks)

  const nextTracks: Track[] = currentTracks.map((track) => track.id === 'first'
    ? { ...track, clips: [...track.clips, { id: 'first:later', name: 'later', startSec: 8, duration: 1, color: 'purple' }] }
    : track)

  setTracks(nextTracks)
  flush()
  const afterCollapsedUpdate = untrack(() => mountedOverviews().get('outer'))
  setCollapsedGroupIds(new Set<string>())
  flush()
  const afterExpand = untrack(mountedOverviews)
  scenarios['mounted-collapsed-group-updates'] =
    beforeUpdate === 2
    && afterCollapsedUpdate?.some((segment) => segment.startSec === 8) === true
    && afterExpand.size === 0
  dispose()
}

Object.defineProperty(window, '__timelineRulerCancelResults', { value: scenarios })
