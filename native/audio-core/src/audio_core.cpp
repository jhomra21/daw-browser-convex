#include "audio_core_internal.h"


extern "C" uint32_t daw_audio_core_get_abi_version(void) {
  return DAW_AUDIO_CORE_ABI_VERSION;
}

extern "C" daw_audio_core_result daw_audio_core_create(
  const daw_audio_core_config *config,
  daw_audio_core_handle *out_core) {
  if (config == nullptr || out_core == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (!valid_abi(config->abi_version)) return DAW_AUDIO_CORE_UNSUPPORTED_VERSION;
  if (!valid_config(*config)) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  Core *core = new (std::nothrow) Core;
  if (core == nullptr) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  if (!initialize_core_storage(*core)) {
    delete core;
    return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
  core->config = *config;
  if (!allocate_graph_stage_buffers(*core)) {
    delete core;
    return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
  *out_core = to_handle(core);
  return DAW_AUDIO_CORE_OK;
}

extern "C" void daw_audio_core_destroy(daw_audio_core_handle core) {
  delete to_core(core);
}
