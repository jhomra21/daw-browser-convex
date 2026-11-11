import { createMemo, createRoot, createSignal, untrack } from 'solid-js'
import { render } from 'solid-js/web'

import { buildGroupClipOverviews } from '~/lib/timeline-track-layout'
import type { Track } from '@daw-browser/timeline-core/types'
import TimelineRuler from './TimelineRuler'

const scenarios: Record<string, boolean> = {}
const runGesture = (
  endType: 'pointercancel' | 'escape' | 'blur' | 'pointerup',
  mode: 'create' | 'resize-start' | 'resize-end' | 'move',
  escapeOwner?: 'dialog' | 'menu',
  absentBaseline = false,
) => {
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:0;top:0;width:1000px;height:24px'
  document.body.append(host)
  let dispose = () => {}
  createRoot((cleanup) => {
    dispose = cleanup
    const [loop, setLoop] = createSignal({
      startSec: absentBaseline ? undefined : 1,
      endSec: absentBaseline ? undefined : 3,
    })
    let commits = 0
    const disposeRuler = render(() => (
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
    const ruler = host.firstElementChild
    if (!(ruler instanceof HTMLElement)) return
    const x = mode === 'create' ? 500
      : mode === 'resize-start' ? 100
      : mode === 'resize-end' ? 300
      : 200
    ruler.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: x,
      clientY: 5,
      pointerId: 1,
    }))
    window.dispatchEvent(new PointerEvent('pointermove', {
      clientX: mode === 'create' ? 700
        : mode === 'resize-start' ? 200
        : mode === 'resize-end' ? 400
        : 250,
      pointerId: 1,
    }))
    scenarios[`${endType}-${mode}-preview-only`] = commits === 0
    if (endType === 'pointercancel') {
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }))
    } else if (endType === 'escape') {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    } else if (endType === 'blur') {
      window.dispatchEvent(new Event('blur'))
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
        target.dispatchEvent(escape)
        scenarios[`${escapeOwner}-escape-not-consumed`] = !escape.defaultPrevented
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: 800, pointerId: 1 }))
        dialog.remove()
      }
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }))
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, pointerId: 1 }))
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
      ruler.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 500,
        clientY: 5,
        pointerId: 2,
      }))
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 700, pointerId: 2 }))
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2 }))
      const afterNextGesture = untrack(loop)
      scenarios['subsequent-gesture-after-escape'] =
        afterNextGesture.startSec === 5 && afterNextGesture.endSec === 7
    }
    disposeRuler()
    dispose()
    host.remove()
  })
}

const runUnmountCancellation = () => {
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:0;top:0;width:1000px;height:24px'
  document.body.append(host)
  let disposeRuler = () => {}
  createRoot((dispose) => {
    const [loop, setLoop] = createSignal({ startSec: 1, endSec: 3 })
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
    const ruler = host.firstElementChild
    if (!(ruler instanceof HTMLElement)) return
    ruler.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 500,
      clientY: 5,
      pointerId: 3,
    }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 700, pointerId: 3 }))
    disposeRuler()
    dispose()
    const current = untrack(loop)
    scenarios['unmount-cancel'] = current.startSec === 1 && current.endSec === 3
  })
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
createRoot((dispose) => {
  const [tracks, setTracks] = createSignal(overviewTracks)
  const [collapsedGroupIds, setCollapsedGroupIds] = createSignal(new Set<Track['id']>(['outer']))
  const mountedOverviews = createMemo(() => buildGroupClipOverviews(tracks(), collapsedGroupIds()))
  const beforeUpdate = untrack(() => mountedOverviews().get('outer')?.length ?? 0)
  const currentTracks = untrack(tracks)
  const nextTracks: Track[] = currentTracks.map((track) => track.id === 'first'
    ? { ...track, clips: [...track.clips, { id: 'first:later', name: 'later', startSec: 8, duration: 1, color: 'purple' }] }
    : track)
  setTracks(nextTracks)
  const afterCollapsedUpdate = untrack(() => mountedOverviews().get('outer'))
  setCollapsedGroupIds(new Set<string>())
  const afterExpand = untrack(mountedOverviews)
  scenarios['mounted-collapsed-group-updates'] =
    beforeUpdate === 2
    && afterCollapsedUpdate?.some((segment) => segment.startSec === 8) === true
    && afterExpand.size === 0
  dispose()
})
Object.defineProperty(window, '__timelineRulerCancelResults', { value: scenarios })
