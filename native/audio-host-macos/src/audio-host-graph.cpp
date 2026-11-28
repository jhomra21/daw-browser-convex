#include "audio-host-internal.h"

namespace daw::audio_host_macos {

namespace {

constexpr std::uint64_t kInstrumentDeviceBytes = 1ULL << 30;

bool LockInstrumentMemory(void* address, const std::size_t bytes) {
#if defined(DAW_AUDIO_HOST_TEST_MEMORY_LOCK)
  if (daw_audio_host_test_fail_memory_lock()) return false;
#endif
  return mlock(address, bytes) == 0;
}

constexpr std::size_t kGranularStateWireBytes = 60;

void LogGraphPrepareFailure(
  const std::uint32_t revision,
  const daw_audio_core_result result,
  const daw_audio_core_handle core
) {
  const auto diagnostic = daw_audio_core_get_graph_validation_diagnostic(core);
  if (diagnostic.code == DAW_AUDIO_CORE_GRAPH_VALIDATION_PDC_DELAY_EXCEEDS_RING_CAPACITY) {
    std::fprintf(stderr, "This path requires %u frames of compensation delay. The product maximum is 65,536 frames (1.37 s at 48 kHz).\n", diagnostic.actual);
  } else if (diagnostic.code == DAW_AUDIO_CORE_GRAPH_VALIDATION_PATH_LATENCY_EXCEEDS_PRODUCT_MAXIMUM) {
    std::fprintf(stderr, "This graph path reports %u frames of latency. The product maximum is 65,536 frames (1.37 s at 48 kHz).\n", diagnostic.actual);
  } else if (diagnostic.code == DAW_AUDIO_CORE_GRAPH_VALIDATION_KEEP_LATENCY_DIVERGENT_MIXED_BUS) {
    std::fprintf(stderr, "Keep Latency cannot mix monitored and compensated signals in a bus with unequal downstream latency paths (%u versus %u frames). Route them through separate buses.\n", diagnostic.actual, diagnostic.limit);
  }
  std::fprintf(
    stderr,
    "[native-graph] prepare rejected {revision:%u,result:%u,diagnostic:%u,index:%u,actual:%u,limit:%u}\n",
    revision,
    static_cast<unsigned int>(result),
    diagnostic.code,
    diagnostic.index,
    diagnostic.actual,
    diagnostic.limit);
}

PlanRouting ReadPlanRouting(const daw::audio_core::GraphView& graph) {
  PlanRouting plan;
  for (std::uint32_t index = 0; index < graph.node_count; ++index) plan.nodes.push_back(graph.nodes[index].id);
  for (std::uint32_t index = 0; index < graph.edge_count; ++index) {
    const auto& edge = graph.edges[index];
    plan.edges.push_back({edge.from_node_id, edge.to_node_id, edge.target_processor_id, edge.tap, edge.sidechain});
  }
  return plan;
}

}  // namespace

bool AudioHost::PrepareAndPublishGraph(const std::uint32_t revision, const std::span<const std::uint8_t> snapshot) {
  const auto prepared = PrepareGraphRevision(revision, snapshot);
  if (prepared.code != GraphRevisionStatusCode::kPrepared) return false;
  const auto published = PublishGraphRevision(revision);
  if (published.code != GraphRevisionStatusCode::kPublished) {
    const auto reconciled = InspectGraphRevision(revision);
    if (reconciled.code == GraphRevisionStatusCode::kPrepared)
      static_cast<void>(RollbackGraphRevision(revision));
    return false;
  }
  if (published.retired_revision != 0) {
    const auto retired = RetireGraphRevision(published.retired_revision);
    if (retired.code != GraphRevisionStatusCode::kRetired) return false;
  }
  return true;
}

GraphRevisionStatus AudioHost::PrepareGraphRevision(
  const std::uint32_t revision,
  const std::span<const std::uint8_t> snapshot,
  const std::uint64_t requested_frame
) {
  impl_->Evidence("graph-prepare", "", revision);
  const auto status = [this, revision](const GraphRevisionStatusCode code) {
    return impl_->GraphStatus(code, revision);
  };
  const auto now = [this] {
    return impl_->observer ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
  };
  Impl::PrepareMarks marks{.entered = now()};
  // The renderer prepares as soon as it hears a worker's latency report, which can be before the control loop has
  // read it; the graph's latency and the attachment bindings must agree.
  ProcessNativeVstControl();
  marks.controlled = now();
  if (impl_->active_core.load(std::memory_order_acquire) == 0 || revision == 0
    || snapshot.size() <= kNativeGraphFrameHeaderBytes || snapshot.size() > kMaximumControlPayloadBytes) {
    return status(GraphRevisionStatusCode::kInvalidRevision);
  }
  // Existing pending code: admission is retryable, not a failed preparation.
  if (impl_->LatencyTransitionPending()) return status(GraphRevisionStatusCode::kPublishPending);
  if (impl_->publication_in_flight != 0) return status(GraphRevisionStatusCode::kPublishPending);
  // The controller keeps the old graph and prepares again at its next opportunity.
  if (impl_->StagedVstStarting()) return status(GraphRevisionStatusCode::kPublishPending);
  if (requested_frame != 0) {
    const auto progress = static_cast<std::uint64_t>(impl_->applied_transport_frame.load(std::memory_order_acquire));
    if (requested_frame > INT64_MAX - impl_->config.max_frames_per_block
      || requested_frame <= progress || (requested_frame - progress) % impl_->config.max_frames_per_block != 0)
      return status(GraphRevisionStatusCode::kInvalidRevision);
  }
  if (impl_->prepared_core != 0
    || revision <= impl_->last_graph_revision.load(std::memory_order_acquire)) {
    return status(GraphRevisionStatusCode::kStaleRevision);
  }
  // Accepted controls still belong to the active graph. Let callbacks consume
  // them before preparing, without rejecting the user's newer graph as stale.
  if (impl_->HasQueuedGraphControl()) return status(GraphRevisionStatusCode::kPublishPending);
  // Preparing copies the published plan the claimed patch is still mutating. The claim
  // lasts until its resolution has been reported.
  if (impl_->claimed_processor_patch.Pending(impl_->processor_patch_reported_token)) {
    return status(GraphRevisionStatusCode::kPrepareFailed);
  }
  const std::uint64_t framed_revision = (static_cast<std::uint64_t>(snapshot[0]) << 56U)
    | (static_cast<std::uint64_t>(snapshot[1]) << 48U)
    | (static_cast<std::uint64_t>(snapshot[2]) << 40U)
    | (static_cast<std::uint64_t>(snapshot[3]) << 32U)
    | (static_cast<std::uint64_t>(snapshot[4]) << 24U)
    | (static_cast<std::uint64_t>(snapshot[5]) << 16U)
    | (static_cast<std::uint64_t>(snapshot[6]) << 8U)
    | static_cast<std::uint64_t>(snapshot[7]);
  const std::uint32_t payload_size = ReadU32(snapshot.data() + 8);
  if (framed_revision != revision || framed_revision > std::numeric_limits<std::uint32_t>::max()
    || payload_size != snapshot.size() - kNativeGraphFrameHeaderBytes) {
    return status(GraphRevisionStatusCode::kInvalidRevision);
  }
  const auto payload = snapshot.subspan(kNativeGraphFrameHeaderBytes);
  // The last invariant of capture-bound routing, checked before anything is prepared or reclaimed: a take bound to
  // node X records X's signal through its output, group and send chain, so no revision may remove or reroute it.
  const auto graph = daw::audio_core::DecodeGraphView(payload);
  auto routing = graph ? std::optional{ReadPlanRouting(*graph)} : std::nullopt;
  if (const auto target = impl_->CaptureTarget();
    target && (!impl_->published_routing || !routing || !CaptureTargetKept(*impl_->published_routing, *routing, *target))) {
    return status(GraphRevisionStatusCode::kCaptureTargetLocked);
  }
  // Control-thread reclamation only. A completed predecessor must not make a
  // newer edit stale; an unfinished reader/transition keeps admission retryable.
  if (impl_->HasRetiredPlan()
    && RetireGraphRevision(impl_->retired_revision.load(std::memory_order_acquire)).code
      != GraphRevisionStatusCode::kRetired) {
    return status(GraphRevisionStatusCode::kPublishPending);
  }
  impl_->prepared_instrument_assets = impl_->published_instrument_assets;
  // Graph envelopes have already been validated below before publication.
  // Drop removed nodes from the next bank without releasing their resident data.
  if (graph) {
    std::unordered_set<std::uint64_t> nodes;
    for (std::uint32_t index = 0; index < graph->node_count; ++index) {
      const auto& node = graph->nodes[index];
      if (node.kind != DAW_AUDIO_GRAPH_NODE_INSTRUMENT) continue;
      nodes.insert(node.id);
      if (node.instrument.kind == DAW_AUDIO_INSTRUMENT_KIND_SYNTH) {
        const auto found = impl_->prepared_instrument_assets.find(node.id);
        if (found != impl_->prepared_instrument_assets.end()) found->second.clear();
      }
    }
    std::erase_if(impl_->prepared_instrument_assets, [&](const auto& entry) { return !nodes.contains(entry.first); });
  }
  const daw_audio_core_handle prepared_core = impl_->active_core.load(std::memory_order_acquire);
  daw::audio_core::SetPrepareProfiling(prepared_core, impl_->observer != nullptr);
  marks.before_core = now();
  const auto prepare_result = daw_audio_core_prepare_graph_bytes(
    prepared_core, payload.data(), static_cast<std::uint32_t>(payload.size()));
  marks.after_core = now();
  if (prepare_result == DAW_AUDIO_CORE_LATENCY_MOVE_PENDING)
    return status(GraphRevisionStatusCode::kPublishPending);
  if (prepare_result != DAW_AUDIO_CORE_OK || daw_audio_core_prepared_graph_continuity(prepared_core) == 0) {
    // Capacity/trust/malformed-plan failures leave ongoing audio alone. Native
    // latency edits never select a cold core or portable continuity fallback.
    if (prepare_result == DAW_AUDIO_CORE_OK)
      static_cast<void>(daw_audio_core_cancel_prepared_graph(prepared_core, revision));
    impl_->prepared_continuity = GraphRevisionContinuity::kRejected;
    LogGraphPrepareFailure(revision, prepare_result, prepared_core);
    auto rejected = status(GraphRevisionStatusCode::kPrepareFailed);
    rejected.diagnostic_code = daw_audio_core_get_graph_validation_diagnostic(prepared_core).code;
    return rejected;
  }
  impl_->requested_publication_frame = requested_frame;
  impl_->prepared_transport_context.reset();
  impl_->prepared_transport_epoch = impl_->transport_epoch.load(std::memory_order_acquire);
  impl_->ResetPreparedSchedule(revision, impl_->prepared_transport_epoch, requested_frame);
  impl_->publication_rebase_required.store(false);
  impl_->prepared_instruments_ready = false;
  impl_->prepared_continuity = GraphRevisionContinuity::kAccepted;
  const auto discard_prepared = [&] {
    static_cast<void>(daw_audio_core_cancel_prepared_graph(prepared_core, revision));
    impl_->prepared_asset_handles.clear();
  };
  auto& candidate_lookup = impl_->observation_lookups[
    1U - impl_->active_observation_lookup.load(std::memory_order_acquire)];
  candidate_lookup = {};
  impl_->prepared_instrument_targets.clear();
  if (graph && (graph->version == DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION
    || graph->version == DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION_EXTERNAL_LATENCY
    || graph->version == DAW_AUDIO_CORE_NATIVE_GRAPH_ENVELOPE_VERSION_KEEP_LATENCY)) {
    candidate_lookup.node_count = graph->node_count;
    for (std::uint32_t index = 0; index < graph->node_count; ++index) {
      const auto& node = graph->nodes[index];
      candidate_lookup.node_ids[index] = node.id;
      if (node.kind == DAW_AUDIO_GRAPH_NODE_INSTRUMENT) impl_->prepared_instrument_targets.emplace(node.id, node.instrument);
    }
  }
  if (!impl_->RegisterPreparedGraphHooks(prepared_core, revision)) {
    impl_->prepared_continuity = GraphRevisionContinuity::kRejected;
    discard_prepared();
    return status(GraphRevisionStatusCode::kPrepareFailed);
  }
  impl_->prepared_core = prepared_core;
  impl_->prepared_revision.store(revision, std::memory_order_release);
  impl_->prepared_routing = std::move(routing);
  impl_->SettlePreparedInstruments();
  impl_->PrepareProfileEvidence(revision, prepared_core, marks);
  return status(GraphRevisionStatusCode::kPrepared);
}

bool AudioHost::ConfigureInstrumentStates(const std::span<const std::uint8_t> payload) {
  impl_->instrument_preparation_error = "invalid instrument state payload";
  if (impl_->publication_in_flight != 0) {
    impl_->instrument_preparation_error = "graph publication is still pending";
    return false;
  }
  const daw_audio_core_handle target_core = impl_->prepared_core != 0
    ? impl_->prepared_core
    : impl_->active_core.load(std::memory_order_acquire);
  if (target_core == 0) {
    impl_->instrument_preparation_error = "audio session is unavailable";
    return false;
  }
  if (payload.size() < 4) return false;
  const std::uint32_t count = ReadLeU32(payload.data());
  if (count > 64) return false;
  if (count == 0 && payload.size() == 4) {
    impl_->SettlePreparedInstruments();
    return true;
  }
#if defined(DAW_AUDIO_HOST_TEST_MEMORY_LOCK)
  daw_audio_host_test_validation_memory(true);
#endif
  std::unordered_set<Impl::InstalledAsset*> candidates;
  Impl::InstrumentAssets configured_assets;
  // One decoded, validated record. Building it changes nothing; only the commit below does.
  struct InstrumentCandidate {
    std::uint64_t node_id = 0;
    std::uint32_t kind = 0;
    daw_audio_synth_state synth{};
    daw_audio_sampler_state sampler{};
    std::array<daw_audio_sample_zone, DAW_AUDIO_CORE_MAX_SAMPLE_ZONES> zones{};
    daw_audio_granular_state granular{};
    std::unordered_set<Impl::InstalledAsset*> assets;
  };
  std::vector<InstrumentCandidate> batch;
  batch.reserve(count);
  const auto record_core_failure = [&](const daw_audio_core_result result) {
    impl_->instrument_preparation_error = result == DAW_AUDIO_CORE_CAPACITY_EXCEEDED
      ? "instrument replacement capacity exceeded; let audio transitions finish, then prepare and retry"
      : "instrument parameters, sample zone bounds, or graph target are invalid";
  };
  const auto validate_batch = [&](const daw_audio_core_handle core) {
    std::size_t offset = 4;
    for (std::uint32_t index = 0; index < count; ++index) {
      auto& candidate = batch.emplace_back();
      auto& device_assets = candidate.assets;
      std::uint64_t device_bytes = 0;
      const auto admit = [&](daw_audio_asset_handle& handle) {
        if (handle == 0) return true;
        // Instrument wire references encode generation 1 + the session asset ID,
        // not the core slot/generation, which depends on installation and reuse.
        const auto id = static_cast<std::uint32_t>(handle);
        const auto found = impl_->assets.find(id);
        if ((handle >> 32U) != 1 || found == impl_->assets.end()) {
          impl_->instrument_preparation_error = "instrument sample session asset is not installed";
          return false;
        }
        auto* asset = &found->second;
        if (!impl_->AssetVisible(*asset, impl_->prepared_core != 0
          ? impl_->prepared_revision.load(std::memory_order_acquire)
          : impl_->active_revision.load(std::memory_order_acquire))) return false;
        const auto prepared = impl_->prepared_asset_handles.find(id);
        handle = prepared == impl_->prepared_asset_handles.end() ? asset->handle : prepared->second;
        if (device_assets.insert(asset).second) {
          device_bytes += asset->frame_count * asset->channel_count * sizeof(float);
          if (device_bytes > kInstrumentDeviceBytes) {
            impl_->instrument_preparation_error = "sample memory budget exceeded (1 GiB per device)";
            return false;
          }
        }
        candidates.insert(asset);
        if (asset->mapped) {
          const auto& ranges = asset->mapped->written_ranges;
          if (ranges.size() != 1 || ranges.front().first != 0 || ranges.front().second != asset->frame_count) {
            impl_->instrument_preparation_error = "sample upload incomplete; retry loading the sample";
            return false;
          }
        }
        return true;
      };
      if (payload.size() - offset < 24) return false;
      const std::uint64_t node_id = ReadLeU64(payload.data() + offset);
      const std::uint32_t kind = ReadLeU32(payload.data() + offset + 8);
      const std::uint32_t state_size = ReadLeU32(payload.data() + offset + 12);
      const std::uint32_t zones_size = ReadLeU32(payload.data() + offset + 16);
      offset += 24;
      if (state_size > kMaximumControlPayloadBytes || zones_size > kMaximumControlPayloadBytes
        || payload.size() - offset < static_cast<std::size_t>(state_size) + zones_size) return false;
      const auto* state_bytes = payload.data() + offset;
      offset += state_size;
      const auto* zones_bytes = payload.data() + offset;
      offset += zones_size;
      candidate.node_id = node_id;
      candidate.kind = kind;
      daw_audio_core_result result = DAW_AUDIO_CORE_INVALID_ARGUMENT;
      if (kind == 1 && zones_size == 0) {
        auto& state = candidate.synth;
        if (daw::audio_core_wire::DecodeSynthState(
          std::span<const std::uint8_t>(state_bytes, state_size), &state)) {
          result = daw::audio_core::ValidateInstrumentState(core, node_id, state)
            ? DAW_AUDIO_CORE_OK : DAW_AUDIO_CORE_INVALID_ARGUMENT;
        }
      } else if ((kind == 2 || kind == 3)
        && zones_size <= kMaximumControlPayloadBytes) {
        auto& state = candidate.sampler;
        auto& zones = candidate.zones;
        if (!daw::audio_core_wire::DecodeSamplerState(
          std::span<const std::uint8_t>(state_bytes, state_size), &state)
          || state.zone_count > DAW_AUDIO_CORE_MAX_SAMPLE_ZONES
          || zones_size != static_cast<std::size_t>(state.zone_count)
            * daw::audio_core_wire::kSampleZoneBytes) {
          return false;
        }
        bool decoded = true;
        for (std::uint32_t zone = 0; zone < state.zone_count; ++zone) {
          decoded = daw::audio_core_wire::DecodeSampleZone(
            std::span<const std::uint8_t>(
              zones_bytes + static_cast<std::size_t>(zone) * daw::audio_core_wire::kSampleZoneBytes,
              daw::audio_core_wire::kSampleZoneBytes
            ),
            &zones[zone]
          );
          if (!decoded) break;
          if (!admit(zones[zone].asset)) return false;
        }
        if (decoded) {
          result = daw::audio_core::ValidateInstrumentState(core, node_id, kind, state,
            std::span(zones).first(state.zone_count))
            ? DAW_AUDIO_CORE_OK : DAW_AUDIO_CORE_INVALID_ARGUMENT;
        }
      } else if (kind == 4 && state_size == kGranularStateWireBytes && zones_size == 0) {
        auto& state = candidate.granular;
        state.version = ReadLeU32(state_bytes);
        state.asset = ReadLeU64(state_bytes + 4);
        state.seed = ReadLeU32(state_bytes + 12);
        state.max_grains = ReadLeU32(state_bytes + 16);
        state.window_shape = ReadLeU32(state_bytes + 20);
        state.freeze = ReadLeU32(state_bytes + 24);
        state.grain_size_ms = ReadLeFloat(state_bytes + 28);
        state.density_hz = ReadLeFloat(state_bytes + 32);
        state.position = ReadLeFloat(state_bytes + 36);
        state.spray = ReadLeFloat(state_bytes + 40);
        state.pitch_semitones = ReadLeFloat(state_bytes + 44);
        state.reverse_probability = ReadLeFloat(state_bytes + 48);
        state.stereo_spread = ReadLeFloat(state_bytes + 52);
        if (!admit(state.asset)) return false;
        result = daw::audio_core::ValidateInstrumentState(core, node_id, state)
          ? DAW_AUDIO_CORE_OK : DAW_AUDIO_CORE_INVALID_ARGUMENT;
      }
      if (result != DAW_AUDIO_CORE_OK) {
        record_core_failure(result);
        return false;
      }
      configured_assets[node_id] = device_assets;
    }
    return offset == payload.size();
  };
  // Validate the entire candidate batch with the core's authoritative validators
  // before locking memory or changing any live/prepared instrument configuration.
  if (!validate_batch(target_core)) return false;
#if defined(DAW_AUDIO_HOST_TEST_MEMORY_LOCK)
  daw_audio_host_test_validation_memory(false);
#endif
  std::vector<Impl::InstalledAsset::MappedStorage*> newly_locked;
  newly_locked.reserve(candidates.size());
  const auto rollback = [&] {
    for (auto* mapped : newly_locked) mapped->Unlock();
  };
  if (impl_->config.device_uid != "offline:render") {
    const auto page_size = static_cast<std::size_t>(getpagesize());
    auto admitted_bytes = instrumentLockedBytes();
    for (auto* asset : candidates) {
      if (!asset->mapped) continue;
      auto& mapped = *asset->mapped;
      if (mapped.locked_bytes != 0) continue;
      const auto bytes = (mapped.byte_length + page_size - 1) / page_size * page_size;
      if (admitted_bytes > impl_->instrument_resident_budget
        || bytes > impl_->instrument_resident_budget - admitted_bytes) {
        impl_->instrument_preparation_error = "sample memory budget exceeded; release unused samples and retry";
        return false;
      }
      admitted_bytes += bytes;
    }
    for (auto* asset : candidates) {
      if (!asset->mapped) continue;
      auto& mapped = *asset->mapped;
      if (mapped.locked_bytes != 0) continue;
      const auto bytes = (mapped.byte_length + page_size - 1) / page_size * page_size;
      if (!LockInstrumentMemory(mapped.address, bytes)) {
        // POSIX does not promise an unsuccessful lock left every page unlocked.
        munlock(mapped.address, bytes);
        rollback();
        impl_->instrument_preparation_error = "memory locking unavailable; release unused samples or restart the audio host and retry";
        return false;
      }
      mapped.locked_bytes = bytes;
      newly_locked.push_back(&mapped);
    }
  }
  const auto configure_candidate = [&](const InstrumentCandidate& candidate) {
    for (auto* asset : candidate.assets) impl_->RetainAsset(*asset);
    switch (candidate.kind) {
      case 1: return daw_audio_core_configure_synth(target_core, candidate.node_id, &candidate.synth);
      case 4: return daw_audio_core_configure_granular(target_core, candidate.node_id, &candidate.granular);
      default: return daw_audio_core_configure_sampler(target_core, candidate.node_id, &candidate.sampler,
        candidate.sampler.zone_count == 0 ? nullptr : candidate.zones.data());
    }
  };
  daw_audio_core_result committed = DAW_AUDIO_CORE_OK;
  for (const auto& candidate : batch) {
    committed = configure_candidate(candidate);
    if (committed != DAW_AUDIO_CORE_OK) break;
  }
  if (committed != DAW_AUDIO_CORE_OK) {
    record_core_failure(committed);
    // Valid states can still exhaust prepared runtime/blend capacity. Cancel the
    // entire unpublished bank before unlocking newly acquired sample memory.
    if (impl_->prepared_core != 0) {
      RollbackGraphRevision(impl_->prepared_revision.load(std::memory_order_acquire));
      rollback();
    } else {
      // Active-core setters update existing runtime directly, without capacity
      // admission. Retain owners conservatively if a future setter can fail here;
      // unlike an unpublished bank, this path has no cancel API.
      for (const auto& [node, assets] : configured_assets) {
        auto& retained = impl_->published_instrument_assets[node];
        retained.insert(assets.begin(), assets.end());
      }
      for (auto* asset : candidates) if (asset->mapped) asset->mapped->instrument_published = true;
    }
    return false;
  }
  for (auto* asset : candidates) if (asset->mapped) asset->mapped->instrument_published = true;
  auto& retained = impl_->prepared_core != 0 ? impl_->prepared_instrument_assets : impl_->published_instrument_assets;
  for (auto& [node, assets] : configured_assets) retained[node] = std::move(assets);
  impl_->SettlePreparedInstruments();
  return true;
}

std::uint64_t AudioHost::instrumentLockedBytes() const {
  std::uint64_t bytes = 0;
  for (const auto& [id, asset] : impl_->assets) {
    static_cast<void>(id);
    if (asset.mapped) bytes += asset.mapped->locked_bytes;
  }
  return bytes;
}

std::uint64_t AudioHost::instrumentResidentBudgetBytes() const { return impl_->instrument_resident_budget; }
std::string_view AudioHost::instrumentPreparationError() const { return impl_->instrument_preparation_error; }
bool AudioHost::HasAudioCore() const {
  return impl_->prepared_core != 0 || impl_->active_core.load(std::memory_order_acquire) != 0;
}

GraphRevisionStatus AudioHost::PublishGraphRevision(const std::uint32_t revision, const std::uint64_t requested_frame) {
  impl_->Evidence("graph-publish-request", "", revision);
  const auto status = [this, revision](const GraphRevisionStatusCode code) {
    return impl_->GraphStatus(code, revision);
  };
  if (impl_->publication_in_flight != 0)
    return status(GraphRevisionStatusCode::kPublishPending);
  if (impl_->LatencyTransitionPending()) return status(GraphRevisionStatusCode::kPublishPending);
  if (revision == 0 || impl_->prepared_core == 0
    || impl_->prepared_revision.load(std::memory_order_acquire) != revision) {
    return status(GraphRevisionStatusCode::kStaleRevision);
  }
  const auto progress = static_cast<std::uint64_t>(impl_->applied_transport_frame.load(std::memory_order_acquire));
  if (requested_frame != 0 && requested_frame != impl_->requested_publication_frame) {
    if (requested_frame > INT64_MAX - impl_->config.max_frames_per_block
      || requested_frame <= progress || (requested_frame - progress) % impl_->config.max_frames_per_block != 0)
      return status(GraphRevisionStatusCode::kInvalidRevision);
    // Rebase discards only the entire unpublished schedule bank, including
    // partial chunks and duplicate digests. The prepared graph/config stay.
    impl_->requested_publication_frame = requested_frame;
    impl_->prepared_transport_epoch = impl_->transport_epoch.load(std::memory_order_acquire);
    impl_->ResetPreparedSchedule(revision, impl_->prepared_transport_epoch, requested_frame);
    impl_->publication_rebase_required.store(false, std::memory_order_release);
    return status(GraphRevisionStatusCode::kPrepared);
  }
  if (impl_->requested_publication_frame != 0) {
    const auto frame = impl_->requested_publication_frame.load(std::memory_order_acquire);
    if (impl_->prepared_transport_epoch != impl_->transport_epoch.load(std::memory_order_acquire)
      || frame <= static_cast<std::uint64_t>(impl_->applied_transport_frame.load(std::memory_order_acquire))) {
      impl_->publication_rebase_required.store(true, std::memory_order_release);
      return status(GraphRevisionStatusCode::kRebaseRequired);
    }
    if (!impl_->prepared_instruments_ready
      || impl_->ActiveSchedule().accepted_schedule_epoch.load(std::memory_order_acquire) != impl_->prepared_transport_epoch
      || impl_->ActiveSchedule().accepted_schedule_through_frame.load(std::memory_order_acquire) < frame
      || impl_->PreparedSchedule().accepted_schedule_through_frame.load(std::memory_order_acquire)
        < frame + impl_->config.max_frames_per_block) return status(GraphRevisionStatusCode::kPublishPending);
    if (impl_->state.load(std::memory_order_acquire) != LifecycleState::kRunning)
      return status(GraphRevisionStatusCode::kPublishPending);
  }
  const auto publish_at_boundary = [this, revision] {
    if (daw_audio_core_publish(impl_->active_core.load(std::memory_order_acquire), revision) != DAW_AUDIO_CORE_OK) {
      return false;
    }
    impl_->ReconcileScheduledTargets(impl_->active_core.load(std::memory_order_acquire),
      impl_->active_revision.load(std::memory_order_acquire), revision);
    impl_->PromoteObservationLookup();
    impl_->RetirePreviousPlan(impl_->active_revision.exchange(revision, std::memory_order_acq_rel));
    impl_->prepared_core = 0;
    impl_->prepared_revision.store(0, std::memory_order_release);
    impl_->last_graph_revision.store(revision, std::memory_order_release);
    impl_->graph_prepared = true;
    impl_->AdoptPublishedNativeVsts();
    impl_->AdoptPublishedRouting();
    return true;
  };
  const auto publish_asset_handles = [this] {
    impl_->PromoteAssets(impl_->active_revision.load(std::memory_order_acquire));
    impl_->published_instrument_assets = std::move(impl_->prepared_instrument_assets);
    for (const auto& [asset_id, handle] : impl_->prepared_asset_handles) {
      const auto asset = impl_->assets.find(asset_id);
      if (asset != impl_->assets.end()) asset->second.handle = handle;
    }
    impl_->prepared_asset_handles.clear();
  };
  if (impl_->state.load(std::memory_order_acquire) != LifecycleState::kRunning) {
    const bool replacing_graph = impl_->graph_prepared;
    if (!publish_at_boundary()) return status(GraphRevisionStatusCode::kPublishFailed);
    publish_asset_handles();
    if (!replacing_graph) impl_->retired_revision.store(0, std::memory_order_release);
    const auto publication_frame = impl_->applied_transport_frame.load();
    const auto publication_epoch = impl_->completed_render_epoch.load();
    impl_->publication_frame.store(publication_frame, std::memory_order_release);
    if (impl_->observer) impl_->observer->SetPublicationPosition(publication_frame, publication_epoch);
    impl_->RecordPublicationLatency();
    impl_->PublicationEvidence("configured-boundary");
    return status(GraphRevisionStatusCode::kPublished);
  }
  impl_->publish_acknowledged_revision.store(0, std::memory_order_release);
  impl_->publish_deferred_revision.store(0, std::memory_order_release);
  impl_->publication_in_flight = revision;
  impl_->publish_requested_revision.store(revision, std::memory_order_release);
  // Callback ownership is reconciled by inspection, never by a control wait.
  return status(GraphRevisionStatusCode::kPublishPending);
}

GraphRevisionStatus AudioHost::InspectGraphRevision(const std::uint32_t revision) {
  impl_->ReclaimAssets();
  if (impl_->publication_in_flight != 0
    && impl_->publish_deferred_revision.load(std::memory_order_acquire) == impl_->publication_in_flight) {
    impl_->publication_in_flight = 0;
    impl_->schedule_owner.store(0, std::memory_order_release);
  }
  if (impl_->publication_in_flight != 0) {
    if (impl_->publish_acknowledged_revision.load(std::memory_order_acquire) != impl_->publication_in_flight)
      return impl_->GraphStatus(GraphRevisionStatusCode::kPublishPending, revision);
    if (impl_->active_revision.load(std::memory_order_acquire) == impl_->publication_in_flight) {
      impl_->PromoteAssets(impl_->publication_in_flight);
      // Finalize only the acknowledged publication, not a newer prepared bank
      // when an ordinary status read names the still-active older revision.
      for (const auto& [asset_id, handle] : impl_->prepared_asset_handles) {
        const auto asset = impl_->assets.find(asset_id);
        if (asset != impl_->assets.end()) asset->second.handle = handle;
      }
      impl_->prepared_asset_handles.clear();
      impl_->published_instrument_assets = std::move(impl_->prepared_instrument_assets);
      impl_->graph_prepared = true;
      impl_->AdoptPublishedNativeVsts();
      impl_->AdoptPublishedRouting();
    } else {
      impl_->publication_in_flight = 0;
      impl_->schedule_owner.store(0, std::memory_order_release);
      return impl_->GraphStatus(GraphRevisionStatusCode::kPublishFailed, revision);
    }
    impl_->publication_in_flight = 0;
    impl_->schedule_owner.store(0, std::memory_order_release);
  }
  if (revision != 0 && impl_->active_revision.load(std::memory_order_acquire) == revision) {
    return impl_->GraphStatus(GraphRevisionStatusCode::kPublished, revision);
  }
  if (impl_->prepared_core != 0 && impl_->requested_publication_frame != 0
    && (impl_->publication_rebase_required.load(std::memory_order_acquire)
      || static_cast<std::uint64_t>(impl_->applied_transport_frame.load(std::memory_order_acquire))
        > impl_->requested_publication_frame))
    return impl_->GraphStatus(GraphRevisionStatusCode::kRebaseRequired, revision);
  if (impl_->LatencyTransitionPending())
    return impl_->GraphStatus(GraphRevisionStatusCode::kPublishPending, revision);
  if (revision > impl_->last_graph_revision.load(std::memory_order_acquire)
    && impl_->prepared_core == 0 && impl_->HasQueuedGraphControl())
    return impl_->GraphStatus(GraphRevisionStatusCode::kPublishPending, revision);
  return impl_->GraphStatus(
    revision != 0 && impl_->prepared_revision.load(std::memory_order_acquire) == revision
      ? GraphRevisionStatusCode::kPrepared : GraphRevisionStatusCode::kStaleRevision, revision);
}

GraphRevisionStatus AudioHost::RollbackGraphRevision(const std::uint32_t revision) {
  if (impl_->publication_in_flight != 0)
    return impl_->GraphStatus(GraphRevisionStatusCode::kPublishPending, revision);
  const auto code = revision != 0 && impl_->prepared_core != 0
    && impl_->prepared_revision.load(std::memory_order_acquire) == revision
    ? GraphRevisionStatusCode::kRolledBack
    : GraphRevisionStatusCode::kStaleRevision;
  if (code == GraphRevisionStatusCode::kRolledBack) {
    impl_->prepared_transport_context.reset();
    impl_->ResetPreparedSchedule(0, 0, 0);
    static_cast<void>(daw_audio_core_cancel_prepared_graph(impl_->prepared_core, revision));
    impl_->prepared_core = 0;
    impl_->prepared_revision.store(0, std::memory_order_release);
    impl_->prepared_asset_handles.clear();
    impl_->prepared_instrument_assets.clear();
    impl_->prepared_routing.reset();
    impl_->RollbackStagedNativeVsts();
    for (auto& [id, asset] : impl_->assets) {
      static_cast<void>(id);
      if (asset.staged_revision == revision) {
        asset.release_requested = true;
        impl_->asset_retirement_pending.store(true, std::memory_order_release);
      }
    }
  }
  return {
    .code = code,
    .requested_revision = revision,
    .active_revision = impl_->active_revision.load(std::memory_order_acquire),
    .prepared_revision = impl_->prepared_revision.load(std::memory_order_acquire),
    .retired_revision = impl_->retired_revision.load(std::memory_order_acquire),
    .render_epoch = impl_->completed_render_epoch.load(std::memory_order_acquire),
    .publication_frame = impl_->publication_frame.load(std::memory_order_acquire),
    .requested_publication_frame = impl_->requested_publication_frame.load(std::memory_order_acquire),
    .progress_frame = static_cast<std::uint64_t>(impl_->applied_transport_frame.load(std::memory_order_acquire)),
    .transport_epoch = impl_->transport_epoch.load(std::memory_order_acquire),
  };
}

GraphRevisionStatus AudioHost::RetireGraphRevision(const std::uint32_t revision) {
  if (impl_->publication_in_flight != 0)
    return impl_->GraphStatus(GraphRevisionStatusCode::kPublishPending, revision);
  impl_->Evidence("graph-retire-request", "", revision);
  GraphRevisionStatusCode code = GraphRevisionStatusCode::kStaleRevision;
  if (revision != 0 && impl_->HasRetiredPlan()
    && impl_->retired_revision.load(std::memory_order_acquire) == revision) {
    if (impl_->LatencyTransitionPending())
      return impl_->GraphStatus(GraphRevisionStatusCode::kRetirementNotSafe, revision);
    if (impl_->completed_render_epoch.load(std::memory_order_acquire)
      < impl_->retired_after_epoch.load(std::memory_order_acquire)) {
      code = GraphRevisionStatusCode::kRetirementNotSafe;
    } else {
      daw_audio_core_reclaim_retired_runtime(impl_->active_core.load(std::memory_order_acquire));
      impl_->retired_revision.store(0, std::memory_order_release);
      code = GraphRevisionStatusCode::kRetired;
      impl_->Evidence("graph-retire");
      impl_->ReclaimAssets();
    }
  }
  return {
    .code = code,
    .requested_revision = revision,
    .active_revision = impl_->active_revision.load(std::memory_order_acquire),
    .prepared_revision = impl_->prepared_revision.load(std::memory_order_acquire),
    .retired_revision = impl_->retired_revision.load(std::memory_order_acquire),
    .render_epoch = impl_->completed_render_epoch.load(std::memory_order_acquire),
    .publication_frame = impl_->publication_frame.load(std::memory_order_acquire),
    .requested_publication_frame = impl_->requested_publication_frame.load(std::memory_order_acquire),
    .progress_frame = static_cast<std::uint64_t>(impl_->applied_transport_frame.load(std::memory_order_acquire)),
    .transport_epoch = impl_->transport_epoch.load(std::memory_order_acquire),
  };
}

}  // namespace daw::audio_host_macos
