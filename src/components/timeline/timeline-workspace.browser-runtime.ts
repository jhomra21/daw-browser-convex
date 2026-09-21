import { selectTimelineGridIntervals } from '../../lib/timeline-view'
import { timelineGridPhasePx } from '../../lib/timeline-grid-phase'

type TimelineSample = {
  readonly scrollLeft: number
  readonly viewportLeft: number
  readonly viewportRight: number
  readonly surfaceLeft: number
  readonly surfaceRight: number
  readonly rulerPresent: boolean
  readonly lanePresent: boolean
  readonly overviewPresent: boolean
  readonly visibleStartSec: number
  readonly pixelsPerSecond: number
  readonly rulerMajorPhasePx: number
  readonly gridMinorPhasePx: number
  readonly gridMajorPhasePx: number
  readonly rulerMajorSpacingPx: number
  readonly gridMinorSpacingPx: number
  readonly gridMajorSpacingPx: number
}

type TimelineWorkspaceRegressionResult = {
  readonly coldMount: readonly TimelineSample[]
  readonly pinnedScroll: readonly TimelineSample[]
  readonly activeNativeScrollFrames: readonly TimelineSample[]
  readonly recenterSameLogicalViewport: readonly TimelineSample[]
  readonly sameLogicalViewportPhysicalProxies: readonly TimelineSample[]
  readonly panZoomSequence: readonly TimelineSample[]
  readonly fixedLogicalPan: readonly TimelineSample[]
  readonly pinnedMaxAttachmentError: number
  readonly runwayWidth: number
  readonly coldMountExpected: TimelineSample
  readonly canonicalMinorSpacingPx: number
  readonly canonicalMajorSpacingPx: number
  readonly activeNativeExpectedPhases: readonly number[]
  readonly fixedLogicalPanExpectedDeltaPx: number
  readonly panZoomExpectedPhases: readonly number[]
}

// Headless Chromium may throttle animation frames; the finite timer fallback
// keeps this test measuring the same post-scroll layout without polling.
const afterFrame = () => new Promise<void>((resolve) => {
  let settled = false
  const settle = () => {
    if (settled) return
    settled = true
    resolve()
  }
  requestAnimationFrame(settle)
  setTimeout(settle, 16)
})

const requireElement = (id: string): HTMLElement => {
  const element = document.getElementById(id)
  if (!(element instanceof HTMLElement)) throw new Error(`Missing ${id}`)
  return element
}

const numericPixels = (value: string) => {
  const match = value.match(/-?(?:\d+\.?\d*|\.\d+)px/)
  if (!match) return 0
  const number = Number.parseFloat(match[0])
  return Number.isFinite(number) ? number : 0
}

const computedBackgroundPositions = (element: HTMLElement) => (
  getComputedStyle(element)
    .backgroundPosition
    .split(',')
    .map((position) => numericPixels(position))
)

const computedBackgroundSize = (element: HTMLElement) => (
  getComputedStyle(element)
    .backgroundSize
    .split(',')
    .map((size) => numericPixels(size))
)

const gridConfig = {
  bpm: 120,
  denominator: 4,
  enabled: true,
} as const

const intervalsFor = (pixelsPerSecond: number) => selectTimelineGridIntervals(
  pixelsPerSecond,
  gridConfig.bpm,
  gridConfig.denominator,
  gridConfig.enabled,
)

