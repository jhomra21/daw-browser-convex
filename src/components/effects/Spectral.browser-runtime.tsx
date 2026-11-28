import { createSignal } from 'solid-js'
import { createDefaultSpectralParams, SPECTRAL_MODES, type SpectralMode } from '@daw-browser/shared'

import Spectral from '~/components/effects/Spectral'
import { mountModulationPanel, publishScenarios, settle } from '~/test-support/modulation-panel-fixture'

const tracks = [{ id: 'self', name: 'Self', volume: 1, clips: [] }, { id: 'drums', name: 'Drums', volume: 1, clips: [] }]

const modeLabels: Record<SpectralMode, string> = { freeze: 'Freeze', gate: 'Gate', morph: 'Morph', 'shift-blur': 'Shift/Blur', hpss: 'HPSS', 'noise-reduce': 'Noise Reduce' }

// Every control the panel can show in any mode, so a scenario can list exactly which are on screen.
const everyControl = ['Mode', 'FFT Size', 'Overlap', 'Freeze', 'Learn', 'Sidechain Source']

const run = async () => {
  const scenarios: Record<string, boolean> = {}
  const sources: Array<string | undefined> = []
  const [targetId, setTargetId] = createSignal('self')

  const panel = await mountModulationPanel(createDefaultSpectralParams(), 360, (state) => (
    <Spectral params={state.params()} tracks={tracks} targetId={targetId()} sourceTrackId="drums" onSourceChange={(source) => sources.push(source)} onChange={state.onChange} onToggleEnabled={() => {}} onReset={() => {}} automationRangesByParameterId={state.ranges()} onManualAutomationOverride={state.onOverride} />
  ))

  const { named, slider, valueText, pressed, lastChange, key } = panel
  const visible = () => [...everyControl.filter((name) => named(name)), ...panel.sliderNames().flatMap((name) => name === null ? [] : [name])].join(',')

  const layout = panel.layout()

  scenarios['the-panel-stays-360-px-wide-and-fits-the-device'] = layout.width === 360 && layout.fits
  scenarios['no-label-or-value-is-wider-than-its-box'] = layout.clipped
  scenarios['no-label-or-value-crowds-another-control'] = layout.crowded
  scenarios['every-control-has-an-accessible-name'] = panel.everyControlIsNamed()
  scenarios['every-enabled-control-shows-a-focus-ring'] = panel.everyEnabledControlShowsAFocusRing()
  scenarios['the-header-shows-the-latency'] = /ms @ .* kHz|samples/.test(panel.host.textContent ?? '')
  scenarios['the-panel-has-no-hpss-kernel-footer'] = !(panel.host.textContent ?? '').includes('kernel')

  scenarios['the-defaults-read-as-the-device-defaults'] = named('Mode')?.textContent?.trim() === 'Freeze' && named('FFT Size')?.textContent?.trim() === '2048' && named('Overlap')?.textContent?.trim() === '4x'
    && pressed('Freeze') === 'false' && valueText('Dry/Wet') === '100%'

  const perMode: Record<SpectralMode, string> = {
    freeze: 'Mode,FFT Size,Overlap,Freeze,Dry/Wet',
    gate: 'Mode,FFT Size,Overlap,Threshold,Attack,Release,Dry/Wet',
    morph: 'Mode,FFT Size,Overlap,Sidechain Source,Morph,Dry/Wet',
    'shift-blur': 'Mode,FFT Size,Overlap,Shift,Blur,Dry/Wet',
    hpss: 'Mode,FFT Size,Overlap,Balance,Dry/Wet',
    'noise-reduce': 'Mode,FFT Size,Overlap,Learn,Reduction,Floor,Dry/Wet',
  }

  const listed: Record<string, string> = {}

  for (const mode of SPECTRAL_MODES) {
    await panel.choose('Mode', modeLabels[mode])
    const names = visible().split(',').sort().join(',')
    listed[mode] = names
    scenarios[`${mode}-mode-shows-exactly-its-controls`] = names === perMode[mode].split(',').sort().join(',') && lastChange()?.mode === mode
    const modeLayout = panel.layout()
    scenarios[`${mode}-mode-fits-the-360-px-device`] = modeLayout.fits && modeLayout.clipped && modeLayout.crowded
  }

  Object.assign(window, { __spectralControlsByMode: listed })

  await panel.choose('Mode', 'Freeze')
  named('Freeze')?.click()
  await settle()
  scenarios['freeze-writes-its-flag-and-reads-pressed'] = (lastChange()?.freeze ?? 0) > 0 && pressed('Freeze') === 'true'
  named('Freeze')?.click()
  await settle()
  scenarios['freeze-releases-back-to-zero'] = lastChange()?.freeze === 0 && pressed('Freeze') === 'false'

  await panel.choose('FFT Size', '1024')
  scenarios['fft-size-chooser-writes-the-size'] = lastChange()?.fftSize === 1024 && named('FFT Size')?.textContent?.trim() === '1024'
  await panel.choose('Overlap', '2x')
  scenarios['overlap-chooser-writes-the-overlap'] = lastChange()?.overlap === 2 && named('Overlap')?.textContent?.trim() === '2x'

  await panel.choose('Mode', 'Gate')
  scenarios['gate-defaults-read-in-dbfs-and-ms'] = valueText('Threshold') === '-60.0 dBFS' && valueText('Attack') === '10.0 ms' && valueText('Release') === '100 ms'
  key(slider('Threshold'), 'ArrowUp')
  scenarios['threshold-writes-its-param'] = lastChange()?.gateThresholdDb === -59.9 && panel.overrides.at(-1) === 'spectral.gateThresholdDb'
  key(slider('Attack'), 'ArrowUp')
  scenarios['attack-writes-its-param'] = (lastChange()?.gateAttackMs ?? 0) > 10 && panel.overrides.at(-1) === 'spectral.gateAttackMs'
  key(slider('Release'), 'ArrowUp')
  scenarios['release-writes-its-param'] = (lastChange()?.gateReleaseMs ?? 0) > 100 && panel.overrides.at(-1) === 'spectral.gateReleaseMs'

  await panel.choose('Mode', 'Morph')
  key(slider('Morph'), 'ArrowUp')
  scenarios['morph-writes-its-param'] = lastChange()?.morph === 0.01 && panel.overrides.at(-1) === 'spectral.morph'
  await panel.choose('Sidechain Source', 'Internal')
  scenarios['the-sidechain-chooser-offers-internal-and-the-other-tracks-only'] = sources.at(-1) === undefined && sources.length === 1 && named('Sidechain Source')?.textContent?.trim() === 'Drums'
  await panel.choose('Sidechain Source', 'Drums')
  scenarios['the-sidechain-chooser-writes-the-chosen-track'] = sources.at(-1) === 'drums'

  scenarios['morph-shows-its-source-chooser-on-a-track'] = named('Sidechain Source') !== undefined
  setTargetId('master')
  await settle()
  scenarios['morph-on-the-master-has-no-source-chooser'] = named('Sidechain Source') === undefined && slider('Morph') !== null
  setTargetId('self')
  await settle()

  await panel.choose('Mode', 'Shift/Blur')
  key(slider('Shift'), 'ArrowUp')
  await settle()
  scenarios['shift-writes-its-param'] = lastChange()?.binShift === 1 && panel.overrides.at(-1) === 'spectral.binShift' && valueText('Shift') === '1 bins'
  key(slider('Blur'), 'ArrowUp')
  scenarios['blur-writes-its-param'] = lastChange()?.blur === 0.01 && panel.overrides.at(-1) === 'spectral.blur'

  await panel.choose('Mode', 'HPSS')
  key(slider('Balance'), 'ArrowUp')
  scenarios['balance-writes-its-param'] = lastChange()?.harmonicPercussiveBalance === 0.01 && panel.overrides.at(-1) === 'spectral.harmonicPercussiveBalance'

  await panel.choose('Mode', 'Noise Reduce')
  scenarios['learn-starts-off'] = pressed('Learn') === 'false'
  named('Learn')?.click()
  await settle()
  scenarios['learn-is-a-toggle-that-writes-the-lane-on'] = (lastChange()?.profileLearn ?? 0) > 0 && pressed('Learn') === 'true'
  named('Learn')?.click()
  await settle()
  scenarios['learn-toggles-back-off'] = lastChange()?.profileLearn === 0 && pressed('Learn') === 'false'
  key(slider('Reduction'), 'ArrowUp')
  scenarios['reduction-writes-its-param'] = lastChange()?.noiseReduction === 0.01 && panel.overrides.at(-1) === 'spectral.noiseReduction'
  scenarios['noise-floor-defaults-to-minus-30-db'] = valueText('Floor') === '-30.0 dB'
  key(slider('Floor'), 'ArrowUp')
  scenarios['noise-floor-writes-its-param'] = lastChange()?.noiseFloorDb === -29.9 && panel.overrides.at(-1) === 'spectral.noiseFloorDb'
  key(slider('Dry/Wet'), 'ArrowUp')
  scenarios['dry-wet-writes-its-param'] = lastChange()?.mix === 1 && panel.overrides.at(-1) === 'spectral.mix'
  key(slider('Dry/Wet'), 'ArrowDown')
  scenarios['dry-wet-moves-down-from-full'] = lastChange()?.mix === 0.99

  const fields = ['noiseReduction', 'noiseFloorDb', 'mix']
  scenarios['no-knob-shows-automation-without-an-envelope'] = panel.dotted().length === 0
  panel.setRanges(new Map(fields.map((field) => [`spectral.${field}`, { min: 0, max: 1 }])))
  await settle()
  scenarios['automated-knobs-show-their-automation'] = JSON.stringify(panel.dotted().sort()) === JSON.stringify(['Reduction', 'Floor', 'Dry/Wet'].sort())



  publishScenarios(scenarios)
}

void run().catch((error) => { Object.assign(window, { __browserFixtureError: String(error) }) })
