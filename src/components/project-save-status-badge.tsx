import type { JSX } from "solid-js";
import type { ProjectSaveStatusInput } from "~/lib/project-save-status";
import { useProjectSaveStatus } from "~/hooks/useProjectSaveStatus";
import { cn } from "~/lib/utils";

type ProjectSaveStatusBadgeProps = ProjectSaveStatusInput & {
  label: "short" | "compact";
  class?: string;
};

export function ProjectSaveStatusBadge(props: ProjectSaveStatusBadgeProps): JSX.Element {
  const status = useProjectSaveStatus(() => props);
  const label = () => props.label === "compact" ? status().compactLabel : status().shortLabel;

  return (
    <span
      title={status().label}
      class={cn("border px-2 py-1 text-[11px] font-medium", status().class, props.class)}
    >
      {label()}
      <span class="sr-only">{status().label}</span>
    </span>
  );
}
