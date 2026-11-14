import { expect, test } from 'bun:test'

const realtimeSources = [
  new URL('../src/coreaudio-hal.mm', import.meta.url),
  new URL('../src/audio-host.cpp', import.meta.url),
  new URL('../src/acceptance-output-tap.h', import.meta.url),
  new URL('../../plugin-host/src/worker-control-service.cpp', import.meta.url),
]

const forbidden = [
  '.notify_',
  '.wait(',
  '.wait_for(',
  '.wait_until(',
  'condition_variable',
  'lock_guard',
  'mutex',
  'NotifyService(',
  'NotifyRecordingStatus(',
  'scoped_lock',
  'unique_lock',
  'malloc(',
  'calloc(',
  'realloc(',
  'fwrite(',
  'fprintf(',
  'printf(',
  'std::cerr',
  'std::make_unique',
  '.resize(',
  '.reserve(',
]

const markedRegions = (source: string) => {
  const regions: string[] = []
  const pattern = /DAW_REALTIME_CALLBACK_(?:REGION|HELPER)_BEGIN[^\n]*\n([\s\S]*?)\/\/ DAW_REALTIME_CALLBACK_(?:REGION|HELPER)_END/g
  for (const match of source.matchAll(pattern)) {
    const region = match[1]
    if (region) regions.push(region)
  }
  return regions
}

