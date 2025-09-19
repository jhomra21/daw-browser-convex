import { Show, createSignal, onCleanup, createMemo, createEffect, batch } from 'solid-js'
import { Button } from '~/components/ui/button'
import VisualEqualizer, { EQBand, createDefaultEQBands } from '~/components/VisualEqualizer'
import {
  Output,
  BufferTarget,
  WebMOutputFormat,
  MediaStreamAudioTrackSource,
  QUALITY_MEDIUM,
  Input,
  ALL_FORMATS,
  BlobSource,
  AudioSampleSink,
} from 'mediabunny'

type RecordingState = 'idle' | 'recording' | 'processing' | 'completed'
type AudioFile = {
  name: string
  blob: Blob
  duration: number
  sampleRate: number
  numberOfChannels: number
  url: string
}

export default function AudioRecorder() {
  const [recordingState, setRecordingState] = createSignal<RecordingState>('idle')
  const [recordingTime, setRecordingTime] = createSignal(0)
  const [audioFile, setAudioFile] = createSignal<AudioFile | null>(null)
  const [uploadedFile, setUploadedFile] = createSignal<AudioFile | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  
  // Recording infrastructure
  let mediaStream: MediaStream | null = null
  let mediaRecorder: MediaRecorder | null = null
  let recordingTimer: ReturnType<typeof setInterval> | undefined
  let output: Output | null = null

  // Cleanup function
  onCleanup(() => {
    stopRecording()
    if (recordingTimer) clearInterval(recordingTimer)
  })

  // Computed values - using simple functions for basic calculations
  const isRecording = () => recordingState() === 'recording'
  const canRecord = () => recordingState() === 'idle'
  const isProcessing = () => recordingState() === 'processing'

  // Format recording time
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  // Start recording using MediaBunny
  const startRecording = async () => {
    try {
      batch(() => {
        setError(null)
        setRecordingState('recording')
        setRecordingTime(0)
      })

      // Get user media
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 44100,
        },
      })

      const audioTrack = mediaStream.getAudioTracks()[0]
      if (!audioTrack) {
        throw new Error('No audio track available')
      }

      // Set up MediaBunny output
      output = new Output({
        format: new WebMOutputFormat(),
        target: new BufferTarget(),
      })

      const audioSource = new MediaStreamAudioTrackSource(audioTrack, {
        codec: 'opus',
        bitrate: QUALITY_MEDIUM,
      })

      output.addAudioTrack(audioSource)
      await output.start()

      // Start timer
      recordingTimer = setInterval(() => {
        setRecordingTime(prev => prev + 1)
      }, 1000)

    } catch (err) {
      console.error('Recording error:', err)
      batch(() => {
        setError(err instanceof Error ? err.message : 'Failed to start recording')
        setRecordingState('idle')
      })
    }
  }

  // Stop recording and process with MediaBunny
  const stopRecording = async () => {
    if (!output || !mediaStream) return

    try {
      setRecordingState('processing')
      
      // Clear timer
      if (recordingTimer) {
        clearInterval(recordingTimer)
        recordingTimer = undefined
      }

      // Stop media tracks
      mediaStream.getTracks().forEach(track => track.stop())
      
      // Finalize MediaBunny output
      await output.finalize()
      const buffer = (output.target as BufferTarget).buffer
      
      if (!buffer) {
        throw new Error('No audio data recorded')
      }

      // Create blob and analyze with MediaBunny
      const blob = new Blob([buffer], { type: 'audio/webm' })
      const audioFile = await analyzeAudioFile(blob, `recording-${Date.now()}.webm`)
      
      batch(() => {
        setAudioFile(audioFile)
        setRecordingState('idle') // Reset to idle to allow new recordings
      })

    } catch (err) {
      console.error('Stop recording error:', err)
      batch(() => {
        setError(err instanceof Error ? err.message : 'Failed to process recording')
        setRecordingState('idle')
      })
    } finally {
      // Cleanup
      mediaStream = null
      output = null
    }
  }

  // Analyze audio file with MediaBunny
  const analyzeAudioFile = async (blob: Blob, fileName: string): Promise<AudioFile> => {
    try {
      const input = new Input({
        formats: ALL_FORMATS,
        source: new BlobSource(blob as File),
      })

      // Get duration and audio metadata
      const duration = await input.computeDuration()
      const audioTrack = await input.getPrimaryAudioTrack()
      
      if (!audioTrack) {
        throw new Error('No audio track found in file')
      }

      const numberOfChannels = audioTrack.numberOfChannels
      const sampleRate = audioTrack.sampleRate
      const url = URL.createObjectURL(blob)

      return {
        name: fileName,
        blob,
        duration,
        sampleRate,
        numberOfChannels,
        url,
      }
    } catch (err) {
      console.error('Audio analysis error:', err)
      throw new Error('Failed to analyze audio file')
    }
  }

  // Handle file upload
  const handleFileUpload = async (event: Event) => {
    const target = event.target as HTMLInputElement
    const file = target.files?.[0]
    
    if (!file) return

    try {
      // Clean up previous file URL to prevent memory leaks
      const previousFile = uploadedFile()
      if (previousFile) {
        URL.revokeObjectURL(previousFile.url)
      }
      
      batch(() => {
        setError(null)
        setUploadedFile(null) // Clear any existing uploaded file state
      })
      
      const audioFile = await analyzeAudioFile(file, file.name)
      setUploadedFile(audioFile)
      
      // Clear the input value so the same file can be selected again if needed
      target.value = ''
      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to process uploaded file')
      // Clear the input value even on error
      target.value = ''
    }
  }

  // No longer needed - audio player is now built into AudioFileInfo component

  // Download audio file
  const downloadAudio = (audioFile: AudioFile) => {
    const a = document.createElement('a')
    a.href = audioFile.url
    a.download = audioFile.name
    a.click()
  }

  return (
    <section class="w-full max-w-2xl mx-auto flex flex-col gap-6 p-6 border rounded-lg bg-card">
      <h2 class="text-2xl font-bold text-center">🎙️ MediaBunny Audio Studio</h2>
      
      {/* Recording Section */}
      <div class="flex flex-col gap-4 items-center">
        <div class="flex gap-3">
          <Button
            onClick={startRecording}
            disabled={!canRecord()}
            variant={isRecording() ? 'secondary' : 'default'}
            size="lg"
          >
            <Show when={isRecording()}>
              <span class="inline-block w-3 h-3 bg-red-500 rounded-full animate-pulse mr-2" />
            </Show>
            {canRecord() ? '🎤 Start Recording' : isRecording() ? 'Recording...' : 'Processing...'}
          </Button>
          
          <Show when={isRecording()}>
            <Button onClick={stopRecording} variant="destructive" size="lg">
              ⏹️ Stop
            </Button>
          </Show>
        </div>

        <Show when={isRecording() || isProcessing()}>
          <div class="text-center">
            <div class="text-xl font-mono">
              {formatTime(recordingTime())}
            </div>
            <Show when={isProcessing()}>
              <div class="text-sm text-muted-foreground mt-1">
                Processing with MediaBunny...
              </div>
            </Show>
          </div>
        </Show>
      </div>

      {/* File Upload Section */}
      <div class="border-t pt-4">
        <label class="block text-sm font-medium mb-2">
          📁 Upload Audio File for Analysis
        </label>
        <input
          type="file"
          accept="audio/*"
          onChange={handleFileUpload}
          class="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-primary file:text-primary-foreground hover:file:bg-primary/90"
        />
      </div>

      {/* Error Display */}
      <Show when={error()}>
        <div class="p-3 bg-destructive/10 border border-destructive/20 rounded-md">
          <p class="text-destructive text-sm" role="alert">❌ {error()}</p>
        </div>
      </Show>

      {/* Recorded Audio Display */}
      <Show when={audioFile()}>
        {(file) => (
          <div class="border rounded-lg p-4 bg-muted/20">
            <h3 class="font-semibold mb-3">🎵 Recorded Audio</h3>
            <AudioFileInfo audioFile={file()} onPlay={() => {}} onDownload={() => downloadAudio(file())} />
          </div>
        )}
      </Show>

      {/* Uploaded Audio Display */}
      <Show when={uploadedFile()}>
        {(file) => (
          <div class="border rounded-lg p-4 bg-muted/20">
            <h3 class="font-semibold mb-3">📂 Uploaded Audio</h3>
            <AudioFileInfo audioFile={file()} onPlay={() => {}} onDownload={() => downloadAudio(file())} />
          </div>
        )}
      </Show>
    </section>
  )
}

