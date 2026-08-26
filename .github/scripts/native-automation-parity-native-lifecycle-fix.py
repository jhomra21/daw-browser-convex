#!/usr/bin/env python3
from pathlib import Path

path = Path("native/audio-host-macos/tests/audio_host_test.cpp")
text = path.read_text()
old = '''  assert(host.PrepareAndPublishGraph(2, GraphSnapshot(2, 1.0F, 0, true)));
  assert(host.SetTransport(1, true, 0));
  assert(host.StartDiagnosticMode());
  assert(host.QueueScheduleWindow(ScheduleProcessorSetWindow(
'''
new = '''  assert(host.PrepareAndPublishGraph(2, GraphSnapshot(2, 1.0F, 0, true)));
  assert(host.SetTransport(1, false, 0));
  assert(host.StartDiagnosticMode());
  assert(host.SetTransport(1, true, 0));
  assert(host.QueueScheduleWindow(ScheduleProcessorSetWindow(
'''
if text.count(old) != 1:
    raise SystemExit(f"expected one scheduled processor lifecycle fixture, found {text.count(old)}")
path.write_text(text.replace(old, new, 1))
print("native automation parity lifecycle fixture fixed")
