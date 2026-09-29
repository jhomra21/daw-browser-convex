import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  automationTargetKey,
  automationTargetKeysAfterReEnable,
  automationTargetKeysForManualOverride,
  createAutomationTarget,
  externalAutomationParameterId,
  filterAutomationEnvelopesForScheduling,
  type AutomationEnvelope,
} from "@daw-browser/shared";

const externalCardPath = new URL("./external-plugin-card.tsx", import.meta.url);
const automationControllerPath = new URL("../../hooks/useTimelineAutomationController.ts", import.meta.url);
const timelinePanelsPath = new URL("./timeline-panels.tsx", import.meta.url);
const nativePlaybackControllerPath = new URL("../../lib/desktop/native-playback-controller.ts", import.meta.url);

test("keeps a visible external-plugin parameter edit overridden until the product re-enable action", async () => {
  const [externalCard, automationController, timelinePanels, nativePlaybackController] = await Promise.all([
    readFile(externalCardPath, "utf8"),
    readFile(automationControllerPath, "utf8"),
    readFile(timelinePanelsPath, "utf8"),
    readFile(nativePlaybackControllerPath, "utf8"),
  ]);
  const manualOverride = externalCard.indexOf("props.onManualAutomationOverride?.");
  const liveParameterWrite = externalCard.indexOf("void props.enqueueParameter", manualOverride);

  expect(manualOverride).toBeGreaterThan(-1);
  expect(liveParameterWrite).toBeGreaterThan(manualOverride);
  expect(externalCard).toContain("if (!props.canWrite || parameter.readOnly) return;");
  expect(automationController).toContain("if (!options.isPlaying()) return;");
  expect(automationController).toContain("if (!envelope?.enabled) return;");
  expect(automationController).not.toContain('window.addEventListener("pointerup", releasePointerAutomation)');
  expect(automationController).not.toContain('window.addEventListener("pointercancel", releasePointerAutomation)');
  expect(timelinePanels).toContain("enqueueNativeVstParameter?: NativeVstParameterQueue[\"enqueue\"]");
  expect(timelinePanels).toContain("enqueueNativeVstParameter={panels().effectsPanel.enqueueNativeVstParameter}");
  expect(nativePlaybackController).toContain("parseExternalAutomationParameterId(parameterId)");
  expect(nativePlaybackController).toContain("const externalInstanceId = externalParameters[0]?.instanceId");
  expect(nativePlaybackController).toContain("preparedSnapshot?.nativeExternalAttachmentPlan?.attachments");
  expect(nativePlaybackController).toContain("scheduleCoordinator.reenableAutomation(externalInstanceId, targets)");
});

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
