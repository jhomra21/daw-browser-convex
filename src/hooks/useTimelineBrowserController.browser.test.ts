import tailwindcss from '@tailwindcss/vite'
import { expect, test } from 'bun:test'
import { mkdir } from 'node:fs/promises'
import { build } from 'vite'
import solidPlugin from 'vite-plugin-solid'
import { z } from 'zod'

// The real controller and left browser run in Chromium with real mouse and
// keyboard input. Only the persistence boundaries are stubbed: local folder
// storage and Convex mutations write an in-memory inventory that can be told
// to reject, and the sample/folder hooks publish that inventory.
const repositoryRoot = new URL('../../', import.meta.url).pathname
const evidenceDirectory = `/tmp/daw-browser-controller-${crypto.randomUUID()}`
const fixtureId = 'virtual:browser-controller-fixture'

const stubs = {
  'hooks/useProjectSamples': `
import { createSignal } from 'solid-js'
const [folders, setFolders] = createSignal([])
const [samples, setSamples] = createSignal([])
const store = {
  folders: [],
  samples: [],
  failures: {},
  nextFolder: 1,
  fail: (action) => {
    const message = store.failures[action]
    if (message) throw new Error(message)
  },
  publish: () => {
    setFolders(store.folders.map((folder) => ({ ...folder })))
    setSamples(store.samples.map((sample) => ({ ...sample })))
  },
}
window.folderStore = store
export const useProjectAssetFolders = () => ({ folders, refreshFolders: store.publish })
export const useProjectSamples = () => ({ samples, defaultSamples: () => [], refreshSamples: store.publish })
`,
  'lib/local-asset-folders': `
const store = () => window.folderStore
export const createLocalAssetFolder = async (_projectId, name) => {
  store().fail('create')
  store().folders.push({ id: 'folder-' + store().nextFolder++, name })
}
export const renameLocalAssetFolder = async (_projectId, folderId, name) => {
  store().fail('rename')
  store().folders = store().folders.map((folder) => folder.id === folderId ? { ...folder, name } : folder)
}
export const deleteEmptyLocalAssetFolder = async (_projectId, folderId) => {
  store().fail('delete')
  store().folders = store().folders.filter((folder) => folder.id !== folderId)
}
export const moveLocalAssetToFolder = async (_projectId, assetKey, folderId) => {
  store().fail('move')
  store().samples = store().samples.map((sample) => sample.assetKey === assetKey ? { ...sample, folderId } : sample)
}
`,
  'lib/convex': `
import { createLocalAssetFolder, renameLocalAssetFolder, deleteEmptyLocalAssetFolder, moveLocalAssetToFolder } from '~/lib/local-asset-folders'
export const convexApi = {
  assetFolders: { create: 'assetFolders.create', rename: 'assetFolders.rename', deleteEmpty: 'assetFolders.deleteEmpty' },
  samples: { moveToFolder: 'samples.moveToFolder' },
}
// Shared mutations update the same inventory, then publish it the way the
// Convex subscription would.
const mutations = {
  'assetFolders.create': (args) => createLocalAssetFolder(args.projectId, args.name),
  'assetFolders.rename': (args) => renameLocalAssetFolder(args.projectId, args.folderId, args.name),
  'assetFolders.deleteEmpty': (args) => deleteEmptyLocalAssetFolder(args.projectId, args.folderId),
  'samples.moveToFolder': (args) => moveLocalAssetToFolder(args.projectId, args.assetKey, args.folderId),
}
export const convexClient = {
  mutation: async (reference, args) => {
    await mutations[reference](args)
    window.folderStore.publish()
  },
}
export const useConvexQuery = () => ({ data: undefined })
`,
  'lib/audio-effect-chain-presets': `
import { BUILTIN_AUDIO_EFFECT_CHAIN_PRESETS as presets } from '${repositoryRoot}src/lib/audio-effect-chain-presets.ts'
export * from '${repositoryRoot}src/lib/audio-effect-chain-presets.ts'
// Unfiled presets exercise the leaf rows that follow the preset folders.
export const BUILTIN_AUDIO_EFFECT_CHAIN_PRESETS = [
  ...presets,
  { ...presets[0], id: 'fixture-unfiled-chain', name: 'Fixture Loose Chain', folderId: undefined, folderName: undefined },
  { ...presets[0], id: 'fixture-unnamed-folder-chain', name: 'Fixture Unnamed Folder Chain', folderId: 'mixing', folderName: undefined },
]
`,
  'lib/instrument-presets': `
import { BUILTIN_INSTRUMENT_PRESETS as presets } from '${repositoryRoot}src/lib/instrument-presets.ts'
export * from '${repositoryRoot}src/lib/instrument-presets.ts'
export const BUILTIN_INSTRUMENT_PRESETS = [
  ...presets,
  { ...presets[0], id: 'fixture-unfiled-preset', name: 'Fixture Loose Preset', folderId: undefined, folderName: undefined },
]
`,
}

