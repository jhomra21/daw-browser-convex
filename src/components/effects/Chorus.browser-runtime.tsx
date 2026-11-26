import { createDefaultChorusParams } from '@daw-browser/shared'

import Chorus from '~/components/effects/Chorus'
import { mountModulationPanel, publishScenarios, settle } from '~/test-support/modulation-panel-fixture'

const run = async () => {
  const scenarios: Record<string, boolean> = {}

  const panel = await mountModulationPanel(createDefaultChorusParams(), 360, (state) => (
    <Chorus params={state.params()} onChange={state.onChange} onToggleEnabled={() => {}} onReset={() => {}} automationRangesByParameterId={state.ranges()} onManualAutomationOverride={state.onOverride} />
  ))

  const { named, slider, valueText, pressed, lastChange, key } = panel

  const layout = panel.layout()

  scenarios['the-panel-stays-360-px-wide-and-fits-the-device'] = layout.width === 360 && layout.fits
  scenarios['no-label-or-value-is-wider-than-its-box'] = layout.clipped
  scenarios['no-label-or-value-crowds-another-control'] = layout.crowded
  scenarios['every-control-has-an-accessible-name'] = panel.everyControlIsNamed()
  scenarios['every-enabled-control-shows-a-focus-ring'] = panel.everyEnabledControlShowsAFocusRing()

  scenarios['the-defaults-read-as-the-device-defaults'] = pressed('Chorus') === 'true' && pressed('Vibrato') === 'false' && pressed('Vintage') === 'false'
    && named('Waveform')?.textContent?.trim() === 'Sine' && pressed('Safe Bass') === 'false'
    && valueText('Delay') === '12.0 ms' && valueText('Depth') === '4.0 ms' && valueText('Rate') === '0.80 Hz' && valueText('Feedback') === '0%'
    && valueText('Phase') === '90°' && valueText('Width') === '100%' && valueText('Output') === '0.0 dB' && valueText('Dry/Wet') === '35%'
  scenarios['safe-bass-off-has-no-frequency-knob'] = slider('Bass Freq') === null

  key(slider('Delay'), 'ArrowUp')
  scenarios['delay-writes-its-param-and-reports-a-manual-override'] = lastChange()?.delayMs === 12.1 && panel.overrides.at(-1) === 'chorus.delayMs'
  key(slider('Depth'), 'ArrowUp')
  scenarios['depth-writes-its-param'] = lastChange()?.depthMs === 4.1 && panel.overrides.at(-1) === 'chorus.depthMs'
  key(slider('Rate'), 'ArrowUp')
  scenarios['rate-writes-its-param'] = (lastChange()?.rateHz ?? 0) > 0.8 && panel.overrides.at(-1) === 'chorus.rateHz'
  key(slider('Feedback'), 'ArrowUp')
  scenarios['feedback-writes-its-param'] = lastChange()?.feedback === 0.01 && panel.overrides.at(-1) === 'chorus.feedback'
  key(slider('Phase'), 'ArrowUp')
  scenarios['phase-writes-its-param-and-reads-degrees'] = lastChange()?.stereoPhase === 0.26 && panel.overrides.at(-1) === 'chorus.stereoPhase'
  key(slider('Width'), 'ArrowUp')
  scenarios['width-writes-its-param'] = lastChange()?.width === 1.01 && panel.overrides.at(-1) === 'chorus.width'
  key(slider('Output'), 'ArrowUp')
  scenarios['output-writes-its-param'] = lastChange()?.outputDb === 0.1 && panel.overrides.at(-1) === 'chorus.outputDb'
  key(slider('Dry/Wet'), 'ArrowUp')
  scenarios['dry-wet-writes-its-param'] = lastChange()?.mix === 0.36 && panel.overrides.at(-1) === 'chorus.mix'
  await settle()
  scenarios['the-knobs-read-the-values-they-wrote'] = valueText('Delay') === '12.1 ms' && valueText('Width') === '101%' && valueText('Output') === '0.1 dB' && valueText('Dry/Wet') === '36%'

  await panel.choose('Waveform', 'Wander')
  scenarios['the-waveform-chooser-writes-the-waveform'] = lastChange()?.waveform === 'wander' && named('Waveform')?.textContent?.trim() === 'Wander'

  named('Vintage')?.click()
  await settle()
  scenarios['vintage-writes-the-mode-and-keeps-the-other-controls'] = lastChange()?.mode === 'vintage' && pressed('Vintage') === 'true' && pressed('Chorus') === 'false' && slider('Feedback') !== null && slider('Dry/Wet') !== null

  // Vibrato is the wet signal alone with no feedback, so those two controls disappear and come back with another mode.
  named('Vibrato')?.click()
  await settle()
  scenarios['vibrato-writes-the-mode-and-hides-feedback-and-dry-wet'] = lastChange()?.mode === 'vibrato' && pressed('Vibrato') === 'true' && slider('Feedback') === null && slider('Dry/Wet') === null && slider('Delay') !== null && slider('Output') !== null
  const vibrato = panel.layout()
  scenarios['vibrato-still-fits'] = vibrato.fits && vibrato.clipped && vibrato.crowded
  named('Chorus')?.click()
  await settle()
  scenarios['chorus-brings-feedback-and-dry-wet-back'] = lastChange()?.mode === 'chorus' && slider('Feedback') !== null && slider('Dry/Wet') !== null

  named('Safe Bass')?.click()
  await settle()
  scenarios['safe-bass-writes-the-flag-and-shows-its-frequency'] = lastChange()?.safeBass === true && pressed('Safe Bass') === 'true' && valueText('Bass Freq') === '100 Hz'
  key(slider('Bass Freq'), 'ArrowUp')
  scenarios['the-bass-frequency-writes-its-param'] = lastChange()?.safeBassHz === 101 && panel.overrides.at(-1) === 'chorus.safeBassHz'
  const full = panel.layout()
  scenarios['every-control-visible-still-fits'] = full.width === 360 && full.fits && full.clipped && full.crowded

  const automatable = ['Delay', 'Depth', 'Rate', 'Feedback', 'Phase', 'Width', 'Bass Freq', 'Output', 'Dry/Wet']
  scenarios['no-knob-shows-automation-without-an-envelope'] = panel.dotted().length === 0
  panel.setRanges(new Map(['delayMs', 'depthMs', 'rateHz', 'feedback', 'stereoPhase', 'width', 'safeBassHz', 'outputDb', 'mix'].map((field) => [`chorus.${field}`, { min: 0, max: 1 }])))
  await settle()
  scenarios['every-automatable-knob-shows-its-automation'] = JSON.stringify(panel.dotted().sort()) === JSON.stringify([...automatable].sort())

  publishScenarios(scenarios)
}

void run().catch((error) => { Object.assign(window, { __browserFixtureError: String(error) }) })
