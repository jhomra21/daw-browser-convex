import { expect, test } from "bun:test";
import {
  automationTargetKey,
  automationTargetKeysAfterReEnable,
  automationTargetKeysForManualOverride,
  createAutomationTarget,
  externalAutomationParameterId,
  filterAutomationEnvelopesForScheduling,
  type AutomationEnvelope,
} from "@daw-browser/shared";

test("suppresses only manually overridden external-plugin automation and clears both in the existing global flow", () => {
  const target = createAutomationTarget(
    { kind: "track", trackId: "track:one" },
    "vst:supermassive",
  );
  const mixParameterId = externalAutomationParameterId("vst:supermassive", 48);
  const widthParameterId = externalAutomationParameterId("vst:supermassive", 49);
  const mixTargetKey = automationTargetKey(target, mixParameterId);
  const widthTargetKey = automationTargetKey(target, widthParameterId);
  const unrelatedTarget = createAutomationTarget({ kind: "track", trackId: "track:two" });
  const unrelatedTargetKey = automationTargetKey(unrelatedTarget, "volume");
  const envelope = (
    id: string,
    envelopeTarget: AutomationEnvelope["target"],
    targetKey: string,
    parameterId: string,
  ): AutomationEnvelope => ({
    id,
    projectId: "project:one",
    target: envelopeTarget,
    targetKey,
    parameterId,
    enabled: true,
    points: [],
    updatedAt: 1,
  });
  const envelopes = [
    envelope("mix", target, mixTargetKey, mixParameterId),
    envelope("width", target, widthTargetKey, widthParameterId),
    envelope("volume", unrelatedTarget, unrelatedTargetKey, "volume"),
  ];

  const mixOverridden = automationTargetKeysForManualOverride(new Set(), mixTargetKey);
  expect(mixOverridden.size).toBe(1);
  expect(filterAutomationEnvelopesForScheduling(envelopes, mixOverridden)).toEqual([
    envelopes[1],
    envelopes[2],
  ]);

  const bothOverridden = automationTargetKeysForManualOverride(mixOverridden, widthTargetKey);
  expect(bothOverridden.size).toBe(2);
  expect(filterAutomationEnvelopesForScheduling(envelopes, bothOverridden)).toEqual([
    envelopes[2],
  ]);

  expect(automationTargetKeysAfterReEnable(bothOverridden, bothOverridden).size).toBe(0);
});