const fixture = `
import { createComponent, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { useTimelineBrowserController } from '~/hooks/useTimelineBrowserController'
import { TimelineLeftBrowser } from '~/components/timeline/browser/timeline-left-browser'
import '~/index.css'

const center = (element) => {
  const rect = element.getBoundingClientRect()
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}
const flattenRows = (rows, depth = 0) => rows.flatMap((row) => row.kind === 'leaf'
  ? [depth + '|leaf|' + row.item.id + '|' + row.item.folderId]
  : [depth + '|folder|' + row.id + '|' + row.label + '|' + row.leafCount + '|' + row.searchText, ...flattenRows(row.children, depth + 1)])

let state
window.browserFixture = {
  mount: (projectId) => {
    state?.dispose()
    document.body.replaceChildren()
    const store = window.folderStore
    store.folders = [{ id: 'folder-drums', name: 'Drums' }, { id: 'folder-empty', name: 'Empty' }]
    store.samples = [{
      key: 'kick', url: 'blob:kick', filePath: 'kick.wav', name: 'Kick', duration: 1, assetKey: 'asset-kick',
      sourceKind: 'file', source: { kind: 'file' }, folderId: 'folder-drums', createdAt: 0, ownerUserId: 'user', count: 0,
    }]
    store.failures = {}
    store.nextFolder = 1
    store.publish()
    const notifications = []
    const [activeTab, setActiveTab] = createSignal('assets')
    const [searchQueryByTab, setSearchQueryByTab] = createSignal({ assets: '', effects: '', 'midi-instruments': '' })
    const [treeExpansionByTab, setTreeExpansionByTab] = createSignal({ assets: {}, effects: {}, 'midi-instruments': {} })
    const root = document.createElement('div')
    root.style.cssText = 'height:600px;display:flex'
    const messages = document.createElement('ol')
    messages.id = 'notifications'
    messages.style.cssText = 'position:fixed;left:320px;top:16px;font:12px sans-serif'
    document.body.append(root, messages)
    const leftBrowser = {
      open: () => true,
      widthPx: () => 280,
      activeTab,
      searchQueryByTab,
      scrollTopByTab: () => ({ assets: 0, effects: 0, 'midi-instruments': 0 }),
      treeExpansionByTab,
      setOpen: () => {},
      toggleOpen: () => {},
      setActiveTab,
      setSearchQuery: (tab, query) => setSearchQueryByTab((current) => ({ ...current, [tab]: query })),
      setScrollTop: () => {},
      setTreeRowExpanded: (tab, rowId, expanded) => setTreeExpansionByTab((current) => ({ ...current, [tab]: { ...current[tab], [rowId]: expanded } })),
      previewWidthPx: () => {},
      commitWidthPx: () => {},
      clampWidthToLayout: () => {},
    }
    let controller
    const dispose = render(() => {
      controller = useTimelineBrowserController({
        projectId: () => projectId,
        userId: () => 'user',
        leftBrowser,
        onResizePointerDown: () => {},
        deviceInsertActions: () => undefined,
        canCreateTrack: () => false,
        tracks: () => [],
        trackLayout: () => [],
        returnTrackLayout: () => [],
        returnSectionElement: () => undefined,
        masterTimelineElement: () => undefined,
        timelineSurfaceElement: () => undefined,
        scrollElement: () => undefined,
        effectsChainElement: () => undefined,
        currentEffectsTargetId: () => 'master',
        handleInsertSample: () => {},
        onDeviceDrop: () => {},
        onExternalPluginInsertionResult: (title, message) => {
          notifications.push({ title, message })
          const item = document.createElement('li')
          item.textContent = title + ': ' + message
          messages.append(item)
        },
      })
      return createComponent(TimelineLeftBrowser, { get browser() { return controller() } })
    }, root)
    state = { dispose, notifications, leftBrowser, controller: () => controller() }
  },
  setFailure: (action, message) => { window.folderStore.failures[action] = message },
  folderRow: (label) => {
    const button = Array.from(document.querySelectorAll('[data-timeline-left-browser] button[aria-expanded]'))
      .find((element) => element.querySelector('span.flex-1')?.textContent === label)
    return button ? center(button) : null
  },
  sampleRow: (label) => {
    const button = Array.from(document.querySelectorAll('[data-timeline-left-browser] button[title]'))
      .find((element) => element.textContent === label)
    return button ? center(button) : null
  },
  menuItem: (label) => {
    const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((element) => element.textContent.trim() === label)
    return item ? center(item) : null
  },
  renameInput: () => {
    const input = document.querySelector('[data-timeline-left-browser] input:not([type="search"])')
    return input ? { ...center(input), value: input.value, disabled: input.disabled, focused: document.activeElement === input } : null
  },
  result: async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
    const store = window.folderStore
    return {
      notifications: state.notifications.slice(),
      folders: store.folders.map((folder) => folder.id + ':' + folder.name),
      samples: store.samples.map((sample) => sample.assetKey + ':' + (sample.folderId ?? 'unfiled')),
      renameInput: window.browserFixture.renameInput(),
      menuOpen: document.querySelector('[role="menu"]') !== null,
    }
  },
  deviceRows: (tab, query) => {
    state.leftBrowser.setSearchQuery(tab, query)
    const controller = state.controller()
    const sections = tab === 'effects' ? controller.devices.effectSections() : controller.devices.instrumentSections()
    return sections.map((section) => ({ id: section.id, leafCount: section.leafCount, rows: flattenRows(section.rows) }))
  },
}
`

