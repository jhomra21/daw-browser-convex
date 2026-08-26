#!/usr/bin/env python3
from pathlib import Path

path = Path("native/audio-host-macos/tests/audio_host_test.cpp")
text = path.read_text()

signature_old = '''std::vector<std::uint8_t> GraphSnapshot(
  const std::uint32_t revision,
  const float gain,
  const std::uint32_t native_node_latency = 0,
  const bool with_utility = false
) {
'''
signature_new = '''std::vector<std::uint8_t> GraphSnapshot(
  const std::uint32_t revision,
  const float gain,
  const std::uint32_t native_node_latency = 0,
  const bool with_utility = false,
  const bool with_utility_parameter_target = false
) {
'''
if text.count(signature_old) != 1:
    raise SystemExit(f"expected GraphSnapshot signature once, found {text.count(signature_old)}")
text = text.replace(signature_old, signature_new, 1)

parameter_count_old = '''    AppendLeU32(payload, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
    AppendLeU32(payload, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, 1);
'''
parameter_count_new = '''    AppendLeU32(payload, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
    AppendLeU32(payload, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
    AppendLeU32(payload, with_utility_parameter_target ? 1 : 0);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, 1);
'''
if text.count(parameter_count_old) != 1:
    raise SystemExit(f"expected utility parameter-count fixture once, found {text.count(parameter_count_old)}")
text = text.replace(parameter_count_old, parameter_count_new, 1)

utility_tail_old = '''    AppendLeU32(payload, DAW_AUDIO_UTILITY_MATRIX_STEREO);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, 0);
  }
'''
utility_tail_new = '''    AppendLeU32(payload, DAW_AUDIO_UTILITY_MATRIX_STEREO);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, 0);
    if (with_utility_parameter_target) {
      AppendLeU32(payload, DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB);
    }
  }
'''
if text.count(utility_tail_old) != 1:
    raise SystemExit(f"expected utility state tail once, found {text.count(utility_tail_old)}")
text = text.replace(utility_tail_old, utility_tail_new, 1)

lifecycle_old = '''  assert(host.PrepareAndPublishGraph(2, GraphSnapshot(2, 1.0F, 0, true)));
  assert(host.SetTransport(1, true, 0));
  assert(host.StartDiagnosticMode());
  assert(host.QueueScheduleWindow(ScheduleProcessorSetWindow(
'''
lifecycle_new = '''  assert(host.PrepareAndPublishGraph(2, GraphSnapshot(2, 1.0F, 0, true, true)));
  assert(host.SetTransport(1, false, 0));
  assert(host.StartDiagnosticMode());
  assert(host.SetTransport(1, true, 0));
  assert(host.QueueScheduleWindow(ScheduleProcessorSetWindow(
'''
if text.count(lifecycle_old) != 1:
    raise SystemExit(f"expected one scheduled processor lifecycle fixture, found {text.count(lifecycle_old)}")
text = text.replace(lifecycle_old, lifecycle_new, 1)

path.write_text(text)
print("native automation parity test fixture isolated")
