---
name: daw-vst3
description: Use for VST3, plugin scanning/trust, plugin parameters, native editor/playback worker behavior, or VST packaged acceptance/recovery.
---

# DAW VST3

Read both [the native VST3 reference](../../../docs/native-vst3.md) and
[the agent control manual](../../../docs/agent-control.md). Cross-check
`apps/desktop`, `native/plugin-host`, `packages/plugin-host-protocol`, and
`packages/desktop-protocol`.

Route public bounded instance and parameter reads to `daw-desktop-runtime`,
using `host.vst.instances` and `host.vst.parameters`. Route normalized
parameter writes to `daw-project-control`, using
`external-plugin.parameters.set` only when returned local capabilities
advertise it. VST insertion/removal and arbitrary editor manipulation are not
public operations. Preserve canonical-path, consent/trust, scanner,
fingerprint, packaged-artifact, worker-preflight, state-size, and SHA-256
checks.

Worker isolation is a crash/availability boundary, not a malicious-code
sandbox. For acceptance, terminate a worker only after independently proving
ownership by an isolated disposable app. Never use the normal profile or a
normal project for destructive acceptance. Do not manually mutate plugin state
artifacts, call raw native frames, load arbitrary plugins, or expose process
control.
