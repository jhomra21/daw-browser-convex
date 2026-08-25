# Native VST3 architecture

**Last Updated: 2026-08-25**

VST3 hosting is a desktop-only capability. The browser runtime and cloud
control surface do not load or execute native plugin binaries.

## Discovery locations

On macOS, catalog initialization seeds these standard directories:

```text
/Library/Audio/Plug-Ins/VST3
~/Library/Audio/Plug-Ins/VST3
```

Configured paths are canonicalized absolute search-root directories. Discovery
traverses those roots for child `.vst3` bundles. The catalog revalidates
persisted entries during initialization; a stale, missing, or changed identity
is not eligible merely because it was previously cataloged.

Discovery is automatic for the standard directories. Initial scanning requires
the product trust acknowledgement, which the renderer persists separately from
the catalog. After a successful trusted scan, the catalog stores its own
`hasTrustedScan` marker. Later startup revalidation may rescan entries covered
by that catalog marker without asking for fresh consent on every launch, but it
still rechecks the current bundle, executable, signature, quarantine state,
architecture, and fingerprints.

## Trust and eligibility

The Electron main process owns native capability selection and lifecycle. A
bundle is eligible for scanner/preflight only when the implementation has
verified all of the following:

- the canonical bundle is inside a configured standard directory;
- the bundle executable exists at the expected bundle location;
- the executable has no `com.apple.quarantine` attribute;
- strict `codesign --verify` succeeds;
- the binary includes the `arm64` architecture;
- the scanner returns a valid protocol-compatible class result;
- the bundle and executable fingerprints match the catalog identity;
- the packaged scanner, worker, audio-host artifacts, and release manifest are
  available when packaged hosting is enabled.

Scanner and launch checks are repeated at the process-local boundary. A catalog
entry is metadata, not a durable permission to execute a changed binary.

## Process architecture

The native path is:

```text
Electron main/preload
  └─ native audio host
       ├─ scanner/catalog/trust checks
       ├─ realtime VST3 playback workers
       ├─ worker-local macOS editor workers/windows
       └─ bounded control/shared-memory transport
```

The realtime playback worker and editor session are separate native host
lifecycles. The editor window is created in the worker-local macOS process;
Electron receives typed status and interaction notifications rather than
embedding a foreign plugin view.

Worker isolation is a crash and availability boundary, not a malicious-code
sandbox. A VST3 binary is native third-party code. Process groups, bounded
frames, artifact manifests, code-signing/quarantine checks, and recovery logic
reduce blast radius and contain failures, but they do not make an untrusted
plugin safe to execute.

## Public operations

The public desktop host catalog exposes these bounded reads:

```text
host.vst.instances
host.vst.parameters
```

Parameter writes use the separate local-only project-control action
`external-plugin.parameters.set`, with persisted processor references and
normalized values. It is advertised by project capabilities and is not a host
runtime operation or generic native RPC.

The other public runtime IDs are `host.status`, `host.import.audio`,
`host.export.run`, `host.export.status`, `host.export.cancel`,
`transport.status`, `transport.play`, `transport.pause`, `transport.stop`,
`transport.seek`, and `diagnostics.snapshot`.

## Deliberately non-public operations

There is no public project-control or generic runtime operation for:

- arbitrary VST3 insertion or removal;
- arbitrary effect/instrument editor manipulation;
- process spawning, killing, or worker lifecycle control;
- raw native host commands or plugin ABI calls;
- arbitrary package, DSP, or extension loading.

Internal native code performs attachment, detachment, process supervision,
editor commands, state capture, and recovery behind trusted desktop flows and
typed native protocols.

## Scanner and worker preflight lifecycle

The current attach lifecycle is:

1. Discover bundles in the standard/configured directories.
2. Canonicalize paths and apply quarantine, code-signing, and architecture
   checks.
3. Run the packaged scanner and record class metadata, scanner protocol, SDK
   data, bundle fingerprint, and binary fingerprint.
4. Resolve the requested catalog identity and reject stale or untrusted
   attachments.
5. Preflight the packaged worker against artifact ID/version, startup/control
   protocol versions, transport ABI, arm64 architecture, class ID, bus layout,
   parameter manifest, state revision, and bounded transport limits.
6. Attach only after all manifests match; graph publication and VST attachment
   are coordinated as one native transaction.
