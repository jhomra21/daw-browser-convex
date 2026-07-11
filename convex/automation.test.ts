import { describe, expect, test } from "bun:test";
import {
  hasSameStructuredAutomationIdentity,
  isUnambiguousLegacyAutomationIdentity,
  selectLegacyEffectMigrationCandidate,
} from "./automation";

describe("automation migration identity helpers", () => {
  test("matches structured identities without inspecting opaque target keys", () => {
    expect(hasSameStructuredAutomationIdentity({
      targetKind: "track",
      trackId: "track:one",
      effectInstanceId: "delay:one:colon",
      parameterId: "delay.feedback",
    }, {
      targetKind: "track",
      trackId: "track:one",
      effectInstanceId: "delay:one:colon",
      parameterId: "delay.feedback",
    })).toBe(true);
    expect(hasSameStructuredAutomationIdentity({
      targetKind: "track",
      trackId: "track:one",
      effectInstanceId: "delay:two",
      parameterId: "delay.feedback",
    }, {
      targetKind: "track",
      trackId: "track:one",
      effectInstanceId: "delay:one:colon",
      parameterId: "delay.feedback",
    })).toBe(false);
  });

  test("only treats legacy mixer identities as unambiguous", () => {
    expect(isUnambiguousLegacyAutomationIdentity({
      targetKind: "track",
      trackId: "track:one",
      parameterId: "volume",
    })).toBe(true);
    expect(isUnambiguousLegacyAutomationIdentity({
      targetKind: "track",
      trackId: "track:one",
      parameterId: "delay.feedback",
    })).toBe(false);
  });
});

describe("legacy effect identity migration", () => {
  test("selects the sole matching legacy track effect", () => {
    const effect = selectLegacyEffectMigrationCandidate([
      { id: "delay-row", targetType: "track", trackId: "track:one", type: "delay" },
      { id: "reverb-row", targetType: "track", trackId: "track:one", type: "reverb" },
    ], {
      targetKind: "track",
      trackId: "track:one",
      effectInstanceId: "delay",
      parameterOwner: "delay",
    });

    expect(effect.id).toBe("delay-row");
  });

  test("selects the sole matching legacy master effect", () => {
    const effect = selectLegacyEffectMigrationCandidate([
      { id: "master-delay", targetType: "master", type: "delay" },
      { id: "track-delay", targetType: "track", trackId: "track:one", type: "delay" },
    ], {
      targetKind: "master",
      effectInstanceId: "delay",
      parameterOwner: "delay",
    });

    expect(effect.id).toBe("master-delay");
  });

  test("rejects duplicate legacy candidates and durable id collisions", () => {
    expect(() => selectLegacyEffectMigrationCandidate([
      { id: "delay-one", targetType: "track", trackId: "track:one", type: "delay" },
      { id: "delay-two", targetType: "track", trackId: "track:one", type: "delay" },
    ], {
      targetKind: "track",
      trackId: "track:one",
      effectInstanceId: "delay",
      parameterOwner: "delay",
    })).toThrow("Automation effect instance does not belong to this target.");

    expect(() => selectLegacyEffectMigrationCandidate([
      { id: "owner", instanceId: "delay", targetType: "master", type: "delay" },
      { id: "legacy", targetType: "track", trackId: "track:one", type: "delay" },
    ], {
      targetKind: "track",
      trackId: "track:one",
      effectInstanceId: "delay",
      parameterOwner: "delay",
    })).toThrow("Automation effect instance id is already owned by another effect.");
  });

  test("rejects automation owned by a different effect kind", () => {
    expect(() => selectLegacyEffectMigrationCandidate([
      { id: "delay-row", targetType: "master", type: "delay" },
    ], {
      targetKind: "master",
      effectInstanceId: "delay",
      parameterOwner: "reverb",
    })).toThrow("Automation parameter does not belong to the referenced effect kind.");
  });

  test("uses the durable identity for automation ownership after migration", () => {
    const legacy = selectLegacyEffectMigrationCandidate([
      { id: "delay-row", targetType: "track", trackId: "track:one", type: "delay" },
    ], {
      targetKind: "track",
      trackId: "track:one",
      effectInstanceId: "delay",
      parameterOwner: "delay",
    });
    const migrated = { ...legacy, instanceId: "delay" };

    expect(migrated.instanceId).toBe("delay");
    expect(migrated.type).toBe("delay");
    expect(migrated.targetType).toBe("track");
    expect(migrated.trackId).toBe("track:one");
  });
});
