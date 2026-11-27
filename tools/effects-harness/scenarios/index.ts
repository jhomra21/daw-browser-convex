import type { Scenario } from '../harness'
import { dynamics } from './dynamics'
import { delay } from './delay'
import { delayModulation } from './delay-modulation'
import { eqFilters } from './eq-filters'
import { lofi } from './lofi'
import { modulation } from './modulation'
import { reverb } from './reverb'
import { saturationUtility } from './saturation-utility'
import { saturator } from './saturator'
import { utility } from './utility'

export type Family = { scenarios: Scenario[]; notEncoded: readonly string[] }

export const families = {
  'eq-filters': eqFilters,
  dynamics,
  reverb,
  delay,
  'delay-modulation': delayModulation,
  modulation,
  saturator,
  lofi,
  utility,
  'saturation-utility': saturationUtility,
}

/** Families whose effects are rebuilt: certification fails on any of their rows. Add a family here once its effects pass. */
export const gatedFamilies: readonly (keyof typeof families)[] = ['dynamics', 'eq-filters', 'reverb', 'delay', 'modulation', 'saturator', 'lofi', 'utility']
