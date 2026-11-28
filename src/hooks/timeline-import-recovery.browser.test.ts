import { expect, test } from 'bun:test'
import { mkdir } from 'node:fs/promises'
import { z } from 'zod'

// Drives the real import, drop, and missing-media recovery hooks in Chromium
// against real OPFS assets and IndexedDB timeline rows. Only the asset-create,
// clip-create, and clip-update boundaries are wrapped so one write can fail.
const sourceRoot = new URL('..', import.meta.url).pathname

const fixture = `
import { createRoot, createSignal } from 'solid-js'
import { useTimelineClipImport } from '${sourceRoot}hooks/useTimelineClipImport'
import { useTimelineDragDrop } from '${sourceRoot}hooks/useTimelineDragDrop'
import { useTimelineSelectionState } from '${sourceRoot}hooks/useTimelineSelectionState'
import { useMissingMediaRecovery } from '${sourceRoot}hooks/useLocalTimelineMediaRecovery'
import { createLocalProject } from '${sourceRoot}lib/local-project-db'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import { createLocalAsset, listLocalAssets } from '~/lib/local-assets'

window.faults = {
  assetCreate: false,
  assetCreateFailures: 0,
  failedAssetNames: [],
  clipCreate: false,
  clipUpdate: null,
  metadataGate: null,
  metadataStarted: null,
  trackCreateGate: null,
  trackCreateStarted: null,
  failedClipNames: [],
}
const unhandled = []
window.addEventListener('unhandledrejection', event => { unhandled.push(String(event.reason)); event.preventDefault() })

const wav = (frames = 22050, sampleRate = 44100) => {
  const view = new DataView(new ArrayBuffer(44 + frames * 2))
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)) }
  text(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); text(8, 'WAVE'); text(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  text(36, 'data'); view.setUint32(40, frames * 2, true)
  for (let i = 0; i < frames; i++) view.setInt16(44 + i * 2, Math.round(Math.sin(i / 20) * 8000), true)
  return new Uint8Array(view.buffer)
}
const bytes = value => new TextEncoder().encode(value)
const files = {
  empty: () => new File([], 'empty.wav', { type: 'audio/wav' }),
  malformed: () => new File([bytes('RIFF\\u0000\\u0000\\u0000\\u0000WAVEnot really audio data at all')], 'malformed.wav', { type: 'audio/wav' }),
  unsupported: () => new File([bytes('plain text notes, not audio')], 'notes.txt', { type: 'text/plain' }),
  'valid-audio-mime': () => new File([wav()], 'tone.wav', { type: 'audio/wav' }),
  'valid-empty-mime': () => new File([wav()], 'tone', { type: '' }),
  'valid-octet-mime': () => new File([wav()], 'tone.bin', { type: 'application/octet-stream' }),
}
const gateMetadata = (file, gate, started) => {
  const slice = file.slice.bind(file)
  Object.defineProperty(file, 'slice', {
    value: (...args) => {
      const blob = slice(...args)
      const stream = blob.stream.bind(blob)
      Object.defineProperty(blob, 'stream', { value: () => new ReadableStream({
      async start(controller) {
        started()
        await gate
        const reader = stream().getReader()
        for (;;) {
          const result = await reader.read()
          if (result.done) break
          controller.enqueue(result.value)
        }
        controller.close()
      },
      }) })
      return blob
    },
  })
  return file
}
const withFile = file => { const transfer = new DataTransfer(); transfer.items.add(file); return transfer }
const withFiles = files => { const transfer = new DataTransfer(); for (const file of files) transfer.items.add(file); return transfer }
const pickerReturning = file => async () => [{ getFile: async () => file }]
const settled = promise => promise.then(() => 'resolved', error => 'rejected: ' + error)

const mountImport = async name => {
  const project = await createLocalProject(name)
  const otherProject = await createLocalProject(name + ':other')
  const repositories = new Map([
    [project.id, createLocalTimelineRepository(project.id)],
    [otherProject.id, createLocalTimelineRepository(otherProject.id)],
  ])
  const repositoryFor = projectId => repositories.get(projectId)
  const [projectId, setProjectId] = createSignal(project.id)
  const repository = repositoryFor(project.id)
  const [tracks, setTracks] = createSignal((await repository.loadSnapshot()).tracks.map(track => ({ ...track, clips: [] })))
  const selection = useTimelineSelectionState({ projectId, tracks })
  const trackLayout = () => tracks().map((track, index) => ({ trackId: track.id, topPx: index * 80, heightPx: 80, clipLaneHeightPx: 80, automationHeightPx: 0, depth: 0 }))
  const notices = []
  const [appMessage, setAppMessage] = createSignal(null)
  const history = []
  const drops = []
  let fallbackPickerOpens = 0
  const scroll = document.createElement('div')
  scroll.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:400px'
  document.body.append(scroll)
  let dispose
  const importer = createRoot(cleanup => {
    dispose = cleanup
    const handlers = useTimelineClipImport({
      audioEngine: {}, tracks, trackLayout,
      removeLocalTrack: id => setTracks(current => current.filter(track => track.id !== id)),
      insertLocalClip: (trackId, clip) => setTracks(current => current.map(track => track.id === trackId ? { ...track, clips: [...track.clips, clip] } : track)),
      removeLocalClips: ids => { const removed = new Set(ids); setTracks(current => current.map(track => ({ ...track, clips: track.clips.filter(clip => !removed.has(clip.id)) }))) },
      selection,
      playheadSec: () => 0, projectId, mountedProjectGeneration: () => 1, userId: () => undefined,
      clipBuffers: { writer: { storeBuffer() {}, storeBuffers() {}, removeBuffer() {} }, preload: async () => {}, uploadToR2: async () => null },
      getScrollElement: () => scroll,
      getFileInput: () => ({ click: () => { fallbackPickerOpens += 1 } }),
      bpm: () => 120, gridEnabled: () => false, gridDenominator: () => 4, pixelsPerSecond: () => 100, visibleStartSec: () => 0,
      createTimelineTrack: async () => {
        const createdProjectId = projectId()
        const createdRepository = repositoryFor(createdProjectId)
        const row = await createdRepository.createTrack({ kind: 'audio' })
        window.faults.trackCreateStarted?.()
        if (window.faults.trackCreateGate) await window.faults.trackCreateGate
        const track = { ...row, clips: [] }
        if (projectId() === createdProjectId) setTracks(current => [...current, track])
        return track
      },
      removeCreatedCloudTrack: async () => {},
      historyPush: entry => history.push(entry.type),
      onLocalSaveFailed: (_projectId, message) => notices.push({ surface: 'save-failure', message }),
      notify: (title, message) => setAppMessage({ surface: 'dialog', title, message }),
    })
    useTimelineDragDrop({
      trackLayout, rootElement: () => undefined, scrollElement: () => scroll,
      // The window drop listener discards this promise, so record how it settles.
      onDrop: event => {
        const drop = handlers.handleDrop(event)
        drops.push(settled(drop))
        return drop
      },
    })
    return handlers
  })
  const run = async (route, file) => {
    if (route === 'picker') {
      window.showOpenFilePicker = typeof file === 'function' ? file : pickerReturning(file)
      return settled(importer.handleAddAudio())
    }
    if (route === 'fallback') return settled(importer.handleFiles(withFile(file).files))
    // Lanes start below the 56 px overview and ruler; the first lane spans 80 px.
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: withFile(file), clientX: 200, clientY: route === 'drop-on-track' ? 96 : 300, cancelable: true, bubbles: true }))
    return (await Promise.all(drops.splice(0))).find(result => result !== 'resolved') ?? 'resolved'
  }
  const runBatch = async (route, batch) => {
    const transfer = withFiles(batch)
    window.dispatchEvent(new DragEvent('drop', {
      dataTransfer: transfer,
      clientX: 200,
      clientY: route === 'drop-on-track' ? 96 : 300,
      cancelable: true,
      bubbles: true,
    }))
    return (await Promise.all(drops.splice(0))).find(result => result !== 'resolved') ?? 'resolved'
  }
  const directDrop = file => importer.handleDrop({
    preventDefault() {},
    dataTransfer: { files: [file], getData: () => '' },
    clientX: 200,
    clientY: 300,
  })
  const state = async () => {
    const snapshot = await repository.loadSnapshot()
    const otherSnapshot = await repositoryFor(otherProject.id).loadSnapshot()
    const dialogMessage = appMessage()
    setAppMessage(null)
    return {
      tracks: snapshot.tracks.length,
      otherTracks: otherSnapshot.tracks.length,
      projectedTracks: tracks().length,
      clips: snapshot.clips.map(clip => ({ name: clip.name, duration: clip.duration, sourceSampleRate: clip.sourceSampleRate })),
      clipRows: snapshot.clips.map(clip => ({ name: clip.name, startSec: clip.startSec, duration: clip.duration, trackId: clip.trackId, id: clip.id })),
      reloadedClipRows: (await createLocalTimelineRepository(project.id).loadSnapshot()).clips.map(clip => ({ name: clip.name, startSec: clip.startSec, duration: clip.duration, trackId: clip.trackId, id: clip.id })),
      otherClips: otherSnapshot.clips.map(clip => clip.name),
      projectedClips: tracks().flatMap(track => track.clips.map(clip => ({ name: clip.name, startSec: clip.startSec, trackId: track.id }))),
      assets: (await listLocalAssets(project.id)).length,
      assetIds: (await listLocalAssets(project.id)).map(asset => asset.id),
      otherAssets: (await listLocalAssets(otherProject.id)).length,
      history: history.splice(0),
      notices: [...notices.splice(0), ...(dialogMessage ? [dialogMessage] : [])],
      fallbackPickerOpens,
    }
  }
  return {
    projectId: project.id,
    otherProjectId: otherProject.id,
    setProject: setProjectId,
    switchToOtherProject: async () => {
      setProjectId(otherProject.id)
      setTracks((await repositoryFor(otherProject.id).loadSnapshot()).tracks.map(track => ({ ...track, clips: [] })))
    },
    setTracks,
    selectTrack: selection.setSelectedTrackId,
    setScrollLeft: value => { scroll.style.left = value + 'px' },
    repositoryFor,
    run,
    runBatch,
    directDrop,
    state,
    dispose: () => { dispose(); scroll.remove() },
  }
}

const failureLeavesNoResidue = (after, surface) => (
  after.notices.length === 1 && after.notices[0].surface === surface
  && after.tracks === 1 && after.projectedTracks === 1 && after.clips.length === 0 && after.projectedClips.length === 0
  && after.assets === 0 && after.history.length === 0 && after.fallbackPickerOpens === 0
)
const importedOneClip = (after, expectedTracks) => (
  after.notices.length === 0 && after.fallbackPickerOpens === 0
  && after.clips.length === 1 && after.projectedClips.length === 1 && after.clips[0].sourceSampleRate === 44100
  && Math.abs(after.clips[0].duration - 0.5) < 0.01
  && after.tracks === expectedTracks && after.projectedTracks === expectedTracks
  && after.assets === 1 && after.history.length === 1
)
const importedBatch = (after, expectedNames, expectedTracks) => (
  after.notices.length === 0 && after.fallbackPickerOpens === 0
  && JSON.stringify(after.clipRows.map(clip => clip.name)) === JSON.stringify(expectedNames)
  && JSON.stringify(after.reloadedClipRows.map(clip => clip.id)) === JSON.stringify(after.clipRows.map(clip => clip.id))
  && after.projectedClips.length === expectedNames.length
  && after.clipRows.every((clip, index) => clip.trackId === after.clipRows[0].trackId
    && Math.abs(clip.startSec - (2 + index * 0.5)) < 0.01
    && clip.duration > 0.49 && clip.duration < 0.51)
  && after.projectedClips.every((clip, index) => clip.name === expectedNames[index]
    && clip.trackId === after.clipRows[0].trackId)
  && after.tracks === expectedTracks && after.projectedTracks === expectedTracks
  && after.assets === expectedNames.length && after.assetIds.length === expectedNames.length
  && after.history.length === expectedNames.length
)

window.importResults = async () => {
  const results = {}
  const evidence = {}
  const record = async (name, view, settlement, check) => {
    const after = await view.state()
    evidence[name] = { settlement, ...after }
    results[name + ':settled'] = settlement === 'resolved'
    results[name] = check(after)
  }

  for (const route of ['picker', 'fallback', 'drop-on-track', 'drop-below-last-track']) {
    for (const [kind, file] of Object.entries(files)) {
      const view = await mountImport(route + ':' + kind)
      const settlement = await view.run(route, file())
      // Picker, fallback, and drop below the last lane auto-create one audio track.
      await record(route + ':' + kind, view, settlement, after => kind.startsWith('valid')
        ? importedOneClip(after, route === 'drop-on-track' ? 1 : 2)
        : failureLeavesNoResidue(after, 'dialog'))
      view.dispose()
    }
  }

  {
    const view = await mountImport('selected-instrument-track')
    const [instrumentTrack] = (await view.repositoryFor(view.projectId).loadSnapshot()).tracks
    view.setTracks(current => current.map(track => ({ ...track, kind: 'instrument' })))
    view.selectTrack(instrumentTrack.id)
    const settlement = await view.run('fallback', files['valid-audio-mime']())
    await record('selected-instrument-creates-audio-track', view, settlement, after => (
      importedOneClip(after, 2)
      && after.clipRows[0].trackId !== instrumentTrack.id
      && after.projectedClips[0].trackId !== instrumentTrack.id
    ))
    view.dispose()
  }
  {
    const view = await mountImport('explicit-instrument-drop-target')
    const [instrumentTrack] = (await view.repositoryFor(view.projectId).loadSnapshot()).tracks
    view.setTracks(current => current.map(track => ({ ...track, kind: 'instrument' })))
    const settlement = await view.run('drop-on-track', files['valid-audio-mime']())
    await record('explicit-instrument-target-is-refused-with-reason', view, settlement, after => (
      after.notices.length === 1
      && after.notices[0].title === 'Audio import failed'
      && after.notices[0].message.includes('cannot receive audio clips')
      && after.tracks === 1 && after.projectedTracks === 1 && after.clips.length === 0
      && after.assets === 0 && instrumentTrack.kind === 'audio'
    ))
    view.dispose()
  }

  for (const route of ['drop-on-track', 'drop-below-last-track']) {
    const view = await mountImport('batch:' + route)
    const settlement = await view.runBatch(route, [
      new File([wav()], 'batch-one.wav', { type: 'audio/wav' }),
      new File([wav()], 'batch-two.wav', { type: 'audio/wav' }),
    ])
    await record('batch:' + route, view, settlement, after => importedBatch(
      after,
      ['batch-one.wav', 'batch-two.wav'],
      route === 'drop-on-track' ? 1 : 2,
    ))
    view.dispose()
  }
  {
    const view = await mountImport('batch:ordered-mixed-durations')
    const repository = view.repositoryFor(view.projectId)
    const [track] = (await repository.loadSnapshot()).tracks
    const existingClip = await repository.createClip({
      trackId: track.id,
      name: 'existing-clip.wav',
      startSec: 3,
      duration: 1,
      color: '#ffffff',
      sourceDurationSec: 1,
      sourceSampleRate: 44100,
      sourceChannelCount: 1,
      sourceKind: 'upload',
    })
    view.setTracks(current => current.map(item => item.id === track.id
      ? { ...item, clips: [{ id: existingClip.id, startSec: 3, duration: 1, name: 'existing-clip.wav' }] }
      : item))
    const settlement = await view.runBatch('drop-on-track', [
      new File([wav(88200)], 'ordered-long.wav', { type: 'audio/wav' }),
      new File([wav(22050)], 'ordered-short.wav', { type: 'audio/wav' }),
    ])
    await record('batch:ordered-mixed-durations', view, settlement, after => (
      after.clipRows.map(clip => clip.name).join('|') === 'existing-clip.wav|ordered-long.wav|ordered-short.wav'
      && after.clipRows.map(clip => clip.startSec).join('|') === '3|4|6'
      && after.clipRows.map(clip => clip.duration).join('|') === '1|2|0.5'
      && after.reloadedClipRows.map(clip => clip.id).join('|') === after.clipRows.map(clip => clip.id).join('|')
      && after.projectedClips.filter(clip => clip.name !== 'existing-clip.wav').map(clip => clip.startSec).join('|') === '4|6'
      && after.assets === 2 && after.tracks === 1 && after.projectedTracks === 1
    ))
    view.dispose()
  }
  {
    const view = await mountImport('batch:below-lane-mixed-durations')
    const settlement = await view.runBatch('drop-below-last-track', [
      new File([wav(44100)], 'below-first.wav', { type: 'audio/wav' }),
      new File([wav(22050)], 'below-second.wav', { type: 'audio/wav' }),
      new File([wav(88200)], 'below-third.wav', { type: 'audio/wav' }),
    ])
    await record('batch:below-lane-mixed-durations', view, settlement, after => (
      after.clipRows.map(clip => clip.name).join('|') === 'below-first.wav|below-second.wav|below-third.wav'
      && after.clipRows.map(clip => clip.startSec).join('|') === '2|3|3.5'
      && after.clipRows.map(clip => clip.duration).join('|') === '1|0.5|2'
      && after.reloadedClipRows.length === 3 && after.projectedClips.length === 3
      && after.assets === 3 && after.tracks === 2 && after.projectedTracks === 2
    ))
    view.dispose()
  }
  {
    const view = await mountImport('batch:two-invalid-one-valid')
    const settlement = await view.runBatch('drop-below-last-track', [
      new File([bytes('not audio')], 'bad-first.wav', { type: 'application/octet-stream' }),
      new File([files.malformed()], 'also-bad.wav', { type: 'audio/wav' }),
      new File([wav()], 'valid-after-errors.wav', { type: 'audio/wav' }),
    ])
    await record('batch:two-invalid-one-valid-notification', view, settlement, after => (
      after.notices.length === 1 && after.notices[0].surface === 'dialog'
      && after.notices[0].title === 'Audio import failed'
      && after.notices[0].message.includes('bad-first.wav')
      && after.notices[0].message.includes('also-bad.wav')
      && after.notices[0].message.split('bad-first.wav').length === 2
      && after.notices[0].message.split('also-bad.wav').length === 2
      && after.clipRows.length === 1 && after.clipRows[0].name === 'valid-after-errors.wav'
      && after.reloadedClipRows.length === 1 && after.projectedClips.length === 1
      && after.tracks === 2 && after.projectedTracks === 2 && after.assets === 1
    ))
    view.dispose()
  }
  {
    const view = await mountImport('batch:invalid-first')
    const settlement = await view.runBatch('drop-below-last-track', [
      files.malformed(),
      new File([wav()], 'valid-after-invalid.wav', { type: 'audio/wav' }),
    ])
    await record('batch:invalid-first-then-valid', view, settlement, after => (
      after.notices.length === 1 && after.notices[0].title === 'Audio import failed'
      && after.notices[0].message.includes('malformed.wav')
      && after.clipRows.length === 1 && after.clipRows[0].name === 'valid-after-invalid.wav'
      && after.reloadedClipRows.length === 1 && after.projectedClips.length === 1
      && after.tracks === 2 && after.projectedTracks === 2 && after.assets === 1 && after.history.length === 1
    ))
    view.dispose()
  }
  {
    const view = await mountImport('batch:invalid-middle')
    const settlement = await view.runBatch('drop-below-last-track', [
      new File([wav()], 'valid-before-invalid.wav', { type: 'audio/wav' }),
      files.malformed(),
      new File([wav()], 'valid-after-invalid.wav', { type: 'audio/wav' }),
    ])
    await record('batch:valid-invalid-valid', view, settlement, after => (
      after.notices.length === 1 && after.notices[0].message.includes('malformed.wav')
      && after.clipRows.map(clip => clip.name).join('|') === 'valid-before-invalid.wav|valid-after-invalid.wav'
      && after.clipRows.every((clip, index) => Math.abs(clip.startSec - (2 + index * 0.5)) < 0.01)
      && after.reloadedClipRows.length === 2 && after.projectedClips.length === 2
      && after.tracks === 2 && after.projectedTracks === 2 && after.assets === 2 && after.history.length === 2
    ))
    view.dispose()
  }
  {
    const view = await mountImport('batch:viewport-captured')
    let release
    let started
    const pending = new Promise(resolve => { release = resolve })
    const metadataStarted = new Promise(resolve => { started = resolve })
    const batch = view.runBatch('drop-below-last-track', [
      gateMetadata(new File([wav()], 'viewport-first.wav', { type: 'audio/wav' }), pending, started),
      new File([wav()], 'viewport-second.wav', { type: 'audio/wav' }),
    ])
    await metadataStarted
    view.setScrollLeft(100)
    release()
    const settlement = await batch
    await record('batch:drop-viewport-captured-before-metadata', view, settlement, after => (
      after.clipRows.map(clip => clip.name).join('|') === 'viewport-first.wav|viewport-second.wav'
      && after.clipRows.every((clip, index) => Math.abs(clip.startSec - (2 + index * 0.5)) < 0.01)
      && after.reloadedClipRows.length === 2 && after.assets === 2 && after.history.length === 2
    ))
    view.dispose()
  }
  for (const failure of ['asset', 'clip']) {
    const view = await mountImport('batch:write-failure:' + failure)
    if (failure === 'asset') window.faults.assetCreateFailures = 1
    else window.faults.failedClipNames = ['write-failure.wav']
    const settlement = await view.runBatch('drop-below-last-track', [
      new File([wav()], 'write-failure.wav', { type: 'audio/wav' }),
      new File([wav()], 'valid-after-write-failure.wav', { type: 'audio/wav' }),
    ])
    window.faults.assetCreate = false
    window.faults.assetCreateFailures = 0
    window.faults.failedClipNames = []
    await record('batch:' + failure + '-failure-then-valid', view, settlement, after => (
      after.notices.length === 1
      && after.clipRows.length === 1 && after.clipRows[0].name === 'valid-after-write-failure.wav'
      && after.reloadedClipRows.length === 1 && after.projectedClips.length === 1
      && after.tracks === 2 && after.projectedTracks === 2 && after.assets === 1 && after.history.length === 1
    ))
    view.dispose()
  }
  {
    const view = await mountImport('batch:failure-after-success')
    window.faults.failedAssetNames = ['middle-write-failure.wav']
    const settlement = await view.runBatch('drop-below-last-track', [
      new File([wav()], 'committed-before-failure.wav', { type: 'audio/wav' }),
      new File([wav()], 'middle-write-failure.wav', { type: 'audio/wav' }),
      new File([wav()], 'committed-after-failure.wav', { type: 'audio/wav' }),
    ])
    window.faults.failedAssetNames = []
    await record('batch:failure-does-not-remove-prior-clip', view, settlement, after => (
      after.notices.length === 1 && after.notices[0].surface === 'save-failure'
      && after.clipRows.map(clip => clip.name).join('|') === 'committed-before-failure.wav|committed-after-failure.wav'
      && after.clipRows.every((clip, index) => Math.abs(clip.startSec - (2 + index * 0.5)) < 0.01)
      && after.reloadedClipRows.length === 2 && after.projectedClips.length === 2
      && after.tracks === 2 && after.projectedTracks === 2 && after.assets === 2 && after.history.length === 2
    ))
    view.dispose()
  }

  {
    const view = await mountImport('picker:canceled')
    const settlement = await view.run('picker', async () => { throw new DOMException('The user aborted a request.', 'AbortError') })
    await record('picker:canceled-is-quiet', view, settlement, after => after.notices.length === 0 && after.fallbackPickerOpens === 0 && after.tracks === 1 && after.assets === 0)
    view.dispose()
  }
  {
    const view = await mountImport('picker:unavailable')
    const settlement = await view.run('picker', async () => { throw new DOMException('Picker requires a top-level frame.', 'SecurityError') })
    await record('picker:unavailable-opens-fallback-once', view, settlement, after => after.notices.length === 0 && after.fallbackPickerOpens === 1)
    view.dispose()
  }
  {
    const view = await mountImport('picker:permission-denied')
    const settlement = await view.run('picker', async () => [{ getFile: async () => { throw new DOMException('Permission denied.', 'NotAllowedError') } }])
    await record('picker:permission-denied', view, settlement, after => failureLeavesNoResidue(after, 'dialog'))
    view.dispose()
  }

  for (const route of ['fallback', 'drop-below-last-track']) {
    const view = await mountImport(route + ':asset-create-failure')
    window.faults.assetCreateFailures = 1
    const failed = await view.run(route, files['valid-audio-mime']())
    window.faults.assetCreate = false
    window.faults.assetCreateFailures = 0
    await record(route + ':asset-create-failure', view, failed, after => failureLeavesNoResidue(after, 'save-failure'))
    const retried = await view.run(route, files['valid-audio-mime']())
    await record(route + ':asset-create-retry', view, retried, after => importedOneClip(after, 2))
    view.dispose()
  }
  {
    const view = await mountImport('fallback:clip-create-failure')
    window.faults.clipCreate = true
    const failed = await view.run('fallback', files['valid-audio-mime']())
    window.faults.clipCreate = false
    await record('fallback:clip-create-failure', view, failed, after => failureLeavesNoResidue(after, 'dialog'))
    const retried = await view.run('fallback', files['valid-audio-mime']())
    await record('fallback:clip-create-retry', view, retried, after => importedOneClip(after, 2))
    view.dispose()
  }

  await new Promise(resolve => requestIdleCallback(resolve))
  results['import:no-unhandled-rejections'] = unhandled.length === 0
  return { results, evidence, unhandled: unhandled.splice(0) }
}

window.importRaceResults = async () => {
  const results = {}
  const evidence = {}
  const stateAfter = async view => {
    const state = await view.state()
    return {
      oldTracks: state.tracks,
      newTracks: state.otherTracks,
      oldClips: state.clips.length,
      newClips: state.otherClips.length,
      oldAssets: state.assets,
      newAssets: state.otherAssets,
      projectedTracks: state.projectedTracks,
      history: state.history,
      notices: state.notices,
    }
  }
  {
    const view = await mountImport('race:metadata')
    let release
    let started
    const pending = new Promise(resolve => { release = resolve })
    const metadataStarted = new Promise(resolve => { started = resolve })
    const file = gateMetadata(files['valid-audio-mime'](), pending, started)
    const drop = settled(view.directDrop(file))
    await metadataStarted
    await view.switchToOtherProject()
    release()
    await drop
    const after = await stateAfter(view)
    evidence['drop-project-switch-during-metadata'] = after
    results['drop-project-switch-during-metadata'] = after.oldTracks === 1 && after.newTracks === 1
      && after.oldClips === 0 && after.newClips === 0 && after.oldAssets === 0 && after.newAssets === 0
      && after.projectedTracks === 1 && after.history.length === 0 && after.notices.length === 0
    view.dispose()
    window.faults.metadataGate = null
  }
  {
    const view = await mountImport('race:batch-second-metadata')
    let release
    let started
    const pending = new Promise(resolve => { release = resolve })
    const metadataStarted = new Promise(resolve => { started = resolve })
    const batch = view.runBatch('drop-below-last-track', [
      new File([wav()], 'committed-before-switch.wav', { type: 'audio/wav' }),
      gateMetadata(new File([wav()], 'pending-at-switch.wav', { type: 'audio/wav' }), pending, started),
      new File([wav()], 'must-not-start.wav', { type: 'audio/wav' }),
    ])
    await metadataStarted
    await view.switchToOtherProject()
    release()
    await batch
    const after = await stateAfter(view)
    evidence['batch-project-switch-during-second-metadata'] = after
    results['batch-project-switch-during-second-metadata'] = after.oldTracks === 2 && after.newTracks === 1
      && after.oldClips === 1 && after.newClips === 0 && after.oldAssets === 1 && after.newAssets === 0
      && after.projectedTracks === 1 && after.history.length === 1 && after.notices.length === 0
    view.dispose()
  }
  {
    const view = await mountImport('race:batch-target-changed')
    let release
    let started
    const pending = new Promise(resolve => { release = resolve })
    const metadataStarted = new Promise(resolve => { started = resolve })
    const batch = view.runBatch('drop-on-track', [
      new File([wav()], 'before-target-change.wav', { type: 'audio/wav' }),
      gateMetadata(new File([wav()], 'target-deleted.wav', { type: 'audio/wav' }), pending, started),
      new File([wav()], 'target-still-deleted.wav', { type: 'audio/wav' }),
    ])
    await metadataStarted
    view.setTracks(current => current.map(track => ({ ...track, kind: 'instrument' })))
    release()
    await batch
    const state = await view.state()
    evidence['batch-target-becomes-incompatible'] = state
    results['batch-target-becomes-incompatible'] = state.tracks === 1 && state.projectedTracks === 1
      && state.clipRows.length === 1 && state.clipRows[0].name === 'before-target-change.wav'
      && state.projectedClips.length === 1 && state.assets === 1 && state.history.length === 1
      && state.notices.length === 1 && state.notices[0].title === 'Audio import failed'
      && state.notices[0].message.includes('target-deleted.wav')
      && state.notices[0].message.includes('target-still-deleted.wav')
    view.dispose()
  }
  {
    const view = await mountImport('race:target-track')
    let release
    let started
    const pending = new Promise(resolve => { release = resolve })
    const trackStarted = new Promise(resolve => { started = resolve })
    window.faults.trackCreateGate = pending
    window.faults.trackCreateStarted = () => started()
    const drop = view.run('drop-below-last-track', files['valid-audio-mime']())
    await trackStarted
    await view.switchToOtherProject()
    release()
    await drop
    const after = await stateAfter(view)
    evidence['drop-project-switch-during-target-track-creation'] = after
    results['drop-project-switch-during-target-track-creation'] = after.oldTracks === 1 && after.newTracks === 1
      && after.oldClips === 0 && after.newClips === 0 && after.oldAssets === 0 && after.newAssets === 0
      && after.projectedTracks === 1 && after.history.length === 0 && after.notices.length === 0
    view.dispose()
    window.faults.trackCreateGate = null
    window.faults.trackCreateStarted = null
  }
  return { results, evidence, unhandled: unhandled.splice(0) }
}

const mountRecovery = async name => {
  const project = await createLocalProject(name)
  const otherProject = await createLocalProject(name + ':other')
  const repository = createLocalTimelineRepository(project.id)
  const [track] = (await repository.loadSnapshot()).tracks
  const original = await createLocalAsset({
    projectId: project.id,
    file: new File([wav()], 'original.wav', { type: 'audio/wav' }),
    metadata: { durationSec: 0.5, sampleRate: 44100, channelCount: 1, sourceKind: 'upload' },
  })
  const clip = await repository.createClip({
    trackId: track.id, name: 'Original', startSec: 0, duration: 0.5,
    sourceAssetId: original.id, sourceAssetKey: original.id, sourceKind: 'upload',
    sourceDurationSec: 0.5, sourceSampleRate: 44100, sourceChannelCount: 1,
  })
  const [tracks, setTracks] = createSignal([{ ...track, clips: [{ ...clip, mediaStatus: 'missing' }] }])
  const notices = []
  const [projectId, setProjectId] = createSignal(project.id)
  const [generation, setGeneration] = createSignal(1)
  let removeClip = async () => true
  let selectionChanges = 0
  let projectionRemovals = 0
  let dispose
  const recovery = createRoot(cleanup => {
    dispose = cleanup
    return useMissingMediaRecovery({
      projectId, mountedProjectGeneration: generation,
      remoteTimelineAvailable: () => false, localTimelineReloadVersion: () => 0,
      userId: () => undefined, renderTracks: tracks,
      audioEngine: { decodeAudioData: data => new OfflineAudioContext(1, 1, 44100).decodeAudioData(data) },
      audioBufferCache: { storeBuffer() {}, storeBuffers() {}, removeBuffer() {} },
      preloadClipBuffer: async () => {}, getClipBuffer: () => undefined,
      removeClip: input => removeClip(input),
      projection: {
        insertLocalClip: (trackId, next) => setTracks(current => current.map(entry => entry.id === trackId ? { ...entry, clips: [...entry.clips, next] } : entry)),
        removeLocalClips: ids => {
          projectionRemovals += 1
          const removed = new Set(ids)
          setTracks(current => current.map(entry => ({ ...entry, clips: entry.clips.filter(item => !removed.has(item.id)) })))
        },
      },
      selection: {
        selectedClip: () => null,
        setSelectedClip() { selectionChanges += 1 },
        setSelectedClipIds() { selectionChanges += 1 },
        selectTrackTarget() { selectionChanges += 1 },
      },
      notify: (title, message) => notices.push({ surface: 'dialog', title, message }),
      onLocalSaveFailed: (_projectId, message) => notices.push({ surface: 'save-failure', message }),
    })
  })
  const replace = file => {
    window.showOpenFilePicker = typeof file === 'function' ? file : pickerReturning(file)
    return settled(recovery.replaceMissingMediaClip(track.id, clip.id))
  }
  const remove = failure => {
    removeClip = async () => { throw failure }
    return settled(recovery.removeMissingMediaClip(track.id, clip.id))
  }
  const removePending = promise => {
    removeClip = async () => await promise
    return settled(recovery.removeMissingMediaClip(track.id, clip.id))
  }
  const state = async () => {
    const assets = (await listLocalAssets(project.id)).map(asset => asset.id)
    const row = (await repository.loadSnapshot()).clips.find(entry => entry.id === clip.id)
    const projected = tracks()[0].clips.find(entry => entry.id === clip.id)
    return {
      originalAssetId: original.id,
      assets,
      clipAssetId: row?.sourceAssetId,
      projectedAssetId: projected?.sourceAssetKey,
      projectedMissing: projected?.mediaStatus === 'missing',
      notices: notices.splice(0),
      selectionChanges,
      projectionRemovals,
    }
  }
  return {
    projectId: project.id,
    otherProjectId: otherProject.id,
    setProject: async id => {
      setProjectId(id)
      setGeneration(current => current + 1)
      if (id === otherProject.id) {
        setTracks((await createLocalTimelineRepository(id).loadSnapshot()).tracks.map(entry => ({ ...entry, clips: [] })))
      }
    },
    setRemoveClip: callback => { removeClip = callback },
    removePending,
    replace,
    remove,
    state,
    dispose,
  }
}

window.recoveryResults = async () => {
  const results = {}
  const evidence = {}
  const record = async (name, view, settlement, check) => {
    const after = await view.state()
    evidence[name] = { settlement, ...after }
    results[name + ':settled'] = settlement === 'resolved'
    results[name] = check(after)
  }
  const unchanged = (after, surface) => (
    after.notices.length === (surface ? 1 : 0) && (!surface || after.notices[0].surface === surface)
    && after.assets.length === 1 && after.assets[0] === after.originalAssetId
    && after.clipAssetId === after.originalAssetId && after.projectedMissing
  )

  {
    const view = await mountRecovery('recovery:canceled')
    const settlement = await view.replace(async () => { throw new DOMException('The user aborted a request.', 'AbortError') })
    await record('recovery:canceled-is-quiet', view, settlement, after => unchanged(after, null))
    view.dispose()
  }
  for (const kind of ['empty', 'malformed', 'unsupported']) {
    const view = await mountRecovery('recovery:' + kind)
    const settlement = await view.replace(files[kind]())
    await record('recovery:' + kind, view, settlement, after => unchanged(after, 'dialog'))
    view.dispose()
  }
  {
    const view = await mountRecovery('recovery:asset-create-failure')
    window.faults.assetCreate = true
    const settlement = await view.replace(files['valid-audio-mime']())
    window.faults.assetCreate = false
    await record('recovery:asset-create-failure', view, settlement, after => unchanged(after, 'save-failure'))
    view.dispose()
  }
  {
    const view = await mountRecovery('recovery:clip-update-failure')
    window.faults.clipUpdate = 'before-write'
    const failed = await view.replace(files['valid-audio-mime']())
    window.faults.clipUpdate = null
    await record('recovery:clip-update-failure', view, failed, after => unchanged(after, 'save-failure'))
    const retried = await view.replace(files['valid-audio-mime']())
    await record('recovery:retry-succeeds', view, retried, after => (
      after.notices.length === 0 && after.assets.length === 2 && after.assets.includes(after.originalAssetId)
      && after.clipAssetId !== after.originalAssetId && after.assets.includes(after.clipAssetId)
      && after.projectedAssetId === after.clipAssetId && !after.projectedMissing
    ))
    view.dispose()
  }
  {
    // The repository may keep a failed clip write queued for retry, so a referenced replacement must survive.
    const view = await mountRecovery('recovery:clip-update-failure-after-write')
    window.faults.clipUpdate = 'after-write'
    const settlement = await view.replace(files['valid-audio-mime']())
    window.faults.clipUpdate = null
    await record('recovery:referenced-replacement-is-kept', view, settlement, after => (
      after.notices.length === 1 && after.notices[0].surface === 'save-failure'
      && after.assets.length === 2 && after.assets.includes(after.originalAssetId) && after.assets.includes(after.clipAssetId)
    ))
    view.dispose()
  }
  {
    const view = await mountRecovery('recovery:remove-failure')
    const settlement = await view.remove(new Error('Injected clip delete failure'))
    await record('recovery:remove-failure', view, settlement, after => after.notices.length === 1 && after.projectedMissing)
    view.dispose()
  }

  await new Promise(resolve => requestIdleCallback(resolve))
  results['recovery:no-unhandled-rejections'] = unhandled.length === 0
  return { results, evidence, unhandled: unhandled.splice(0) }
}

window.recoveryRaceResults = async () => {
  const results = {}
  const view = await mountRecovery('recovery:stale-remove')
  let completeRemoval
  const removal = new Promise(resolve => { completeRemoval = resolve })
  const pending = view.removePending(removal)
  await Promise.resolve()
  await view.setProject(view.otherProjectId)
  completeRemoval(true)
  const settlement = await pending
  const after = await view.state()
  results['remove-project-switch-before-resolution-is-ignored'] = settlement === 'resolved'
    && after.projectionRemovals === 0 && after.selectionChanges === 0
  view.dispose()
  return { results, evidence: { staleRemove: after }, unhandled: unhandled.splice(0) }
}
`

