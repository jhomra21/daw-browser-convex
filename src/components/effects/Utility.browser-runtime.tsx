import { createDefaultUtilityParams } from '@daw-browser/shared'

import Utility from '~/components/effects/Utility'
import { mountModulationPanel, publishScenarios, settle } from '~/test-support/modulation-panel-fixture'

const run = async () => {
  const scenarios: Record<string, boolean> = {}

  const panel = await mountModulationPanel(createDefaultUtilityParams(), 420, (state) => (
    <Utility params={state.params()} onChange={state.onChange} onToggleEnabled={() => {}} onReset={() => {}} automationRangesByParameterId={state.ranges()} onManualAutomationOverride={state.onOverride} />
  ))

  const { named, slider, valueText, pressed, lastChange, key, choose } = panel
  const names = () => panel.sliderNames().join()
  const gainKnob = slider('Gain')
  const channelMode = named('Channel Mode')

  const base = panel.layout()
  scenarios['the-panel-stays-420-px-wide-and-fits-the-device'] = base.width === 420 && base.fits
  scenarios['no-label-or-value-is-wider-than-its-box'] = base.clipped
  scenarios['no-label-or-value-crowds-another-control'] = base.crowded
  scenarios['every-control-has-an-accessible-name'] = panel.everyControlIsNamed()
  scenarios['every-enabled-control-shows-a-focus-ring'] = panel.everyEnabledControlShowsAFocusRing()

  scenarios['the-defaults-read-as-the-device-defaults'] = valueText('Gain') === '0.00 dB' && valueText('Balance') === 'C' && valueText('Width') === '100%'
    && named('Channel Mode')?.textContent?.trim() === 'Stereo' && named('Matrix')?.textContent?.trim() === 'L/R'
    && ['Phase L', 'Phase R', 'Mono', 'Mid/Side mode', 'Bass Mono', 'Mute', 'DC Block'].every((name) => pressed(name) === 'false')
  scenarios['stereo-shows-width-and-no-bass-mono-controls'] = names() === 'Width,Gain,Balance' && named('Bass Mono Frequency') === undefined && named('Audition Bass Mono') === undefined

  key(slider('Gain'), 'ArrowUp')
  scenarios['gain-writes-its-param-and-reports-a-manual-override'] = lastChange()?.gainDb === 0.1 && panel.overrides.at(-1) === 'utility.gainDb'
  key(slider('Balance'), 'ArrowDown')
  scenarios['balance-writes-its-param-and-reads-in-sides'] = lastChange()?.balance === -0.01 && panel.overrides.at(-1) === 'utility.balance'
  key(slider('Width'), 'ArrowUp')
  scenarios['width-writes-its-param'] = lastChange()?.width === 1.01 && panel.overrides.at(-1) === 'utility.width'
  await settle()
  scenarios['the-knobs-read-the-values-they-wrote'] = valueText('Gain') === '+0.10 dB' && valueText('Balance') === '1L' && valueText('Width') === '101%'
  scenarios['a-value-change-keeps-the-same-knob-and-chooser'] = slider('Gain') === gainKnob && named('Channel Mode') === channelMode

  // Gain reads minus infinity at its floor, where the kernel is silent.
  for (let step = 0; step < 4; step++) key(slider('Gain'), 'Home')
  await settle()
  scenarios['gain-at-the-floor-reads-minus-infinity'] = lastChange()?.gainDb === -70 && valueText('Gain') === '-inf dB'

  named('Phase L')?.click()
  named('Phase R')?.click()
  named('Mono')?.click()
  named('Mute')?.click()
  named('DC Block')?.click()
  await settle()
  scenarios['the-toggles-write-their-flags'] = panel.changes.some((change) => change.phaseLeft === true) && panel.changes.some((change) => change.phaseRight === true)
    && panel.changes.some((change) => change.inputMode === 'mono-sum') && panel.changes.some((change) => change.mute === true) && lastChange()?.dcBlock === true
    && ['Phase L', 'Phase R', 'Mono', 'Mute', 'DC Block'].every((name) => pressed(name) === 'true')
  await choose('Matrix', 'M/S Encode')
  scenarios['the-matrix-chooser-writes-the-matrix'] = lastChange()?.matrix === 'mid-side-encode' && named('Matrix')?.textContent?.trim() === 'M/S Encode'

  // Mid/Side swaps the Width knob for the Mid/Side knob.
  named('Mid/Side mode')?.click()
  await settle()
  scenarios['mid-side-swaps-the-width-knob-for-mid-side'] = lastChange()?.widthMode === 'mid-side' && pressed('Mid/Side mode') === 'true' && slider('Width') === null && valueText('Mid/Side') === '0%' && names() === 'Mid/Side,Gain,Balance'
  key(slider('Mid/Side'), 'ArrowUp')
  scenarios['mid-side-writes-its-param-and-reports-a-manual-override'] = lastChange()?.midSide === 0.01 && panel.overrides.at(-1) === 'utility.midSide'
  named('Mid/Side mode')?.click()
  await settle()
  scenarios['mid-side-off-brings-the-width-knob-back'] = lastChange()?.widthMode === 'stereo' && slider('Mid/Side') === null && slider('Width') !== null

  // Left and Right play one channel on both outputs, so the width controls have nothing to do.
  await choose('Channel Mode', 'Left')
  scenarios['left-removes-the-width-controls'] = lastChange()?.channelMode === 'left' && names() === 'Gain,Balance' && named('Mid/Side mode') === undefined && slider('Width') === null
  await choose('Channel Mode', 'Right')
  scenarios['right-removes-the-width-controls'] = lastChange()?.channelMode === 'right' && names() === 'Gain,Balance' && named('Mid/Side mode') === undefined
  await choose('Channel Mode', 'Swap')
  scenarios['swap-keeps-the-width-controls'] = lastChange()?.channelMode === 'swap' && names() === 'Width,Gain,Balance' && named('Mid/Side mode') !== undefined
  scenarios['a-channel-mode-change-keeps-the-same-gain-knob-and-chooser'] = slider('Gain') === gainKnob && named('Channel Mode') === channelMode

  // Bass Mono shows its frequency and audition only while it is on.
  named('Bass Mono')?.click()
  await settle()
  scenarios['bass-mono-writes-the-flag-and-shows-frequency-and-audition'] = lastChange()?.bassMono === true && valueText('Bass Mono Frequency') === '120 Hz' && pressed('Audition Bass Mono') === 'false'
  key(slider('Bass Mono Frequency'), 'ArrowUp')
  scenarios['bass-mono-frequency-writes-its-param-and-reports-a-manual-override'] = (lastChange()?.bassMonoHz ?? 0) > 120 && panel.overrides.at(-1) === 'utility.bassMonoHz'
  named('Audition Bass Mono')?.click()
  await settle()
  scenarios['audition-writes-the-flag'] = lastChange()?.bassMonoAudition === true && pressed('Audition Bass Mono') === 'true'
  const bass = panel.layout()
  scenarios['bass-mono-and-width-still-fit'] = bass.width === 420 && bass.fits && bass.clipped && bass.crowded
  named('Bass Mono')?.click()
  await settle()
  scenarios['bass-mono-off-removes-frequency-and-audition'] = lastChange()?.bassMono === false && named('Bass Mono Frequency') === undefined && named('Audition Bass Mono') === undefined

  const fields = ['gainDb', 'balance', 'width', 'midSide', 'bassMonoHz']
  scenarios['no-knob-shows-automation-without-an-envelope'] = panel.dotted().length === 0
  named('Bass Mono')?.click()
  named('Mid/Side mode')?.click()
  panel.setRanges(new Map(fields.map((field) => [`utility.${field}`, { min: 0, max: 1 }])))
  await settle()
  scenarios['every-automatable-knob-shows-its-automation'] = JSON.stringify(panel.dotted().sort()) === JSON.stringify(['Gain', 'Balance', 'Mid/Side', 'Bass Mono Frequency'].sort())
  named('Mid/Side mode')?.click()
  await settle()
  scenarios['the-width-knob-shows-its-automation'] = panel.dotted().includes('Width')

  publishScenarios(scenarios)
}

void run().catch((error) => { Object.assign(window, { __browserFixtureError: String(error) }) })
