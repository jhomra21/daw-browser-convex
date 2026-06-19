import type { JSX } from "solid-js";
import { cn } from "~/lib/utils";

export function DashboardScrollView(props: { class?: string; children: JSX.Element }) {
  return (
    <div class={cn("min-h-0 flex-1 overflow-y-auto px-6 py-5", props.class)}>
      <div class="flex flex-col gap-5">{props.children}</div>
    </div>
  );
}

export function DashboardSection(props: { title: string; description?: string; children: JSX.Element }) {
  return (
    <section class="flex flex-col gap-2">
      <div class="px-1">
        <h2 class="text-sm font-semibold text-neutral-100">{props.title}</h2>
        {props.description ? <p class="mt-1 text-xs text-neutral-500">{props.description}</p> : null}
      </div>
      <div class="overflow-hidden">{props.children}</div>
    </section>
  );
}

export function DashboardRow(props: { label: JSX.Element; value?: JSX.Element; action?: JSX.Element }) {
  return (
    <div class="flex min-h-12 items-center gap-4 border-b border-neutral-800 px-4 py-3 last:border-b-0">
      <div class="min-w-0 flex-1">
        <div class="text-sm text-neutral-200">{props.label}</div>
        {props.value ? <div class="mt-1 text-xs text-neutral-500">{props.value}</div> : null}
      </div>
      {props.action}
    </div>
  );
}

export function EmptyDashboardState(props: { title: string; message: string }) {
  return (
    <div class="border border-dashed border-neutral-800 p-6 text-center">
      <p class="text-sm font-medium text-neutral-200">{props.title}</p>
      <p class="mt-1 text-xs text-neutral-500">{props.message}</p>
    </div>
  );
}