const buildFixture = async () => {
  const stubSources = new Map(Object.entries(stubs))
  const stubFor = (id: string) => Array.from(stubSources.keys()).find((suffix) => id.endsWith(suffix))
  const result = await build({
    root: repositoryRoot,
    configFile: false,
    logLevel: 'silent',
    plugins: [solidPlugin(), tailwindcss(), {
      name: 'browser-controller-fixture',
      enforce: 'pre',
      resolveId: (id) => {
        if (id.endsWith(fixtureId)) return `\0${fixtureId}.ts`
        const stub = stubFor(id)
        return stub ? `\0stub:${stub}.ts` : undefined
      },
      load: (id) => {
        if (id === `\0${fixtureId}.ts`) return fixture
        return id.startsWith('\0stub:') ? stubSources.get(id.slice('\0stub:'.length, -'.ts'.length)) : undefined
      },
    }],
    resolve: { alias: { '~': `${repositoryRoot}src` } },
    build: { write: false, minify: false, lib: { entry: fixtureId, formats: ['iife'], name: 'browserControllerFixture' } },
  })
  const output = Array.isArray(result) ? result[0] : result
  if (!output || !('output' in output)) throw new Error('Expected a single fixture bundle.')
  const styles = output.output.flatMap((chunk) => (
    chunk.type === 'asset' && chunk.fileName.endsWith('.css') ? [String(chunk.source)] : []
  ))
  return `<!doctype html><head><meta charset="utf-8"><style>${styles.join('\n')}</style></head><body style="margin:0"><script>${output.output[0].code}</script>`
}