test('CoreAudio callback paths contain no scheduler wake, wait, or lock operations', async () => {
  for (const sourceUrl of realtimeSources) {
    const source = await Bun.file(sourceUrl).text()
    const regions = markedRegions(source)
    expect(regions.length).toBeGreaterThan(0)
    for (const region of regions) {
      for (const token of forbidden) expect(region).not.toContain(token)
    }
  }
  const core = await Bun.file(new URL('../../audio-core/src/audio_core.cpp', import.meta.url)).text()
  const seam = core.slice(core.indexOf('// DAW_REALTIME_CALLBACK_HELPER_BEGIN native-source-seam'),
    core.indexOf('// DAW_REALTIME_CALLBACK_HELPER_END native-source-seam'))
  expect(seam.length).toBeGreaterThan(0)
  for (const token of [...forbidden, 'new ', 'delete ', 'std::vector', '.erase(',
    'clear_sample_sources(', 'release_asset_storage(', 'last_event_sequence = 0']) {
    expect(seam).not.toContain(token)
  }
  expect(seam).toContain('std::sort(')
  expect(seam).toContain('if (!apply) return true')
  expect(seam).toContain('kSampleTerminationFadeMilliseconds')
  expect(seam).toContain('source.node_runtime_slot, source.node_runtime_generation')
  const sourceOwnership = core.slice(core.indexOf('// DAW_REALTIME_CALLBACK_HELPER_BEGIN sample-source-node-ownership'),
    core.indexOf('// DAW_REALTIME_CALLBACK_HELPER_END sample-source-node-ownership'))
  expect(sourceOwnership.length).toBeGreaterThan(0)
  for (const token of [...forbidden, 'new ', 'delete ', 'std::vector', '.erase(']) {
    expect(sourceOwnership).not.toContain(token)
  }
  expect(sourceOwnership).toContain('graph.node_slots[')
  expect(sourceOwnership).toContain('graph.node_generations[')
  expect(sourceOwnership).toContain('== source.node_runtime_generation')
  const publish = core.slice(core.indexOf('extern "C" daw_audio_core_result daw_audio_core_publish('),
    core.indexOf('extern "C" daw_audio_core_result daw_audio_core_cancel_prepared_graph('))
  expect(publish.length).toBeGreaterThan(0)
  expect(publish).not.toContain('snapshot_instrument_configurations(')
  expect(publish).not.toContain('build_processor_continuity_map(')
  expect(publish).not.toContain('seed_replacement_bypass(')
  expect(publish).not.toContain('same_core_graph_shape(')
  expect(publish).not.toContain('prepare_continuity_state(')
  // Publication is integer slot bookkeeping: histories are initialized when the
  // plan is prepared, never cleared or copied while the callback runs.
  const mentions = (region: string, token: string) => region.includes(token)
  for (const token of ['memset', 'memcpy', 'std::copy', 'std::fill', '= {}', '.fill(', 'new ', 'delete ', 'std::vector', 'resize(']) {
    expect(mentions(publish, token)).toBe(false)
  }
  const activation = core.slice(core.indexOf('void activate_prepared_runtime('),
    core.indexOf('extern "C" daw_audio_core_result daw_audio_core_publish('))
  expect(activation.length).toBeGreaterThan(0)
  const transport = core.slice(core.indexOf('extern "C" daw_audio_core_result daw_audio_core_set_transport('),
    core.indexOf('extern "C" daw_audio_core_result daw_audio_core_configure_synth('))
  expect(transport.length).toBeGreaterThan(0)
  expect(transport).toContain('core->transport.running == 0 && state->running == 0')
  expect(transport).toContain('state->frame != core->transport.frame')
  for (const token of [...forbidden, 'new ', 'delete ', 'memset', 'memcpy', '.fill(', 'std::vector']) {
    expect(transport).not.toContain(token)
  }
  const reconciliation = core.slice(core.indexOf('bool retained_scheduled_node('),
    core.indexOf('daw::audio_core::NativeLatencyTransition daw::audio_core::InspectLatencyTransition('))
  expect(reconciliation.length).toBeGreaterThan(0)
  for (const token of [...forbidden, 'new ', 'delete ', 'std::vector']) {
    expect(reconciliation).not.toContain(token)
  }
  for (const token of ['memset', 'initialize_processor_slot', 'free_processor_slot_histories', 'reclaim_retired_slots', 'seed_replacement_bypass']) {
    expect(mentions(activation, token)).toBe(false)
  }
  // Rendering includes the chain helpers that crossfade removed processors: a
  // fading run is rendered in place on stack storage, with one ramp per run.
  const rendering = core.slice(core.indexOf('struct ChainItem {'), core.indexOf('bool bind_process_transport('))
  expect(rendering.indexOf('render_chain_segment(')).toBeGreaterThan(0)
  expect(rendering.indexOf('void process_graph(')).toBeGreaterThan(rendering.indexOf('render_chain_segment('))
  for (const token of ['reclaim_retired_slots(', 'initialize_processor_slot(', 'RetirementLane', 'new ', 'std::vector', 'memset']) {
    expect(mentions(rendering, token)).toBe(false)
  }
  const chainSegment = core.slice(core.indexOf('bool render_chain_segment('), core.indexOf('void process_graph('))
  expect(chainSegment.length).toBeGreaterThan(0)
  expect([...chainSegment.matchAll(/deletion_fade_gain\(/g)].length).toBe(1)
  // Ghost edges, including key edges, are plan data; the callback reads the
  // key's processor from the plan and never searches for it.
  expect(core).toContain('edge_target_processors')
  // Transition storage is dynamic: output planes share the config-sized stage
  // allocation instead of a fixed 8192-frame array per node.
  expect(core).not.toContain('graph_buffers')
  // A transition the live core cannot hold fails the edit. The host must not
  // answer exhaustion by publishing a fresh core, and a claimed patch that was
  // never acknowledged blocks graph preparation.
  const host = await Bun.file(new URL('../src/audio-host.cpp', import.meta.url)).text()
  // Bank publication is index bookkeeping. Never reset, copy, or reclaim a
  // schedule bank on the callback, including late-frame and transport paths.
  const callback = host.slice(host.indexOf('bool AudioHost::ProcessPlanar('),
    host.indexOf('bool AudioHost::ProcessRecordingPlanar('))
  expect(callback.length).toBeGreaterThan(0)
  for (const token of ['ResetPreparedSchedule(', '.Reset(', 'schedule_banks =', 'std::move(', 'delete ']) {
    expect(callback).not.toContain(token)
  }
  expect(callback).toContain('active_schedule_bank.store(')
  expect(callback).toContain('publication_rebase_required.store(true')
  expect(callback).toContain('schedule_owner.compare_exchange_strong(')
  // Sorted schedule heads are constant-time. Direct source commands may be
  // unordered, so that lane's scan is bounded by its preallocated capacity.
  const seamGuard = callback.slice(callback.indexOf('const auto has_pre_seam_event ='),
    callback.indexOf('if (old_bank_pending)'))
  expect(seamGuard.length).toBeGreaterThan(0)
  expect(seamGuard).toContain('source ? Capacity : 1')
  expect(seamGuard).toContain('index < count')
  expect(seamGuard).not.toMatch(/\bwhile\s*\(/)
  expect(seamGuard).toContain('scheduled_processor_queue')
  expect(seamGuard).toContain('source_queue')
  expect(callback).toContain('instrument_drain_priority')
  expect(callback.indexOf('if ((impl_->ActiveSchedule().instrument_drain_priority'))
    .toBeLessThan(callback.indexOf('|| !drain_instrument_lane(impl_->urgent_queue'))
  const prepare = host.slice(host.indexOf('GraphRevisionStatus AudioHost::PrepareGraphRevision('),
    host.indexOf('bool AudioHost::ConfigureInstrumentStates('))
  expect(prepare.length).toBeGreaterThan(0)
  expect(prepare).not.toMatch(/same_core_result == DAW_AUDIO_CORE_(RETIREMENT_)?CAPACITY_EXCEEDED/)
  // Native latency changes use read-head seams, never a revision-core fallback.
  expect(prepare).not.toMatch(/!=\s*DAW_AUDIO_CORE_GRAPH_COMPATIBILITY_REJECTED/)
  expect(prepare).not.toContain('DAW_AUDIO_CORE_LATENCY_CHANGE_DEFERRED')
  expect(prepare).not.toContain('CreateRevisionCore(')
  expect(prepare).toContain('LatencyTransitionPending(')
  expect(host).not.toContain('WaitForLatencyCompletion(')
  const hostPublish = host.slice(host.indexOf('GraphRevisionStatus AudioHost::PublishGraphRevision('),
    host.indexOf('GraphRevisionStatus AudioHost::InspectGraphRevision('))
  expect(hostPublish).not.toContain('WaitForCallbackRequest(')
  expect(hostPublish).toContain('kPublishPending')
  expect(prepare).toContain('claimed_processor_patch.Pending(')
  const queuePatch = host.slice(host.indexOf('ProcessorPatchStatus AudioHost::QueueProcessorStatePatch('),
    host.indexOf('bool AudioHost::QueueInstrumentEvents('))
  expect(queuePatch.length).toBeGreaterThan(0)
  expect(queuePatch).toContain('WaitForCallbackRequest(')
  expect(queuePatch).toContain('claimed_processor_patch.Record(')
  expect(queuePatch).not.toContain('wait_for(')
  // The callback applies a requested patch only through one marked helper, so the guard
  // scans exactly the code that publishes the resolved record.
  expect(host).toContain('// DAW_REALTIME_CALLBACK_HELPER_BEGIN processor-patch-apply')
  expect(callback).toContain('ApplyRequestedProcessorPatch(')
  expect(callback).not.toContain('processor_patch_requested.exchange(')
  // Manual parameter overrides are callback-owned and live in the processor's
  // runtime slot. A plan's processor carries none, so preparing a ghost copies
  // only immutable configuration and never reads what the callback writes.
  const processorStruct = core.slice(core.indexOf('struct Processor {'), core.indexOf('uint32_t processor_count = 0;'))
  expect(processorStruct.length).toBeGreaterThan(0)
  expect(processorStruct).not.toContain('live_parameter')
  expect(core).not.toContain('live_parameter')
  const ghostPreparation = core.slice(core.indexOf('daw_audio_core_result append_deletion_ghosts('),
    core.indexOf('void collect_released_slots('))
  expect(ghostPreparation.length).toBeGreaterThan(0)
  for (const token of ['processor_overrides', 'override_parameter', 'drop_deletion_ghosts', 'fade_elapsed']) {
    expect(mentions(ghostPreparation, token)).toBe(false)
  }
  expect(core).not.toContain('drop_deletion_ghosts')
  // A stage already fading on its own clock keeps it when its node is deleted too.
  expect(ghostPreparation).toContain('old.detached ||')
  // Each object keeps or replaces its own runtime. Bypass is a parameter, and the
  // only graph-wide verdict left is latency: no structure, layout, bus or
  // processor comparison may turn one object's edit into a reset of the rest.
  const processorHistory = core.slice(core.indexOf('bool compatible_processor_history('),
    core.indexOf('struct ProcessorContinuityMap {'))
  expect(processorHistory.length).toBeGreaterThan(0)
  expect(processorHistory).not.toContain('bypassed')
  // The product compiles a bypass as the plan flag and the stage's own enabled flag
  // cleared together, so toggling either must keep the slot. Only an EQ band's
  // enable, which changes which filters exist, is structural.
  expect([...processorHistory.matchAll(/\.enabled/g)].length).toBe(2)
  expect(processorHistory).toContain('bands[band].enabled')
  // No graph-wide verdict is left at all: a latency change moves read heads, and
  // the one structural replacement, a Spectral FFT size change, is decided per
  // processor from its own kind and size and nothing else.
  for (const verdict of ['latency_continuity_compatible', 'spectral_size_continuity_compatible', '= ContinuityPreparationResult::kIncompatible']) {
    expect(core).not.toContain(verdict)
  }
  const sizeReplacement = core.slice(core.indexOf('bool replaced_by_spectral_size_change('),
    core.indexOf('ProcessorContinuityMap build_processor_continuity_map('))
  expect(sizeReplacement.length).toBeGreaterThan(0)
  expect(sizeReplacement).toContain('spectral.fft_size')
  for (const token of ['input_bus', 'input_layout', 'output_layout', 'bypassed', 'compatible_processor_history']) {
    expect(mentions(sizeReplacement, token)).toBe(false)
  }
  expect(core).not.toContain('prepared_instrument_configurations_compatible')
  // A deleted key hands the detector back to the processor's own input as it
  // fades; the callback reads the plan, never searches for or retires the edge.
  const keyedFrame = core.slice(core.indexOf('void render_chain_frame('), core.indexOf('bool render_chain_segment('))
  expect(keyedFrame).toContain('own_left * (1.0F - key_level)')
  expect(keyedFrame).toContain('ghost_edge_fade_gain(')
  expect(keyedFrame).toContain('edge_join_gain(')
  // One bypass mechanism for every processor kind. A restructure hands the old
  // slot's actual position to the new one at publish, on the callback side and
  // validated by identity and generation; preparation only seeds a fresh slot and
  // never reads a value the callback writes.
  expect(core).not.toContain('seed_replacement_bypass')
  expect(publish).toContain('hand_off_bypass(')
  const handOff = core.slice(core.indexOf('void hand_off_bypass('),
    core.indexOf('bool mark_replaced_node(const Core &core, const GraphRevision &current, GraphRevision &next, uint32_t node) {'))
  expect(handOff.length).toBeGreaterThan(0)
  const seeding = core.slice(core.indexOf('void seed_bypass('), core.indexOf('void hand_off_bypass('))
  expect(seeding.length).toBeGreaterThan(0)
  // A stage built bypassed (a graph's first plan, an addition) starts on its dry
  // signal: the seed reads the plan's own request, with no value the callback writes.
  expect(seeding).toContain('bypass_requested(fresh)')
  const ownership = core.slice(core.indexOf('daw_audio_core_result prepare_runtime_ownership(Core &core) {'),
    core.indexOf('bool prepared_runtime_current('))
  expect(ownership).toContain('seed_bypass(')
  expect(ownership).not.toContain('hand_off_bypass(')
  const bypassMixer = core.slice(core.indexOf('float advance_bypass('), core.indexOf('float bypass_mix('))
  expect(bypassMixer.length).toBeGreaterThan(0)
  for (const kind of ['saturator', 'eq', 'dynamics', 'utility']) {
    expect(core).toContain(`${kind}_histories[processor.history_slot].bypass`)
  }
  // A node whose stages are reordered dips on the callback: its output goes to nothing
  // through the order it was running, and returns through the plan's order. No copy of
  // output or state is kept (the mirror ring is gone, as are the 3 MiB it cost): a dip is
  // four integers and a fixed list of processor indices per node slot, every function
  // below allocates and searches nothing, and each processor still runs once per sample.
  // A layout change and a replaced instrument crossfade their waveforms instead, from
  // per-slot levels and a fixed-size chain of the instruments being replaced.
  for (const retired of ['splice_node_output', 'kOutputRingFrames', 'kOutputMirrorFrames', 'kInaudibleSpliceStep',
    'node_splices', 'node_spliced', 'begin_node_splices', 'mark_spliced_nodes', 'NodeSplice']) {
    expect(core).not.toContain(retired)
  }
  const dip = core.slice(core.indexOf('uint32_t dip_half_frames('), core.indexOf('void process_graph('))
  expect(dip.length).toBeGreaterThan(0)
  for (const fn of ['uint32_t dip_old_frames(', 'uint32_t dip_hold_frames(', 'void apply_node_dip(', 'void order_chain_for_dip(', 'bool render_node_chain(']) {
    expect(dip).toContain(fn)
  }
  expect(core).toContain('std::array<NodeDip, kNodeRuntimeSlots> node_dips')
  expect(core).toContain('std::array<uint16_t, kMaximumNodeChain> order')
  for (const token of ['new ', 'std::vector', 'memset', 'resize(', 'memcpy', 'graph_node_index(', 'std::mutex']) {
    expect(mentions(dip, token)).toBe(false)
  }
  // The block is split between the two orders at the frame the output reaches nothing,
  // so a stage never renders twice for one sample.
  expect(dip).toContain('render_chain_segment(core, graph, node_index, 0, old_frames, old_items, count)')
  expect(dip).toContain('render_chain_segment(core, graph, node_index, old_frames, frame_count, items, count)')
  // Publish only starts or carries a dip: integers, the fixed order list and a struct
  // copy for a replaced instrument's node; nothing there allocates.
  const beginDips = core.slice(core.indexOf('void carry_node_dip('),
    core.indexOf('daw_audio_core_result prepare_runtime_ownership(Core &core) {'))
  expect(beginDips.length).toBeGreaterThan(0)
  expect(beginDips).toContain('void begin_node_dips(')
  expect(publish).toContain('begin_node_dips(')
  expect(beginDips).toContain('void begin_edge_ramps(')
  expect(publish).toContain('begin_edge_ramps(')
  for (const token of ['new ', 'std::vector', 'memcpy', 'memset', 'resize(', 'std::mutex']) {
    expect(mentions(beginDips, token)).toBe(false)
  }
  const blends = core.slice(core.indexOf('void end_node_blend('), core.indexOf('void process_graph('))
  expect(blends).toContain('void advance_node_blends(')
  expect(blends).toContain('float advance_fold(')
  expect(blends).toContain('void render_instrument_state(')
  const blending = core.slice(core.indexOf('void process_graph('), core.indexOf('bool bind_process_transport('))
  expect(blending).toContain('std::array<InstrumentLink, kMaximumNodeBlends + 1> instrument_links')
  expect(blending).toContain('apply_node_dip(core, graph, node_index, block.frame_count, old_frames, hold_frames)')
  for (const region of [handOff, seeding, blends]) {
    for (const token of ['new ', 'std::vector', 'resize(', 'std::mutex', 'memset', 'memcpy']) {
      expect(mentions(region, token)).toBe(false)
    }
  }
  // The dip a reorder leaves on a node slot, the layout folds and the replaced
  // instruments beside it are all callback-written, per slot. A slot that leaves a
  // plan is cleared when it is reclaimed on the control thread, so the node that
  // takes it next starts from nothing; publish and activation never clear anything.
  const nodeSlotInit = core.slice(core.indexOf('void initialize_node_slot('), core.indexOf('void free_processor_slot_histories('))
  for (const field of ['end_node_blend(', 'node_dips[slot]', 'node_folds[slot]', 'node_blends[slot]']) {
    expect(nodeSlotInit).toContain(field)
  }
  const reclaim = core.slice(core.indexOf('void reclaim_retired_slots('), core.indexOf('int32_t acquire_runtime_slot('))
  expect(reclaim).toContain('initialize_node_slot(core, index)')
  expect(publish).not.toContain('initialize_node_slot')
  expect(activation).not.toContain('initialize_node_slot')
  // A replacement that would exceed the chain a node may blend fails the edit.
  const replaced = core.slice(core.indexOf('bool mark_replaced_node('), core.indexOf('bool mark_reordered_nodes('))
  expect(replaced).toContain('kMaximumNodeBlends')
  expect(core).not.toContain('node_splice_from')
  // The systematic transition matrix and the round-3 contracts run in the default
  // native gate, not only as opt-in cases.
  const nativeTest = await Bun.file(new URL('../../audio-core/tests/audio_core_test.cpp', import.meta.url)).text()
  const defaultGate = nativeTest.slice(nativeTest.indexOf('if (argc != 1) return 2;'))
  for (const name of [
    'test_phase3_non_latency_edit_touches_only_its_own_object',
    'test_phase3_edit_that_cannot_be_carried_fails_instead_of_resetting',
    'test_phase3_deleting_a_node_keeps_its_processors_running_fade',
    'test_phase3_deleted_key_hands_the_detector_back_to_its_own_input',
    'test_phase3_every_kind_bypass_ramps_alike',
    'test_phase3_restructure_mid_bypass_keeps_the_ramp',
    'test_phase3_reorder_dips_through_nothing',
    'test_phase3_ungroup_hands_children_from_the_group_to_the_direct_route',
    'test_phase3_send_deletion_and_addition_ramp',
    'test_phase3_instrument_replacement_hands_over_without_a_step',
    'test_phase3_reused_node_slot_starts_clean',
    'test_phase3_reclaimed_slots_are_pristine',
    'test_phase3_compiled_bypass_is_a_parameter_not_a_restructure',
    'test_phase3_initially_bypassed_stage_starts_dry',
    'test_phase3_instrument_replacement_crossfades_the_waveform',
    'test_phase3_replacement_depth_is_bounded_and_recovers',
    'test_phase3_reorder_steps_stay_small_at_every_rate',
    'test_phase3_reorder_does_not_replay_expired_transients',
    'test_phase3_reorder_during_a_dip_continues_it',
    'test_phase3_reorder_with_an_external_stage_dips_at_block_edges',
    'test_phase3_reused_node_slot_has_no_dip',
    'test_phase3_reorder_never_exceeds_the_envelope_of_either_order',
    'test_phase3_reorder_residue_decays_through_a_resonant_high_pass',
    'test_phase3_stages_are_what_the_compiler_emits',
  ]) expect(defaultGate).toContain(`${name}();`)
  for (const name of ['test_phase3_layout_change_ramps(true)', 'test_phase3_layout_change_ramps(false)',
    'test_phase3_layout_change_crossfades_the_waveform(true)', 'test_phase3_layout_change_crossfades_the_waveform(false)',
    'test_phase3_transition_matrix(false)']) expect(defaultGate).toContain(`${name};`)
  // Only the callback writes an override table; the control thread clears one
  // when it reclaims the slot or applies a state patch to the published plan.
  const overrideWrites = [...core.matchAll(/processor_overrides\[[^\]]*\]\.count = 0/g)].length
  expect(overrideWrites).toBe(2)
  const latch = core.slice(core.indexOf('void latch_processor_parameter_values('), core.indexOf('float clamp_bypass_step('))
  expect(latch).toContain('processor_overrides[processor.history_slot]')
  expect(latch).toContain('core.mixer_latches[mixer.slot]')
  for (const token of ['new ', 'std::vector', 'memset', 'resize(']) expect(mentions(latch, token)).toBe(false)
  // Native hooks are core-lifetime immutable plan banks, not mutable DSP
  // runtime. Publication must swap pointers, not the large inline bank.
  expect(core.includes('NativeGraphHooks *prepared_native_hooks')).toBe(true)
  expect(core.includes('NativeGraphHooks *published_native_hooks')).toBe(true)
  expect(publish).not.toContain('std::swap(*core->published_native_hooks')
})

// A prepared graph always lives in the active core and a publication always retires inside it. No revision core is
// created, so nothing is destroyed on publish, rollback or the callback, and no flag says which kind a graph is.
test('publish, rollback and the callback keep no revision-core branch', async () => {
  const host = await Bun.file(new URL('../src/audio-host.cpp', import.meta.url)).text()
  const slices = {
    publish: host.slice(host.indexOf('GraphRevisionStatus AudioHost::PublishGraphRevision('),
      host.indexOf('GraphRevisionStatus AudioHost::InspectGraphRevision(')),
    rollback: host.slice(host.indexOf('GraphRevisionStatus AudioHost::RollbackGraphRevision('),
      host.indexOf('GraphRevisionStatus AudioHost::RetireGraphRevision(')),
    callback: host.slice(host.indexOf('bool AudioHost::ProcessPlanar('), host.indexOf('bool AudioHost::ProcessRecordingPlanar(')),
  }
  for (const [name, slice] of Object.entries(slices)) {
    expect(slice.length, name).toBeGreaterThan(0)
    for (const token of ['prepared_core_is_same_core', 'retired_core', 'retired_same_core', 'RetireSameCorePlan',
      'daw_audio_core_destroy(impl_->prepared_core', 'previous_core']) expect(slice, `${name}: ${token}`).not.toContain(token)
  }
  for (const token of ['prepared_core_is_same_core', 'retired_core', 'retired_same_core', 'RetireSameCorePlan',
    'daw_audio_core_destroy(impl_->prepared_core']) expect(host).not.toContain(token)
  expect(slices.rollback).toContain('daw_audio_core_cancel_prepared_graph(impl_->prepared_core')
})

test('AudioHost publishes running state before opening CoreAudio', async () => {
  const source = await Bun.file(new URL('../src/audio-host.cpp', import.meta.url)).text()
  const start = source.slice(source.indexOf('bool AudioHost::Start()'))
  const runningPublication = start.indexOf('impl_->state.store(LifecycleState::kRunning')
  const deviceOpen = start.indexOf('StartCoreAudioDevice(')
  expect(runningPublication).toBeGreaterThanOrEqual(0)
  expect(deviceOpen).toBeGreaterThan(runningPublication)
})

test('asset reader completion is bounded and reclamation stays off the callback', async () => {
  const host = await Bun.file(new URL('../src/audio-host.cpp', import.meta.url)).text()
  const core = await Bun.file(new URL('../../audio-core/src/audio_core.cpp', import.meta.url)).text()
  const readers = core.slice(core.indexOf('// DAW_REALTIME_CALLBACK_HELPER_BEGIN native-asset-reader-completion'),
    core.indexOf('// DAW_REALTIME_CALLBACK_HELPER_END native-asset-reader-completion'))
  expect(readers.length).toBeGreaterThan(0)
  for (const token of [...forbidden, 'new ', 'delete ', '.erase(', 'release_asset_storage(',
    'find_asset(', 'prepared_instrument_configs', 'while (']) expect(readers).not.toContain(token)
  expect(readers).toContain('std::array<bool, kMaximumAssets>')
  expect(readers).toContain('compare_exchange_strong(requested, requested + 1')
  for (const region of markedRegions(host)) {
    for (const token of ['ReclaimAssets(', 'ReclaimAsset(', 'release_asset_storage(', 'munmap(', 'munlock(']) {
      expect(region).not.toContain(token)
    }
  }
  const callback = host.slice(host.indexOf('bool AudioHost::ProcessPlanar('))
  expect(callback.indexOf('daw::audio_core::CompleteAssetReaders(active_core,')).toBeLessThan(
    callback.indexOf('impl_->completed_render_epoch.fetch_add(1'))
})

test('render-enabled native VST processing is not gated by tail metadata or silence gaps', async () => {
  const source = await Bun.file(new URL('../src/audio-host.cpp', import.meta.url)).text()
  const processStart = source.indexOf('void Process(const daw::audio_core::NativeGraphNodeRender& render)')
  const processEnd = source.indexOf('\n  }\n};', processStart)
  expect(processStart).toBeGreaterThanOrEqual(0)
  expect(processEnd).toBeGreaterThan(processStart)
  const process = source.slice(processStart, processEnd)
  expect(process).toContain('if (!metadata.render_enabled)')
  expect(process).toContain('port.Submit(')
  expect(process).not.toContain('ReadTailMetadata')
  expect(process).not.toContain('tail_remaining_frames')
  expect(process).not.toContain('silent_completion')
  expect(process).not.toContain('kNativeVstTailGraceFrames')
})
