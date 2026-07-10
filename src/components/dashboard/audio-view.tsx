import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useAppPreferences } from "~/context/app-preferences"
import { areAudioDeviceListsEqual, filterAudioDevices, isSelectedDeviceAvailable, resolveAudioRuntimeConfiguration } from "~/lib/audio-settings-core"
import { getAudioEngine, getAudioSinkStatus, playAudioOutputTestTone, subscribeAudioSinkStatus } from "~/lib/audio-engine-singleton"
import { parseAudioLatencyMode, parseAudioSampleRate } from "~/lib/preferences/app-preferences"
import { DashboardRow, DashboardScrollView, DashboardSection } from "./dashboard-shared"

const formatLatency = (seconds: number | null) => seconds === null ? "Unavailable" : `${(seconds * 1000).toFixed(1)} ms`
type OutputSelectableMediaDevices = MediaDevices & {
  selectAudioOutput: () => Promise<MediaDeviceInfo>
}
const supportsOutputSelection = (mediaDevices: MediaDevices): mediaDevices is OutputSelectableMediaDevices =>
  "selectAudioOutput" in mediaDevices && typeof mediaDevices.selectAudioOutput === "function"

export function DashboardAudioView() {
  const preferences = useAppPreferences()
  const [devices, setDevices] = createSignal<MediaDeviceInfo[]>([])
  const [deviceError, setDeviceError] = createSignal("")
  const [sinkStatus, setSinkStatus] = createSignal(getAudioSinkStatus())
  let deviceRequestId = 0
  const supportedConstraints = navigator.mediaDevices.getSupportedConstraints()
  const audioEngine = getAudioEngine()
  const audioDevices = createMemo(() => filterAudioDevices(devices()))
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

  const requestMicrophone = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      for (const track of stream.getTracks()) track.stop()
      await refreshDevices()
    } catch {
      setDeviceError("Microphone permission was not granted.")
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
    try {
      await playAudioOutputTestTone()
      setDeviceError("")
    } catch (error) {
      setDeviceError(error instanceof Error ? error.message : "Unable to play the output test tone.")
    }
  }

  onMount(() => {
    void refreshDevices()
    const onDeviceChange = () => void refreshDevices()
    navigator.mediaDevices.addEventListener("devicechange", onDeviceChange)
    const unsubscribe = subscribeAudioSinkStatus(() => setSinkStatus(getAudioSinkStatus()))
    const unsubscribeRuntime = audioEngine.subscribeRuntimeSnapshot(() => setRuntime(audioEngine.getRuntimeSnapshot()))
    onCleanup(() => {
      deviceRequestId += 1
      navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange)
      unsubscribe()
      unsubscribeRuntime()
    })
  })

  return (
    <DashboardScrollView>
      <DashboardSection title="Audio Devices" description="Device labels become available after browser permission is granted.">
        <DashboardRow
          label="Recording input"
          value={!isSelectedDeviceAvailable(preferences.audio.preferences().inputDeviceId, audioDevices().inputs) ? "Saved device is currently unavailable." : undefined}
          action={
            <select class="h-8 border border-border bg-background px-2 text-sm" value={preferences.audio.preferences().inputDeviceId} onChange={(event) => preferences.audio.setInputDeviceId(event.currentTarget.value)}>
              <option value="">System default</option>
              <For each={audioDevices().inputs}>{(device) => <option value={device.deviceId}>{device.label || "Microphone"}</option>}</For>
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
        <DashboardRow label="Requested sample rate" action={
          <select class="h-8 border border-border bg-background px-2 text-sm" value={preferences.audio.preferences().sampleRate} onChange={(event) => {
            preferences.audio.setSampleRate(parseAudioSampleRate(Number(event.currentTarget.value)))
          }}>
            <option value="default">System default</option><option value="44100">44.1 kHz</option><option value="48000">48 kHz</option><option value="96000">96 kHz</option>
          </select>
        } />
        <DashboardRow label="Latency mode" action={
          <select class="h-8 border border-border bg-background px-2 text-sm" value={preferences.audio.preferences().latencyMode} onChange={(event) => {
            preferences.audio.setLatencyMode(parseAudioLatencyMode(event.currentTarget.value))
          }}>
            <option value="interactive">Interactive</option><option value="balanced">Balanced</option><option value="playback">Playback</option>
          </select>
        } />
        <DashboardRow label="Buffer size" value="Managed by the browser and operating system." />
      </DashboardSection>

      <DashboardSection title="Recording">
        <DashboardRow label="Echo cancellation" value={supportedConstraints.echoCancellation ? undefined : "Not supported by this browser."} action={<input type="checkbox" disabled={!supportedConstraints.echoCancellation} checked={preferences.audio.preferences().echoCancellation} onChange={(event) => preferences.audio.setEchoCancellation(event.currentTarget.checked)} />} />
        <DashboardRow label="Noise suppression" value={supportedConstraints.noiseSuppression ? undefined : "Not supported by this browser."} action={<input type="checkbox" disabled={!supportedConstraints.noiseSuppression} checked={preferences.audio.preferences().noiseSuppression} onChange={(event) => preferences.audio.setNoiseSuppression(event.currentTarget.checked)} />} />
        <DashboardRow label="Automatic gain control" value={supportedConstraints.autoGainControl ? undefined : "Not supported by this browser."} action={<input type="checkbox" disabled={!supportedConstraints.autoGainControl} checked={preferences.audio.preferences().autoGainControl} onChange={(event) => preferences.audio.setAutoGainControl(event.currentTarget.checked)} />} />
      </DashboardSection>

      <DashboardSection title="Diagnostics">
        <DashboardRow label="Engine state" value={runtime().state} />
        <DashboardRow label="Actual sample rate" value={runtime().sampleRate === null ? "No audio context" : `${runtime().sampleRate} Hz`} />
        <DashboardRow label="Base latency" value={formatLatency(runtime().baseLatencySec)} />
        <DashboardRow label="Output latency" value={formatLatency(runtime().outputLatencySec)} />
        <DashboardRow label="Total output estimate" value={formatLatency(runtime().totalOutputLatencySec)} />
        <DashboardRow label="Output test" action={<button type="button" class="h-8 border border-border px-3 text-sm" onClick={() => void playTestTone()}>Play tone</button>} />
        <Show when={deviceError()}>{(message) => <p class="px-4 py-2 text-xs text-destructive">{message()}</p>}</Show>
      </DashboardSection>
    </DashboardScrollView>
  )
}
