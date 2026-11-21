#include "audio-host-internal.h"

namespace daw::audio_host_macos {

namespace {

bool ValidNativeVstAttachment(const NativeVstAttachment& attachment) {
  const auto channels_for_layout = [](const std::uint32_t layout) {
    return layout == DAW_AUDIO_GRAPH_LAYOUT_MONO ? 1U
      : layout == DAW_AUDIO_GRAPH_LAYOUT_STEREO ? 2U : 0U;
  };
  const std::uint32_t input_channels = channels_for_layout(attachment.input_layout);
  const std::uint32_t output_channels = channels_for_layout(attachment.output_layout);
  const bool instrument = attachment.role == NativeVstRole::kInstrument;
  if (attachment.graph_node_id == 0 || attachment.instance_id.empty() || attachment.instance_id.size() > 256
    || attachment.class_id.empty() || attachment.class_id.size() > 256 || attachment.vendor_id.empty()
    || attachment.vendor_id.size() > 256 || attachment.canonical_bundle_path.empty()
    || attachment.canonical_executable_path.empty()
    || !attachment.canonical_executable_path.starts_with(attachment.canonical_bundle_path + "/")
    || attachment.architecture != 1 || attachment.scanner_catalog_version != 2
    || (attachment.role != NativeVstRole::kEffect && attachment.role != NativeVstRole::kInstrument)
    || (!instrument && attachment.input_layout != DAW_AUDIO_GRAPH_LAYOUT_MONO
      && attachment.input_layout != DAW_AUDIO_GRAPH_LAYOUT_STEREO)
    || (instrument && attachment.input_layout != 0)
    || (attachment.output_layout != DAW_AUDIO_GRAPH_LAYOUT_MONO && attachment.output_layout != DAW_AUDIO_GRAPH_LAYOUT_STEREO)
    || attachment.transport.slot_count == 0 || attachment.transport.slot_count > kMaximumNativeVstSlots
    || attachment.transport.maximum_frames == 0 || attachment.transport.maximum_frames > kMaximumNativeVstFrames
    || attachment.transport.input_channels > kMaximumNativeVstChannels
    || attachment.transport.output_channels == 0 || attachment.transport.output_channels > kMaximumNativeVstChannels
    || attachment.transport.maximum_events_per_block == 0 || attachment.transport.maximum_events_per_block > daw::plugin_host::kMaximumWorkerEvents
    || (!instrument && input_channels == 0) || output_channels == 0
    || attachment.transport.input_channels != input_channels || attachment.transport.output_channels != output_channels
    || attachment.transport_latency_frames != attachment.transport.maximum_frames
    || attachment.declared_latency_frames > std::numeric_limits<std::uint32_t>::max() - attachment.transport_latency_frames
    || (attachment.infinite_tail && attachment.declared_tail_frames)
    || (attachment.declared_tail_frames
      && !daw::plugin_host::IsValidFiniteWorkerTailFrames(*attachment.declared_tail_frames))
    || std::all_of(attachment.bundle_fingerprint.begin(), attachment.bundle_fingerprint.end(), [](const auto value) { return value == 0; })
    || std::all_of(attachment.binary_fingerprint.begin(), attachment.binary_fingerprint.end(), [](const auto value) { return value == 0; })) {
    return false;
  }
  if (attachment.stage_index >= DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE * 2u) return false;
  if (instrument && attachment.source_index != 0) return false;
  return instrument
    ? attachment.transport.input_channels == 0
    : input_channels == output_channels && attachment.transport.input_channels > 0;
}

}  // namespace

bool WorkerNotificationQueue::Push(WorkerNotification notification) {
  for (auto& current : notifications_) {
    if (IsParameterEdit(current)
      && IsParameterEdit(notification)
      && current.instance_id == notification.instance_id
      && current.parameter_id == notification.parameter_id) {
      current = std::move(notification);
      return true;
    }
  }
  if (notifications_.size() < kCapacity) {
    notifications_.push_back(std::move(notification));
    return true;
  }
  if (IsParameterEdit(notification)) {
    const auto parameter = std::find_if(
      notifications_.begin(),
      notifications_.end(),
      [](const WorkerNotification& current) { return IsParameterEdit(current); }
    );
    if (parameter != notifications_.end()) {
      notifications_.erase(parameter);
      notifications_.push_back(std::move(notification));
      return true;
    }
  }
  const auto informational = std::find_if(
    notifications_.begin(),
    notifications_.end(),
    [](const WorkerNotification& current) { return !IsCritical(current); }
  );
  if (informational == notifications_.end()) return false;
  notifications_.erase(informational);
  notifications_.push_back(std::move(notification));
  return true;
}

WorkerNotification WorkerNotificationQueue::Pop() {
  WorkerNotification notification = std::move(notifications_.front());
  notifications_.pop_front();
  return notification;
}

WorkerNotification IdentifyWorkerNotification(
  const NativeVstAttachment& attachment,
  const std::uint32_t graph_revision,
  const WorkerNotificationKind kind,
  const std::uint32_t value,
  const std::uint32_t parameter_id,
  const double normalized_value
) {
  return {
    .kind = kind,
    .graph_revision = graph_revision,
    .graph_node_id = attachment.graph_node_id,
    .instance_id = attachment.instance_id,
    .value = value,
    .parameter_id = parameter_id,
    .normalized_value = normalized_value,
  };
}

bool AudioHost::ReenableVstScheduleAutomation(const std::span<const std::uint8_t> payload) {
  if (payload.size() < 8) return false;
  const auto instance_bytes = ReadLeU32(payload.data());
  if (instance_bytes == 0 || instance_bytes > kMaximumScheduleInstanceIdBytes
    || payload.size() < 8 + instance_bytes) return false;
  const std::string instance_id(reinterpret_cast<const char*>(payload.data() + 4), instance_bytes);
  const auto attachment = impl_->native_vst_attachments.find(instance_id);
  if (attachment == impl_->native_vst_attachments.end()) return false;
  const auto count = ReadLeU32(payload.data() + 4 + instance_bytes);
  if (count > kMaximumScheduleAutomationSegments
    || payload.size() != 8 + instance_bytes + static_cast<std::size_t>(count) * 4) return false;
  for (std::uint32_t index = 0; index < count; ++index) {
    const auto parameter_id = ReadLeU32(payload.data() + 8 + instance_bytes + index * 4);
    if (std::find(
      attachment->second->metadata.parameter_ids.begin(),
      attachment->second->metadata.parameter_ids.end(),
      parameter_id
    ) == attachment->second->metadata.parameter_ids.end()) return false;
  }
  for (std::uint32_t index = 0; index < count; ++index) {
    attachment->second->ClearAutomationOverride(ReadLeU32(payload.data() + 8 + instance_bytes + index * 4));
  }
  return true;
}

bool AudioHost::QueueNativeVstParameterEvents(const std::span<const std::uint8_t> payload) {
  std::size_t offset = 0;
  std::string instance_id;
  if (!ReadNativeInstanceId(payload, offset, instance_id) || offset + 4 > payload.size()) return false;
  const std::uint32_t count = ReadLeU32(payload.data() + offset);
  offset += 4;
  if (count > daw::plugin_host::kMaximumWorkerEvents || payload.size() != offset + static_cast<std::size_t>(count) * 16) return false;
  const auto attachment = impl_->native_vst_attachments.find(instance_id);
  if (attachment == impl_->native_vst_attachments.end() || !attachment->second->metadata.playback_enabled
    || count > attachment->second->metadata.transport.maximum_events_per_block) return false;
  std::array<daw::plugin_host::WorkerTransportEvent, daw::plugin_host::kMaximumWorkerEvents> events{};
  std::array<std::uint32_t, daw::plugin_host::kMaximumWorkerEvents> candidate_override_ids{};
  std::array<std::uint32_t, daw::plugin_host::kMaximumWorkerEvents> inserted_override_ids{};
  std::size_t candidate_override_count = 0;
  std::size_t inserted_override_count = 0;
  const auto rollback_overrides = [&]() noexcept {
    for (std::size_t index = 0; index < inserted_override_count; ++index) {
      attachment->second->ClearAutomationOverride(inserted_override_ids[index]);
    }
  };
  for (std::uint32_t index = 0; index < count; ++index) {
    const auto* bytes = payload.data() + offset + index * 16;
    const auto parameter_id = ReadLeU32(bytes);
    const double value = ReadLeDouble(bytes + 8);
    if (ReadLeU32(bytes + 4) >= attachment->second->metadata.transport.maximum_frames
      || !std::isfinite(value) || value < 0.0 || value > 1.0
      || (!attachment->second->metadata.parameter_ids.empty()
        && std::find(
          attachment->second->metadata.parameter_ids.begin(),
          attachment->second->metadata.parameter_ids.end(),
          parameter_id
        ) == attachment->second->metadata.parameter_ids.end())) return false;
    if (std::find(candidate_override_ids.begin(), candidate_override_ids.begin() + static_cast<std::ptrdiff_t>(candidate_override_count), parameter_id)
      == candidate_override_ids.begin() + static_cast<std::ptrdiff_t>(candidate_override_count)) {
      if (candidate_override_count >= candidate_override_ids.size()) return false;
      candidate_override_ids[candidate_override_count++] = parameter_id;
    }
    events[index] = {.kind = daw::plugin_host::WorkerEventKind::kParameter, .sampleOffset = ReadLeU32(bytes + 4),
      .parameterId = parameter_id, .parameterValue = value};
  }
  if (ShouldOverrideNativeVstAutomation(impl_->transport_running.load(std::memory_order_acquire))) {
    for (std::size_t index = 0; index < candidate_override_count; ++index) {
      const auto result = attachment->second->SetAutomationOverride(candidate_override_ids[index]);
      if (result == NativeVstWorkerAttachment::AutomationOverrideSetResult::kFull) {
        rollback_overrides();
        return false;
      }
      if (result == NativeVstWorkerAttachment::AutomationOverrideSetResult::kInserted) {
        inserted_override_ids[inserted_override_count++] = candidate_override_ids[index];
      }
    }
  }
  if (!attachment->second->QueueEvents(
    std::span<const daw::plugin_host::WorkerTransportEvent>(events.data(), count)
  )) {
    rollback_overrides();
    return false;
  }
  return true;
}

bool AudioHost::QueueNativeVstMidiEvents(const std::span<const std::uint8_t> payload) {
  std::size_t offset = 0;
  std::string instance_id;
  if (!ReadNativeInstanceId(payload, offset, instance_id) || offset + 4 > payload.size()) return false;
  const std::uint32_t count = ReadLeU32(payload.data() + offset);
  offset += 4;
  if (count > daw::plugin_host::kMaximumWorkerEvents || payload.size() != offset + static_cast<std::size_t>(count) * 8) return false;
  const auto attachment = impl_->native_vst_attachments.find(instance_id);
  if (attachment == impl_->native_vst_attachments.end() || !attachment->second->metadata.playback_enabled
    || count > attachment->second->metadata.transport.maximum_events_per_block) return false;
  std::array<daw::plugin_host::WorkerTransportEvent, daw::plugin_host::kMaximumWorkerEvents> events{};
  for (std::uint32_t index = 0; index < count; ++index) {
    const auto* bytes = payload.data() + offset + index * 8;
    if (ReadLeU32(bytes) >= attachment->second->metadata.transport.maximum_frames || bytes[7] != 0) return false;
    events[index] = {.kind = daw::plugin_host::WorkerEventKind::kMidi, .sampleOffset = ReadLeU32(bytes),
      .midiData = {bytes[4], bytes[5], bytes[6]}};
  }
  return attachment->second->QueueEvents(std::span<const daw::plugin_host::WorkerTransportEvent>(events.data(), count));
}

bool AudioHost::SetNativeVstState(const std::span<const std::uint8_t> payload) {
  std::size_t offset = 0;
  std::string instance_id;
  if (!ReadNativeInstanceId(payload, offset, instance_id) || offset + 8 > payload.size()) return false;
  const std::uint32_t bytes = ReadLeU32(payload.data() + offset);
  const std::uint32_t hash_bytes = ReadLeU32(payload.data() + offset + 4);
  offset += 8;
  if (bytes > daw::plugin_host::kMaximumWorkerStateBytes || hash_bytes != 64 || payload.size() != offset + bytes + hash_bytes) return false;
  const auto attachment = impl_->native_vst_attachments.find(instance_id);
  if (attachment == impl_->native_vst_attachments.end() || !attachment->second->metadata.playback_enabled) return false;
  daw::plugin_host::WorkerState state{
    .bytes = {payload.begin() + static_cast<std::ptrdiff_t>(offset), payload.begin() + static_cast<std::ptrdiff_t>(offset + bytes)},
    .sha256 = {reinterpret_cast<const char*>(payload.data() + offset + bytes), hash_bytes},
  };
  return daw::plugin_host::IsValidWorkerState(state) && attachment->second->worker.SetState(state);
}

std::optional<std::vector<std::uint8_t>> AudioHost::GetNativeVstState(const std::span<const std::uint8_t> payload) {
  std::size_t offset = 0;
  std::string instance_id;
  const bool well_formed = ReadNativeInstanceId(payload, offset, instance_id) && offset == payload.size();
  // The reply carries no reason, so a refused read names it here. GetState reports only that it failed, not why.
  // The id comes off the wire, so anything outside an id's characters is replaced to keep the evidence line valid JSON.
  // A malformed request names no id (empty, or the one that was read before trailing bytes).
  const auto refused = [&](const char* reason) {
    std::string printable = instance_id;
    for (char& c : printable) if (!std::isalnum(static_cast<unsigned char>(c)) && c != '-') c = '?';
    char detail[384];
    std::snprintf(detail, sizeof(detail), ",\"instanceId\":\"%s\"", printable.c_str());
    impl_->Evidence("vst-state-get-refused", reason, 0, detail);
    return std::nullopt;
  };
  if (!well_formed) return refused("malformed");
  const auto attachment = impl_->native_vst_attachments.find(instance_id);
  if (attachment == impl_->native_vst_attachments.end()) return refused("no-attachment");
  if (!attachment->second->metadata.playback_enabled) return refused("playback-disabled");
  const auto state = attachment->second->CheckpointState();
  if (!state) return refused("worker-get-state");
  std::vector<std::uint8_t> result;
  result.reserve(4 + instance_id.size() + 8 + state->bytes.size() + state->sha256.size());
  const auto append_le = [&result](const std::uint32_t value) {
    result.push_back(static_cast<std::uint8_t>(value));
    result.push_back(static_cast<std::uint8_t>(value >> 8U));
    result.push_back(static_cast<std::uint8_t>(value >> 16U));
    result.push_back(static_cast<std::uint8_t>(value >> 24U));
  };
  append_le(static_cast<std::uint32_t>(instance_id.size()));
  result.insert(result.end(), instance_id.begin(), instance_id.end());
  append_le(static_cast<std::uint32_t>(state->bytes.size()));
  append_le(static_cast<std::uint32_t>(state->sha256.size()));
  result.insert(result.end(), state->bytes.begin(), state->bytes.end());
  result.insert(result.end(), state->sha256.begin(), state->sha256.end());
  return result;
}

void AudioHost::ProcessNativeVstControl() {
  impl_->ReclaimAssets();
  impl_->ReclaimRetiredNativeVsts();
  for (auto& [map_key, attachment] : impl_->native_vst_attachments) {
    static_cast<void>(map_key);
    while (const auto diagnostic = attachment->worker.ReadDiagnostic()) {
      if (diagnostic->kind == daw::plugin_host::WorkerDiagnosticKind::kScheduledAutomationInput) {
        const auto epoch = diagnostic->transport_epoch;
        if (diagnostic->value > 0 && epoch != 0
          && epoch == impl_->transport_epoch.load(std::memory_order_acquire)
          && (!attachment->worker_automation || attachment->worker_automation->transport_epoch != epoch
            || diagnostic->sequence > attachment->worker_automation->sequence)) {
          attachment->worker_automation = Diagnostics::WorkerAutomation{
            diagnostic->value, diagnostic->parameter_id, epoch, diagnostic->sequence,
            attachment->metadata.instance_id,
          };
        }
      } else if (diagnostic->kind == daw::plugin_host::WorkerDiagnosticKind::kLatency) {
        if (diagnostic->value != attachment->metadata.declared_latency_frames) {
          char detail[128];
          std::snprintf(detail, sizeof(detail), ",\"oldLatencyFrames\":%u,\"newLatencyFrames\":%u",
            attachment->metadata.declared_latency_frames, diagnostic->value);
          // The notification sink already carries the value to the typed latency
          // publish path; the host keeps running while it recomputes compensation.
          impl_->Evidence("attachment-latency-report", "worker-notification", 0, detail);
          attachment->metadata.declared_latency_frames = diagnostic->value;
        }
      } else if (diagnostic->kind == daw::plugin_host::WorkerDiagnosticKind::kTail) {
        if (!daw::plugin_host::IsValidWorkerTailFrames(diagnostic->value)) {
          continue;
        }
        if (daw::plugin_host::IsInfiniteTailFrames(diagnostic->value)) {
          attachment->metadata.infinite_tail = true;
          attachment->metadata.declared_tail_frames.reset();
        } else {
          attachment->metadata.infinite_tail = false;
          attachment->metadata.declared_tail_frames = diagnostic->value;
        }
      } else if (diagnostic->kind == daw::plugin_host::WorkerDiagnosticKind::kBuses) {
        // The worker emits its validated active-bus summary during every
        // successful startup. Attachment preflight and transport dimensions
        // already prove the supported stereo bus contract; this notification
        // is informational and must not mute or tear down the graph.
      } else if (diagnostic->kind == daw::plugin_host::WorkerDiagnosticKind::kRestart) {
        char detail[64];
        std::snprintf(detail, sizeof(detail), ",\"restartFlags\":%u", diagnostic->value);
        impl_->Evidence("host-restart-request", "plugin-restartComponent", 0, detail);
        // The worker re-sets its own component up; nothing else restarts.
        attachment->worker_automation.reset();
        impl_->vst_worker_restarts.fetch_add(1, std::memory_order_relaxed);
      } else if (diagnostic->kind == daw::plugin_host::WorkerDiagnosticKind::kFault) {
        // A faulted worker is no longer ready, so its callback writes silence for
        // this instance only. Every other attachment and the graph keep rendering.
        impl_->Evidence("attachment-fault-isolated",
          daw::plugin_host::IsPluginFaultOrigin(diagnostic->value) ? "plugin-fault" : "host-defect");
        attachment->worker_automation.reset();
        impl_->vst_worker_faults.fetch_add(1, std::memory_order_relaxed);
      }
    }
  }
}

std::optional<WorkerNotification> AudioHost::WaitForWorkerNotification(const std::atomic<bool>* running) {
  std::unique_lock lock(impl_->worker_notifications.mutex);
  impl_->worker_notifications.ready.wait(lock, [this, running] {
    return !impl_->worker_notifications.notifications.Empty()
      || (running != nullptr && !running->load(std::memory_order_acquire));
  });
  if (impl_->worker_notifications.notifications.Empty()) return std::nullopt;
  return impl_->worker_notifications.notifications.Pop();
}

void AudioHost::WakeWorkerNotificationWait() {
  impl_->worker_notifications.ready.notify_all();
}

bool AudioHost::AttachNativeVst(const NativeVstAttachment& attachment) {
  NativeVstAttachment normalized = attachment;
  impl_->ReclaimRetiredNativeVsts();
  if (!ValidNativeVstAttachment(normalized)) return false;
  if (const auto held = impl_->native_vst_attachments.find(normalized.instance_id);
    held != impl_->native_vst_attachments.end()) {
    if (impl_->RejoinParkedNativeVst(*held->second, normalized)) return true;
    if (!held->second->Detached()) return false;
    // A parked or retired object that cannot be reused is moved aside, still owned until
    // reclaimed, so the instance ID is free for the new load.
    auto superseded = impl_->native_vst_attachments.extract(held);
    impl_->RetireNativeVst(*superseded.mapped());
    superseded.key() = "superseded:" + std::to_string(++impl_->superseded_vst_ordinal);
    impl_->native_vst_attachments.insert(std::move(superseded));
  }
  if (impl_->native_vst_attachments.size() >= kMaximumNativeVstAttachments) return false;
  auto worker_attachment = std::make_unique<NativeVstWorkerAttachment>();
  worker_attachment->observer = impl_->observer.get();
  worker_attachment->active_schedule_bank = &impl_->active_schedule_bank;
  worker_attachment->metadata = normalized;
  worker_attachment->notification_sink = &impl_->worker_notifications;
  worker_attachment->offline_failure = &impl_->offline_failure;
  // Added to a graph that is already live, the instance waits for a published revision to bind it.
  if (impl_->graph_prepared) worker_attachment->ownership = NativeVstWorkerAttachment::Ownership::kStaged;
  auto* const staged = worker_attachment.get();
  impl_->native_vst_attachments.emplace(normalized.instance_id, std::move(worker_attachment));
  impl_->PublishAutomationCredits();
  if (impl_->native_worker_mode && staged->metadata.playback_enabled) {
    // A spawn failure leaves the instance not ready, so no revision binds it.
    if (const auto executable = WorkerExecutablePath()) {
      static_cast<void>(impl_->StartNativeVstWorker(staged, *impl_->native_worker_mode, *executable));
    }
  }
  return true;
}

std::optional<NativeVstWorkerHealth> AudioHost::NativeVstHealth(const std::string_view instance_id) const {
  const auto attachment = impl_->native_vst_attachments.find(std::string(instance_id));
  if (attachment == impl_->native_vst_attachments.end()) return std::nullopt;
  switch (attachment->second->worker.health()) {
    case daw::plugin_host::WorkerHealth::kStarting: return NativeVstWorkerHealth::kStarting;
    case daw::plugin_host::WorkerHealth::kReady: return NativeVstWorkerHealth::kReady;
    case daw::plugin_host::WorkerHealth::kStopping: return NativeVstWorkerHealth::kStopping;
    case daw::plugin_host::WorkerHealth::kStopped: return NativeVstWorkerHealth::kStopped;
    case daw::plugin_host::WorkerHealth::kFaulted: return NativeVstWorkerHealth::kFaulted;
  }
  return std::nullopt;
}

std::optional<NativeVstEditorStatus> AudioHost::ExecuteNativeVstEditorCommand(
  const std::string_view instance_id,
  const NativeVstEditorCommand command,
  const std::uint32_t width,
  const std::uint32_t height,
  const std::optional<NativeVstEditorAnchor> anchor
) {
  const auto attachment = impl_->native_vst_attachments.find(std::string(instance_id));
  if (attachment == impl_->native_vst_attachments.end()) return std::nullopt;
  if (!attachment->second->metadata.playback_enabled
    || attachment->second->worker.health() != daw::plugin_host::WorkerHealth::kReady) {
    return NativeVstEditorStatus{.owned = true};
  }
  const auto workerCommand = static_cast<daw::plugin_host::WorkerControlCommand>(
    static_cast<std::uint32_t>(command) + static_cast<std::uint32_t>(daw::plugin_host::WorkerControlCommand::kEditorOpen) - 1U
  );
  const auto response = attachment->second->worker.ExecuteEditorCommand(
    workerCommand,
    width,
    height,
    anchor
      ? std::optional<daw::plugin_host::WorkerEditorAnchor>(
        daw::plugin_host::WorkerEditorAnchor{.x = anchor->x, .y = anchor->y})
      : std::nullopt
  );
  if (!response) return std::nullopt;
  return NativeVstEditorStatus{
    .success = response->success,
    .owned = true,
    .supported = response->status.supported,
    .open = response->status.open,
    .width = response->status.width,
    .height = response->status.height,
  };
}

bool AudioHost::DetachVstReference(const std::string_view instance_id) {
  const auto attachment = impl_->native_vst_attachments.find(std::string(instance_id));
  if (attachment == impl_->native_vst_attachments.end()) return false;
  auto& detached = *attachment->second;
  if (detached.Detached() || detached.worker.health() != daw::plugin_host::WorkerHealth::kReady) {
    impl_->RetireNativeVst(detached);
  } else {
    impl_->ParkNativeVst(detached);
  }
  impl_->ReclaimRetiredNativeVsts();
  return true;
}

}  // namespace daw::audio_host_macos
