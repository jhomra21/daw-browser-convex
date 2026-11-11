import type { AudioEffectInstance, AudioEffectKind } from "@daw-browser/shared";

// Keeps one stable instance object per instance the mounted project currently
// owns (persisted rows, optimistic additions and drafts), so keyed lists see
// the same reference across rebuilds. Edit identity lives in the Timeline's
// processor edit registry, not here.
export const createAudioEffectInstanceIdentityCache = () => {
  const members = new Map<string, AudioEffectInstance>();
  const keyOf = (targetId: string, id: string) => `${targetId}:${id}`;
  const admit = (targetId: string, id: string, kind: AudioEffectKind) => {
    const key = keyOf(targetId, id);
    const member = members.get(key);
    if (member?.kind === kind) return member;
    const created = { id, kind };
    members.set(key, created);
    return created;
  };
  return {
    // Pure read for memos; an unadmitted member is not cached.
    instance: (targetId: string, id: string, kind: AudioEffectKind): AudioEffectInstance => {
      const member = members.get(keyOf(targetId, id));
      return member?.kind === kind ? member : { id, kind };
    },
    retain: (reachable: readonly { targetId: string; id: string; kind: AudioEffectKind }[]) => {
      const live = new Map(reachable.map((entry) => [keyOf(entry.targetId, entry.id), entry.kind]));
      for (const [key, member] of members) {
        if (live.get(key) !== member.kind) members.delete(key);
      }
      for (const entry of reachable) admit(entry.targetId, entry.id, entry.kind);
    },
    reset: () => members.clear(),
  };
};
