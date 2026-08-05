import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useAppPreferences } from "~/context/app-preferences"
import { areAudioDeviceListsEqual, buildActiveInputProbeConstraints, canUseStereoRecording, filterAudioDevices, isSelectedDeviceAvailable, resolveAudioRuntimeConfiguration, resolveRecordingChannelOptions } from "~/lib/audio-settings-core"
import { getAudioEngine, getAudioSinkStatus, playAudioOutputTestTone, subscribeAudioSinkStatus } from "~/lib/audio-engine-singleton"
import { parseAudioLatencyMode, parseAudioSampleRate } from "~/lib/preferences/app-preferences"
import { findExactCalibration, replaceExactCalibration, resolveCalibrationPlatformIdentity } from "~/lib/recording/recording-calibration"
import { getRecordingDiagnostics, subscribeRecordingDiagnostics } from "~/lib/recording/recording-diagnostics"
import { DashboardRow, DashboardScrollView, DashboardSection } from "./dashboard-shared"

const formatLatency = (seconds: number | null) => seconds === null ? "Unavailable" : `${(seconds * 1000).toFixed(1)} ms`
const formatFrames = (frames: number | null) => frames === null ? "unavailable" : String(frames)
type OutputSelectableMediaDevices = MediaDevices & {
  selectAudioOutput: () => Promise<MediaDeviceInfo>
}
const supportsOutputSelection = (mediaDevices: MediaDevices): mediaDevices is OutputSelectableMediaDevices =>
  "selectAudioOutput" in mediaDevices && typeof mediaDevices.selectAudioOutput === "function"

