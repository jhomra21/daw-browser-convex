import type { ExternalSidechainRoute } from "@daw-browser/timeline-core/types";
import type { ExportAutomationPatch } from "~/lib/export/run-export-job";
import type { LivePlaybackTimeSignature } from "~/lib/live-playback-snapshot";

type NativePlaybackInputs = {
  timeSignature: LivePlaybackTimeSignature;
  automationEnvelopes: readonly unknown[] | undefined;
  masterVolume: number;
  automation: readonly ExportAutomationPatch[];
  sidechains: readonly ExternalSidechainRoute[];
  processorStructure: number;
};

// Explicit keys keep bookkeeping and mapper-live values out of schedule identity.
// Tracks/BPM and loop already have their own fingerprint carriers in the hook.
export const pickNativePlaybackInputs = (input: NativePlaybackInputs): NativePlaybackInputs => ({
  timeSignature: input.timeSignature,
  automationEnvelopes: input.automationEnvelopes,
  masterVolume: input.masterVolume,
  automation: input.automation,
  sidechains: input.sidechains,
  processorStructure: input.processorStructure,
});
