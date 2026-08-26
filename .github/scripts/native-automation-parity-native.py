#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    target = ROOT / path
    text = target.read_text()
    actual = text.count(old)
    if actual != count:
        raise SystemExit(f"{path}: expected {count} matches, found {actual}: {old[:140]!r}")
    target.write_text(text.replace(old, new, count))


host = "native/audio-host-macos/src/audio-host.cpp"

replace(host,
'''    std::uint64_t absolute_frame = 0;
    bool scheduled = false;
    std::uint32_t processor_revision = 0;''',
'''    std::uint64_t absolute_frame = 0;
    bool scheduled = false;
    bool processor_linear = false;
    std::uint64_t processor_end_frame = 0;
    float processor_end_value = 0.0F;
    std::uint32_t processor_revision = 0;''')

replace(host,
'''  ControlLane<kSourceQueueCapacity> source_queue{};
  ControlLane<kProcessorQueueCapacity> processor_queue{};
  RealtimeProcessScratch realtime_process_scratch{};''',
'''  ControlLane<kSourceQueueCapacity> source_queue{};
  ControlLane<kProcessorQueueCapacity> scheduled_processor_queue{};
  ControlLane<kProcessorQueueCapacity> processor_queue{};
  RealtimeProcessScratch realtime_process_scratch{};''')

replace(host,
'''    source_queue.read.store(source_queue.write.load(std::memory_order_acquire), std::memory_order_release);
    processor_queue.read.store(processor_queue.write.load(std::memory_order_acquire), std::memory_order_release);
    transport_queue.read.store(transport_queue.write.load(std::memory_order_acquire), std::memory_order_release);''',
'''    source_queue.read.store(source_queue.write.load(std::memory_order_acquire), std::memory_order_release);
    scheduled_processor_queue.read.store(
      scheduled_processor_queue.write.load(std::memory_order_acquire), std::memory_order_release);
    processor_queue.read.store(processor_queue.write.load(std::memory_order_acquire), std::memory_order_release);
    transport_queue.read.store(transport_queue.write.load(std::memory_order_acquire), std::memory_order_release);''')

replace(host,
'''    return HasQueuedControl(urgent_queue) || HasQueuedControl(instrument_queue)
      || HasQueuedControl(source_queue) || HasQueuedControl(processor_queue);''',
'''    return HasQueuedControl(urgent_queue) || HasQueuedControl(instrument_queue)
      || HasQueuedControl(source_queue) || HasQueuedControl(scheduled_processor_queue)
      || HasQueuedControl(processor_queue);''')

replace(host,
'''  impl_->source_queue.read.store(0, std::memory_order_release);
  impl_->source_queue.write.store(0, std::memory_order_release);
  impl_->processor_queue.read.store(0, std::memory_order_release);
  impl_->processor_queue.write.store(0, std::memory_order_release);''',
'''  impl_->source_queue.read.store(0, std::memory_order_release);
  impl_->source_queue.write.store(0, std::memory_order_release);
  impl_->scheduled_processor_queue.read.store(0, std::memory_order_release);
  impl_->scheduled_processor_queue.write.store(0, std::memory_order_release);
  impl_->processor_queue.read.store(0, std::memory_order_release);
  impl_->processor_queue.write.store(0, std::memory_order_release);''')

replace(host, "  if (payload.size() < 56 || impl_->prepared_core != 0) return false;",
              "  if (payload.size() < 60 || impl_->prepared_core != 0) return false;")
replace(host,
'''  const std::uint32_t source_count = ReadLeU32(payload.data() + 48);
  const std::uint32_t automation_count = ReadLeU32(payload.data() + 52);''',
'''  const std::uint32_t source_count = ReadLeU32(payload.data() + 48);
  const std::uint32_t automation_count = ReadLeU32(payload.data() + 52);
  const std::uint32_t processor_automation_count = ReadLeU32(payload.data() + 56);''')
replace(host,
'''    || instrument_count + source_count + automation_count > kMaximumScheduleRecords
    || instrument_count > DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS
    || source_count > DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS
    || automation_count > kMaximumScheduleAutomationSegments) return false;''',
'''    || instrument_count + source_count + automation_count + processor_automation_count > kMaximumScheduleRecords
    || instrument_count > DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS
    || source_count > DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS
    || automation_count > kMaximumScheduleAutomationSegments
    || processor_automation_count > kMaximumScheduleAutomationSegments) return false;''')
