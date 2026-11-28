import { createDefaultLoFiParams } from '@daw-browser/shared'

import LoFi from '~/components/effects/LoFi'
import { mountModulationPanel, publishScenarios, settle } from '~/test-support/modulation-panel-fixture'

const run = async () => {
  const scenarios: Record<string, boolean> = {}

  const panel = await mountModulationPanel(createDefaultLoFiParams(), 400, (state) => (
    <LoFi params={state.params()} onChange={state.onChange} onToggleEnabled={() => {}} onReset={() => {}} automationRangesByParameterId={state.ranges()} onManualAutomationOverride={state.onOverride} />
  ))

  const { named, slider, valueText, pressed, lastChange, key, choose } = panel
  const names = () => panel.sliderNames().join()
  const sliderBefore = slider('Rate')
  const noiseBefore = slider('Noise')
  const quantizer = named('Quantizer')

  const base = panel.layout()
  scenarios['the-panel-stays-400-px-wide-and-fits-the-device'] = base.width === 400 && base.fits
  scenarios['no-label-or-value-is-wider-than-its-box'] = base.clipped
  scenarios['no-label-or-value-crowds-another-control'] = base.crowded
  scenarios['every-control-has-an-accessible-name'] = panel.everyControlIsNamed()
  scenarios['every-enabled-control-shows-a-focus-ring'] = panel.everyEnabledControlShowsAFocusRing()

  scenarios['the-defaults-read-as-the-transparent-device'] = valueText('Rate') === '96.00 kHz' && valueText('Bits') === '16 bit' && valueText('Jitter') === '0%'
    && valueText('Noise') === '-120.0 dB' && valueText('Dry/Wet') === '100%' && named('Quantizer')?.textContent?.trim() === 'Round' && named('Dither')?.textContent?.trim() === 'Triangular'
    && pressed('Pre Filter') === 'false' && pressed('Post Filter') === 'false' && pressed('Sub-sample clock') === 'false'
  scenarios['round-has-no-dc-fix'] = names() === 'Rate,Jitter,Bits,Noise,Dry/Wet' && named('Floor DC Fix') === undefined

  key(slider('Rate'), 'ArrowDown')
  scenarios['rate-writes-hz-and-reports-a-manual-override'] = (lastChange()?.sampleRateHz ?? 96000) < 96000 && panel.overrides.at(-1) === 'lofi.sampleRateHz'
  key(slider('Bits'), 'ArrowDown')
  scenarios['bits-write-a-whole-number'] = lastChange()?.bitDepth === 15 && panel.overrides.at(-1) === 'lofi.bitDepth'
  key(slider('Jitter'), 'ArrowUp')
  key(slider('Noise'), 'ArrowUp')
  key(slider('Dry/Wet'), 'ArrowDown')
  scenarios['jitter-noise-and-dry-wet-write-their-params'] = panel.changes.some((change) => change.jitter === 0.01) && panel.changes.some((change) => change.noiseDb === -119.9) && lastChange()?.mix === 0.99
    && panel.overrides.slice(-3).join() === 'lofi.jitter,lofi.noiseDb,lofi.mix'
  await settle()
  scenarios['a-value-change-keeps-the-same-knobs-and-choosers'] = slider('Rate') === sliderBefore && slider('Noise') === noiseBefore && named('Quantizer') === quantizer
    && valueText('Bits') === '15 bit' && valueText('Dry/Wet') === '99%'

  named('Pre Filter')?.click()
  named('Post Filter')?.click()
  named('Sub-sample clock')?.click()
  await settle()
  scenarios['the-toggles-write-their-flags'] = panel.changes.some((change) => change.preFilter === true) && panel.changes.some((change) => change.postFilter === true) && lastChange()?.subSampleClock === true
    && pressed('Pre Filter') === 'true' && pressed('Post Filter') === 'true' && pressed('Sub-sample clock') === 'true'

  await choose('Dither', 'Rectangular')
  scenarios['the-dither-chooser-writes-the-dither'] = lastChange()?.dither === 'rectangular' && named('Dither')?.textContent?.trim() === 'Rectangular'
  await choose('Quantizer', 'Truncate')
  scenarios['truncate-has-no-dc-fix'] = lastChange()?.quantization === 'truncate' && named('Floor DC Fix') === undefined
  await choose('Quantizer', 'Floor')
  scenarios['floor-adds-dc-fix'] = lastChange()?.quantization === 'floor' && pressed('Floor DC Fix') === 'false'
  named('Floor DC Fix')?.click()
  await settle()
  scenarios['dc-fix-writes-its-flag'] = lastChange()?.dcCorrection === true && pressed('Floor DC Fix') === 'true'
  const floor = panel.layout()
  scenarios['floor-still-fits'] = floor.width === 400 && floor.fits && floor.clipped && floor.crowded
  scenarios['a-quantizer-change-keeps-the-same-knobs'] = slider('Rate') === sliderBefore && named('Quantizer') === quantizer

  const fields = ['sampleRateHz', 'bitDepth', 'jitter', 'noiseDb', 'mix']
  scenarios['no-knob-shows-automation-without-an-envelope'] = panel.dotted().length === 0
  panel.setRanges(new Map(fields.map((field) => [`lofi.${field}`, { min: 0, max: 1 }])))
  await settle()
  scenarios['every-automatable-knob-shows-its-automation'] = JSON.stringify(panel.dotted().sort()) === JSON.stringify(['Rate', 'Bits', 'Jitter', 'Noise', 'Dry/Wet'].sort())

  publishScenarios(scenarios)
}

void run().catch((error) => { Object.assign(window, { __browserFixtureError: String(error) }) })