const openFixture = async (name: string) => {
  const directory = `${evidenceDirectory}/${name}`
  await mkdir(directory, { recursive: true })
  await Bun.write(`${directory}/index.html`, await buildFixture())
  const session = `browser-controller-${name}-${crypto.randomUUID()}`
  const run = async (...args: string[]) => {
    const env = { ...process.env }
    delete env.AGENT_BROWSER_CDP
    delete env.AGENT_BROWSER_SESSION
    const child = Bun.spawn(['agent-browser', '--session', session, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (await child.exited !== 0) throw new Error(stderr || stdout)
    return stdout.trim()
  }
  await run('open', `file://${directory}/index.html`)
  const read = async <Schema extends z.ZodType>(schema: Schema, script: string): Promise<z.infer<Schema>> => (
    schema.parse(JSON.parse(await run('eval', `(async () => JSON.stringify(await ${script}))()`).then((text) => JSON.parse(text))))
  )
  const pointSchema = z.object({ x: z.number(), y: z.number() })
  const at = async (script: string) => read(pointSchema, script)
  const click = async (point: z.infer<typeof pointSchema>, button: 'left' | 'right' = 'left') => {
    await run('mouse', 'move', String(Math.round(point.x)), String(Math.round(point.y)))
    await run('mouse', 'down', button)
    await run('mouse', 'up', button)
  }
  return {
    directory,
    run,
    read,
    evaluate: (script: string) => run('eval', script),
    // Real right-click on a row, then a real click on the named menu item.
    contextAction: async (rowScript: string, label: string) => {
      await click(await at(rowScript), 'right')
      await run('wait', '[role="menuitem"]')
      await click(await at(`browserFixture.menuItem(${JSON.stringify(label)})`))
    },
    click: async (script: string) => click(await at(script)),
    close: () => run('close').catch(() => ''),
  }
}

const resultSchema = z.object({
  notifications: z.array(z.object({ title: z.string(), message: z.string() })),
  folders: z.array(z.string()),
  samples: z.array(z.string()),
  renameInput: z.object({ value: z.string(), disabled: z.boolean(), focused: z.boolean() }).nullable(),
  menuOpen: z.boolean(),
})
type FolderResult = z.infer<typeof resultSchema>

test('browser folder failures show action-specific feedback and retry cleanly', async () => {
  const page = await openFixture('folder-failures')
  const results: Record<string, Record<string, FolderResult>> = {}
  const result = () => page.read(resultSchema, 'browserFixture.result()')
  try {
    for (const project of ['project:local-fixture', 'shared-fixture']) {
      const runs: Record<string, FolderResult> = {}
      const mount = () => page.evaluate(`browserFixture.mount(${JSON.stringify(project)})`)
      const fail = (action: string, message: string | null) => page.evaluate(`browserFixture.setFailure(${JSON.stringify(action)}, ${JSON.stringify(message)})`)

      await mount()
      await fail('create', 'Disk is full')
      await page.contextAction('browserFixture.folderRow("Drums")', 'New folder')
      runs.createFailed = await result()
      await fail('create', null)
      await page.contextAction('browserFixture.folderRow("Drums")', 'New folder')
      runs.createRetried = await result()

      await mount()
      await fail('rename', 'Folder is locked')
      await page.contextAction('browserFixture.folderRow("Drums")', 'Rename folder')
      await page.run('keyboard', 'type', 'Kicks')
      await page.run('press', 'Enter')
      runs.renameFailed = await result()
      await page.run('screenshot', `${page.directory}/${project.replace(':', '-')}-rename-failed.png`)
      await fail('rename', null)
      await page.click('browserFixture.renameInput()')
      await page.run('press', 'Enter')
      runs.renameRetried = await result()

      await mount()
      await page.contextAction('browserFixture.folderRow("Drums")', 'Rename folder')
      await page.run('keyboard', 'type', 'Never saved')
      await page.run('press', 'Escape')
      runs.renameCancelled = await result()

      await mount()
      await fail('delete', 'Permission denied')
      await page.contextAction('browserFixture.folderRow("Empty")', 'Delete empty folder')
      runs.deleteFailed = await result()
      await fail('delete', null)
      await page.contextAction('browserFixture.folderRow("Empty")', 'Delete empty folder')
      runs.deleteRetried = await result()

      await mount()
      await fail('move', 'Sample is offline')
      await page.contextAction('browserFixture.sampleRow("Kick")', 'Move to Unfiled')
      runs.moveFailed = await result()
      await fail('move', null)
      await page.contextAction('browserFixture.sampleRow("Kick")', 'Move to Unfiled')
      runs.moveRetried = await result()

      results[project] = runs
    }
  } finally {
    await Bun.write(`${page.directory}/results.json`, JSON.stringify(results, null, 2))
    console.log(`Browser folder failure evidence: ${page.directory}`)
    await page.close()
  }
  const original = ['folder-drums:Drums', 'folder-empty:Empty']
  for (const runs of Object.values(results)) {
    expect(runs.createFailed).toMatchObject({ notifications: [{ title: 'Folder creation failed', message: 'Disk is full' }], folders: original })
    expect(runs.createRetried).toMatchObject({ notifications: runs.createFailed?.notifications, folders: [...original, 'folder-1:New Folder'] })

    expect(runs.renameFailed).toMatchObject({
      notifications: [{ title: 'Folder rename failed', message: 'Folder is locked' }],
      folders: original,
      renameInput: { value: 'Kicks', disabled: false },
    })
    expect(runs.renameRetried).toMatchObject({
      notifications: runs.renameFailed?.notifications,
      folders: ['folder-drums:Kicks', 'folder-empty:Empty'],
      renameInput: null,
    })
    expect(runs.renameCancelled).toMatchObject({ notifications: [], folders: original, renameInput: null })

    expect(runs.deleteFailed).toMatchObject({ notifications: [{ title: 'Folder deletion failed', message: 'Permission denied' }], folders: original })
    expect(runs.deleteRetried).toMatchObject({ notifications: runs.deleteFailed?.notifications, folders: ['folder-drums:Drums'] })

    expect(runs.moveFailed).toMatchObject({ notifications: [{ title: 'Sample move failed', message: 'Sample is offline' }], samples: ['asset-kick:folder-drums'] })
    expect(runs.moveRetried).toMatchObject({ notifications: runs.moveFailed?.notifications, samples: ['asset-kick:unfiled'] })
  }
}, 240_000)

const deviceSectionsSchema = z.array(z.object({ id: z.string(), leafCount: z.number(), rows: z.array(z.string()) }))

test('built-in preset folders keep their row IDs, order, counts, and search wording', async () => {
  const page = await openFixture('preset-folders')
  const results: Record<string, z.infer<typeof deviceSectionsSchema>> = {}
  try {
    await page.evaluate('browserFixture.mount("project:local-fixture")')
    for (const [tab, query] of [
      ['effects', ''], ['effects', 'mixing'], ['effects', 'audio effect chains'], ['effects', 'space delay'], ['effects', 'fixture'],
      ['midi-instruments', ''], ['midi-instruments', 'synths'], ['midi-instruments', 'instrument presets'], ['midi-instruments', 'pluck'], ['midi-instruments', 'fixture'],
    ] as const) {
      results[`${tab}:${query}`] = await page.read(deviceSectionsSchema, `browserFixture.deviceRows(${JSON.stringify(tab)}, ${JSON.stringify(query)})`)
    }
  } finally {
    await Bun.write(`${page.directory}/results.json`, JSON.stringify(results, null, 2))
    console.log(`Preset folder evidence: ${page.directory}/results.json`)
    await page.close()
  }
  expect(results).toEqual(expectedPresetSections)
}, 120_000)

// Captured from the controller before the preset-folder grouping was shared.
const expectedPresetSections = {
  'effects:': [
    {
      id: 'builtin-effects',
      leafCount: 23,
      rows: [
        '0|folder|builtin-audio-effects|Audio Effects|17|audio effects builtin',
        '1|leaf|builtin:audio-effect:utility|undefined',
        '1|leaf|builtin:audio-effect:eq|undefined',
        '1|leaf|builtin:audio-effect:autofilter|undefined',
        '1|leaf|builtin:audio-effect:gate|undefined',
        '1|leaf|builtin:audio-effect:compressor|undefined',
        '1|leaf|builtin:audio-effect:saturator|undefined',
        '1|leaf|builtin:audio-effect:limiter|undefined',
        '1|leaf|builtin:audio-effect:lofi|undefined',
        '1|leaf|builtin:audio-effect:chorus|undefined',
        '1|leaf|builtin:audio-effect:flanger|undefined',
        '1|leaf|builtin:audio-effect:phaser|undefined',
        '1|leaf|builtin:audio-effect:tremolo|undefined',
        '1|leaf|builtin:audio-effect:autopan|undefined',
        '1|leaf|builtin:audio-effect:ensemble|undefined',
        '1|leaf|builtin:audio-effect:delay|undefined',
        '1|leaf|builtin:audio-effect:reverb|undefined',
        '1|leaf|builtin:audio-effect:spectral|undefined',
        '0|folder|builtin-audio-effect-chains|Audio Effect Chains|5|audio effect chains presets builtin',
        '1|folder|builtin-audio-effect-chain-folder:mixing|Mixing|2|mixing audio effect chains builtin',
        '2|leaf|builtin:audio-effect-chain:vocal-chain|mixing',
        '2|leaf|builtin:audio-effect-chain:drum-bus-punch|mixing',
        '1|folder|builtin-audio-effect-chain-folder:space|Space|1|space audio effect chains builtin',
        '2|leaf|builtin:audio-effect-chain:space-delay|space',
        '1|leaf|builtin:audio-effect-chain:fixture-unfiled-chain|undefined',
        '1|leaf|builtin:audio-effect-chain:fixture-unnamed-folder-chain|mixing',
        '0|folder|builtin-midi-effects|MIDI Effects|1|midi effects builtin',
        '1|leaf|builtin:midi-effect:arpeggiator|undefined'
      ]
    }
  ],
  'effects:mixing': [
    {
      id: 'builtin-effects',
      leafCount: 2,
      rows: [
        '0|folder|builtin-audio-effect-chains|Audio Effect Chains|2|audio effect chains presets builtin',
        '1|folder|builtin-audio-effect-chain-folder:mixing|Mixing|2|mixing audio effect chains builtin',
        '2|leaf|builtin:audio-effect-chain:vocal-chain|mixing',
        '2|leaf|builtin:audio-effect-chain:drum-bus-punch|mixing'
      ]
    }
  ],
  'effects:audio effect chains': [
    {
      id: 'builtin-effects',
      leafCount: 5,
      rows: [
        '0|folder|builtin-audio-effect-chains|Audio Effect Chains|5|audio effect chains presets builtin',
        '1|folder|builtin-audio-effect-chain-folder:mixing|Mixing|2|mixing audio effect chains builtin',
        '2|leaf|builtin:audio-effect-chain:vocal-chain|mixing',
        '2|leaf|builtin:audio-effect-chain:drum-bus-punch|mixing',
        '1|folder|builtin-audio-effect-chain-folder:space|Space|1|space audio effect chains builtin',
        '2|leaf|builtin:audio-effect-chain:space-delay|space',
        '1|leaf|builtin:audio-effect-chain:fixture-unfiled-chain|undefined',
        '1|leaf|builtin:audio-effect-chain:fixture-unnamed-folder-chain|mixing'
      ]
    }
  ],
  'effects:space delay': [
    {
      id: 'builtin-effects',
      leafCount: 1,
      rows: [
        '0|folder|builtin-audio-effect-chains|Audio Effect Chains|1|audio effect chains presets builtin',
        '1|folder|builtin-audio-effect-chain-folder:space|Space|1|space audio effect chains builtin',
        '2|leaf|builtin:audio-effect-chain:space-delay|space'
      ]
    }
  ],
  'effects:fixture': [
    {
      id: 'builtin-effects',
      leafCount: 2,
      rows: [
        '0|folder|builtin-audio-effect-chains|Audio Effect Chains|2|audio effect chains presets builtin',
        '1|leaf|builtin:audio-effect-chain:fixture-unfiled-chain|undefined',
        '1|leaf|builtin:audio-effect-chain:fixture-unnamed-folder-chain|mixing'
      ]
    }
  ],
  'midi-instruments:': [
    {
      id: 'builtin-midi-instruments',
      leafCount: 8,
      rows: [
        '0|folder|builtin-instruments|Instruments|4|instruments builtin',
        '1|leaf|builtin:midi-instrument:synth|undefined',
        '1|leaf|builtin:midi-instrument:drum-rack|undefined',
        '1|leaf|builtin:midi-instrument:sampler|undefined',
        '1|leaf|builtin:midi-instrument:granular|undefined',
        '0|folder|builtin-instrument-presets|Instrument Presets|4|instrument presets builtin',
        '1|folder|builtin-instrument-preset-folder:synths|Synths|2|synths instrument presets builtin',
        '2|leaf|builtin:instrument-preset:bright-poly-synth|synths',
        '2|leaf|builtin:instrument-preset:pluck-arp|synths',
        '1|folder|builtin-instrument-preset-folder:drums|Drums|1|drums instrument presets builtin',
        '2|leaf|builtin:instrument-preset:drum-rack-punch|drums',
        '1|leaf|builtin:instrument-preset:fixture-unfiled-preset|undefined'
      ]
    }
  ],
  'midi-instruments:synths': [
    {
      id: 'builtin-midi-instruments',
      leafCount: 2,
      rows: [
        '0|folder|builtin-instrument-presets|Instrument Presets|2|instrument presets builtin',
        '1|folder|builtin-instrument-preset-folder:synths|Synths|2|synths instrument presets builtin',
        '2|leaf|builtin:instrument-preset:bright-poly-synth|synths',
        '2|leaf|builtin:instrument-preset:pluck-arp|synths'
      ]
    }
  ],
  'midi-instruments:instrument presets': [
    {
      id: 'builtin-midi-instruments',
      leafCount: 4,
      rows: [
        '0|folder|builtin-instrument-presets|Instrument Presets|4|instrument presets builtin',
        '1|folder|builtin-instrument-preset-folder:synths|Synths|2|synths instrument presets builtin',
        '2|leaf|builtin:instrument-preset:bright-poly-synth|synths',
        '2|leaf|builtin:instrument-preset:pluck-arp|synths',
        '1|folder|builtin-instrument-preset-folder:drums|Drums|1|drums instrument presets builtin',
        '2|leaf|builtin:instrument-preset:drum-rack-punch|drums',
        '1|leaf|builtin:instrument-preset:fixture-unfiled-preset|undefined'
      ]
    }
  ],
  'midi-instruments:pluck': [
    {
      id: 'builtin-midi-instruments',
      leafCount: 1,
      rows: [
        '0|folder|builtin-instrument-presets|Instrument Presets|1|instrument presets builtin',
        '1|folder|builtin-instrument-preset-folder:synths|Synths|1|synths instrument presets builtin',
        '2|leaf|builtin:instrument-preset:pluck-arp|synths'
      ]
    }
  ],
  'midi-instruments:fixture': [
    {
      id: 'builtin-midi-instruments',
      leafCount: 1,
      rows: [
        '0|folder|builtin-instrument-presets|Instrument Presets|1|instrument presets builtin',
        '1|leaf|builtin:instrument-preset:fixture-unfiled-preset|undefined'
      ]
    }
  ]
}