replace(host, "  std::size_t offset = 56;", "  std::size_t offset = 60;")

vst_tail = '''    has_previous_automation = true;
    offset += 40;
  }
  if (offset != payload.size()) return false;'''
processor_parse = '''    has_previous_automation = true;
    offset += 40;
  }
  std::uint64_t previous_processor_frame = 0;
  std::uint64_t previous_processor_instance = 0;
  std::uint32_t previous_processor_target = 0;
  bool has_previous_processor = false;
  for (std::uint32_t index = 0; index < processor_automation_count; ++index) {
    if (offset + 40 > payload.size()) return false;
    const auto* bytes = payload.data() + offset;
    const std::uint64_t processor_instance = ReadLeU64(bytes);
    const std::uint32_t parameter_target = ReadLeU32(bytes + 8);
    const std::uint32_t kind = ReadLeU32(bytes + 12);
    const std::uint64_t frame = ReadLeU64(bytes + 16);
    const std::uint64_t processor_end_frame = ReadLeU64(bytes + 24);
    const float start_value = ReadLeFloat(bytes + 32);
    const float end_value = ReadLeFloat(bytes + 36);
    if (processor_instance == 0 || parameter_target == 0 || kind > 1
      || frame < start_frame || frame >= end_frame
      || !std::isfinite(start_value) || !std::isfinite(end_value)
      || (kind == 0 && processor_end_frame != frame)
      || (kind == 1 && (processor_end_frame <= frame || processor_end_frame > end_frame))
      || (has_previous_processor && (frame < previous_processor_frame
        || (frame == previous_processor_frame && (processor_instance < previous_processor_instance
          || (processor_instance == previous_processor_instance
            && parameter_target <= previous_processor_target)))))
      || staging.record_count >= staging.events.size()) return false;
    Impl::QueuedControlEvent event{};
    event.kind = Impl::QueuedControlKind::kProcessor;
    event.window_id = window_id;
    event.absolute_frame = frame;
    event.scheduled = true;
    event.processor_linear = kind == 1;
    event.processor_end_frame = processor_end_frame;
    event.processor_end_value = end_value;
    event.processor_revision = revision;
    event.processor_epoch = epoch;
    event.processor = {
      .processor_instance_id = processor_instance,
      .frame_offset = 0,
      .parameter_target = parameter_target,
      .value = start_value,
    };
    staging.events[staging.record_count++] = event;
    previous_processor_frame = frame;
    previous_processor_instance = processor_instance;
    previous_processor_target = parameter_target;
    has_previous_processor = true;
    offset += 40;
  }
  if (offset != payload.size()) return false;'''
replace(host, vst_tail, processor_parse)

replace(host,
'''  const std::uint32_t source_events = static_cast<std::uint32_t>(staging.record_count) - instrument_events;
  if (!impl_->HasCapacity(Impl::QueuedControlKind::kInstrument, instrument_events)
    || !impl_->HasCapacity(Impl::QueuedControlKind::kSource, source_events)) {''',
'''  const std::uint32_t source_events = static_cast<std::uint32_t>(
    std::count_if(staging.events.begin(), staging.events.begin() + staging.record_count,
      [](const auto& event) { return event.kind == Impl::QueuedControlKind::kSource; })
  );
  const std::uint32_t processor_events = static_cast<std::uint32_t>(
    std::count_if(staging.events.begin(), staging.events.begin() + staging.record_count,
      [](const auto& event) { return event.kind == Impl::QueuedControlKind::kProcessor; })
  );
  if (!impl_->HasCapacity(Impl::QueuedControlKind::kInstrument, instrument_events)
    || !impl_->HasCapacity(Impl::QueuedControlKind::kSource, source_events)
    || !Impl::HasCapacity(impl_->scheduled_processor_queue, processor_events)) {''')

replace(host,
'''  for (std::size_t index = 0; index < staging.record_count; ++index) {
    if (!impl_->EnqueueControlEvent(staging.events[index])) {
      staging.clear();
      return false;
    }
  }''',
'''  for (std::size_t index = 0; index < staging.record_count; ++index) {
    const auto& event = staging.events[index];
    const bool queued = event.kind == Impl::QueuedControlKind::kProcessor
      ? Impl::EnqueueControlEvent(impl_->scheduled_processor_queue, event)
      : impl_->EnqueueControlEvent(event);
    if (!queued) {
      staging.clear();
      return false;
    }
  }''')

