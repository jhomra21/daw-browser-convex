import type { Scenario } from '../harness'
import { dynamics } from './dynamics'
import { delayModulation } from './delay-modulation'
import { eqFilters } from './eq-filters'
import { reverb } from './reverb'
import { saturationUtility } from './saturation-utility'

export type Family = { scenarios: Scenario[]; notEncoded: readonly string[] }

export const families = {
  'eq-filters': eqFilters,
  dynamics,
  reverb,
  'delay-modulation': delayModulation,
  'saturation-utility': saturationUtility,
}

/** Families whose effects are rebuilt: certification fails on any of their rows. Add a family here once its effects pass. */
export const gatedFamilies: readonly (keyof typeof families)[] = ['dynamics', 'eq-filters']
