import { createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import {
  builtinBrowserWorkspaceContributionId,
  type ActiveWorkspaceContribution,
  type WorkspaceContributionRegistry,
} from "~/lib/extensions";

export type TimelineWorkspaceContributionAccess<TValue> = Readonly<{
  browser: Accessor<ActiveWorkspaceContribution<TValue> | undefined>;
}>;

export const createTimelineWorkspaceContributionAccess = <TValue>(
  registry: WorkspaceContributionRegistry<TValue>,
): TimelineWorkspaceContributionAccess<TValue> => {
  const [generation, setGeneration] = createSignal(
    registry.snapshot().generation,
  );
  const unsubscribe = registry.subscribe((snapshot) => {
    setGeneration(snapshot.generation);
  });
  onCleanup(unsubscribe);

  const browser = createMemo(() => {
    generation();
    return registry.get(builtinBrowserWorkspaceContributionId);
  });

  return Object.freeze({ browser });
};