const boundaries = {
  assets: `export * from '${sourceRoot}lib/local-assets.ts'
import { createLocalAsset as createStoredAsset, LocalAssetWriteError } from '${sourceRoot}lib/local-assets.ts'
export const createLocalAsset = input => {
  if (window.faults.failedAssetNames.includes(input.file.name)) {
    return Promise.reject(new LocalAssetWriteError('quota-exceeded', 'Project storage is full.'))
  }
  if (window.faults.assetCreateFailures > 0) {
    window.faults.assetCreateFailures -= 1
    return Promise.reject(new LocalAssetWriteError('quota-exceeded', 'Project storage is full.'))
  }
  return window.faults.assetCreate
    ? Promise.reject(new LocalAssetWriteError('quota-exceeded', 'Project storage is full.'))
    : createStoredAsset(input)
}`,
  repository: `export * from '${sourceRoot}lib/timeline-repository/local-timeline-repository.ts'
import { createLocalTimelineRepository as createStoredRepository } from '${sourceRoot}lib/timeline-repository/local-timeline-repository.ts'
export const createLocalTimelineRepository = projectId => {
  const repository = createStoredRepository(projectId)
  return {
    ...repository,
    createClip: input => window.faults.clipCreate || window.faults.failedClipNames.includes(input.name)
      ? Promise.reject(new Error('Injected clip create failure'))
      : repository.createClip(input),
    updateClip: async input => {
      if (window.faults.clipUpdate === 'before-write') throw new Error('Injected clip update failure')
      const row = await repository.updateClip(input)
      if (window.faults.clipUpdate === 'after-write') throw new Error('Injected clip update failure after write')
      return row
    },
  }
}`,
}

