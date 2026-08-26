#!/usr/bin/env python3
from pathlib import Path

path = Path("native/audio-host-macos/tests/audio_host_test.cpp")
text = path.read_text()

lifecycle_old = '''  assert(host.PrepareAndPublishGraph(2, GraphSnapshot(2, 1.0F, 0, true)));
  assert(host.SetTransport(1, true, 0));
  assert(host.StartDiagnosticMode());
  assert(host.QueueScheduleWindow(ScheduleProcessorSetWindow(
'''
lifecycle_new = '''  assert(host.PrepareAndPublishGraph(2, GraphSnapshot(2, 1.0F, 0, true)));
  assert(host.SetTransport(1, false, 0));
  assert(host.StartDiagnosticMode());
  assert(host.SetTransport(1, true, 0));
  assert(host.QueueScheduleWindow(ScheduleProcessorSetWindow(
'''
if text.count(lifecycle_old) != 1:
    raise SystemExit(f"expected one scheduled processor lifecycle fixture, found {text.count(lifecycle_old)}")
text = text.replace(lifecycle_old, lifecycle_new, 1)

utility_old = '''    AppendLeU32(payload, 77);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
    AppendLeU32(payload, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, 1);
    AppendLeFloat(payload, 0.0F);
    AppendLeU32(payload, DAW_AUDIO_UTILITY_POLARITY_NORMAL);
    AppendLeU32(payload, DAW_AUDIO_UTILITY_INPUT_MODE_STEREO);
    AppendLeFloat(payload, 0.0F);
    AppendLeFloat(payload, 0.0F);
    AppendLeFloat(payload, 1.0F);
    AppendLeU32(payload, DAW_AUDIO_UTILITY_MATRIX_STEREO);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, 0);
'''
utility_new = '''    AppendLeU32(payload, 77);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
    AppendLeU32(payload, DAW_AUDIO_GRAPH_LAYOUT_STEREO);
    AppendLeU32(payload, 1);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, 1);
    AppendLeFloat(payload, 0.0F);
    AppendLeU32(payload, DAW_AUDIO_UTILITY_POLARITY_NORMAL);
    AppendLeU32(payload, DAW_AUDIO_UTILITY_INPUT_MODE_STEREO);
    AppendLeFloat(payload, 0.0F);
    AppendLeFloat(payload, 0.0F);
    AppendLeFloat(payload, 1.0F);
    AppendLeU32(payload, DAW_AUDIO_UTILITY_MATRIX_STEREO);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, 0);
    AppendLeU32(payload, DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB);
'''
if text.count(utility_old) != 1:
    raise SystemExit(f"expected one utility graph fixture, found {text.count(utility_old)}")
text = text.replace(utility_old, utility_new, 1)

path.write_text(text)
print("native automation parity lifecycle/parameter fixture fixed")
