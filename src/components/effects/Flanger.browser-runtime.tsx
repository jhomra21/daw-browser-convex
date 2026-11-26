import { createDefaultFlangerParams } from '@daw-browser/shared'

import Flanger from '~/components/effects/Flanger'
import { mountModulationPanel, publishScenarios, settle } from '~/test-support/modulation-panel-fixture'

const run = async () => {
  const scenarios: Record<string, boolean> = {}

  const panel = await mountModulationPanel(createDefaultFlangerParams(), 360, (state) => (
    <Flanger params={state.params()} onChange={state.onChange} onToggleEnabled={() => {}} onReset={() => {}} automationRangesByParameterId={state.ranges()} onManualAutomationOverride={state.onOverride} />
  ))

  const { named, slider, valueText, pressed, lastChange, key } = panel

  const layout = panel.layout()

  scenarios['the-panel-stays-360-px-wide-and-fits-the-device'] = layout.width === 360 && layout.fits
  scenarios['no-label-or-value-is-wider-than-its-box'] = layout.clipped
  scenarios['no-label-or-value-crowds-another-control'] = layout.crowded
  scenarios['every-control-has-an-accessible-name'] = panel.everyControlIsNamed()
  scenarios['every-enabled-control-shows-a-focus-ring'] = panel.everyEnabledControlShowsAFocusRing()

  scenarios['the-defaults-read-as-the-device-defaults'] = pressed('Flanger') === 'true' && pressed('Through-Zero') === 'false' && named('Waveform')?.textContent?.trim() === 'Sine' && pressed('Safe Bass') === 'false'
    && valueText('Delay') === '1.5 ms' && valueText('Depth') === '1.0 ms' && valueText('Rate') === '0.20 Hz' && valueText('Feedback') === '35%'
    && valueText('Phase') === '180°' && valueText('Width') === '100%' && valueText('Output') === '0.0 dB' && valueText('Dry/Wet') === '50%'
  scenarios['safe-bass-off-has-no-frequency-knob'] = slider('Bass Freq') === null

  key(slider('Delay'), 'ArrowUp')
  scenarios['delay-writes-its-param-and-reports-a-manual-override'] = lastChange()?.delayMs === 1.6 && panel.overrides.at(-1) === 'flanger.delayMs'
  key(slider('Depth'), 'ArrowUp')
  scenarios['depth-writes-its-param'] = lastChange()?.depthMs === 1.1 && panel.overrides.at(-1) === 'flanger.depthMs'
  key(slider('Rate'), 'ArrowUp')
  scenarios['rate-writes-its-param'] = (lastChange()?.rateHz ?? 0) > 0.2 && panel.overrides.at(-1) === 'flanger.rateHz'
  key(slider('Feedback'), 'ArrowDown')
  scenarios['feedback-writes-its-param'] = lastChange()?.feedback === 0.34 && panel.overrides.at(-1) === 'flanger.feedback'
  key(slider('Phase'), 'ArrowDown')
  scenarios['phase-writes-its-param-and-reads-degrees'] = lastChange()?.stereoPhase === 0.49 && panel.overrides.at(-1) === 'flanger.stereoPhase'
  key(slider('Width'), 'ArrowDown')
  scenarios['width-writes-its-param'] = lastChange()?.width === 0.99 && panel.overrides.at(-1) === 'flanger.width'
  key(slider('Output'), 'ArrowUp')
  scenarios['output-writes-its-param'] = lastChange()?.outputDb === 0.1 && panel.overrides.at(-1) === 'flanger.outputDb'
  key(slider('Dry/Wet'), 'ArrowUp')
  scenarios['dry-wet-writes-its-param'] = lastChange()?.mix === 0.51 && panel.overrides.at(-1) === 'flanger.mix'
  await settle()
  scenarios['the-knobs-read-the-values-they-wrote'] = valueText('Delay') === '1.6 ms' && valueText('Feedback') === '34%' && valueText('Phase') === '176°' && valueText('Width') === '99%' && valueText('Output') === '0.1 dB' && valueText('Dry/Wet') === '51%'

  await panel.choose('Waveform', 'Saw Up')
  scenarios['the-waveform-chooser-writes-the-waveform'] = lastChange()?.waveform === 'sawUp' && named('Waveform')?.textContent?.trim() === 'Saw Up'

  // Through-Zero keeps every control: its Delay and Depth are measured from the delayed dry path.
  named('Through-Zero')?.click()
  await settle()
  scenarios['through-zero-writes-the-mode-and-excludes-flanger'] = lastChange()?.mode === 'throughZero' && pressed('Through-Zero') === 'true' && pressed('Flanger') === 'false' && slider('Feedback') !== null && slider('Dry/Wet') !== null
  named('Flanger')?.click()
  await settle()
  scenarios['flanger-writes-the-mode-back'] = lastChange()?.mode === 'flanger' && pressed('Flanger') === 'true' && pressed('Through-Zero') === 'false'

  named('Safe Bass')?.click()
  await settle()
  scenarios['safe-bass-writes-the-flag-and-shows-its-frequency'] = lastChange()?.safeBass === true && pressed('Safe Bass') === 'true' && valueText('Bass Freq') === '100 Hz'
  key(slider('Bass Freq'), 'ArrowUp')
  scenarios['the-bass-frequency-writes-its-param'] = lastChange()?.safeBassHz === 101 && panel.overrides.at(-1) === 'flanger.safeBassHz'
  const full = panel.layout()
  scenarios['every-control-visible-still-fits'] = full.width === 360 && full.fits && full.clipped && full.crowded

  const fields = ['delayMs', 'depthMs', 'rateHz', 'feedback', 'stereoPhase', 'width', 'safeBassHz', 'outputDb', 'mix']
  scenarios['no-knob-shows-automation-without-an-envelope'] = panel.dotted().length === 0
  panel.setRanges(new Map(fields.map((field) => [`flanger.${field}`, { min: 0, max: 1 }])))
  await settle()
  scenarios['every-automatable-knob-shows-its-automation'] = JSON.stringify(panel.dotted().sort()) === JSON.stringify(['Delay', 'Depth', 'Rate', 'Feedback', 'Phase', 'Width', 'Bass Freq', 'Output', 'Dry/Wet'].sort())

  publishScenarios(scenarios)
}

void run().catch((error) => { Object.assign(window, { __browserFixtureError: String(error) }) })
