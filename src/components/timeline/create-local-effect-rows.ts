import { createEffect, createMemo, createSignal, type Accessor } from "solid-js";
import { deleteLocalEffect, getLocalEffect, setLocalEffect, type LocalEffectKind, type LocalEffectRow } from "~/lib/local-effects";
import { isLocalId } from "@daw-browser/shared";

type LocalEffectSelector = LocalEffectKind | ((targetId: string) => LocalEffectKind);

type LocalEffectRows<TParams> = {
  fetchRow: (projectId: string, targetId: string) => Promise<LocalEffectRow<TParams> | undefined>;
  isLocalProject: Accessor<boolean>;
  persist: (projectId: string, targetId: string, params: TParams) => Promise<void>;
  remove: (projectId: string, targetId: string) => Promise<void>;
  row: (targetId: string | undefined) => LocalEffectRow<TParams> | undefined;
};

const resolveEffect = (effect: LocalEffectSelector, targetId: string) => (
  typeof effect === "function" ? effect(targetId) : effect
);

const scopeKey = (projectId: string, targetId: string, effect: LocalEffectKind) => (
  `${projectId}:${targetId}:${effect}`
);

export function createLocalEffectRows<TParams>(input: {
  projectId: Accessor<string | undefined>;
  targetId: Accessor<string | undefined>;
  effect: LocalEffectSelector;
  normalize?: (params: TParams) => TParams;
}): LocalEffectRows<TParams> {
  const [rows, setRows] = createSignal<Record<string, LocalEffectRow<TParams> | undefined>>({});
  const isLocalProject = createMemo(() => {
    const projectId = input.projectId();
    return Boolean(projectId && isLocalId("project", projectId));
  });

  createEffect(() => {
    const projectId = input.projectId();
    const targetId = input.targetId();
    if (!projectId || !targetId || !isLocalProject()) return;
    const effect = resolveEffect(input.effect, targetId);
    const key = scopeKey(projectId, targetId, effect);
    const isCurrentScope = () => (
      input.projectId() === projectId
      && input.targetId() === targetId
      && isLocalProject()
    );
    void getLocalEffect<TParams>(projectId, targetId, effect).then((row) => {
      if (!isCurrentScope()) return;
      setRows((prev) => ({ ...prev, [key]: row }));
    }).catch(() => {
      if (!isCurrentScope()) return;
      setRows((prev) => ({ ...prev, [key]: undefined }));
    });
  });

  const persist = async (projectId: string, targetId: string, params: TParams) => {
    if (!projectId || !isLocalId("project", projectId)) return;
    const effect = resolveEffect(input.effect, targetId);
    const row = await setLocalEffect(
      projectId,
      targetId,
      effect,
      input.normalize ? input.normalize(params) : params,
    );
    if (input.projectId() !== projectId) return;
    setRows((prev) => ({ ...prev, [scopeKey(projectId, targetId, effect)]: row }));
  };

  const fetchRow = async (projectId: string, targetId: string) => {
    if (!isLocalId("project", projectId)) return undefined;
    const effect = resolveEffect(input.effect, targetId);
    const key = scopeKey(projectId, targetId, effect);
    const cached = rows()[key];
    if (cached) return cached;
    const row = await getLocalEffect<TParams>(projectId, targetId, effect);
    if (input.projectId() !== projectId) return row;
    setRows((prev) => ({ ...prev, [key]: row }));
    return row;
  };

  const remove = async (projectId: string, targetId: string) => {
    if (!isLocalId("project", projectId)) return;
    const effect = resolveEffect(input.effect, targetId);
    await deleteLocalEffect(projectId, targetId, effect);
    if (input.projectId() !== projectId) return;
    setRows((prev) => ({ ...prev, [scopeKey(projectId, targetId, effect)]: undefined }));
  };

  return {
    fetchRow,
    isLocalProject,
    persist,
    remove,
    row: (targetId) => {
      const projectId = input.projectId();
      if (!projectId || !targetId || !isLocalId("project", projectId)) return undefined;
      return rows()[scopeKey(projectId, targetId, resolveEffect(input.effect, targetId))];
    },
  };
}
