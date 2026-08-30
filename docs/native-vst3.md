# Native VST3 architecture

**Last updated: 2026-08-26**

VST3 runs only in the Electron desktop app. Browser and cloud targets never load native plugin binaries.

## Trust model

A VST3 plugin is third-party native code running with the desktop user's authority. The worker process model helps the app survive plugin crashes and keeps plugin UI and DSP out of the Electron renderer. It does not make an untrusted plugin safe.

Only load plugins you trust.

Before the app launches a plugin, it checks the current bundle again. A catalog entry by itself is not permission to execute a changed binary.

## Discovery

On macOS, the catalog starts with the standard VST3 locations:

```text
/Library/Audio/Plug-Ins/VST3
~/Library/Audio/Plug-Ins/VST3
```

Configured roots are converted to canonical absolute paths. Discovery walks those roots for `.vst3` bundles.

The first native scan requires the product trust acknowledgement. The renderer stores that acknowledgement separately from the plugin catalog. After a trusted scan succeeds, the catalog records `hasTrustedScan` so startup can revalidate known entries without asking for consent on every launch.

Revalidation still checks the current files. A missing, moved, changed, quarantined, unsigned, or incompatible plugin can become unavailable even if it worked before.

## Launch checks

A plugin must pass these checks before scanner or worker launch:

- the canonical bundle path is inside an allowed VST3 root
- the bundle executable exists where the bundle declares it
- the executable does not have `com.apple.quarantine`
- strict `codesign --verify` succeeds
- the executable contains `arm64`
- the scanner returns a protocol-compatible VST3 class
- bundle and executable fingerprints match the catalog record
- the packaged scanner, worker, audio host, and release manifest are present

The native code repeats launch checks near the process boundary instead of trusting renderer state.

## Process layout

```text
Electron renderer
      |
Electron main and preload
      |
native audio host
  |        |         |
scanner  playback   editor
         workers    workers
```

Playback workers run plugin DSP. Editor workers own native plugin windows. Electron receives typed status and interaction messages instead of embedding the plugin's native view in the renderer.

The two worker lifecycles are separate. Closing an editor does not tear down playback, and a playback worker crash does not give the renderer direct ownership of plugin DSP.

## Public operations

Desktop runtime reads:

```text
host.vst.instances
host.vst.parameters
```

Project-control write, only when local capabilities advertise it:

```text
external-plugin.parameters.set
```

The runtime reads describe the attached native host. Parameter writes use project control because the parameter value belongs to durable project state.

Other desktop runtime IDs are:

```text
host.status
host.import.audio
host.export.run
host.export.status
host.export.cancel
transport.status
transport.play
transport.pause
transport.stop
transport.seek
diagnostics.snapshot
```

Public control does not currently expose arbitrary plugin insertion, removal, scanner control, worker process control, raw native commands, or arbitrary editor-window control.

## Attachment

The attach path works in this order:

1. Resolve the persisted plugin identity against the current trusted catalog.
2. Recheck the bundle and executable.
3. Run worker preflight against the packaged artifact and protocol metadata.
4. Check class ID, bus layout, parameter manifest, state revision, and transport limits.
5. Start the worker.
6. Apply initial state and parameters when required.
7. Publish the graph revision only after the native transaction is ready.

If scanner, fingerprint, manifest, bus, protocol, or worker checks fail, the attachment stays unavailable. The app does not fall back to an unchecked launch path.

The attachment payload has strict size and count limits. The native decoder also accepts the current parameter-ID extension emitted by the TypeScript serializer. That compatibility fix was required for the real packaged VST campaign.

## Parameters

`host.vst.parameters` reports the parameters the native worker exposes for an attached instance.

Project-control writes use normalized values through `external-plugin.parameters.set`. The action must use processor and target IDs from the latest project snapshot.

A manual parameter edit can override scheduled automation for the same parameter during playback. The native host tracks those overrides and keeps the manual value in control until the override is cleared.

The current product flow requires stopped transport before automation re-enable succeeds. The low-level command itself is not documented as a stopped-transport guarantee, so treat this as current product behavior.

## State and persistence