7. Read bounded instance/parameter data and write normalized parameter changes
   through the local canonical action.

Worker preflight is bounded by a hard deadline and response frame limits.
Missing, crashed, timed-out, or invalid workers make the attachment unavailable;
they do not trigger a fallback to arbitrary execution.

### Attachment, persistence, and restoration

The project persists the native attachment plan, processor parameters, catalog
identity, and supported captured state as project state. A successful attach
resolves that plan against the current trusted catalog and restores validated
state before the graph transaction is published. A plugin that advertises no
state support is recreated with defaults and persisted initial parameters; a
stateful plugin must provide a bounded, hash-validated capture when the
attachment or export flow requires it.

After a cold desktop restart, standard discovery and catalog revalidation run
again before the persisted attachment plan is resolved. State is restored only
after scanner, fingerprint, manifest, worker, and bus checks pass. Missing or
stale entries self-heal by being revalidated/repaired or marked unavailable;
the application does not silently execute a stale trusted record.

## Editor lifecycle

An editor-capable plugin advertises `supportsEditor`. An editor session creates
a separate native supervisor, configures a diagnostic audio session, resolves
and preflights the attachment, applies initial state when required, commits the
transaction, and waits for the worker-ready notification.

Editor commands are bounded to open, close, focus, resize, and status. Parameter
edits and editor interaction are reported as typed notifications. Editor state
is captured before teardown when the session requires or requests it. A
session is suspended and torn down on host loss or application shutdown; stale
generation callbacks are ignored.

Plugins that do not advertise editor support remain valid for non-editor
hosting. Callers must inspect the returned `supportsEditor` value.

## State, recovery, and restart

Opaque VST state is accepted only when it is at most 512 KiB and its SHA-256
digest matches the bytes. Stateful plugins must provide valid captured state
when the attach or export flow requires it. Stateless plugins may be
instantiated with defaults and persisted initial parameter values.

Worker loss produces bounded recovery behavior:

- the worker is faulted and its process group is contained;
- a restart may reuse the validated startup request and state;
- at most three worker restarts are permitted by the native supervisor;
- stale generations, invalid manifests, fingerprint mismatches, and malformed
  state are rejected rather than replayed;
- graph revision publication can be rolled back or retired when preparation,
  publication, or safe stop fails.

Recovery/rebuild is for availability and consistency. It is not a trust
upgrade and does not bypass catalog or preflight checks.

## Export and playback limits

Native export re-runs attachment resolution and worker preflight. Stateful
attachments require a validated captured state; state is not guessed from a
catalog entry. Export fails when required native artifacts, state, or manifest
checks are unavailable.

Current offline export behavior is intentionally narrow: native Phase A export
rejects projects containing automation. Projects without automation can use
the same validated native attachments; stateful attachments require captured
state, while stateless attachments use defaults plus persisted parameter
values. This is the current behavior, not a claim of general offline VST3
parity.

Native playback is gated on a proven attachment subset, acknowledged worker
handshake, acknowledged graph revision, supported bus layout, worker deadlines,
and safe graph publication. Worker latency, tails, bus changes, restarts,
misses, and faults are surfaced as bounded revision notifications.

### Automation overrides and manual edits

During native playback, parameter events for a plugin are bounded to the
worker transport and mark those parameter IDs as automation-overridden. A
manual parameter edit therefore takes precedence for the addressed parameter
until its automation override is explicitly cleared. Override insertion is
bounded and rolls back if event queuing fails.

Re-enabling schedule automation clears the selected parameter overrides. The
low-level native command does not itself enforce a stopped transport. The
certified packaged campaign observed the product flow reject re-enable while
playback was live and succeed after transport stopped, so treat that as an
observed current product boundary rather than a protocol guarantee.

## Current limitations

- VST3 is unavailable in browser and cloud targets.
- Hosting requires the explicit desktop release/artifact gate and packaged
  scanner, worker, and audio-host artifacts.
- First native execution remains trust-gated and is revalidated at launch.
- Plugin behavior, editor/state support, device availability, supported bus
  layout, and platform architecture can make an instance unavailable even
  when its catalog entry exists.
- Worker isolation does not protect against malicious native plugin code.

For packaged evidence and environmental skips, see the
[runtime acceptance report](../acceptance-reports/control-platform-runtime-2026-08-20.md).