const applyLogicalViewport = (
  visibleStartSec: number,
  pixelsPerSecond: number,
) => {
  const ruler = requireElement('timeline-ruler')
  const grid = requireElement('timeline-grid')
  const intervals = intervalsFor(pixelsPerSecond)
  const minor = Math.max(0.5, intervals.minorSec * pixelsPerSecond)
  const major = Math.max(0.5, intervals.majorSec * pixelsPerSecond)
  ruler.style.background = `
    repeating-linear-gradient(
      to right,
      #8b8b8b 0px,
      #8b8b8b 2px,
      transparent 2px,
      transparent ${major}px
    ),
    #252525`
  grid.style.background = `
    repeating-linear-gradient(
      to right,
      #616161 0px,
      #616161 1px,
      transparent 1px,
      transparent ${minor}px
    ),
    repeating-linear-gradient(
      to right,
      #8b8b8b 0px,
      #8b8b8b 2px,
      transparent 2px,
      transparent ${major}px
    )`
  ruler.style.backgroundPosition = `${timelineGridPhasePx(
    visibleStartSec,
    pixelsPerSecond,
    intervals.majorSec,
  )}px 0px`
  grid.style.backgroundPosition = [
    `${timelineGridPhasePx(visibleStartSec, pixelsPerSecond, intervals.minorSec)}px 0px`,
    `${timelineGridPhasePx(visibleStartSec, pixelsPerSecond, intervals.majorSec)}px 0px`,
  ].join(', ')
  ruler.style.backgroundSize = `${major}px 100%`
  grid.style.backgroundSize = `${minor}px 100%, ${major}px 100%`
}

const sample = (
  viewport: HTMLElement,
  surface: HTMLElement,
  visibleStartSec: number,
  pixelsPerSecond: number,
): TimelineSample => {
  const viewportRect = viewport.getBoundingClientRect()
  const surfaceRect = surface.getBoundingClientRect()
  const ruler = surface.querySelector('[data-timeline-ruler]')
  const grid = surface.querySelector('[data-timeline-grid]')
  const rulerPhase = ruler instanceof HTMLElement
    ? computedBackgroundPositions(ruler)[0] ?? 0
    : 0
  const gridPhases = grid instanceof HTMLElement
    ? computedBackgroundPositions(grid)
    : []
  const rulerSpacing = ruler instanceof HTMLElement
    ? computedBackgroundSize(ruler)[0] ?? 0
    : 0
  const gridSpacings = grid instanceof HTMLElement
    ? computedBackgroundSize(grid)
    : []
  return {
    scrollLeft: viewport.scrollLeft,
    viewportLeft: viewportRect.left,
    viewportRight: viewportRect.right,
    surfaceLeft: surfaceRect.left,
    surfaceRight: surfaceRect.right,
    rulerPresent: surface.querySelector('[data-timeline-ruler]') !== null,
    lanePresent: surface.querySelector('[data-timeline-lane]') !== null,
    overviewPresent: surface.querySelector('[data-timeline-overview]') !== null,
    visibleStartSec,
    pixelsPerSecond,
    rulerMajorPhasePx: rulerPhase,
    gridMinorPhasePx: gridPhases[0] ?? 0,
    gridMajorPhasePx: gridPhases[1] ?? 0,
    rulerMajorSpacingPx: rulerSpacing,
    gridMinorSpacingPx: gridSpacings[0] ?? 0,
    gridMajorSpacingPx: gridSpacings[1] ?? 0,
  }
}

const attachmentError = (value: TimelineSample) => Math.max(
  Math.abs(value.surfaceLeft - value.viewportLeft),
  Math.abs(value.surfaceRight - value.viewportRight),
)

const sampleScrollPath = (
  viewport: HTMLElement,
  surface: HTMLElement,
  positions: readonly number[],
  visibleStartSec: number,
  pixelsPerSecond: number,
) => new Promise<readonly TimelineSample[]>((resolve) => {
  let settled = false
  const finish = () => {
    if (settled) return
    settled = true
    const samples: TimelineSample[] = []
    for (const position of positions) {
      viewport.scrollLeft = position
      applyLogicalViewport(visibleStartSec, pixelsPerSecond)
      samples.push(sample(viewport, surface, visibleStartSec, pixelsPerSecond))
    }
    resolve(samples)
  }
  requestAnimationFrame(finish)
  setTimeout(finish, 0)
})

