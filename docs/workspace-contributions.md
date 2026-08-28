# Workspace contributions

The workspace contribution registry is the first renderer-independent UI composition boundary in the extension platform.

It exists so built-ins and extensions can provide or replace stable workspace surfaces without teaching the extension kernel about Solid components, DOM nodes, or renderer-specific state.

## Contribution contract

A workspace contribution has:

- a stable namespaced contribution ID;
- a kind: `tab`, `panel`, or `view`;
- a human-readable title;
- a host-defined slot;
- a bounded deterministic order;
- an implementation value whose type is chosen by the host;
- optional replacement policy or replacement intent.

`createWorkspaceContributionRegistry<TValue>()` is generic over the implementation value. A Solid host can use a component or view-model factory. Another renderer can use a different value without changing the registry contract.

The core registry does not import Solid or own rendering.

## Replacement rules

Replacement is explicit and fail-closed.

The original contribution must opt in with a replacement contract. The replacing contribution must:

1. use the same stable contribution ID;
2. provide the exact same kind, title, slot, and order;
3. name the same replacement contract;
4. not advertise another replacement policy.

Nested replacement is intentionally rejected for now.

When a replacement is removed, the original contribution is restored. If the original provider disappears while its replacement is active, the registry removes the replacement too rather than leaving an implementation whose contract owner no longer exists.

This mirrors the extension kernel's command replacement behavior: the public surface remains stable while the implementation provider changes.

## Lifecycle use

`register()` returns an idempotent cleanup function. `contributeWorkspace()` registers against the current extension ID and adds that cleanup to the existing extension activation context.

```ts
contributeWorkspace(context, workspace, contribution)
```

No separate cleanup authority is required.

## Timeline host

`createTimelineExtensionHost()` owns a workspace registry alongside its command and shortcut host.

When the host receives a Browser workspace value, it activates `builtin.workspace.browser` through the same built-in extension manager used by the Browser command. That built-in owns the stable `workspace.browser` panel contribution and opts into replacement through `workspace.panel.browser/v1`.

Host activation is fail-closed. If the Browser workspace activates and a later built-in activation fails, the host disables the workspace built-in before returning its fallback activation result. Disposal removes both command and workspace contributions through the normal extension lifecycle.

The host remains renderer-independent: the Browser contribution value is generic. The Solid renderer adapter can therefore supply a component or factory without moving Solid into the extension kernel.

## What this does not do

This registry does not load packages, execute arbitrary extension code, grant project mutation authority, or expose renderer internals.

External extension loading should be layered on top of the existing extension lifecycle and scoped project-action grants after its manifest and capability contracts are explicit. A package loader should consume these contribution APIs rather than invent a second extension system.

## Next seams

The next useful host adapters are:

- resolve `workspace.browser` from the timeline host into Solid-owned rendering while preserving the current Browser UI as the fallback;
- register the remaining stable workspace surfaces as built-ins only when they have a real replacement use case;
- define declarative external manifests that request only named contribution and project-action capabilities;
- add typed contribution planes for model/tool providers where the DAW needs replaceable non-UI behavior.
