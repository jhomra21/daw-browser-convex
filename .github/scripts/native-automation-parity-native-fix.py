from pathlib import Path

path = Path("native/audio-host-macos/tests/audio_host_test.cpp")
text = path.read_text()
old = """    0x44, 0x41, 0x57, 0x48,\n    0x00, 0x00, 0x00, 0x10,\n    0x00, 0x00, 0x00, 0x27,\n"""
new = """    0x44, 0x41, 0x57, 0x48,\n    0x00, 0x00, 0x00, static_cast<std::uint8_t>(daw::audio_host_macos::kControlProtocolVersion),\n    0x00, 0x00, 0x00, 0x27,\n"""
if text.count(old) != 1:
    raise SystemExit("control-frame protocol fixture anchor changed")
path.write_text(text.replace(old, new, 1))
print("native protocol fixture migration applied")