Opaque plugin state is accepted only when it is at most 512 KiB and its SHA-256 digest matches the bytes.

For plugins that support state capture, the project can persist the captured state and use it for rebuild, editor teardown, export, and cold restart. A stateful attach or export fails if required state is missing or invalid.

Plugins that report no state support are recreated from defaults plus persisted parameter values.

Shared local state artifacts are reference-aware. Deleting one processor does not delete an artifact still used by another processor. Recovery may reuse an existing artifact only when the stored metadata and bytes match exactly.

## Editor lifecycle

A plugin that reports `supportsEditor` can create a native editor session.

The editor path:

1. starts a separate native supervisor
2. resolves and preflights the plugin again
3. applies state when needed
4. commits the native transaction
5. waits for the worker-ready message
6. opens the native editor window

Supported editor commands are open, close, focus, resize, and status. Parameter and editor events return through typed notifications.

The app captures editor state before teardown when the plugin and flow require it. Host loss and app shutdown tear down the editor session. Late callbacks from an older generation are ignored.

Plugins without editor support can still run for playback and export.

## Worker loss and recovery

A worker crash marks that worker as failed and cleans up its process group. The supervisor may rebuild from the previously validated startup request and state.

The native supervisor allows at most three worker restarts. Recovery still runs the normal manifest, fingerprint, protocol, and state checks. A restart is not a trust bypass.

If graph preparation, publication, or safe stop fails, the graph revision can be rolled back or retired instead of publishing half-applied native state.

The packaged acceptance campaign killed the isolated Valhalla playback worker on purpose, then verified that the next Play action rebuilt the worker and returned playback to `playing`.

## Cold restart

On desktop restart, the app discovers and revalidates the standard VST3 catalog before it resolves persisted attachments.

A stale catalog entry can be rescanned and repaired when the current files still satisfy the trust checks. The app does not silently run the old catalog record.

The certified Valhalla campaign verified that attachment, parameter state, playback readiness, and editor access survived a cold restart.

## Export

Native export resolves and preflights attachments again. It does not trust the currently running graph as proof that an export worker may start.

Stateful plugins need valid captured state. Stateless plugins use defaults plus persisted parameters.

The export path waits for the render result before plugin teardown. Offline workers do not initialize unused AppKit editor state.

Native Phase A mixdown projects enabled VST3 parameter automation into the same scheduled automation representation consumed by the native VST worker. Hold and linear interpolation are preserved, custom export ranges are rebased to offline frame zero, and the planner checks each worker's frame and callback-event limits before rendering. Mixer and built-in-effect automation remain unsupported in Native Phase A and are rejected instead of being silently omitted.

The packaged merge campaign independently verified a one-second stereo 48 kHz 16-bit PCM VST export without automation. The file was 192,044 bytes and contained nonzero signal. VST automation export was added after that campaign, so a fresh packaged run is required before treating that path as runtime-certified evidence.

## Packaged acceptance

ValhallaSupermassive 5.0.0 arm64 was the real installed plugin used for the merge gate.

The campaign verified:

- standard-directory discovery
- trust-gated scanning
- attachment and all 19 reported parameters
- native editor open and close
- manual Mix changes with public MCP verification
- playback, pause, and stop
- manual automation override and re-enable
- one-second WAV export with nonzero audio
- playback worker loss and recovery
- renderer reload and crash recovery
- cold restart with plugin and parameter state preserved
- stale catalog repair followed by playback and export

See the [runtime acceptance report](../acceptance-reports/control-platform-runtime-2026-08-20.md) for the full evidence trail.

## Current limits

- VST3 runs only in the macOS desktop app.
- The packaged native artifacts and release manifest must be present.
- First native execution requires trust acknowledgement.
- Every launch rechecks the current plugin files.
- Device availability, bus layout, editor support, state support, plugin behavior, or architecture can make an instance unavailable.
- Public control does not expose arbitrary plugin insertion, removal, editor control, or worker control.
- Native Phase A mixdown supports VST3 parameter automation but still rejects mixer and built-in-effect automation.
- Native stem export with VST3 remains outside the current native offline mixdown path.
- VST worker processes do not sandbox malicious plugin code.