// EQ bands are now imported from VisualEqualizer component

// Enhanced audio player component with seeking and EQ
function AudioFileInfo(props: { 
  audioFile: AudioFile
  onPlay: () => void
  onDownload: () => void
}) {
  const [isPlaying, setIsPlaying] = createSignal(false)
  const [currentTime, setCurrentTime] = createSignal(0)
  const [duration, setDuration] = createSignal(props.audioFile.duration)
  const [eqEnabled, setEqEnabled] = createSignal(false)
  const [eqBands, setEqBands] = createSignal<EQBand[]>(createDefaultEQBands())
  const [spectrumAnalysis, setSpectrumAnalysis] = createSignal<Float32Array | null>(null)
  
  let audioElement: HTMLAudioElement | undefined
  let audioContext: AudioContext | undefined
  let sourceNode: MediaElementAudioSourceNode | undefined
  let gainNode: GainNode | undefined
  let analyserNode: AnalyserNode | undefined
  let eqFilters: BiquadFilterNode[] = []

  // Cleanup when component unmounts or file changes
  onCleanup(() => {
    stopSpectrumAnalysis()
    if (audioElement) {
      audioElement.pause()
      audioElement.src = ''
    }
    if (audioContext) {
      audioContext.close()
    }
  })

  // Effect to handle when audioFile changes (new file uploaded)
  createEffect(() => {
    props.audioFile // Track changes to audioFile
    
    // If audioFile changes, cleanup existing audio state
    stopSpectrumAnalysis()
    if (audioElement) {
      audioElement.pause()
      audioElement.src = ''
      audioElement = undefined
    }
    if (audioContext) {
      audioContext.close()
      audioContext = undefined
      sourceNode = undefined
      gainNode = undefined
      analyserNode = undefined
      eqFilters = []
    }
    
    // Group all reactive state updates to prevent multiple re-renders
    batch(() => {
      setIsPlaying(false)
      setCurrentTime(0)
      setDuration(props.audioFile.duration)
      setEqEnabled(false)
      setEqBands(createDefaultEQBands())
      setSpectrumAnalysis(null)
    })
  })

  // Setup Web Audio API chain with EQ and spectrum analysis
  const setupAudioChain = () => {
    if (!audioElement || audioContext) return

    try {
      audioContext = new AudioContext()
      sourceNode = audioContext.createMediaElementSource(audioElement)
      gainNode = audioContext.createGain()
      
      // Create analyser node for spectrum visualization
      analyserNode = audioContext.createAnalyser()
      analyserNode.fftSize = 2048 // Higher resolution for smoother spectrum
      analyserNode.smoothingTimeConstant = 0.8 // Smooth out rapid changes

      // Create EQ filters for enabled bands
      eqFilters = eqBands().map((band) => {
        const filter = audioContext!.createBiquadFilter()
        filter.type = band.type
        filter.frequency.setValueAtTime(band.frequency, audioContext!.currentTime)
        filter.Q.setValueAtTime(band.Q, audioContext!.currentTime)
        filter.gain.setValueAtTime(band.enabled ? band.gain : 0, audioContext!.currentTime)
        return filter
      })

      // Connect the audio chain: source -> analyser -> EQ filters -> gain -> destination
      let currentNode: AudioNode = sourceNode
      
      // Connect analyser first to get pre-EQ spectrum data
      currentNode.connect(analyserNode)
      
      if (eqEnabled()) {
        eqFilters.forEach(filter => {
          currentNode.connect(filter)
          currentNode = filter
        })
      }
      
      currentNode.connect(gainNode)
      gainNode.connect(audioContext.destination)
      
      // Start spectrum analysis updates
      startSpectrumAnalysis()
      
    } catch (error) {
      console.error('Failed to setup Web Audio API:', error)
    }
  }

  // Continuous spectrum analysis updates
  let spectrumAnimationId: number | undefined
  const startSpectrumAnalysis = () => {
    if (!analyserNode) return

    const updateSpectrum = () => {
      if (isPlaying() && analyserNode) {
        // Create fresh array for each update to avoid type issues
        const dataArray = new Uint8Array(analyserNode.frequencyBinCount)
        analyserNode.getByteFrequencyData(dataArray)
        
        // Convert to normalized float array for easier processing
        const normalizedSpectrum = new Float32Array(dataArray.length)
        for (let i = 0; i < dataArray.length; i++) {
          normalizedSpectrum[i] = dataArray[i] / 255 // Normalize to 0-1
        }
        
        setSpectrumAnalysis(normalizedSpectrum)
        spectrumAnimationId = requestAnimationFrame(updateSpectrum)
      }
    }
    
    updateSpectrum()
  }

  const stopSpectrumAnalysis = () => {
    if (spectrumAnimationId) {
      cancelAnimationFrame(spectrumAnimationId)
      spectrumAnimationId = undefined
    }
    setSpectrumAnalysis(null)
  }

  const togglePlayback = async () => {
    if (!audioElement) {
      audioElement = new Audio(props.audioFile.url)
      audioElement.crossOrigin = 'anonymous' // Enable CORS for Web Audio API
      
      audioElement.addEventListener('loadedmetadata', () => {
        setDuration(audioElement!.duration)
      })
      
      audioElement.addEventListener('timeupdate', () => {
        setCurrentTime(audioElement!.currentTime)
      })
      
      audioElement.addEventListener('ended', () => {
        setIsPlaying(false)
        setCurrentTime(0)
        stopSpectrumAnalysis()
      })

      // Setup Web Audio API chain when EQ is enabled (includes spectrum analysis)
      if (eqEnabled()) {
        setupAudioChain()
      }
    }

    if (isPlaying()) {
      audioElement.pause()
      setIsPlaying(false)
      stopSpectrumAnalysis()
    } else {
      // Resume AudioContext if it's suspended
      if (audioContext && audioContext.state === 'suspended') {
        await audioContext.resume()
      }
      audioElement.play()
      setIsPlaying(true)
      
      // Start spectrum analysis if EQ is enabled
      if (eqEnabled() && analyserNode) {
        startSpectrumAnalysis()
      }
    }
  }

  const handleSeek = (event: Event) => {
    const target = event.target as HTMLInputElement
    const seekTime = parseFloat(target.value)
    
    if (audioElement) {
      audioElement.currentTime = seekTime
      setCurrentTime(seekTime)
    }
  }

  // Toggle EQ on/off
  const toggleEQ = () => {
    const newEqEnabled = !eqEnabled()
    setEqEnabled(newEqEnabled)
    
    // If we're toggling EQ and audio is already loaded, recreate the audio chain
    if (audioElement) {
      stopSpectrumAnalysis()
      
      if (audioContext) {
        audioContext.close()
        audioContext = undefined
        sourceNode = undefined
        gainNode = undefined
        analyserNode = undefined
        eqFilters = []
      }
      
      if (newEqEnabled) {
        setupAudioChain()
        // If currently playing, start spectrum analysis
        if (isPlaying()) {
          startSpectrumAnalysis()
        }
      }
    }
  }

  // Update EQ band properties
  const updateEQBand = (bandId: string, updates: Partial<EQBand>) => {
    const currentBands = eqBands()
    const bandIndex = currentBands.findIndex(b => b.id === bandId)
    
    if (bandIndex === -1) return
    
    const newBands = [...currentBands]
    newBands[bandIndex] = { ...newBands[bandIndex], ...updates }
    setEqBands(newBands)
    
    // Apply to Web Audio API if active
    if (eqFilters[bandIndex] && audioContext) {
      const filter = eqFilters[bandIndex]
      const band = newBands[bandIndex]
      
      if ('frequency' in updates) {
        filter.frequency.setValueAtTime(band.frequency, audioContext.currentTime)
      }
      if ('gain' in updates) {
        filter.gain.setValueAtTime(band.enabled ? band.gain : 0, audioContext.currentTime)
      }
      if ('Q' in updates) {
        filter.Q.setValueAtTime(band.Q, audioContext.currentTime)
      }
      if ('type' in updates) {
        filter.type = band.type
      }
      if ('enabled' in updates) {
        filter.gain.setValueAtTime(band.enabled ? band.gain : 0, audioContext.currentTime)
      }
    }
  }

  // Toggle EQ band enabled state
  const toggleEQBand = (bandId: string) => {
    const currentBands = eqBands()
    const bandIndex = currentBands.findIndex(b => b.id === bandId)
    
    if (bandIndex === -1) return
    
    const newBands = [...currentBands]
    newBands[bandIndex] = { ...newBands[bandIndex], enabled: !newBands[bandIndex].enabled }
    setEqBands(newBands)
    
    // Apply to Web Audio API if active
    if (eqFilters[bandIndex] && audioContext) {
      const filter = eqFilters[bandIndex]
      const band = newBands[bandIndex]
      filter.gain.setValueAtTime(band.enabled ? band.gain : 0, audioContext.currentTime)
    }
  }

  // Reset all EQ bands
  const resetEQ = () => {
    const resetBands = createDefaultEQBands()
    setEqBands(resetBands)
    
    eqFilters.forEach((filter, index) => {
      if (filter && audioContext) {
        const band = resetBands[index]
        if (band) {
          filter.frequency.setValueAtTime(band.frequency, audioContext.currentTime)
          filter.gain.setValueAtTime(0, audioContext.currentTime)
          filter.Q.setValueAtTime(band.Q, audioContext.currentTime)
          filter.type = band.type
        }
      }
    })
  }

  const formatTime = (time: number) => {
    const minutes = Math.floor(time / 60)
    const seconds = Math.floor(time % 60)
    return `${minutes}:${seconds.toString().padStart(2, '0')}`
  }

  return (
    <div class="space-y-4">
      {/* File Info */}
      <div class="grid grid-cols-2 gap-2 text-sm">
        <div><strong>File:</strong> {props.audioFile.name}</div>
        <div><strong>Duration:</strong> {props.audioFile.duration.toFixed(2)}s</div>
        <div><strong>Sample Rate:</strong> {props.audioFile.sampleRate} Hz</div>
        <div><strong>Channels:</strong> {props.audioFile.numberOfChannels}</div>
      </div>
      
      {/* Audio Player Controls */}
      <div class="space-y-3">
        {/* Play/Pause, EQ, and Download */}
        <div class="flex gap-2">
          <Button onClick={togglePlayback} variant="outline" size="sm">
            {isPlaying() ? '⏸️ Pause' : '▶️ Play'}
          </Button>
          <Button 
            onClick={toggleEQ} 
            variant={eqEnabled() ? 'default' : 'outline'} 
            size="sm"
            title={eqEnabled() ? 'EQ Enabled' : 'Enable EQ'}
          >
            🎛️ EQ
          </Button>
          <Button onClick={props.onDownload} variant="outline" size="sm">
            💾 Download
          </Button>
        </div>
        
        {/* Seek Bar */}
        <div class="space-y-2">
          <div class="flex items-center gap-3">
            <span class="text-xs font-mono min-w-[35px]">
              {formatTime(currentTime())}
            </span>
            <input
              type="range"
              min="0"
              max={duration()}
              step="0.1"
              value={currentTime()}
              onInput={handleSeek}
              class="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer slider"
              style={{
                background: `linear-gradient(to right, hsl(var(--primary)) 0%, hsl(var(--primary)) ${(currentTime() / duration()) * 100}%, #e5e7eb ${(currentTime() / duration()) * 100}%, #e5e7eb 100%)`
              }}
            />
            <span class="text-xs font-mono min-w-[35px]">
              {formatTime(duration())}
            </span>
          </div>
          
          {/* Waveform placeholder */}
          <div class="h-12 bg-muted/40 rounded border flex items-center justify-center">
            <div class="flex items-end gap-px h-8">
              {Array.from({ length: 50 }, (_, i) => (
                <div 
                  class={`w-1 bg-primary/30 ${i < (currentTime() / duration()) * 50 ? 'bg-primary' : ''}`}
                  style={{ height: `${Math.random() * 100}%` }}
                />
              ))}
            </div>
          </div>
        </div>
        
        {/* Visual EQ Controls */}
        <Show when={eqEnabled()}>
          <VisualEqualizer 
            bands={eqBands()}
            onBandChange={updateEQBand}
            onBandToggle={toggleEQBand}
            onReset={resetEQ}
            enabled={eqEnabled()}
            spectrumData={spectrumAnalysis()}
            isPlaying={isPlaying()}
          />
        </Show>
      </div>
    </div>
  )
}
