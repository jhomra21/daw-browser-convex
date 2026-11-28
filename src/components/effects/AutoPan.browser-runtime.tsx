import { createDefaultAutoPanParams } from '@daw-browser/shared'

import AutoPan from '~/components/effects/AutoPan'
import { mountModulationPanel, publishScenarios, settle } from '~/test-support/modulation-panel-fixture'

const run = async () => {
  const scenarios: Record<string, boolean> = {}

  const panel = await mountModulationPanel(createDefaultAutoPanParams(), 300, (state) => (
    <AutoPan params={state.params()} onChange={state.onChange} onToggleEnabled={() => {}} onReset={() => {}} automationRangesByParameterId={state.ranges()} onManualAutomationOverride={state.onOverride} />
  ))

  const { named, slider, valueText, pressed, lastChange, key } = panel

  const layout = panel.layout()

  scenarios['the-panel-stays-300-px-wide-and-fits-the-device'] = layout.width === 300 && layout.fits
  scenarios['no-label-or-value-is-wider-than-its-box'] = layout.clipped
  scenarios['no-label-or-value-crowds-another-control'] = layout.crowded
  scenarios['every-control-has-an-accessible-name'] = panel.everyControlIsNamed()
  scenarios['every-enabled-control-shows-a-focus-ring'] = panel.everyEnabledControlShowsAFocusRing()

  scenarios['the-defaults-read-as-the-device-defaults'] = named('Waveform')?.textContent?.trim() === 'Sine' && pressed('Invert') === 'false' && pressed('Sync') === 'false'
    && valueText('Rate') === '1.00 Hz' && valueText('Depth') === '100%' && valueText('Shape') === '50%' && valueText('Phase') === '180°'
  scenarios['free-rate-has-no-division-chooser'] = named('Rate division') === undefined && slider('Offset') === null

  key(slider('Rate'), 'ArrowUp')
  scenarios['rate-writes-its-param-and-reports-a-manual-override'] = (lastChange()?.rateHz ?? 0) > 1 && panel.overrides.at(-1) === 'autopan.rateHz'
  key(slider('Depth'), 'ArrowDown')
  scenarios['depth-writes-its-param'] = lastChange()?.depth === 0.99 && panel.overrides.at(-1) === 'autopan.depth'
  key(slider('Shape'), 'ArrowUp')
  scenarios['shape-writes-its-param'] = lastChange()?.['shape'] === 0.51 && panel.overrides.at(-1) === 'autopan.shape'
  key(slider('Phase'), 'ArrowDown')
  scenarios['phase-writes-its-param'] = lastChange()?.stereoPhase === 0.49 && panel.overrides.at(-1) === 'autopan.stereoPhase'
  await settle()
  scenarios['the-knobs-read-the-values-they-wrote-in-degrees-and-percent'] = valueText('Depth') === '99%' && valueText('Shape') === '51%' && valueText('Phase') === '176°'

  await panel.choose('Waveform', 'Sample & Hold')
  scenarios['the-waveform-chooser-writes-the-waveform'] = lastChange()?.waveform === 'sampleHold' && named('Waveform')?.textContent?.trim() === 'Sample & Hold'
  named('Invert')?.click()
  await settle()
  scenarios['invert-writes-the-flag'] = lastChange()?.invert === true && pressed('Invert') === 'true'

  const fields = ['rateHz', 'depth', 'shape', 'stereoPhase', 'phase']
  scenarios['no-knob-shows-automation-without-an-envelope'] = panel.dotted().length === 0
  panel.setRanges(new Map(fields.map((field) => [`autopan.${field}`, { min: 0, max: 1 }])))
  await settle()
  scenarios['every-automatable-knob-shows-its-automation'] = JSON.stringify(panel.dotted().sort()) === JSON.stringify(['Rate', 'Depth', 'Shape', 'Phase'].sort())

  // Synced to the tempo the LFO runs at a note division, so the free Rate knob is replaced by the division chooser.
  named('Sync')?.click()
  await settle()
  scenarios['sync-writes-the-flag-and-swaps-the-rate-knob-for-a-division'] = lastChange()?.sync === true && pressed('Sync') === 'true' && slider('Rate') === null && named('Rate division')?.textContent?.trim() === '1/4'
  await panel.choose('Rate division', '1/8T')
  scenarios['the-division-chooser-writes-its-index'] = lastChange()?.division === 9 && named('Rate division')?.textContent?.trim() === '1/8T'
  key(slider('Offset'), 'ArrowUp')
  scenarios['offset-writes-its-param'] = lastChange()?.phase === 0.01 && panel.overrides.at(-1) === 'autopan.phase'
  await settle()
  const synced = panel.layout()
  scenarios['synced-still-fits'] = synced.width === 300 && synced.fits && synced.clipped && synced.crowded
  scenarios['synced-automation-shows-on-the-remaining-knobs'] = JSON.stringify(panel.dotted().sort()) === JSON.stringify(['Depth', 'Shape', 'Phase', 'Offset'].sort())
  named('Sync')?.click()
  await settle()
  scenarios['sync-off-brings-the-rate-knob-back'] = lastChange()?.sync === false && slider('Rate') !== null && named('Rate division') === undefined && slider('Offset') === null

  publishScenarios(scenarios)
}

void run().catch((error) => { Object.assign(window, { __browserFixtureError: String(error) }) })
