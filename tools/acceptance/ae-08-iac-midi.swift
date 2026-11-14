// CoreMIDI and CoreAudio helper for the AE-08 phase 9 hardware rows (run with `swift`, see ae-08-phase-9-devices.ts).
//   ae-08-iac-midi.swift sources                          names of the MIDI sources that are online, one per line
//   ae-08-iac-midi.swift send <name> on|off <note> [vel]  one note message to the destination called <name>
//   ae-08-iac-midi.swift play <output name> <wav path>    plays a float32 stereo WAV to the output device called <output name>
import AVFoundation
import CoreAudio
import CoreMIDI
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

func displayName(_ endpoint: MIDIEndpointRef) -> String {
  var name: Unmanaged<CFString>?
  MIDIObjectGetStringProperty(endpoint, kMIDIPropertyDisplayName, &name)
  return name?.takeRetainedValue() as String? ?? ""
}

func isOnline(_ endpoint: MIDIEndpointRef) -> Bool {
  var offline: Int32 = 0
  MIDIObjectGetIntegerProperty(endpoint, kMIDIPropertyOffline, &offline)
  return offline == 0
}

// CoreMIDI lists no endpoints to a process that has not created a client.
var client = MIDIClientRef()
guard MIDIClientCreate("ae08" as CFString, nil, nil, &client) == noErr else { fail("CoreMIDI client unavailable") }

let arguments = CommandLine.arguments.dropFirst()
switch arguments.first {
case "sources":
  for index in 0..<MIDIGetNumberOfSources() {
    let source = MIDIGetSource(index)
    if isOnline(source) { print(displayName(source)) }
  }
case "send":
  let rest = Array(arguments.dropFirst())
  guard rest.count >= 3, let note = UInt8(rest[2]) else { fail("usage: send <name> on|off <note> [velocity]") }
  let velocity = rest.count > 3 ? UInt8(rest[3]) ?? 100 : 100
  var port = MIDIPortRef()
  guard MIDIOutputPortCreate(client, "ae08-out" as CFString, &port) == noErr else { fail("CoreMIDI output port unavailable") }
  var destination: MIDIEndpointRef?
  for index in 0..<MIDIGetNumberOfDestinations() where displayName(MIDIGetDestination(index)) == rest[0] && isOnline(MIDIGetDestination(index)) {
    destination = MIDIGetDestination(index)
  }
  guard let target = destination else { fail("MIDI destination \(rest[0]) is not online") }
  guard rest[1] == "on" || rest[1] == "off" else { fail("expected on or off") }
  var packetList = MIDIPacketList()
  let packet = MIDIPacketListInit(&packetList)
  let bytes: [UInt8] = [rest[1] == "on" ? 0x90 : 0x80, note, rest[1] == "on" ? velocity : 0]
  _ = MIDIPacketListAdd(&packetList, MemoryLayout<MIDIPacketList>.size, packet, 0, bytes.count, bytes)
  guard MIDISend(port, target, &packetList) == noErr else { fail("MIDISend failed") }
case "play":
  let rest = Array(arguments.dropFirst())
  guard rest.count == 2 else { fail("usage: play <output name> <wav path>") }
  var deviceCount: UInt32 = 0
  var devicesAddress = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &devicesAddress, 0, nil, &deviceCount)
  var devices = [AudioDeviceID](repeating: 0, count: Int(deviceCount) / MemoryLayout<AudioDeviceID>.size)
  AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &devicesAddress, 0, nil, &deviceCount, &devices)
  var match: AudioDeviceID?
  for device in devices {
    var nameAddress = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var name: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    AudioObjectGetPropertyData(device, &nameAddress, 0, nil, &size, &name)
    if (name?.takeRetainedValue() as String?) == rest[0] { match = device }
  }
  guard let outputDevice = match else { fail("audio device \(rest[0]) is not present") }
  guard let file = try? AVAudioFile(forReading: URL(fileURLWithPath: rest[1])),
    let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
    (try? file.read(into: buffer)) != nil else { fail("cannot read \(rest[1])") }
  let engine = AVAudioEngine()
  let player = AVAudioPlayerNode()
  guard let unit = engine.outputNode.audioUnit else { fail("no output unit") }
  var deviceID = outputDevice
  guard AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &deviceID, UInt32(MemoryLayout<AudioDeviceID>.size)) == noErr else {
    fail("cannot select \(rest[0]) on the engine only")
  }
  engine.attach(player)
  engine.connect(player, to: engine.mainMixerNode, format: file.processingFormat)
  do { try engine.start() } catch { fail("engine start failed: \(error)") }
  let finished = DispatchSemaphore(value: 0)
  player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { _ in finished.signal() }
  player.play()
  finished.wait()
  engine.stop()
default:
  fail("usage: sources | send <name> on|off <note> [velocity] | play <output name> <wav path>")
}
