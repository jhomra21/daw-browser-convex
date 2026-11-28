#include "audio_core_internal.h"

namespace daw::audio_core_internal {

float processor_parameter_value(
  const Core &core,
  const GraphRevision::Processor &processor,
  uint32_t target,
  uint32_t frame,
  float fallback) {
  const uint32_t slot = processor.control_slot;
  static_cast<void>(frame);
  const auto parameter_begin = processor.parameter_targets.begin();
  const auto parameter_end = parameter_begin + processor.parameter_count;
  const auto parameter = std::lower_bound(parameter_begin, parameter_end, target);
  if (parameter == parameter_end || *parameter != target) return fallback;
  const auto index = static_cast<size_t>(parameter - parameter_begin);
  return core.resolved_parameter_valid[slot][index]
    ? core.resolved_parameter_values[slot][index]
    : fallback;
}

void resolve_processor_parameter_frame(
  Core &core,
  GraphRevision::Processor &processor,
  uint32_t frame) {
  const uint32_t slot = processor.control_slot;
  const daw_audio_processor_parameter_block *parameters = core.active_parameter_blocks[slot];
  uint32_t &event_cursor = core.parameter_event_cursors[slot];
  while (event_cursor < core.event_ends[slot]
    && core.active_events[event_cursor].frame_offset <= frame) {
    const daw_audio_processor_event &event = core.active_events[event_cursor++];
    const auto parameter_begin = processor.parameter_targets.begin();
    const auto parameter_end = parameter_begin + processor.parameter_count;
    const auto parameter = std::lower_bound(parameter_begin, parameter_end, event.parameter_target);
    if (parameter == parameter_end || *parameter != event.parameter_target) continue;
    const auto index = static_cast<size_t>(parameter - parameter_begin);
    core.event_parameter_values[slot][index] = event.value;
    core.event_parameter_valid[slot][index] = true;
  }
  for (uint32_t index = 0; index < processor.parameter_count; ++index) {
    bool valid = core.override_parameter_valid[slot][index];
    float value = core.override_parameter_values[slot][index];
    const uint32_t block_parameter = core.parameter_block_indices[slot][index];
    if (parameters != nullptr && block_parameter < parameters->parameter_count) {
      value = parameters->values[block_parameter * parameters->frame_count
        + (parameters->frame_count == 1 ? 0 : frame)];
      valid = true;
    }
    if (core.event_parameter_valid[slot][index]) {
      value = core.event_parameter_values[slot][index];
      valid = true;
    }
    core.resolved_parameter_values[slot][index] = value;
    core.resolved_parameter_valid[slot][index] = valid;
  }
}

void prepare_processor_parameter_cache(
  Core &core,
  GraphRevision::Processor &processor) {
  const uint32_t slot = processor.control_slot;
  core.parameter_event_cursors[slot] = core.event_starts[slot];
  core.event_parameter_valid[slot].fill(false);
  core.resolved_parameter_valid[slot].fill(false);
  core.override_parameter_valid[slot].fill(false);
  const Core::ProcessorOverrides &overrides = core.processor_overrides[processor.history_slot];
  for (uint32_t entry = 0; entry < overrides.count; ++entry) {
    const auto parameter_begin = processor.parameter_targets.begin();
    const auto parameter_end = parameter_begin + processor.parameter_count;
    const auto target = std::lower_bound(parameter_begin, parameter_end, overrides.targets[entry]);
    if (target == parameter_end || *target != overrides.targets[entry]) continue;
    const auto index = static_cast<size_t>(target - parameter_begin);
    core.override_parameter_values[slot][index] = overrides.values[entry];
    core.override_parameter_valid[slot][index] = true;
  }
  core.parameter_block_indices[slot].fill(
    static_cast<uint8_t>(DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS));
  const daw_audio_processor_parameter_block *parameters = core.active_parameter_blocks[slot];
  if (parameters != nullptr) {
    for (uint32_t parameter = 0; parameter < parameters->parameter_count; ++parameter) {
      const auto parameter_begin = processor.parameter_targets.begin();
      const auto parameter_end = parameter_begin + processor.parameter_count;
      const auto target = std::lower_bound(
        parameter_begin, parameter_end, parameters->parameter_targets[parameter]);
      if (target == parameter_end || *target != parameters->parameter_targets[parameter]) continue;
      const auto index = static_cast<size_t>(target - parameter_begin);
      core.parameter_block_indices[slot][index] = static_cast<uint8_t>(parameter);
    }
  }
  core.parameter_cache_prepared[slot] = true;
}

// Callback. A plan's processor reaches its override table through the runtime
// slot it owns, so a retained processor keeps its values across republishes.
void latch_processor_parameter_values(Core &core) {
  const GraphRevision &graph = *core.published_graph;
  for (uint32_t processor_index = 0; processor_index < graph.processor_count; ++processor_index) {
    const GraphRevision::Processor &processor = graph.processors[processor_index];
    const uint32_t slot = processor.control_slot;
    if (!core.parameter_cache_prepared[slot]) continue;
    Core::ProcessorOverrides &overrides = core.processor_overrides[processor.history_slot];
    for (uint32_t index = 0; index < processor.parameter_count; ++index) {
      if (!core.resolved_parameter_valid[slot][index]) continue;
      const uint32_t target = processor.parameter_targets[index];
      uint32_t entry = 0;
      while (entry < overrides.count && overrides.targets[entry] != target) ++entry;
      if (entry == overrides.count) {
        if (entry < DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS) {
          ++overrides.count;
        } else {
          // Full of targets earlier plans declared: this plan declares at most
          // the table size and this target is missing from it, so one entry is stale.
          const auto declared_begin = processor.parameter_targets.begin();
          const auto declared_end = declared_begin + processor.parameter_count;
          entry = 0;
          while (std::binary_search(declared_begin, declared_end, overrides.targets[entry])) ++entry;
        }
        overrides.targets[entry] = target;
      }
      overrides.values[entry] = core.resolved_parameter_values[slot][index];
    }
  }
}
}  // namespace daw::audio_core_internal
