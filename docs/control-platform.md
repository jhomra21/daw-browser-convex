# Control platform architecture

## Ownership

`@daw-browser/control` is the contract owner. Its versioned schemas,
serialization, digests, durable request metadata, and keyed catalog are the
compatibility boundary. `@daw-browser/control-core` is a pure semantic
dependency used by local and Convex authorities; it does not depend back on
the contract consumers.

Handlers bind trusted target state. `ControlInvoker` binds a target and
trusted principal once, then dispatches through the catalog. The canonical SDK
client exposes grouped typed methods and performs no retry or auth work. REST,
desktop, CLI, and MCP remain compatibility adapters around those boundaries.

## Targets and transports

The project-control catalog supports `cloud` and `desktop`, with
`project.current` intentionally desktop-only. REST and the desktop socket
retain their public V1/V2 contracts and project through canonical handlers.
Desktop host/runtime operations use the separate keyed catalog in
`@daw-browser/desktop-protocol`; host operations are not mixed into project
control.

The JSONL adapter accepts one bounded JSON-RPC 2.0 request per line and
processes lines sequentially. Notifications execute without a response;
batches, malformed requests, unknown methods, invalid parameters, unsupported
targets, and oversized/deep inputs are rejected. The process decoder bounds
UTF-8 input before parsing, discards oversized lines until their newline, and
continues with following requests. The CLI provides
`rpc --target host` over the authenticated desktop registration/socket path.
Host acquisition failures are returned as a stable unavailable error without
registration, socket, or temporary-directory details. Cloud JSONL remains
deferred because no equivalent secure process authentication path exists.

## Extension boundaries

Only statically imported trusted built-ins are managed. The extension kernel
publishes a registry atomically, isolates diagnostics, aborts stale
generations, and cleans up in reverse order. Replacement is explicit and
contract-matched. No external manifests, package loading, DSP ABI, eval, or
ambient store access is supported.

Menu projection is bounded to 16 validated first-level slots with stable
contribution IDs, titles, ordering, and enabled/checked state. Native menus
are not regenerated. The browser toggle is composed through the extension
kernel; existing browser tab menu commands remain native compatibility
commands.

Project actions use a narrow facade over the canonical client. A built-in
must receive explicit action-kind and operation grants. Preview, approval, and
commit are separate methods, each checks abort and generation state, and no
raw service/store/invoker is exposed.

## Compatibility and deferred work

V1/V2 control contracts, REST endpoints, desktop frames, CLI commands, MCP
tools, durable rows, and `registration-v1.json` are retained. Source-only
changes are removed only with repository and external evidence; no external
parity is claimed without an installed/deployed consumer matrix.

Deferred features are extension preference persistence, external extension
packages/manifests, arbitrary package or DSP loading, public operation
endpoints, and cloud JSONL process authentication.

The repeatable focused suite is:

```sh
bun run test:control-platform
```
