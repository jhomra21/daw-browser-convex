import { createDefaultSaturatorParams } from '@daw-browser/shared'

import Saturator from '~/components/effects/Saturator'
import { mountModulationPanel, publishScenarios, settle } from '~/test-support/modulation-panel-fixture'

const run = async () => {
  const scenarios: Record<string, boolean> = {}

  const panel = await mountModulationPanel(createDefaultSaturatorParams(), 460, (state) => (
    <Saturator params={state.params()} onChange={state.onChange} onToggleEnabled={() => {}} onReset={() => {}} automationRangesByParameterId={state.ranges()} onManualAutomationOverride={state.onOverride} />
  ))

  const { host, named, slider, valueText, pressed, lastChange, key, choose } = panel
  const names = () => panel.sliderNames().join()
  const curvePath = () => host.querySelector('.touch-none svg > path:last-of-type')?.getAttribute('d') ?? ''
  const curveYs = () => curvePath().split(/[ML] /).filter(Boolean).map((point) => Number(point.split(' ')[1]))
  const graphSvg = () => host.querySelector('.touch-none svg')
  const graph = graphSvg()
  const driveKnob = slider('Drive')
  const hiQuality = () => host.querySelector('[aria-label^="Hi-Quality"]')

  scenarios['every-control-has-an-accessible-name'] = panel.everyControlIsNamed()
  scenarios['every-enabled-control-shows-a-focus-ring'] = panel.everyEnabledControlShowsAFocusRing()
  const base = panel.layout()
  scenarios['the-panel-stays-460-px-wide-and-fits-the-device'] = base.width === 460 && base.fits
  scenarios['no-label-or-value-is-wider-than-its-box'] = base.clipped
  scenarios['no-label-or-value-crowds-another-control'] = base.crowded

  scenarios['the-defaults-read-as-the-device-defaults'] = named('Curve')?.textContent?.trim() === 'Soft' && named('Post Clip')?.textContent?.trim() === 'No Clip'
    && pressed('Color') === 'false' && hiQuality()?.getAttribute('aria-pressed') === 'true'
    && valueText('Drive') === '6.0 dB' && valueText('Output') === '0.0 dB' && valueText('Dry/Wet') === '100%'
  scenarios['soft-shows-only-drive-output-and-dry-wet'] = names() === 'Drive,Output,Dry/Wet'

  // The display is evaluateSaturatorCurvePoint at the drive: Soft is tanh, so the output is odd, rises and bends over.
  const soft = curveYs()
  scenarios['the-soft-curve-is-odd-rises-and-saturates'] = soft.length === 181 && Math.abs(soft[90] - 29) < 0.01 && Math.abs(soft[0] + soft[180] - 58) < 0.01
    && soft[0] > soft[90] && soft[180] < soft[90] && Math.abs(soft[150] - soft[180]) < 4

  // A Drive change redraws the curve without replacing the graph, the knob or the HQ button.
  const hiQualityButton = hiQuality()
  key(driveKnob, 'ArrowUp')
  await settle()
  scenarios['drive-writes-its-param-and-reports-a-manual-override'] = lastChange()?.driveDb === 6.1 && panel.overrides.at(-1) === 'saturator.driveDb'
  scenarios['drive-redraws-the-curve-without-remounting'] = curvePath() !== '' && curveYs()[135] < soft[135] && graphSvg() === graph && slider('Drive') === driveKnob && hiQuality() === hiQualityButton
  scenarios['the-knob-reads-the-value-it-wrote'] = valueText('Drive') === '6.1 dB'

  await choose('Curve', 'Bass Shaper')
  scenarios['bass-adds-only-its-threshold'] = lastChange()?.curve === 'bass' && names() === 'Drive,Output,Dry/Wet,Threshold' && valueText('Threshold') === '-12.0 dB'
  const bassKnee = curveYs()
  key(slider('Threshold'), 'ArrowDown')
  await settle()
  scenarios['threshold-writes-its-param-and-moves-the-curve'] = lastChange()?.bassThresholdDb === -12.1 && panel.overrides.at(-1) === 'saturator.bassThresholdDb' && curveYs().join() !== bassKnee.join()
  scenarios['a-curve-change-keeps-the-graph-and-the-drive-knob'] = graphSvg() === graph && slider('Drive') === driveKnob

  await choose('Curve', 'Warp')
  scenarios['warp-adds-only-depth-and-period'] = names() === 'Drive,Output,Dry/Wet,Warp Depth,Warp Period' && valueText('Warp Depth') === '50%' && valueText('Warp Period') === '0.50'
  const warp = curveYs()
  key(slider('Warp Depth'), 'ArrowUp')
  key(slider('Warp Period'), 'ArrowDown')
  await settle()
  scenarios['depth-and-period-write-their-params-and-move-the-curve'] = panel.changes.some((change) => change.warpDepth === 0.51) && lastChange()?.warpPeriod === 0.49
    && panel.overrides.slice(-2).join() === 'saturator.warpDepth,saturator.warpPeriod' && curveYs().join() !== warp.join()

  await choose('Curve', 'Fold')
  scenarios['fold-has-no-curve-specific-control'] = names() === 'Drive,Output,Dry/Wet'
  scenarios['fold-folds-the-curve-back-at-this-drive'] = curveYs().some((y, index, ys) => index > 0 && index < ys.length - 1 && y < ys[index - 1] && y < ys[index + 1])

  const plainCurves: string[] = []
  for (const curve of ['Medium', 'Hard', 'Analog', 'Sine']) {
    await choose('Curve', curve)
    plainCurves.push(names())
  }
  scenarios['medium-hard-analog-and-sine-have-no-curve-specific-control'] = plainCurves.every((shown) => shown === 'Drive,Output,Dry/Wet')

  await choose('Curve', 'Clip')
  const clipped = curveYs()
  scenarios['clip-flattens-at-full-scale'] = clipped[0] === 58 || clipped[0] > 57.9
  await choose('Post Clip', 'Hard Clip')
  scenarios['post-clip-writes-its-mode-and-latency-shows-on-hq'] = lastChange()?.postClip === 'hard' && named('Post Clip')?.textContent?.trim() === 'Hard Clip' && hiQuality()?.getAttribute('aria-label')?.includes('6 frames') === true

  // Color on shows its four knobs; off removes them.
  named('Color')?.click()
  await settle()
  scenarios['color-on-writes-the-flag-and-shows-its-four-knobs'] = lastChange()?.color === true && pressed('Color') === 'true' && names() === 'Drive,Output,Dry/Wet,Color Frequency,Color Width,Amt Lo,Amt Hi'
    && valueText('Color Frequency') === '1.20 kHz' && valueText('Color Width') === '57%' && valueText('Amt Lo') === '0.0 dB' && valueText('Amt Hi') === '0.0 dB'
  key(slider('Color Frequency'), 'ArrowUp')
  key(slider('Color Width'), 'ArrowUp')
  key(slider('Amt Lo'), 'ArrowUp')
  key(slider('Amt Hi'), 'ArrowDown')
  scenarios['color-knobs-write-their-params-and-report-overrides'] = panel.changes.some((change) => (change.colorFrequencyHz ?? 0) > 1200) && panel.changes.some((change) => change.colorWidth === 0.58)
    && panel.changes.some((change) => change.colorLowDb === 0.1) && lastChange()?.colorHighDb === -0.1
    && panel.overrides.slice(-4).join() === 'saturator.colorFrequencyHz,saturator.colorWidth,saturator.colorLowDb,saturator.colorHighDb'
  await choose('Curve', 'Warp')
  const crowded = panel.layout()
  scenarios['warp-with-color-fits-the-device-and-crowds-nothing'] = crowded.width === 460 && crowded.fits && crowded.clipped && crowded.crowded && names().split(',').length === 9

  named('Color')?.click()
  await settle()
  scenarios['color-off-removes-its-knobs'] = lastChange()?.color === false && slider('Color Frequency') === null && slider('Amt Hi') === null

  hiQuality()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await settle()
  scenarios['hi-quality-writes-the-flag'] = lastChange()?.hiQuality === false && hiQuality()?.getAttribute('aria-pressed') === 'false'

  const fields = ['driveDb', 'outputDb', 'dryWet', 'bassThresholdDb', 'warpDepth', 'warpPeriod', 'colorFrequencyHz', 'colorWidth', 'colorLowDb', 'colorHighDb']
  scenarios['no-knob-shows-automation-without-an-envelope'] = panel.dotted().length === 0
  named('Color')?.click()
  panel.setRanges(new Map(fields.map((field) => [`saturator.${field}`, { min: 0, max: 1 }])))
  await settle()
  scenarios['every-automatable-knob-shows-its-automation'] = panel.dotted().length === 9 && !panel.dotted().includes('Threshold')

  publishScenarios(scenarios)
}

void run().catch((error) => { Object.assign(window, { __browserFixtureError: String(error) }) })
