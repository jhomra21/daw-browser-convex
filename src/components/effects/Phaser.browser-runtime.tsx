import { createDefaultPhaserParams } from '@daw-browser/shared'

import Phaser from '~/components/effects/Phaser'
import { mountModulationPanel, publishScenarios, settle } from '~/test-support/modulation-panel-fixture'

const run = async () => {
  const scenarios: Record<string, boolean> = {}

  const panel = await mountModulationPanel(createDefaultPhaserParams(), 360, (state) => (
    <Phaser params={state.params()} onChange={state.onChange} onToggleEnabled={() => {}} onReset={() => {}} automationRangesByParameterId={state.ranges()} onManualAutomationOverride={state.onOverride} />
  ))

  const { named, slider, valueText, pressed, lastChange, key } = panel

  const layout = panel.layout()

  scenarios['the-panel-stays-360-px-wide-and-fits-the-device'] = layout.width === 360 && layout.fits
  scenarios['no-label-or-value-is-wider-than-its-box'] = layout.clipped
  scenarios['no-label-or-value-crowds-another-control'] = layout.crowded
  scenarios['every-control-has-an-accessible-name'] = panel.everyControlIsNamed()
  scenarios['every-enabled-control-shows-a-focus-ring'] = panel.everyEnabledControlShowsAFocusRing()

  scenarios['the-defaults-read-as-the-device-defaults'] = pressed('6 stages') === 'true' && pressed('4 stages') === 'false' && pressed('8 stages') === 'false' && pressed('12 stages') === 'false'
    && named('Waveform')?.textContent?.trim() === 'Sine' && pressed('Safe Bass') === 'false'
    && valueText('Center') === '1.00 kHz' && valueText('Depth') === '3.00 oct' && valueText('Rate') === '0.30 Hz' && valueText('Feedback') === '30%'
    && valueText('Phase') === '180°' && valueText('Spread') === '0.00 oct' && valueText('Blend') === '0%' && valueText('Output') === '0.0 dB' && valueText('Dry/Wet') === '50%'
  scenarios['safe-bass-off-has-no-frequency-knob'] = slider('Bass Freq') === null

  for (const stages of [4, 8, 12, 6]) named(`${stages} stages`)?.click()
  await settle()
  scenarios['the-stage-buttons-write-the-count-and-exclude-each-other'] = panel.changes.map((change) => change.stages).join() === '4,8,12,6' && pressed('6 stages') === 'true' && pressed('12 stages') === 'false' && pressed('4 stages') === 'false'

  key(slider('Center'), 'ArrowUp')
  scenarios['center-writes-its-param-and-reports-a-manual-override'] = lastChange()?.centerHz === 1001 && panel.overrides.at(-1) === 'phaser.centerHz'
  key(slider('Depth'), 'ArrowUp')
  scenarios['depth-writes-its-param'] = lastChange()?.depthOctaves === 3.01 && panel.overrides.at(-1) === 'phaser.depthOctaves'
  key(slider('Rate'), 'ArrowUp')
  scenarios['rate-writes-its-param'] = (lastChange()?.rateHz ?? 0) > 0.3 && panel.overrides.at(-1) === 'phaser.rateHz'
  key(slider('Feedback'), 'ArrowUp')
  scenarios['feedback-writes-its-param'] = lastChange()?.feedback === 0.31 && panel.overrides.at(-1) === 'phaser.feedback'
  key(slider('Phase'), 'ArrowDown')
  scenarios['phase-writes-its-param'] = lastChange()?.stereoPhase === 0.49 && panel.overrides.at(-1) === 'phaser.stereoPhase'
  key(slider('Spread'), 'ArrowUp')
  scenarios['spread-writes-its-param'] = lastChange()?.spreadOctaves === 0.01 && panel.overrides.at(-1) === 'phaser.spreadOctaves'
  key(slider('Blend'), 'ArrowUp')
  scenarios['blend-writes-its-param'] = lastChange()?.blend === 0.01 && panel.overrides.at(-1) === 'phaser.blend'
  key(slider('Output'), 'ArrowUp')
  scenarios['output-writes-its-param'] = lastChange()?.outputDb === 0.1 && panel.overrides.at(-1) === 'phaser.outputDb'
  key(slider('Dry/Wet'), 'ArrowUp')
  scenarios['dry-wet-writes-its-param'] = lastChange()?.mix === 0.51 && panel.overrides.at(-1) === 'phaser.mix'
  await settle()
  scenarios['the-knobs-read-the-values-they-wrote'] = valueText('Center') === '1.00 kHz' && valueText('Depth') === '3.01 oct' && valueText('Feedback') === '31%' && valueText('Phase') === '176°' && valueText('Spread') === '0.01 oct' && valueText('Blend') === '1%' && valueText('Dry/Wet') === '51%'

  await panel.choose('Waveform', 'Sample & Hold')
  scenarios['the-waveform-chooser-writes-the-waveform'] = lastChange()?.waveform === 'sampleHold' && named('Waveform')?.textContent?.trim() === 'Sample & Hold'

  named('Safe Bass')?.click()
  await settle()
  scenarios['safe-bass-writes-the-flag-and-shows-its-frequency'] = lastChange()?.safeBass === true && pressed('Safe Bass') === 'true' && valueText('Bass Freq') === '100 Hz'
  key(slider('Bass Freq'), 'ArrowUp')
  scenarios['the-bass-frequency-writes-its-param'] = lastChange()?.safeBassHz === 101 && panel.overrides.at(-1) === 'phaser.safeBassHz'
  const full = panel.layout()
  scenarios['every-control-visible-still-fits'] = full.width === 360 && full.fits && full.clipped && full.crowded

  const fields = ['centerHz', 'depthOctaves', 'rateHz', 'feedback', 'stereoPhase', 'spreadOctaves', 'blend', 'safeBassHz', 'outputDb', 'mix']
  scenarios['no-knob-shows-automation-without-an-envelope'] = panel.dotted().length === 0
  panel.setRanges(new Map(fields.map((field) => [`phaser.${field}`, { min: 0, max: 1 }])))
  await settle()
  scenarios['every-automatable-knob-shows-its-automation'] = JSON.stringify(panel.dotted().sort()) === JSON.stringify(['Center', 'Depth', 'Rate', 'Feedback', 'Phase', 'Spread', 'Blend', 'Bass Freq', 'Output', 'Dry/Wet'].sort())

  publishScenarios(scenarios)
}

void run().catch((error) => { Object.assign(window, { __browserFixtureError: String(error) }) })
