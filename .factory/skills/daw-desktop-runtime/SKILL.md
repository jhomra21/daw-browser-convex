---
name: daw-desktop-runtime
description: Use for playback, pause, stop, seek, host status, diagnostics, local import, local export, or VST discovery through an attached desktop host. This skill covers non-semantic Electron runtime operations, not project mutations.
---

# DAW desktop runtime

Read [the control architecture](../../../docs/control-platform.md) and
[the agent manual](../../../docs/agent-control.md). Use the existing
authenticated adapter and an attached desktop host; do not access
registration/socket internals manually.

Operation families:

- **Host status:** `host.status`.
- **Transport:** `transport.status`, `transport.play`, `transport.pause`,
  `transport.stop`, `transport.seek`.
- **Diagnostics:** `diagnostics.snapshot`.
- **Local media:** `host.import.audio`, `host.export.run`,
  `host.export.status`, `host.export.cancel`.
- **VST reads:** `host.vst.instances`, `host.vst.parameters`.

`daw-control rpc --target host` is the canonical **PROJECT CONTROL JSONL**
adapter over the authenticated desktop host. It is not generic runtime RPC.
VST parameter **WRITES** belong to canonical project control through
`external-plugin.parameters.set` when local capabilities advertise it; they
are not host runtime writes.

Route project discovery and every semantic mutation to `daw-project-control`.
Keep host runtime IDs separate from project semantic actions. Never infer
project state from host status, print registration/socket paths or credentials,
or bypass the public client.
