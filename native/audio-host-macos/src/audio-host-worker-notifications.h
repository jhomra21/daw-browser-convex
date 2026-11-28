#pragma once

#include "daw/audio_host_macos.h"
#include "audio-host-vst-attachment.h"

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <mutex>
#include <optional>

namespace daw::audio_host_macos {

struct WorkerNotificationSink {
  std::mutex mutex;
  std::condition_variable ready;
  WorkerNotificationQueue notifications;
  std::atomic<std::uint32_t>* active_revision = nullptr;
};

inline void ForwardWorkerDiagnostic(
  const daw::plugin_host::WorkerDiagnostic& diagnostic,
  void* const context
) noexcept {
  auto* attachment = static_cast<NativeVstWorkerAttachment*>(context);
  if (attachment == nullptr) return;
  if (diagnostic.kind == daw::plugin_host::WorkerDiagnosticKind::kParameterEditBegin) {
    static_cast<void>(attachment->SetAutomationOverride(diagnostic.parameter_id));
    return;
  }
  if (attachment->notification_sink == nullptr) return;
  std::optional<WorkerNotificationKind> kind;
  if (diagnostic.kind == daw::plugin_host::WorkerDiagnosticKind::kLatency) kind = WorkerNotificationKind::kLatency;
  else if (diagnostic.kind == daw::plugin_host::WorkerDiagnosticKind::kBuses) kind = WorkerNotificationKind::kBuses;
  else if (diagnostic.kind == daw::plugin_host::WorkerDiagnosticKind::kRestart) kind = WorkerNotificationKind::kRestart;
  else if (diagnostic.kind == daw::plugin_host::WorkerDiagnosticKind::kFault) kind = WorkerNotificationKind::kFault;
  else if (diagnostic.kind == daw::plugin_host::WorkerDiagnosticKind::kMiss) kind = WorkerNotificationKind::kMiss;
  else if (diagnostic.kind == daw::plugin_host::WorkerDiagnosticKind::kTail) kind = WorkerNotificationKind::kTail;
  else if (diagnostic.kind == daw::plugin_host::WorkerDiagnosticKind::kEditorInteraction) kind = WorkerNotificationKind::kEditorInteraction;
  else if (diagnostic.kind == daw::plugin_host::WorkerDiagnosticKind::kParameterEdit) kind = WorkerNotificationKind::kParameterEdit;
  else if (diagnostic.kind == daw::plugin_host::WorkerDiagnosticKind::kEditorState) kind = WorkerNotificationKind::kEditorState;
  if (!kind) return;
  WorkerNotificationSink& sink = *attachment->notification_sink;
  if (*kind == WorkerNotificationKind::kParameterEdit) {
    static_cast<void>(attachment->SetAutomationOverride(diagnostic.parameter_id));
  }
  if (*kind == WorkerNotificationKind::kEditorState && attachment->observer) {
    char fields[384];
    std::snprintf(fields, sizeof(fields), ",\"instanceId\":\"%s\",\"open\":%s",
      attachment->metadata.instance_id.c_str(), diagnostic.value != 0 ? "true" : "false");
    attachment->observer->Event("vst-editor-state", fields);
  }
  const std::lock_guard lock(sink.mutex);
  static_cast<void>(sink.notifications.Push(IdentifyWorkerNotification(
    attachment->metadata,
    sink.active_revision->load(std::memory_order_acquire),
    *kind,
    diagnostic.value,
    diagnostic.parameter_id,
    diagnostic.normalized_value
  )));
  sink.ready.notify_one();
}

inline void DispatchNativeVstGraphHook(const daw::audio_core::NativeGraphNodeRender& render) noexcept {
  auto* attachment = static_cast<NativeVstWorkerAttachment*>(render.attachment);
  if (attachment != nullptr) attachment->Process(render);
}

}  // namespace daw::audio_host_macos