const mountTimelineSurface = () => {
  document.body.innerHTML = `
    <style>
      html, body { margin: 0; width: 1100px; height: 300px; overflow: hidden; }
      #app { display: flex; width: 1100px; height: 240px; }
      #left-chrome, #right-chrome { flex: 0 0 150px; }
      #left-chrome { background: #222; }
      #right-chrome { background: #333; }
      #timeline-viewport { flex: 0 0 800px; width: 800px; height: 240px; overflow: auto; position: relative; }
      #timeline-runway { position: relative; display: flex; width: 200000px; height: 240px; min-height: 100%; }
      #timeline-surface { position: sticky; left: 0; flex: 0 0 800px; width: 800px; height: 240px; background: #111; z-index: 1; }
      [data-timeline-overview] { height: 20px; background: #222; }
      [data-timeline-lane] { height: 190px; background: #111; }
      [data-timeline-grid] { position: absolute; inset: 0; pointer-events: none; }
    </style>
    <div id="app">
      <div id="left-chrome"></div>
      <div id="timeline-viewport">
        <div id="timeline-runway">
          <div id="timeline-surface">
            <div data-timeline-overview></div>
            <div id="timeline-ruler" data-timeline-ruler></div>
            <div data-timeline-lane>
              <div id="timeline-grid" data-timeline-grid></div>
            </div>
          </div>
        </div>
      </div>
      <div id="right-chrome"></div>
    </div>
  `
}

