import { createDefaultEnsembleParams } from '@daw-browser/shared'

import Ensemble from '~/components/effects/Ensemble'
import { mountModulationPanel, publishScenarios, settle } from '~/test-support/modulation-panel-fixture'

const run = async () => {
  const scenarios: Record<string, boolean> = {}

  const panel = await mountModulationPanel(createDefaultEnsembleParams(), 380, (state) => (
    <Ensemble params={state.params()} onChange={state.onChange} onToggleEnabled={() => {}} onReset={() => {}} automationRangesByParameterId={state.ranges()} onManualAutomationOverride={state.onOverride} />
  ))

  const { named, slider, valueText, pressed, lastChange, key } = panel

  const layout = panel.layout()

  scenarios['the-panel-stays-380-px-wide-and-fits-the-device'] = layout.width === 380 && layout.fits
  scenarios['no-label-or-value-is-wider-than-its-box'] = layout.clipped
  scenarios['no-label-or-value-crowds-another-control'] = layout.crowded
  scenarios['every-control-has-an-accessible-name'] = panel.everyControlIsNamed()
  scenarios['every-enabled-control-shows-a-focus-ring'] = panel.everyEnabledControlShowsAFocusRing()

  scenarios['the-defaults-read-as-the-device-defaults'] = named('Waveform')?.textContent?.trim() === 'Sine' && pressed('Safe Bass') === 'false'
    && valueText('Delay') === '18.0 ms' && valueText('Depth') === '6.0 ms' && valueText('Rate') === '0.60 Hz' && valueText('Spread') === '100%'
    && valueText('Fast Depth') === '0.0 ms' && valueText('Width') === '100%' && valueText('Output') === '0.0 dB' && valueText('Dry/Wet') === '50%'
  scenarios['safe-bass-off-has-no-frequency-knob'] = slider('Bass Freq') === null
  // The fast LFO is silent at zero depth, so Fast Rate only exists once Fast Depth is up.
  scenarios['fast-rate-is-hidden-at-zero-fast-depth'] = slider('Fast Rate') === null

  key(slider('Delay'), 'ArrowUp')
  scenarios['delay-writes-its-param-and-reports-a-manual-override'] = lastChange()?.delayMs === 18.1 && panel.overrides.at(-1) === 'ensemble.delayMs'
  key(slider('Depth'), 'ArrowUp')
  scenarios['depth-writes-its-param'] = lastChange()?.depthMs === 6.1 && panel.overrides.at(-1) === 'ensemble.depthMs'
  key(slider('Rate'), 'ArrowUp')
  scenarios['rate-writes-its-param'] = (lastChange()?.rateHz ?? 0) > 0.6 && panel.overrides.at(-1) === 'ensemble.rateHz'
  key(slider('Spread'), 'ArrowDown')
  scenarios['spread-writes-its-param'] = lastChange()?.spread === 0.99 && panel.overrides.at(-1) === 'ensemble.spread'
  key(slider('Width'), 'ArrowUp')
  scenarios['width-writes-its-param'] = lastChange()?.width === 1.01 && panel.overrides.at(-1) === 'ensemble.width'
  key(slider('Output'), 'ArrowUp')
  scenarios['output-writes-its-param'] = lastChange()?.outputDb === 0.1 && panel.overrides.at(-1) === 'ensemble.outputDb'
  key(slider('Dry/Wet'), 'ArrowUp')
  scenarios['dry-wet-writes-its-param'] = lastChange()?.mix === 0.51 && panel.overrides.at(-1) === 'ensemble.mix'
  await settle()
  scenarios['the-knobs-read-the-values-they-wrote'] = valueText('Delay') === '18.1 ms' && valueText('Spread') === '99%' && valueText('Width') === '101%' && valueText('Output') === '0.1 dB' && valueText('Dry/Wet') === '51%'

  key(slider('Fast Depth'), 'ArrowUp')
  await settle()
  scenarios['fast-depth-writes-its-param-and-shows-the-fast-rate'] = lastChange()?.fastDepthMs === 0.1 && panel.overrides.at(-1) === 'ensemble.fastDepthMs' && valueText('Fast Rate') === '6.00 Hz'
  key(slider('Fast Rate'), 'ArrowUp')
  scenarios['fast-rate-writes-its-param'] = (lastChange()?.fastRateHz ?? 0) > 6 && panel.overrides.at(-1) === 'ensemble.fastRateHz'
  key(slider('Fast Depth'), 'ArrowDown')
  await settle()
  scenarios['fast-rate-hides-again-at-zero-fast-depth'] = slider('Fast Rate') === null
  key(slider('Fast Depth'), 'ArrowUp')
  await settle()

  await panel.choose('Waveform', 'Square')
  scenarios['the-waveform-chooser-writes-the-waveform'] = lastChange()?.waveform === 'square' && named('Waveform')?.textContent?.trim() === 'Square'

  named('Safe Bass')?.click()
  await settle()
  scenarios['safe-bass-writes-the-flag-and-shows-its-frequency'] = lastChange()?.safeBass === true && pressed('Safe Bass') === 'true' && valueText('Bass Freq') === '100 Hz'
  key(slider('Bass Freq'), 'ArrowUp')
  scenarios['the-bass-frequency-writes-its-param'] = lastChange()?.safeBassHz === 101 && panel.overrides.at(-1) === 'ensemble.safeBassHz'
  const full = panel.layout()
  scenarios['every-control-visible-still-fits'] = full.width === 380 && full.fits && full.clipped && full.crowded

  const fields = ['delayMs', 'depthMs', 'rateHz', 'spread', 'fastDepthMs', 'fastRateHz', 'width', 'safeBassHz', 'outputDb', 'mix']
  scenarios['no-knob-shows-automation-without-an-envelope'] = panel.dotted().length === 0
  panel.setRanges(new Map(fields.map((field) => [`ensemble.${field}`, { min: 0, max: 1 }])))
  await settle()
  scenarios['every-automatable-knob-shows-its-automation'] = JSON.stringify(panel.dotted().sort()) === JSON.stringify(['Delay', 'Depth', 'Rate', 'Spread', 'Fast Depth', 'Fast Rate', 'Width', 'Bass Freq', 'Output', 'Dry/Wet'].sort())

  publishScenarios(scenarios)
}

void run().catch((error) => { Object.assign(window, { __browserFixtureError: String(error) }) })