old_drain = '''    const auto drain_processor_lane = [&]<std::size_t Capacity>(Impl::ControlLane<Capacity>& lane) {
      std::uint32_t read = lane.read.load(std::memory_order_relaxed);
      const std::uint32_t write = lane.write.load(std::memory_order_acquire);
      while (read != write) {
        const auto& event = lane.events[read % Capacity];
        if (event.processor_revision != 0
          && (event.processor_revision != impl_->active_revision.load(std::memory_order_acquire)
            || event.processor_epoch != applied_epoch)) {
          ++read;
          continue;
        }
        if (event.processor.frame_offset >= frames) break;
        if (processor_event_count >= processor_events.size()) return false;
        processor_events[processor_event_count] = event.processor;
        ++processor_event_count;
        processor_sequence_applied = std::max(processor_sequence_applied, event.processor_sequence);
        ++read;
      }
      lane.read.store(read, std::memory_order_release);
      return true;
    };'''
new_drain = '''    const auto drain_scheduled_processor_lane = [&]<std::size_t Capacity>(Impl::ControlLane<Capacity>& lane) {
      std::uint32_t read = lane.read.load(std::memory_order_relaxed);
      const std::uint32_t write = lane.write.load(std::memory_order_acquire);
      while (read != write) {
        const auto& event = lane.events[read % Capacity];
        if (event.processor_revision != impl_->active_revision.load(std::memory_order_acquire)
          || event.processor_epoch != applied_epoch) {
          ++read;
          continue;
        }
        if (!impl_->applied_transport_running.load(std::memory_order_acquire)) break;
        if (event.window_id > published_window) break;
        if (event.absolute_frame >= static_cast<std::uint64_t>(block_end_frame)) break;
        if (event.absolute_frame < static_cast<std::uint64_t>(block_start_frame)) {
          ++read;
          continue;
        }
        if (event.processor_linear) return false;
        if (processor_event_count >= processor_events.size()) return false;
        processor_events[processor_event_count] = event.processor;
        processor_events[processor_event_count].frame_offset = event.absolute_frame <= static_cast<std::uint64_t>(block_start_frame)
          ? 0
          : static_cast<std::uint32_t>(event.absolute_frame - static_cast<std::uint64_t>(block_start_frame));
        ++processor_event_count;
        ++read;
      }
      lane.read.store(read, std::memory_order_release);
      return true;
    };
    const auto drain_processor_lane = [&]<std::size_t Capacity>(Impl::ControlLane<Capacity>& lane) {
      std::uint32_t read = lane.read.load(std::memory_order_relaxed);
      const std::uint32_t write = lane.write.load(std::memory_order_acquire);
      while (read != write) {
        const auto& event = lane.events[read % Capacity];
        if (event.processor_revision != 0
          && (event.processor_revision != impl_->active_revision.load(std::memory_order_acquire)
            || event.processor_epoch != applied_epoch)) {
          ++read;
          continue;
        }
        if (event.processor.frame_offset >= frames) break;
        if (processor_event_count >= processor_events.size()) return false;
        processor_events[processor_event_count] = event.processor;
        ++processor_event_count;
        processor_sequence_applied = std::max(processor_sequence_applied, event.processor_sequence);
        ++read;
      }
      lane.read.store(read, std::memory_order_release);
      return true;
    };'''
replace(host, old_drain, new_drain)

replace(host,
'''      || !drain_instrument_lane(impl_->instrument_queue)
      || !drain_processor_lane(impl_->processor_queue)
      || !drain_source_lane(impl_->source_queue)) {''',
'''      || !drain_instrument_lane(impl_->instrument_queue)
      || !drain_scheduled_processor_lane(impl_->scheduled_processor_queue)
      || !drain_processor_lane(impl_->processor_queue)
      || !drain_source_lane(impl_->source_queue)) {''')