const resultSchema = z.object({
  results: z.record(z.string(), z.boolean()),
  evidence: z.record(z.string(), z.unknown()),
  unhandled: z.array(z.string()),
})

const runInChromium = async (name: string, entry: string) => {
  const directory = `/tmp/daw-${name}-${crypto.randomUUID()}`
  const session = `${name}-${crypto.randomUUID()}`
  const browser = async (...args: string[]) => {
    const env = { ...process.env }
    delete env.AGENT_BROWSER_CDP
    delete env.AGENT_BROWSER_SESSION
    const child = Bun.spawn(['agent-browser', '--session', session, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (await child.exited !== 0) throw new Error(stderr || stdout)
    return stdout.trim()
  }
  await mkdir(directory, { recursive: true })
  await Bun.write(`${directory}/fixture.js`, fixture)
  const build = await Bun.build({
    entrypoints: [`${directory}/fixture.js`],
    target: 'browser',
    format: 'esm',
    outdir: directory,
    naming: 'bundle.js',
    plugins: [{
      name: 'import-recovery-boundaries',
      setup(builder) {
        builder.onResolve({ filter: /^solid-js$/ }, () => ({ path: new URL('../../node_modules/solid-js/dist/solid.js', import.meta.url).pathname }))
        builder.onResolve({ filter: /^~\/lib\/local-assets$/ }, () => ({ path: 'assets', namespace: 'boundary' }))
        builder.onResolve({ filter: /^~\/lib\/timeline-repository\/local-timeline-repository$/ }, () => ({ path: 'repository', namespace: 'boundary' }))
        builder.onLoad({ filter: /^(assets|repository)$/, namespace: 'boundary' }, (args) => ({
          contents: args.path === 'assets' ? boundaries.assets : boundaries.repository,
          loader: 'js',
        }))
      },
    }],
  })
  expect(build.success).toBe(true)
  // OPFS and IndexedDB need a real origin, so serve the bundle from localhost.
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/bundle.js') return new Response(Bun.file(`${directory}/bundle.js`), { headers: { 'content-type': 'text/javascript' } })
      return new Response('<!doctype html><script type="module" src="/bundle.js"></script>', { headers: { 'content-type': 'text/html' } })
    },
  })
  try {
    await browser('open', `http://localhost:${server.port}/`)
    const output = resultSchema.parse(JSON.parse(await browser('eval', `window.${entry}()`)))
    await Bun.write(`${directory}/results.json`, JSON.stringify(output, null, 2))
    console.log(`${name} evidence: ${directory}/results.json`)
    return output
  } finally {
    await browser('close').catch(() => undefined)
    server.stop(true)
  }
}

test('audio import failures are reported once and leave no residue on every route', async () => {
  const output = await runInChromium('import-failures', 'importResults')
  expect(output.unhandled).toEqual([])
  expect(Object.entries(output.results).filter(([, passed]) => !passed).map(([name]) => name)).toEqual([])
}, 120_000)

test('missing-media replacement failures keep the original and never orphan the new asset', async () => {
  const output = await runInChromium('media-recovery', 'recoveryResults')
  expect(output.unhandled).toEqual([])
  expect(Object.entries(output.results).filter(([, passed]) => !passed).map(([name]) => name)).toEqual([])
}, 120_000)

test('project switches invalidate pending import and recovery work', async () => {
  for (const entry of ['importRaceResults', 'recoveryRaceResults']) {
    const output = await runInChromium(`import-race-${entry}`, entry)
    expect(output.unhandled).toEqual([])
    expect(Object.entries(output.results).filter(([, passed]) => !passed).map(([name]) => name)).toEqual([])
  }
}, 120_000)
