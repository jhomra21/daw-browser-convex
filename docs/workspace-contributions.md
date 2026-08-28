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

`register()` returns an idempotent cleanup function, so extension activation can bind a workspace contribution to the existing lifecycle boundary:

```ts
const cleanup = workspace.register(context.extensionId, contribution)
context.addCleanup(cleanup)
```

No separate cleanup authority is required.

## What this does not do

This registry does not load packages, execute arbitrary extension code, grant project mutation authority, or expose renderer internals.

External extension loading should be layered on top of the existing extension lifecycle and scoped project-action grants after its manifest and capability contracts are explicit. A package loader should consume these contribution APIs rather than invent a second extension system.

## Next seams

The next useful host adapters are:

- current timeline/browser workspace surfaces registered as built-ins;
- a renderer adapter that resolves active contributions into Solid-owned rendering;
- declarative external manifests that request only named contribution and project-action capabilities;
- additional typed contribution planes for model/tool providers where the DAW needs replaceable non-UI behavior.