const run = async (): Promise<TimelineWorkspaceRegressionResult> => {
  mountTimelineSurface()
  const viewport = requireElement('timeline-viewport')
  const surface = requireElement('timeline-surface')
  const runwayWidth = requireElement('timeline-runway').getBoundingClientRect().width
  const anchor = (runwayWidth - viewport.clientWidth) / 2
  const initialVisibleStartSec = 7.375
  const initialPixelsPerSecond = 100
  applyLogicalViewport(initialVisibleStartSec, initialPixelsPerSecond)
  viewport.scrollLeft = anchor
  await afterFrame()
  const coldMount = [
    sample(viewport, surface, initialVisibleStartSec, initialPixelsPerSecond),
  ]
  viewport.dataset.project = 'project-b'
  viewport.scrollLeft = anchor
  await afterFrame()
  coldMount.push(sample(viewport, surface, initialVisibleStartSec, initialPixelsPerSecond))
  const fixedLogicalPan = [
    sample(viewport, surface, initialVisibleStartSec, initialPixelsPerSecond),
  ]
  const fixedPanStartSec = initialVisibleStartSec + 0.375
  applyLogicalViewport(fixedPanStartSec, initialPixelsPerSecond)
  fixedLogicalPan.push(sample(viewport, surface, fixedPanStartSec, initialPixelsPerSecond))
  const maxScrollLeft = viewport.scrollWidth - viewport.clientWidth
  const pinnedScroll = await sampleScrollPath(
    viewport,
    surface,
    [anchor, 1_000, 50_000, maxScrollLeft, anchor, 199_000, 0],
    initialVisibleStartSec,
    initialPixelsPerSecond,
  )
  const activeNativeScrollFrames: TimelineSample[] = []
  let logicalStartSec = initialVisibleStartSec
  let previousPhysicalScrollLeft = anchor
  for (const physicalScrollLeft of [anchor + 125, anchor + 275, anchor + 50, anchor + 350]) {
    logicalStartSec += (
      physicalScrollLeft - previousPhysicalScrollLeft
    ) / initialPixelsPerSecond
    viewport.scrollLeft = physicalScrollLeft
    applyLogicalViewport(logicalStartSec, initialPixelsPerSecond)
    activeNativeScrollFrames.push(sample(
      viewport,
      surface,
      logicalStartSec,
      initialPixelsPerSecond,
    ))
    viewport.scrollLeft = anchor
    previousPhysicalScrollLeft = anchor
  }
  const recenterStartSec = 13.125
  applyLogicalViewport(recenterStartSec, initialPixelsPerSecond)
  const recenterSameLogicalViewport = [
    sample(viewport, surface, recenterStartSec, initialPixelsPerSecond),
  ]
  viewport.scrollLeft = anchor + 8_000
  recenterSameLogicalViewport.push(
    sample(viewport, surface, recenterStartSec, initialPixelsPerSecond),
  )
  const sameLogicalViewportPhysicalProxies = [
    sample(viewport, surface, recenterStartSec, initialPixelsPerSecond),
  ]
  viewport.scrollLeft = anchor - 6_000
  sameLogicalViewportPhysicalProxies.push(
    sample(viewport, surface, recenterStartSec, initialPixelsPerSecond),
  )
  const panZoomSequence: TimelineSample[] = []
  const sequence = [
    { visibleStartSec: 8.25, pixelsPerSecond: 100 },
    { visibleStartSec: 9.75, pixelsPerSecond: 160 },
    { visibleStartSec: 10.125, pixelsPerSecond: 160 },
    { visibleStartSec: 9.25, pixelsPerSecond: 100 },
    { visibleStartSec: 9.25, pixelsPerSecond: 100 },
    { visibleStartSec: 8.75, pixelsPerSecond: 100 },
  ]
  for (const step of sequence) {
    viewport.scrollLeft = anchor + panZoomSequence.length * 2_000
    applyLogicalViewport(step.visibleStartSec, step.pixelsPerSecond)
    panZoomSequence.push(sample(
      viewport,
      surface,
      step.visibleStartSec,
      step.pixelsPerSecond,
    ))
  }
  const expectedPhase = (visibleStartSec: number, pixelsPerSecond: number) => (
    timelineGridPhasePx(
      visibleStartSec,
      pixelsPerSecond,
      selectTimelineGridIntervals(
        pixelsPerSecond,
        gridConfig.bpm,
        gridConfig.denominator,
        gridConfig.enabled,
      ).majorSec,
    )
  )
  const canonicalMinorSpacingPx = Math.max(
    0.5,
    intervalsFor(initialPixelsPerSecond).minorSec * initialPixelsPerSecond,
  )
  const canonicalMajorSpacingPx = Math.max(
    0.5,
    intervalsFor(initialPixelsPerSecond).majorSec * initialPixelsPerSecond,
  )
  const coldMountExpected = {
    ...coldMount[0],
    rulerMajorPhasePx: expectedPhase(initialVisibleStartSec, initialPixelsPerSecond),
    gridMajorPhasePx: expectedPhase(initialVisibleStartSec, initialPixelsPerSecond),
  }
  return {
    coldMount,
    pinnedScroll,
    pinnedMaxAttachmentError: Math.max(...pinnedScroll.map(attachmentError)),
    runwayWidth,
    activeNativeScrollFrames,
    recenterSameLogicalViewport,
    sameLogicalViewportPhysicalProxies,
    panZoomSequence,
    fixedLogicalPan,
    coldMountExpected,
    canonicalMinorSpacingPx,
    canonicalMajorSpacingPx,
    activeNativeExpectedPhases: activeNativeScrollFrames.map((sample) =>
      expectedPhase(sample.visibleStartSec, sample.pixelsPerSecond)),
    fixedLogicalPanExpectedDeltaPx: expectedPhase(
      fixedPanStartSec,
      initialPixelsPerSecond,
    ) - expectedPhase(initialVisibleStartSec, initialPixelsPerSecond),
    panZoomExpectedPhases: sequence.map((step) =>
      expectedPhase(step.visibleStartSec, step.pixelsPerSecond)),
  }
}

void run().then((result) => {
  Reflect.set(globalThis, '__timelineWorkspaceRegressionResult', result)
}).catch((error) => {
  Reflect.set(globalThis, '__timelineWorkspaceRegressionResult', {
    error: error instanceof Error ? error.message : String(error),
  })
})