old_sort = '''    std::sort(processor_events.begin(), processor_events.begin() + processor_event_count,
      [](const auto& left, const auto& right) {
        return left.processor_instance_id < right.processor_instance_id
          || (left.processor_instance_id == right.processor_instance_id && (
            left.frame_offset < right.frame_offset
            || (left.frame_offset == right.frame_offset && left.parameter_target < right.parameter_target)));
      });'''
new_sort = '''    const auto processor_before = [](const auto& left, const auto& right) {
      return left.processor_instance_id < right.processor_instance_id
        || (left.processor_instance_id == right.processor_instance_id && (
          left.frame_offset < right.frame_offset
          || (left.frame_offset == right.frame_offset && left.parameter_target < right.parameter_target)));
    };
    for (std::uint32_t index = 1; index < processor_event_count; ++index) {
      const auto event = processor_events[index];
      std::uint32_t position = index;
      while (position > 0 && processor_before(event, processor_events[position - 1])) {
        processor_events[position] = processor_events[position - 1];
        --position;
      }
      processor_events[position] = event;
    }'''
replace(host, old_sort, new_sort)

# v17 schedule test helper: append the processor-automation count.
test = "native/audio-host-macos/tests/audio_host_test.cpp"
replace(test,
'''  AppendLeU32(payload, 0);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, 0);
  return payload;
}''',
'''  AppendLeU32(payload, 0);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, 0);
  AppendLeU32(payload, 0);
  return payload;
}''', count=1)

helper_anchor = '''std::vector<std::uint8_t> ScheduleAutomationWindow(
'''
helper = '''std::vector<std::uint8_t> ScheduleProcessorSetWindow(
  const std::uint32_t revision,
  const std::uint32_t epoch,
  const std::uint64_t window_id,
  const std::uint64_t start_frame,
  const std::uint64_t end_frame,
  const std::uint64_t processor_instance_id,
  const std::uint32_t parameter_target,
  const std::uint64_t frame,
  const float value
) {
  auto payload = ScheduleWindow(revision, epoch, window_id, start_frame, end_frame, 0, 1, false);
  WriteLeU32(payload, 56, 1);
  AppendLeU64(payload, processor_instance_id);
  AppendLeU32(payload, parameter_target);
  AppendLeU32(payload, 0);
  AppendLeU64(payload, frame);
  AppendLeU64(payload, frame);
  AppendLeFloat(payload, value);
  AppendLeFloat(payload, value);
  return payload;
}

std::vector<std::uint8_t> ScheduleAutomationWindow(
'''
replace(test, helper_anchor, helper)

# Add a parser/drain regression near the existing schedule tests. The scheduled set is absolute-frame;
# rendering the window must consume it without rejecting the callback.
insert_before = '''void TestScheduleWindowCompletionSemantics() {
'''
phase_a_test = '''void TestScheduledProcessorSetUsesAbsoluteFrame() {
  daw::audio_host_macos::AudioHost host;
  assert(host.Configure({
    .device_uid = "diagnostic",
    .sample_rate_hz = 48'000,
    .max_frames_per_block = 4,
    .channel_count = 2,
    .revision = 1,
  }));
  assert(host.PrepareAndPublishGraph(2, GraphSnapshot(2, 1.0F, 0, true)));
  assert(host.SetTransport(1, true, 0));
  assert(host.StartDiagnosticMode());
  assert(host.QueueScheduleWindow(ScheduleProcessorSetWindow(
    2, 1, 1, 0, 4, 77, DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB, 2, -6.0F
  )));
  std::array<float, 4> left{{1.0F, 1.0F, 1.0F, 1.0F}};
  std::array<float, 4> right = left;
  std::array<float, 4> out_left{};
  std::array<float, 4> out_right{};
  const std::array<const float*, 2> input{{left.data(), right.data()}};
  const std::array<float*, 2> output{{out_left.data(), out_right.data()}};
  assert(host.ProcessPlanar(input, output, 4));
  assert(host.diagnostics().rejected_blocks == 0);
  host.Stop();
}

void TestScheduleWindowCompletionSemantics() {
'''
replace(test, insert_before, phase_a_test)

# Register the regression immediately before the existing completion-semantics test.
replace(test,
'''  TestScheduleWindowCompletionSemantics();''',
'''  TestScheduledProcessorSetUsesAbsoluteFrame();
  TestScheduleWindowCompletionSemantics();''')

print("native automation parity Phase A patch applied")