export function DashboardAudioView() {
  const preferences = useAppPreferences()
  const requiresNativeAudio = import.meta.env.VITE_DESKTOP === "true"
  const [devices, setDevices] = createSignal<MediaDeviceInfo[]>([])
  const [deviceError, setDeviceError] = createSignal("")
  const [sinkStatus, setSinkStatus] = createSignal(getAudioSinkStatus())
  const [activeInputSettings, setActiveInputSettings] = createSignal<MediaTrackSettings | null>(null)
  const [diagnostics, setDiagnostics] = createSignal(getRecordingDiagnostics())
  const [calibrationState, setCalibrationState] = createSignal<"idle" | "running" | "cancelled" | "failed" | "complete">("idle")
  const [calibrationMessage, setCalibrationMessage] = createSignal("")
  const [platformIdentity, setPlatformIdentity] = createSignal<string | null>(null)
  let calibrationController: AbortController | null = null
  let deviceRequestId = 0
  let inputProbeRequestId = 0
  const supportedConstraints = navigator.mediaDevices.getSupportedConstraints()
  const audioEngine = getAudioEngine()
  const audioDevices = createMemo(() => filterAudioDevices(devices()))
  const selectedInputDeviceId = () => preferences.audio.preferences().inputDeviceId
  const [runtime, setRuntime] = createSignal(audioEngine.getRuntimeSnapshot())
  const hasPendingRuntimeChange = () => {
    const snapshot = runtime()
    if (snapshot.state === "uninitialized") return false
    const requested = resolveAudioRuntimeConfiguration(preferences.audio.preferences())
    return snapshot.requestedSampleRate !== (requested.sampleRate ?? null)
      || snapshot.latencyHint !== requested.latencyHint
  }
  const sinkStatusText = () => {
    const status = sinkStatus()
    if (status.state === "error") return status.message
    if (status.state === "unsupported") return "Live output routing is not supported by this browser."
    if (status.state === "uninitialized") return "Output saved and will be applied when audio starts."
    return `Route status: ${status.state}`
  }

  const refreshDevices = async () => {
    const requestId = ++deviceRequestId
    try {
      const nextDevices = await navigator.mediaDevices.enumerateDevices()
      if (requestId !== deviceRequestId) return
      setDevices((current) => areAudioDeviceListsEqual(current, nextDevices) ? current : nextDevices)
      setDeviceError("")
    } catch (error) {
      if (requestId !== deviceRequestId) return
      setDeviceError(error instanceof Error ? error.message : "Unable to enumerate audio devices.")
    }
  }

  const refreshActiveInputSettings = async (inputDeviceId: string) => {
    const requestId = ++inputProbeRequestId
    setActiveInputSettings(null)
    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getUserMedia(buildActiveInputProbeConstraints(inputDeviceId))
      if (requestId !== inputProbeRequestId) return
      setActiveInputSettings(stream.getAudioTracks()[0]?.getSettings() ?? null)
      setDeviceError("")
    } catch (error) {
      if (requestId !== inputProbeRequestId) return
      setActiveInputSettings(null)
      setDeviceError(error instanceof Error ? error.message : "Unable to inspect the selected microphone.")
    } finally {
      for (const track of stream?.getTracks() ?? []) track.stop()
    }
  }

  const requestMicrophone = async () => {
    await refreshActiveInputSettings(selectedInputDeviceId())
    await refreshDevices()
  }

  const recording = () => preferences.recording.preferences()
  const setRecording = (update: Partial<ReturnType<typeof recording>>) => {
    const current = recording()
    preferences.recording.setInputConfiguration({
      layout: update.layout ?? current.layout,
      inputChannel: update.inputChannel ?? current.inputChannel,
      monitor: update.monitor ?? current.monitor,
      gainDb: update.gainDb ?? current.gainDb,
      invertPolarity: update.invertPolarity ?? current.invertPolarity,
    })
  }
  const exactCalibration = createMemo(() => {
    const identity = platformIdentity()
    const snapshot = runtime()
    if (!identity || snapshot.sampleRate === null) return null
    return findExactCalibration(recording().calibrations, {
      inputDeviceId: preferences.audio.preferences().inputDeviceId,
      outputDeviceId: preferences.audio.preferences().outputDeviceId,
      sampleRate: snapshot.sampleRate,
      platform: navigator.platform,
      userAgent: navigator.userAgent,
      userAgentData: navigator.userAgentData,
    })
  })
  const startCalibration = async () => {
    if (requiresNativeAudio) {
      setCalibrationState("failed")
      setCalibrationMessage("Browser loopback calibration is unavailable in the native desktop audio mode.")
      return
    }
    const audio = preferences.audio.preferences()
    const identity = await resolveCalibrationPlatformIdentity(navigator)
    setPlatformIdentity(identity)
    if (!audio.inputDeviceId || !audio.outputDeviceId || !identity) {
      setCalibrationState("failed")
      setCalibrationMessage("Choose explicit input and output devices. Stable browser and OS identity is also required.")
      return
    }
    calibrationController = new AbortController()
    setCalibrationState("running")
    setCalibrationMessage("Playing the calibration signal and measuring the returned input…")
    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: audio.inputDeviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
      const result = await audioEngine.calibrateRecording({
        stream,
        inputDeviceId: audio.inputDeviceId,
        outputDeviceId: audio.outputDeviceId,
        signal: calibrationController.signal,
      })
      if (!result.accepted) {
        setCalibrationState("failed")
        setCalibrationMessage(`Measurement rejected: ${result.reason}. Confidence ${Math.round(result.confidence * 100)}%.`)
        return
      }
      const sampleRate = audioEngine.getRuntimeSnapshot().sampleRate
      if (sampleRate === null) throw new Error("Calibration sample rate is unavailable.")
      preferences.recording.setCalibrations(replaceExactCalibration(recording().calibrations, {
        inputDeviceId: audio.inputDeviceId,
        outputDeviceId: audio.outputDeviceId,
        sampleRate,
        measuredRoundTripFrames: result.measuredRoundTripFrames,
        recordingOffsetFrames: -result.measuredRoundTripFrames,
        confidence: result.confidence,
        platformIdentity: identity,
        createdAtMs: Date.now(),
      }))
      setCalibrationState("complete")
      setCalibrationMessage(`Measured ${result.measuredRoundTripFrames} frames with ${Math.round(result.confidence * 100)}% confidence.`)
    } catch (error) {
      const cancelled = error instanceof DOMException && error.name === "AbortError"
      setCalibrationState(cancelled ? "cancelled" : "failed")
      setCalibrationMessage(cancelled ? "Calibration cancelled." : error instanceof Error ? error.message : "Calibration failed.")
    } finally {
      for (const track of stream?.getTracks() ?? []) track.stop()
      calibrationController = null
    }
  }

  const chooseOutput = async () => {
    if (!supportsOutputSelection(navigator.mediaDevices)) {
      setDeviceError("This browser does not support authorized audio output selection.")
      return
    }
    try {
      const device = await navigator.mediaDevices.selectAudioOutput()
      preferences.audio.setOutputDeviceId(device.deviceId)
      await refreshDevices()
    } catch (error) {
      setDeviceError(error instanceof Error ? error.message : "Audio output selection was cancelled.")
    }
  }

  const useSystemOutput = () => {
    preferences.audio.setOutputDeviceId("")
  }

  const playTestTone = async () => {
    if (requiresNativeAudio) {
      setDeviceError("The desktop native audio host does not expose a browser test tone.")
      return
    }
    try {
      await playAudioOutputTestTone()
      setDeviceError("")
    } catch (error) {
      setDeviceError(error instanceof Error ? error.message : "Unable to play the output test tone.")
    }
  }

  onMount(() => {
    void refreshDevices()
    void resolveCalibrationPlatformIdentity(navigator).then(setPlatformIdentity)
    const onDeviceChange = () => {
      inputProbeRequestId += 1
      setActiveInputSettings(null)
      void refreshDevices()
    }
    navigator.mediaDevices.addEventListener("devicechange", onDeviceChange)
    const unsubscribe = subscribeAudioSinkStatus(() => setSinkStatus(getAudioSinkStatus()))
    const unsubscribeRuntime = audioEngine.subscribeRuntimeSnapshot(() => setRuntime(audioEngine.getRuntimeSnapshot()))
    const unsubscribeDiagnostics = subscribeRecordingDiagnostics(() => setDiagnostics(getRecordingDiagnostics()))
    onCleanup(() => {
      deviceRequestId += 1
      inputProbeRequestId += 1
      setActiveInputSettings(null)
      navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange)
      unsubscribe()
      unsubscribeRuntime()
      unsubscribeDiagnostics()
      calibrationController?.abort()
    })
  })

  return (
    <DashboardScrollView>
      <DashboardSection title="Audio Devices" description="Device labels become available after browser permission is granted.">
        <DashboardRow
          label="Recording input"
          controlId="audio-recording-input"
          value={!isSelectedDeviceAvailable(selectedInputDeviceId(), audioDevices().inputs) ? "Saved device is currently unavailable." : undefined}
          action={
            <select id="audio-recording-input" class="h-8 border border-border bg-background px-2 text-sm" onChange={(event) => {
              inputProbeRequestId += 1
              setActiveInputSettings(null)
              preferences.audio.setInputDeviceId(event.currentTarget.value)
            }}>
              <option value="" selected={!selectedInputDeviceId()}>System default</option>
              <Show when={selectedInputDeviceId() && !isSelectedDeviceAvailable(selectedInputDeviceId(), audioDevices().inputs)}>
                <option value={selectedInputDeviceId()} selected>Saved microphone (unavailable)</option>
              </Show>
              <For each={audioDevices().inputs}>{(device) => <option value={device.deviceId} selected={device.deviceId === selectedInputDeviceId()}>{device.label || "Microphone"}</option>}</For>
            </select>
          }
        />
        <DashboardRow label="Microphone permission" action={<button type="button" class="h-8 border border-border px-3 text-sm" onClick={requestMicrophone}>Request access</button>} />
        <DashboardRow
          label="Playback output"
          value={!isSelectedDeviceAvailable(preferences.audio.preferences().outputDeviceId, audioDevices().outputs) ? "Saved output requires reconnection or reauthorization." : sinkStatusText()}
          action={<div class="flex gap-2"><button type="button" class="h-8 border border-border px-3 text-sm" onClick={useSystemOutput}>System output</button><button type="button" class="h-8 border border-border px-3 text-sm" onClick={chooseOutput}>Choose output</button></div>}
        />
      </DashboardSection>

      <DashboardSection title="Audio Engine" description="Changes apply to the next audio context and never rebuild an active graph.">
        <Show when={hasPendingRuntimeChange()}>
          <p class="px-4 py-2 text-xs text-muted-foreground">The requested sample rate or latency mode will apply the next time the timeline creates an audio context.</p>
        </Show>
        <DashboardRow label="Requested sample rate" controlId="audio-sample-rate" action={
          <select id="audio-sample-rate" class="h-8 border border-border bg-background px-2 text-sm" onChange={(event) => {
            preferences.audio.setSampleRate(parseAudioSampleRate(Number(event.currentTarget.value)))
          }}>
            <option value="default" selected={preferences.audio.preferences().sampleRate === "default"}>System default</option>
            <option value="44100" selected={preferences.audio.preferences().sampleRate === 44100}>44.1 kHz</option>
            <option value="48000" selected={preferences.audio.preferences().sampleRate === 48000}>48 kHz</option>
            <option value="96000" selected={preferences.audio.preferences().sampleRate === 96000}>96 kHz</option>
          </select>
        } />
        <DashboardRow label="Latency mode" controlId="audio-latency-mode" action={
          <select id="audio-latency-mode" class="h-8 border border-border bg-background px-2 text-sm" onChange={(event) => {
            preferences.audio.setLatencyMode(parseAudioLatencyMode(event.currentTarget.value))
          }}>
            <option value="interactive" selected={preferences.audio.preferences().latencyMode === "interactive"}>Interactive</option>
            <option value="balanced" selected={preferences.audio.preferences().latencyMode === "balanced"}>Balanced</option>
            <option value="playback" selected={preferences.audio.preferences().latencyMode === "playback"}>Playback</option>
          </select>
        } />
        <DashboardRow label="Buffer size" value="Managed by the browser and operating system." />
        <Show when={requiresNativeAudio} fallback={
          <DashboardRow
            label="Experimental portable browser playback"
            value="Uses the Wasm AudioWorklet only for fully supported source-only sessions."
            action={<input
              type="checkbox"
              checked={preferences.audio.preferences().portableBrowserPlaybackEnabled}
              onChange={(event) => preferences.audio.setPortableBrowserPlaybackEnabled(event.currentTarget.checked)}
            />}
          />
        }>
          <DashboardRow label="Playback backend" value="Native CoreAudio is required in the Electron app." />
        </Show>
      </DashboardSection>

      <DashboardSection title="Recording">
        <Show when={!requiresNativeAudio}>
          <DashboardRow
            label="Experimental portable recording"
            value="Uses the portable Wasm recorder only while portable browser playback is active. Legacy recording remains the default."
            action={<input
              type="checkbox"
              disabled={!preferences.audio.preferences().portableBrowserPlaybackEnabled}
              checked={recording().portableEnabled}
              onChange={(event) => preferences.recording.setPortableEnabled(event.currentTarget.checked)}
            />}
          />
        </Show>
        <DashboardRow label="Input layout" controlId="recording-layout" action={<select id="recording-layout" class="h-8 border border-border bg-background px-2 text-sm" value={recording().layout} onChange={(event) => setRecording({ layout: event.currentTarget.value === "stereo" ? "stereo" : "mono" })}><option value="mono">Mono</option><option value="stereo" disabled={!canUseStereoRecording(activeInputSettings()?.channelCount, recording().inputChannel)}>Stereo</option></select>} />
        <DashboardRow label="Mono input channel" controlId="recording-input-channel" value="Channels are shown one-based." action={<select id="recording-input-channel" class="h-8 border border-border bg-background px-2 text-sm" value={recording().inputChannel} disabled={recording().layout === "stereo"} onChange={(event) => setRecording({ inputChannel: Number(event.currentTarget.value) })}><For each={resolveRecordingChannelOptions(activeInputSettings()?.channelCount)}>{(option) => <option value={option.channel} disabled={option.disabled}>{option.label}</option>}</For></select>} />
        <DashboardRow label="Software monitoring" controlId="recording-monitor" value="Monitoring runs through the armed track FX. Disable interface direct monitoring to avoid doubled sound; speakers can cause feedback." action={<select id="recording-monitor" class="h-8 border border-border bg-background px-2 text-sm" value={recording().monitor} onChange={(event) => setRecording({ monitor: event.currentTarget.value === "auto" || event.currentTarget.value === "on" ? event.currentTarget.value : "off" })}><option value="off">Off</option><option value="auto">Auto</option><option value="on">On</option></select>} />
        <DashboardRow label="Input gain" controlId="recording-gain" value={`${recording().gainDb.toFixed(1)} dB`} action={<input id="recording-gain" type="range" min="-60" max="24" step="0.5" value={recording().gainDb} onInput={(event) => setRecording({ gainDb: Number(event.currentTarget.value) })} />} />
        <DashboardRow label="Invert polarity" controlId="recording-polarity" action={<input id="recording-polarity" type="checkbox" checked={recording().invertPolarity} onChange={(event) => setRecording({ invertPolarity: event.currentTarget.checked })} />} />
        <DashboardRow label="Manual recording offset" controlId="recording-offset" value="Frames. Used when no exact reusable calibration matches." action={<input id="recording-offset" type="number" class="h-8 w-28 border border-border bg-background px-2 text-sm" value={recording().manualOffsetFrames} onChange={(event) => preferences.recording.setManualOffsetFrames(Number(event.currentTarget.value))} />} />
        <DashboardRow label="Echo cancellation" controlId="audio-echo-cancellation" value={supportedConstraints.echoCancellation ? undefined : "Not supported by this browser."} action={<input id="audio-echo-cancellation" type="checkbox" disabled={!supportedConstraints.echoCancellation} checked={preferences.audio.preferences().echoCancellation} onChange={(event) => preferences.audio.setEchoCancellation(event.currentTarget.checked)} />} />
        <DashboardRow label="Noise suppression" controlId="audio-noise-suppression" value={supportedConstraints.noiseSuppression ? undefined : "Not supported by this browser."} action={<input id="audio-noise-suppression" type="checkbox" disabled={!supportedConstraints.noiseSuppression} checked={preferences.audio.preferences().noiseSuppression} onChange={(event) => preferences.audio.setNoiseSuppression(event.currentTarget.checked)} />} />
        <DashboardRow label="Automatic gain control" controlId="audio-auto-gain-control" value={supportedConstraints.autoGainControl ? undefined : "Not supported by this browser."} action={<input id="audio-auto-gain-control" type="checkbox" disabled={!supportedConstraints.autoGainControl} checked={preferences.audio.preferences().autoGainControl} onChange={(event) => preferences.audio.setAutoGainControl(event.currentTarget.checked)} />} />
        <Show when={!requiresNativeAudio}>
          <DashboardRow label="Loopback calibration" value="Connect the selected output to the selected input. Turn monitor volume down first. Hardware acceptance is not claimed." action={<Show when={calibrationState() === "running"} fallback={<button type="button" class="h-8 border border-border px-3 text-sm" onClick={() => void startCalibration()}>Start calibration</button>}><button type="button" class="h-8 border border-border px-3 text-sm" onClick={() => calibrationController?.abort()}>Cancel</button></Show>} />
        </Show>
        <Show when={calibrationMessage()}>{(message) => <p class="px-4 py-2 text-xs text-muted-foreground">{message()} {exactCalibration() ? "Reusable for this exact configuration." : ""}</p>}</Show>
      </DashboardSection>

      <DashboardSection title="Diagnostics">
        <DashboardRow label="Engine state" value={runtime().state} />
        <DashboardRow label="Actual sample rate" value={runtime().sampleRate === null ? "No audio context" : `${runtime().sampleRate} Hz`} />
        <DashboardRow label="Browser base-latency estimate" value={formatLatency(runtime().baseLatencySec)} />
        <DashboardRow label="Browser output-latency estimate" value={formatLatency(runtime().outputLatencySec)} />
        <DashboardRow label="Browser total output estimate" value={formatLatency(runtime().totalOutputLatencySec)} />
        <DashboardRow label="Graph/PDC latency" value={formatFrames(runtime().graphPdcLatencyFrames)} />
        <DashboardRow label="Calibrated recording offset" value={exactCalibration() ? `${exactCalibration()?.recordingOffsetFrames} frames` : `${recording().manualOffsetFrames} frames (manual fallback)`} />
        <DashboardRow label="Worklet fault event count" value={String(runtime().runtimeFaults.eventCount)} />
        <DashboardRow label="Worklet fault unique signature count" value={String(runtime().runtimeFaults.uniqueSignatureCount)} />
        <DashboardRow label="Inferred application stall count" value={String(runtime().inferredApplicationStallCount)} />
        <DashboardRow label="Recording format" value={`${diagnostics().activeFormat} (requested ${diagnostics().requestedFormat})`} />
        <DashboardRow label="Recording settings" value={`${diagnostics().activeChannels ?? "—"} channels at ${diagnostics().activeSampleRate ?? "—"} Hz (requested ${diagnostics().requestedLayout}, ${diagnostics().requestedSampleRate ?? "default"} Hz)`} />
        <DashboardRow label="Recording transport" value={diagnostics().transport ?? "Not active"} />
        <DashboardRow label="Capture counters" value={`${formatFrames(diagnostics().capturedFrames)} captured, ${formatFrames(diagnostics().overrunFrames)} overrun, ${formatFrames(diagnostics().droppedFrames)} dropped, ${formatFrames(diagnostics().queuedFrames)} queued`} />
        <DashboardRow label="Input state" value={diagnostics().deviceLost ? "Device lost" : diagnostics().muted ? "Muted" : "Available"} />
        <DashboardRow label="Last recording failure" value={diagnostics().lastFailure ?? "None"} />
        <Show when={!requiresNativeAudio}>
          <DashboardRow label="Output test" action={<button type="button" class="h-8 border border-border px-3 text-sm" onClick={() => void playTestTone()}>Play tone</button>} />
        </Show>
        <Show when={deviceError()}>{(message) => <p class="px-4 py-2 text-xs text-destructive">{message()}</p>}</Show>
      </DashboardSection>
    </DashboardScrollView>
  )
}
