import {
  automationTargetKey,
  automationEnvelopeValueRange,
  normalizeSynthParams,
  parseSynthAutomationKey,
  synthAutomationKey,
  SYNTH_AUTOMATION_PARAMETER_IDS,
  type AutomationEnvelope,
  type SynthAutomationParameterId,
  type SynthParams,
} from "@daw-browser/shared";

export function createSynthAutomationState(
  targetId: string | undefined,
  instanceId: string | undefined,
  automationEnvelopes: readonly AutomationEnvelope[],
) {
  const ranges = new Map<string, { min: number; max: number }>();
  const parameterIds = new Map<string, string>();
  if (!targetId || !instanceId) return { ranges, parameterIds };

  for (const parameterId of SYNTH_AUTOMATION_PARAMETER_IDS) {
    parameterIds.set(parameterId, synthAutomationKey(targetId, instanceId, parameterId));
  }
  for (const envelope of automationEnvelopes) {
    if (envelope.target.kind !== "track" || envelope.target.trackId !== targetId) continue;
    const key = parseSynthAutomationKey(envelope.parameterId);
    if (!key || key.instanceId !== instanceId || envelope.points.length === 0) continue;
    const range = automationEnvelopeValueRange(envelope);
    if (!range) continue;
    ranges.set(key.parameterId, range);
    parameterIds.set(key.parameterId, envelope.parameterId);
  }
  return { ranges, parameterIds };
}

export function overlaySynthAutomationValues(
  params: SynthParams,
  parameterIds: ReadonlyMap<string, string>,
  evaluatedValuesByTargetKey: ReadonlyMap<string, number> | undefined,
): SynthParams {
  const normalized = normalizeSynthParams(params);
  const valueFor = (parameterId: SynthAutomationParameterId, fallback: number) => {
    const encodedParameterId = parameterIds.get(parameterId);
    const key = encodedParameterId && parseSynthAutomationKey(encodedParameterId);
    const targetKey = key
      ? automationTargetKey(
          { kind: "track", trackId: key.trackId },
          encodedParameterId,
        )
      : undefined;
    return targetKey ? evaluatedValuesByTargetKey?.get(targetKey) ?? fallback : fallback;
  };
  return {
    ...normalized,
    gain: valueFor("output.gain", normalized.gain),
    pan: valueFor("output.pan", normalized.pan),
    oscillators: [
      {
        ...normalized.oscillators[0],
        level: valueFor("osc1.level", normalized.oscillators[0].level),
        detuneCents: valueFor("osc1.detune", normalized.oscillators[0].detuneCents),
      },
      {
        ...normalized.oscillators[1],
        level: valueFor("osc2.level", normalized.oscillators[1].level),
        detuneCents: valueFor("osc2.detune", normalized.oscillators[1].detuneCents),
      },
    ],
    ampEnvelope: {
      attackSec: valueFor("amp.attack", normalized.ampEnvelope.attackSec),
      decaySec: valueFor("amp.decay", normalized.ampEnvelope.decaySec),
      sustain: valueFor("amp.sustain", normalized.ampEnvelope.sustain),
      releaseSec: valueFor("amp.release", normalized.ampEnvelope.releaseSec),
    },
    filter: {
      ...normalized.filter,
      frequencyHz: valueFor("filter.frequency", normalized.filter.frequencyHz),
      q: valueFor("filter.q", normalized.filter.q),
      envelopeAmountOctaves: valueFor("filter.envAmount", normalized.filter.envelopeAmountOctaves),
      envelope: {
        attackSec: valueFor("filter.attack", normalized.filter.envelope.attackSec),
        decaySec: valueFor("filter.decay", normalized.filter.envelope.decaySec),
        sustain: valueFor("filter.sustain", normalized.filter.envelope.sustain),
        releaseSec: valueFor("filter.release", normalized.filter.envelope.releaseSec),
      },
    },
    lfo: {
      ...normalized.lfo,
      frequencyHz: valueFor("lfo.rate", normalized.lfo.frequencyHz),
      pitchCents: valueFor("lfo.pitchDepth", normalized.lfo.pitchCents),
      filterOctaves: valueFor("lfo.filterDepth", normalized.lfo.filterOctaves),
      amp: valueFor("lfo.ampDepth", normalized.lfo.amp),
      pan: valueFor("lfo.panDepth", normalized.lfo.pan),
    },
  };
}
