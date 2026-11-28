#include "audio-host-internal.h"

namespace daw::audio_host_macos {

#if defined(DAW_AUDIO_HOST_TEST_PATCH_CLAIM) && DAW_AUDIO_HOST_TEST_PATCH_CLAIM == 1
void SetTestPatchClaimHook(void (*const hook)()) {
  test_patch_claim_hook.store(hook, std::memory_order_release);
}

void SetTestPatchAckHook(void (*const hook)(std::uint64_t, std::uint32_t)) {
  test_patch_ack_hook.store(hook, std::memory_order_release);
}

void SetTestPatchClaimHold(const bool hold) {
  test_patch_claim_hold.store(hold, std::memory_order_release);
}

void SetTestPatchClaimDiscard(const bool discard) {
  test_patch_claim_discard.store(discard, std::memory_order_release);
}

void SetTestDeviceStart(bool (*const start)(AudioHost*, void**)) {
  test_device_start.store(start, std::memory_order_release);
}

void AudioHostTestAccess::UseNoPluginWorkers(const bool use) {
  test_no_plugin_workers.store(use, std::memory_order_release);
}

void AudioHostTestAccess::SetParkedAge(AudioHost& host, const std::chrono::milliseconds age) {
  host.impl_->parked_age = age;
}

bool AudioHostTestAccess::ProcessorPatchPosted(AudioHost& host) {
  return host.impl_->processor_patch_requested.load(std::memory_order_acquire) != 0;
}

void AudioHostTestAccess::UseWorkerExecutable(std::string path) {
  test_worker_executable = std::move(path);
}

bool AudioHostTestAccess::PublishWorkerDiagnostic(
  AudioHost& host,
  const std::string_view instance_id,
  const daw::plugin_host::WorkerDiagnostic& diagnostic
) {
  const auto attachment = host.impl_->native_vst_attachments.find(std::string(instance_id));
  return attachment != host.impl_->native_vst_attachments.end()
    && attachment->second->worker.callbackPort().PublishDiagnostic(diagnostic);
}

std::uint64_t AudioHostTestAccess::WorkerGeneration(AudioHost& host, const std::string_view instance_id) {
  const auto attachment = host.impl_->native_vst_attachments.find(std::string(instance_id));
  return attachment == host.impl_->native_vst_attachments.end() ? 0 : attachment->second->worker.workerGeneration();
}

AudioHostTestAccess::Ownership AudioHostTestAccess::AttachmentOwnership(
  AudioHost& host,
  const std::string_view instance_id
) {
  const auto attachment = host.impl_->native_vst_attachments.find(std::string(instance_id));
  if (attachment == host.impl_->native_vst_attachments.end()) return Ownership::kAbsent;
  switch (attachment->second->ownership) {
    case NativeVstWorkerAttachment::Ownership::kStaged: return Ownership::kStaged;
    case NativeVstWorkerAttachment::Ownership::kActive: return Ownership::kActive;
    case NativeVstWorkerAttachment::Ownership::kParked: return Ownership::kParked;
    case NativeVstWorkerAttachment::Ownership::kRetired: return Ownership::kRetired;
  }
  return Ownership::kAbsent;
}

int AudioHostTestAccess::WorkerProcessGroup(AudioHost& host, const std::string_view instance_id) {
  const auto attachment = host.impl_->native_vst_attachments.find(std::string(instance_id));
  return attachment == host.impl_->native_vst_attachments.end() ? -1 : attachment->second->worker.workerProcessGroupId();
}
#endif

}  // namespace daw::audio_host_macos
