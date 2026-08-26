#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define DAW_AUDIO_CORE_ABI_VERSION 3u
#define DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE 32u
#define DAW_AUDIO_CORE_MAX_PROCESSOR_STATE_BYTES 256u
#define DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS 24u
#define DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETER_BLOCKS 512u
#define DAW_AUDIO_CORE_MAX_PROCESSOR_EVENTS 256u
#define DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS 256u
#define DAW_AUDIO_CORE_MAX_INSTRUMENT_VOICES 32u
#define DAW_AUDIO_CORE_MAX_INSTRUMENT_PARAMETERS 16u

/* Version-one fixed-memory Wasm graph envelope. Every integer and float is
 * little-endian. It is intentionally byte-addressed rather than a packed C
 * struct so callers cannot depend on host pointer width or struct padding.
 *
 * graph: header (24 bytes), node records (28), edge records (48), then
 * processor records. A processor record is node_id (u64) followed by the
 * existing 40-byte processor-state envelope, state bytes, then parameter
 * target u32s. Parameter and event envelopes start with a u32 count; their
 * records are described by the exported process entry below. */
#define DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION 3u
#define DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION_LEGACY_2 2u
#define DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION_LEGACY 1u
#define DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION_EXTERNAL_LATENCY 4u
#define DAW_AUDIO_CORE_WASM_GRAPH_HEADER_BYTES 24u
#define DAW_AUDIO_CORE_WASM_GRAPH_NODE_BYTES 28u
#define DAW_AUDIO_CORE_WASM_GRAPH_NODE_WITH_INSTRUMENT_BYTES 132u
#define DAW_AUDIO_CORE_WASM_GRAPH_EDGE_BYTES 48u
#define DAW_AUDIO_CORE_WASM_PROCESSOR_ENVELOPE_BYTES 40u

typedef uint64_t daw_audio_core_handle;
typedef uint64_t daw_audio_asset_handle;
typedef uint64_t daw_audio_event_handle;
typedef uint64_t daw_audio_diagnostic_handle;

typedef enum daw_audio_core_result {
  DAW_AUDIO_CORE_OK = 0,
  DAW_AUDIO_CORE_INVALID_ARGUMENT = 1,
  DAW_AUDIO_CORE_UNSUPPORTED_VERSION = 2,
  DAW_AUDIO_CORE_CAPACITY_EXCEEDED = 3,
  DAW_AUDIO_CORE_INVALID_HANDLE = 4,
  DAW_AUDIO_CORE_STALE_REVISION = 5,
  DAW_AUDIO_CORE_NOT_PREPARED = 6,
  DAW_AUDIO_CORE_ASSET_IN_USE = 7,
  DAW_AUDIO_CORE_LATENCY_CHANGE_DEFERRED = 8,
  DAW_AUDIO_CORE_PROCESSOR_KIND_UNKNOWN = 9,
  DAW_AUDIO_CORE_PROCESSOR_IMPLEMENTATION_UNAVAILABLE = 10,
  DAW_AUDIO_CORE_PROCESSOR_STATE_INVALID = 11,
  DAW_AUDIO_CORE_NO_DATA = 12,
  DAW_AUDIO_CORE_GRAPH_COMPATIBILITY_REJECTED = 13,
  DAW_AUDIO_CORE_RETIREMENT_CAPACITY_EXCEEDED = 14
} daw_audio_core_result;

typedef enum daw_audio_core_graph_validation_code {
  DAW_AUDIO_CORE_GRAPH_VALIDATION_NONE = 0,
  DAW_AUDIO_CORE_GRAPH_VALIDATION_PDC_DELAY_EXCEEDS_RING_CAPACITY = 1
} daw_audio_core_graph_validation_code;

typedef struct daw_audio_core_graph_validation_diagnostic {
  uint32_t code;
  uint32_t index;
  uint32_t actual;
  uint32_t limit;
} daw_audio_core_graph_validation_diagnostic;

#define DAW_AUDIO_RECORDING_CAPTURE_BLOCK_FRAMES 2048u
#define DAW_AUDIO_RECORDING_CAPTURE_MAX_CHANNELS 2u
#define DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS 32u

/* This capture tap is deliberately independent of the graph render core.
 * A host configures a session off its audio thread, feeds planar input into
 * process, and drains complete PCM blocks from the bounded pool. The core
 * neither opens devices nor owns browser MediaStreams. */
typedef struct daw_audio_recording_capture_config {
  uint32_t abi_version;
  uint32_t generation;
  uint64_t session_id;
  uint32_t channel_count;
  uint32_t input_channels[DAW_AUDIO_RECORDING_CAPTURE_MAX_CHANNELS];
  float gain;
  int32_t polarity;
  int64_t punch_start_frame;
  int64_t punch_end_frame; /* -1 means no punch-out boundary. */
} daw_audio_recording_capture_config;

typedef struct daw_audio_recording_capture_block {
  uint32_t generation;
  uint64_t session_id;
  uint32_t sequence;
  uint32_t block_id;
  uint32_t frame_count;
  uint32_t channel_count;
  const float *planes[DAW_AUDIO_RECORDING_CAPTURE_MAX_CHANNELS];
  float rms;
  float peak;
} daw_audio_recording_capture_block;

typedef struct daw_audio_recording_capture_diagnostics {
  uint32_t generation;
  uint64_t session_id;
  uint64_t captured_frames;
  uint64_t dropped_frames;
  uint32_t dropped_blocks;
  uint32_t available_blocks;
  uint32_t queued_blocks;
  float rms;
  float peak;
  uint32_t fatal;
  uint32_t active;
} daw_audio_recording_capture_diagnostics;

typedef struct daw_audio_core_config {
  uint32_t abi_version;
  uint32_t max_frames_per_block;
  uint32_t max_channels;
  uint32_t max_assets;
  uint32_t sample_rate_hz;
} daw_audio_core_config;

typedef struct daw_audio_core_prepare_request {
  uint32_t abi_version;
  uint32_t graph_revision;
  uint32_t reserved0;
  uint32_t reserved1;
} daw_audio_core_prepare_request;

typedef enum daw_audio_graph_layout {
  DAW_AUDIO_GRAPH_LAYOUT_MONO = 1,
  DAW_AUDIO_GRAPH_LAYOUT_STEREO = 2
} daw_audio_graph_layout;

typedef enum daw_audio_graph_node_kind {
  DAW_AUDIO_GRAPH_NODE_SOURCE = 1,
  DAW_AUDIO_GRAPH_NODE_UTILITY = 2,
  DAW_AUDIO_GRAPH_NODE_MIXER = 3,
  DAW_AUDIO_GRAPH_NODE_MASTER = 4,
  DAW_AUDIO_GRAPH_NODE_INSTRUMENT = 5
} daw_audio_graph_node_kind;

/* Source nodes with this input bus do not consume physical process input.
 * Explicit numeric buses, including bus zero, retain their normal behavior. */
#define DAW_AUDIO_GRAPH_INPUT_BUS_DISCONNECTED UINT32_MAX

typedef enum daw_audio_instrument_kind {
  DAW_AUDIO_INSTRUMENT_KIND_NONE = 0,
  DAW_AUDIO_INSTRUMENT_KIND_SYNTH = 1,
  DAW_AUDIO_INSTRUMENT_KIND_SAMPLER = 2,
  DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK = 3,
  DAW_AUDIO_INSTRUMENT_KIND_GRANULAR = 4
} daw_audio_instrument_kind;

#define DAW_AUDIO_CORE_MAX_SAMPLE_ZONES 32u
#define DAW_AUDIO_CORE_MAX_GRANULAR_GRAINS 128u

typedef enum daw_audio_sample_playback_mode {
  DAW_AUDIO_SAMPLE_PLAYBACK_ONE_SHOT = 0,
  DAW_AUDIO_SAMPLE_PLAYBACK_FORWARD_LOOP = 1,
  DAW_AUDIO_SAMPLE_PLAYBACK_CROSSFADE_LOOP = 2
} daw_audio_sample_playback_mode;

/* Sample zones are copied at configuration time. Their asset handles must
 * remain live until the configuration is replaced and all voices finish. */
typedef struct daw_audio_sample_zone {
  daw_audio_asset_handle asset;
  uint32_t key_low;
  uint32_t key_high;
  uint32_t velocity_low;
  uint32_t velocity_high;
  uint32_t root_note;
  float tune_cents;
  float gain;
  float pan;
  uint32_t round_robin_group;
  uint32_t round_robin_index;
  uint32_t playback_mode;
  uint32_t start_frame;
  uint32_t end_frame;
  uint32_t loop_start_frame;
  uint32_t loop_end_frame;
  uint32_t crossfade_frame_count;
  uint32_t choke_group;
} daw_audio_sample_zone;

typedef struct daw_audio_sampler_state {
  uint32_t version;
  uint32_t zone_count;
  float amp_attack_ms;
  float amp_decay_ms;
  float amp_sustain;
  float amp_release_ms;
  uint32_t filter_enabled;
  uint32_t filter_mode;
  float filter_cutoff_hz;
  float filter_resonance;
  float filter_envelope_amount;
  float filter_attack_ms;
  float filter_decay_ms;
  float filter_sustain;
  float filter_release_ms;
  uint32_t lfo_enabled;
  float lfo_rate_hz;
  float lfo_pitch_cents;
  float lfo_filter_hz;
  float lfo_amplitude;
  float lfo_pan;
  uint32_t retrigger;
} daw_audio_sampler_state;

/* Granular state is deliberately a fixed-size, asset-handle based ABI. The
 * asset is immutable after registration and all grain memory is owned by the
 * core; callers never provide render-time pointers. */
typedef struct daw_audio_granular_state {
  uint32_t version;
  daw_audio_asset_handle asset;
  uint32_t seed;
  uint32_t max_grains;
  uint32_t window_shape;
  uint32_t freeze;
  float grain_size_ms;
  float density_hz;
  float position;
  float spray;
  float pitch_semitones;
  float reverse_probability;
  float stereo_spread;
} daw_audio_granular_state;

typedef enum daw_audio_granular_window_shape {
  DAW_AUDIO_GRANULAR_WINDOW_HANN = 0,
  DAW_AUDIO_GRANULAR_WINDOW_TUKEY = 1,
  DAW_AUDIO_GRANULAR_WINDOW_GAUSSIAN = 2
} daw_audio_granular_window_shape;

typedef enum daw_audio_synth_parameter {
  DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_GAIN = 1,
  DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_PAN = 2,
  DAW_AUDIO_SYNTH_PARAMETER_FILTER_CUTOFF_HZ = 3,
  DAW_AUDIO_SYNTH_PARAMETER_FILTER_RESONANCE = 4,
  DAW_AUDIO_SYNTH_PARAMETER_AMP_ATTACK_MS = 5,
  DAW_AUDIO_SYNTH_PARAMETER_AMP_DECAY_MS = 6,
  DAW_AUDIO_SYNTH_PARAMETER_AMP_SUSTAIN = 7,
  DAW_AUDIO_SYNTH_PARAMETER_AMP_RELEASE_MS = 8
} daw_audio_synth_parameter;

typedef enum daw_audio_mixer_parameter {
  DAW_AUDIO_MIXER_PARAMETER_GAIN = 26,
  DAW_AUDIO_MIXER_PARAMETER_PAN = 27,
  DAW_AUDIO_MIXER_PARAMETER_MUTE = 28,
  DAW_AUDIO_MIXER_PARAMETER_SOLO = 29
} daw_audio_mixer_parameter;

/* Node fader state is copied at prepare time. Mixer events are sample-frame
 * commands: an event at offset N is applied before rendering sample N and
 * remains in effect until superseded. Equal-offset events are last-wins. */
typedef struct daw_audio_mixer_state {
  uint64_t instance_id;
  float gain;
  float pan;
  uint32_t muted;
  uint32_t soloed;
} daw_audio_mixer_state;

typedef enum daw_audio_synth_waveform {
  DAW_AUDIO_SYNTH_WAVEFORM_SINE = 0,
  DAW_AUDIO_SYNTH_WAVEFORM_SQUARE = 1,
  DAW_AUDIO_SYNTH_WAVEFORM_SAWTOOTH = 2,
  DAW_AUDIO_SYNTH_WAVEFORM_TRIANGLE = 3
} daw_audio_synth_waveform;

typedef enum daw_audio_synth_filter_mode {
  DAW_AUDIO_SYNTH_FILTER_MODE_LOWPASS = 0,
  DAW_AUDIO_SYNTH_FILTER_MODE_HIGHPASS = 1,
  DAW_AUDIO_SYNTH_FILTER_MODE_BANDPASS = 2,
  DAW_AUDIO_SYNTH_FILTER_MODE_NOTCH = 3
} daw_audio_synth_filter_mode;

typedef struct daw_audio_synth_oscillator_state {
  uint32_t enabled;
  uint32_t waveform;
  float level;
  int32_t octave;
  int32_t semitone;
  float detune_cents;
} daw_audio_synth_oscillator_state;

/* Version one is a deterministic, fixed-memory subtractive synth profile.
 * A zero version selects these defaults to preserve the descriptor's original
 * state-free form for callers that only need MIDI lifecycle validation. */
typedef struct daw_audio_synth_state {
  uint32_t version;
  uint32_t seed;
  daw_audio_synth_oscillator_state oscillators[2];
  uint32_t noise_enabled;
  float noise_level;
  uint32_t filter_enabled;
  uint32_t filter_mode;
  float filter_cutoff_hz;
  float filter_resonance;
  float filter_key_tracking;
  float filter_envelope_amount_octaves;
  float filter_attack_ms;
  float filter_decay_ms;
  float filter_sustain;
  float filter_release_ms;
  float amp_attack_ms;
  float amp_decay_ms;
  float amp_sustain;
  float amp_release_ms;
  uint32_t lfo_enabled;
  uint32_t lfo_waveform;
  float lfo_rate_hz;
  float lfo_pitch_cents;
  float lfo_filter_octaves;
  float lfo_amplitude;
  float lfo_pan;
  float output_gain;
  float output_pan;
} daw_audio_synth_state;

/* This is copied by value into a prepared graph. It deliberately contains no
 * browser object, asset handle, native handle, or caller-owned memory. */
typedef struct daw_audio_instrument_state_descriptor {
  uint32_t kind;
  uint32_t version;
  uint32_t voice_capacity;
  uint32_t parameter_count;
  uint32_t parameter_targets[DAW_AUDIO_CORE_MAX_INSTRUMENT_PARAMETERS];
} daw_audio_instrument_state_descriptor;

typedef enum daw_audio_graph_edge_tap {
  DAW_AUDIO_GRAPH_EDGE_PRE_FX = 1,
  DAW_AUDIO_GRAPH_EDGE_PRE_FADER = 2,
  DAW_AUDIO_GRAPH_EDGE_POST_FADER = 3
} daw_audio_graph_edge_tap;

typedef enum daw_audio_processor_kind {
  DAW_AUDIO_PROCESSOR_KIND_UTILITY = 1,
  DAW_AUDIO_PROCESSOR_KIND_SATURATOR = 2,
  DAW_AUDIO_PROCESSOR_KIND_EQ = 3,
  DAW_AUDIO_PROCESSOR_KIND_CHORUS = 4,
  DAW_AUDIO_PROCESSOR_KIND_FLANGER = 5,
  DAW_AUDIO_PROCESSOR_KIND_PHASER = 6,
  DAW_AUDIO_PROCESSOR_KIND_TREMOLO = 7,
  DAW_AUDIO_PROCESSOR_KIND_AUTOPAN = 8,
  DAW_AUDIO_PROCESSOR_KIND_ENSEMBLE = 9,
  DAW_AUDIO_PROCESSOR_KIND_GATE = 10,
  DAW_AUDIO_PROCESSOR_KIND_COMPRESSOR = 11,
  DAW_AUDIO_PROCESSOR_KIND_LIMITER = 12,
  DAW_AUDIO_PROCESSOR_KIND_DELAY = 13,
  DAW_AUDIO_PROCESSOR_KIND_REVERB = 14,
  DAW_AUDIO_PROCESSOR_KIND_SPECTRAL = 15,
  DAW_AUDIO_PROCESSOR_KIND_AUTOFILTER = 16,
  DAW_AUDIO_PROCESSOR_KIND_LOFI = 17
} daw_audio_processor_kind;

typedef enum daw_audio_processor_parameter {
  DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB = 1,
  DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_PAN = 2,
  DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_BALANCE = 3,
  DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_WIDTH = 4,
  DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_TIME_MS = 5,
  DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_FEEDBACK = 6,
  DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_DRY_WET = 7,
  DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_LOW_CUT_HZ = 8,
  DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_HIGH_CUT_HZ = 9,
  DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_WET = 10,
  DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_PRE_DELAY_MS = 11,
  DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_LOW_CUT_HZ = 12,
  DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_HIGH_CUT_HZ = 13,
  DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_STEREO_WIDTH = 14,
  DAW_AUDIO_PROCESSOR_PARAMETER_SPECTRAL_FREEZE = 15,
  DAW_AUDIO_PROCESSOR_PARAMETER_SPECTRAL_GATE_THRESHOLD_DB = 16,
  DAW_AUDIO_PROCESSOR_PARAMETER_SPECTRAL_GATE_ATTACK_MS = 17,
  DAW_AUDIO_PROCESSOR_PARAMETER_SPECTRAL_GATE_RELEASE_MS = 18,
  DAW_AUDIO_PROCESSOR_PARAMETER_SPECTRAL_MORPH = 19,
  DAW_AUDIO_PROCESSOR_PARAMETER_SPECTRAL_BIN_SHIFT = 20,
  DAW_AUDIO_PROCESSOR_PARAMETER_SPECTRAL_BLUR = 21,
  DAW_AUDIO_PROCESSOR_PARAMETER_SPECTRAL_HARMONIC_PERCUSSIVE_BALANCE = 22,
  DAW_AUDIO_PROCESSOR_PARAMETER_SPECTRAL_NOISE_REDUCTION = 23,
  DAW_AUDIO_PROCESSOR_PARAMETER_SPECTRAL_PROFILE_LEARN = 24,
  DAW_AUDIO_PROCESSOR_PARAMETER_SPECTRAL_MIX = 25,
  DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_FREQUENCY_HZ = 30,
  DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_RESONANCE = 31,
  DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_DRIVE_DB = 32,
  DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_MIX = 33,
  DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_ENVELOPE_AMOUNT_OCTAVES = 34,
  DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_ENVELOPE_ATTACK_MS = 35,
  DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_ENVELOPE_RELEASE_MS = 36,
  DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_LFO_RATE_HZ = 37,
  DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_LFO_DEPTH_OCTAVES = 38,
  DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_LFO_PHASE_OFFSET = 39,
  DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_LFO_STEREO_PHASE = 40,
  DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_SAMPLE_RATE_RATIO = 41,
  DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_JITTER = 42,
  DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_NOISE_DB = 43,
  DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_MIX = 44,
  DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_0_FREQUENCY_HZ = 45,
  DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_0_GAIN_DB = 46,
  DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_0_Q = 47,
  DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_1_FREQUENCY_HZ = 48,
  DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_1_GAIN_DB = 49,
  DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_1_Q = 50,
  DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_2_FREQUENCY_HZ = 51,
  DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_2_GAIN_DB = 52,
  DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_2_Q = 53,
  DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_3_FREQUENCY_HZ = 54,
  DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_3_GAIN_DB = 55,
  DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_3_Q = 56,
  DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_4_FREQUENCY_HZ = 57,
  DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_4_GAIN_DB = 58,
  DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_4_Q = 59,
  DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_5_FREQUENCY_HZ = 60,
  DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_5_GAIN_DB = 61,
  DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_5_Q = 62,
  DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_6_FREQUENCY_HZ = 63,
  DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_6_GAIN_DB = 64,
  DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_6_Q = 65,
  DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_7_FREQUENCY_HZ = 66,
  DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_7_GAIN_DB = 67,
  DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_7_Q = 68,
  DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_DRIVE_DB = 69,
  DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_COLOR_FREQUENCY_HZ = 70,
  DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_COLOR_AMOUNT = 71,
  DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_OUTPUT_DB = 72,
  DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_DRY_WET = 73,
  DAW_AUDIO_PROCESSOR_PARAMETER_CHORUS_DELAY_MS = 74,
  DAW_AUDIO_PROCESSOR_PARAMETER_CHORUS_DEPTH_MS = 75,
  DAW_AUDIO_PROCESSOR_PARAMETER_CHORUS_RATE_HZ = 76,
  DAW_AUDIO_PROCESSOR_PARAMETER_CHORUS_FEEDBACK = 77,
  DAW_AUDIO_PROCESSOR_PARAMETER_CHORUS_STEREO_PHASE = 78,
  DAW_AUDIO_PROCESSOR_PARAMETER_CHORUS_MIX = 79,
  DAW_AUDIO_PROCESSOR_PARAMETER_FLANGER_DELAY_MS = 80,
  DAW_AUDIO_PROCESSOR_PARAMETER_FLANGER_DEPTH_MS = 81,
  DAW_AUDIO_PROCESSOR_PARAMETER_FLANGER_RATE_HZ = 82,
  DAW_AUDIO_PROCESSOR_PARAMETER_FLANGER_FEEDBACK = 83,
  DAW_AUDIO_PROCESSOR_PARAMETER_FLANGER_STEREO_PHASE = 84,
  DAW_AUDIO_PROCESSOR_PARAMETER_FLANGER_MIX = 85,
  DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_CENTER_HZ = 86,
  DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_DEPTH_OCTAVES = 87,
  DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_RATE_HZ = 88,
  DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_FEEDBACK = 89,
  DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_STEREO_PHASE = 90,
  DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_MIX = 91,
  DAW_AUDIO_PROCESSOR_PARAMETER_TREMOLO_RATE_HZ = 92,
  DAW_AUDIO_PROCESSOR_PARAMETER_TREMOLO_DEPTH = 93,
  DAW_AUDIO_PROCESSOR_PARAMETER_TREMOLO_SHAPE = 94,
  DAW_AUDIO_PROCESSOR_PARAMETER_TREMOLO_PHASE = 95,
  DAW_AUDIO_PROCESSOR_PARAMETER_AUTOPAN_RATE_HZ = 96,
  DAW_AUDIO_PROCESSOR_PARAMETER_AUTOPAN_DEPTH = 97,
  DAW_AUDIO_PROCESSOR_PARAMETER_AUTOPAN_SHAPE = 98,
  DAW_AUDIO_PROCESSOR_PARAMETER_AUTOPAN_PHASE = 99,
  DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_DELAY_MS = 100,
  DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_DEPTH_MS = 101,
  DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_RATE_HZ = 102,
  DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_SPREAD = 103,
  DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_MIX = 104,
  DAW_AUDIO_PROCESSOR_PARAMETER_GATE_THRESHOLD_DB = 105,
  DAW_AUDIO_PROCESSOR_PARAMETER_GATE_RATIO = 106,
  DAW_AUDIO_PROCESSOR_PARAMETER_GATE_ATTACK_MS = 107,
  DAW_AUDIO_PROCESSOR_PARAMETER_GATE_HOLD_MS = 108,
  DAW_AUDIO_PROCESSOR_PARAMETER_GATE_RELEASE_MS = 109,
  DAW_AUDIO_PROCESSOR_PARAMETER_GATE_HYSTERESIS_DB = 110,
  DAW_AUDIO_PROCESSOR_PARAMETER_GATE_RANGE_DB = 111,
  DAW_AUDIO_PROCESSOR_PARAMETER_GATE_LOOKAHEAD_MS = 112,
  DAW_AUDIO_PROCESSOR_PARAMETER_GATE_LINK = 113,
  DAW_AUDIO_PROCESSOR_PARAMETER_GATE_SIDECHAIN_FREQUENCY_HZ = 114,
  DAW_AUDIO_PROCESSOR_PARAMETER_GATE_SIDECHAIN_Q = 115,
  DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_THRESHOLD_DB = 116,
  DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_RATIO = 117,
  DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_ATTACK_MS = 118,
  DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_RELEASE_MS = 119,
  DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_MAKEUP_DB = 120,
  DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_OUTPUT_DB = 121,
  DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_DRY_WET = 122,
  DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_KNEE_DB = 123,
  DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_LOOKAHEAD_MS = 124,
  DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_SIDECHAIN_FREQUENCY_HZ = 125,
  DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_SIDECHAIN_Q = 126,
  DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_CEILING = 127,
  DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_RELEASE = 128,
  DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_LOOKAHEAD_MS = 129,
  DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_LINK = 130,
  DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_BIT_DEPTH = 131,
  DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DECAY_SEC = 132,
  DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_REFLECTIONS = 133,
  DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_REFLECTION_MOD_AMOUNT_MS = 134,
  DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_REFLECTION_MOD_RATE_HZ = 135,
  DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_REFLECTION_SHAPE = 136,
  DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DIFFUSE = 137,
  DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_SIZE = 138,
  DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DIFFUSION = 139,
  DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DENSITY = 140,
  DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DIFFUSION_LOW_CUT_HZ = 141,
  DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DIFFUSION_HIGH_CUT_HZ = 142
} daw_audio_processor_parameter;

#define DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_TARGET_BASE DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_0_FREQUENCY_HZ
#define DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_TARGET_LAST DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_7_Q
#define DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_TARGET_STRIDE 3u
#define DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_FREQUENCY_HZ(band_index) \
  (DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_TARGET_BASE + ((band_index) * DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_TARGET_STRIDE))
#define DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_GAIN_DB(band_index) \
  (DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_FREQUENCY_HZ(band_index) + 1u)
#define DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_Q(band_index) \
  (DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_FREQUENCY_HZ(band_index) + 2u)

/* Graph descriptors are copied into an immutable prepared revision. Node and
 * edge ids are stable control-plane identifiers; process never dereferences
 * caller-owned graph memory. */
typedef struct daw_audio_graph_node_descriptor {
  uint64_t id;
  uint32_t kind;
  uint32_t input_layout;
  uint32_t output_layout;
  uint32_t input_bus;
  uint32_t latency_frames;
  uint32_t external_latency_frames;
  daw_audio_instrument_state_descriptor instrument;
  daw_audio_mixer_state mixer;
} daw_audio_graph_node_descriptor;

typedef struct daw_audio_graph_edge_descriptor {
  uint64_t id;
  uint64_t from_node_id;
  uint64_t to_node_id;
  uint64_t target_processor_id;
  float gain;
  uint32_t tap;
  uint32_t sidechain;
  uint32_t pdc_delay_frames;
} daw_audio_graph_edge_descriptor;

/* State bytes use the generated, little-endian processor protocol. They are
 * decoded field-by-field during prepare; callers must not pass packed structs. */
typedef struct daw_audio_processor_descriptor {
  uint64_t node_id;
  uint64_t instance_id;
  uint32_t kind;
  uint32_t state_version;
  uint32_t state_size;
  uint32_t bypassed;
  uint32_t input_layout;
  uint32_t output_layout;
  uint32_t latency_frames;
  uint32_t tail_frames;
  uint32_t parameter_count;
  const uint32_t *parameter_targets;
  const uint8_t *state;
} daw_audio_processor_descriptor;

typedef struct daw_audio_processor_state_patch {
  uint32_t graph_revision;
  uint64_t node_id;
  uint64_t instance_id;
  uint32_t kind;
  uint32_t state_version;
  uint32_t state_size;
  uint32_t bypassed;
  uint32_t input_layout;
  uint32_t output_layout;
  uint32_t parameter_count;
  uint32_t latency_frames;
  uint32_t tail_frames;
  const uint32_t *parameter_targets;
  const uint8_t *state;
} daw_audio_processor_state_patch;

typedef struct daw_audio_graph_prepare_request {
  uint32_t abi_version;
  uint32_t graph_revision;
  uint32_t node_count;
  uint32_t edge_count;
  uint32_t processor_count;
  uint32_t reserved0;
  const daw_audio_graph_node_descriptor *nodes;
  const daw_audio_graph_edge_descriptor *edges;
  const daw_audio_processor_descriptor *processors;
} daw_audio_graph_prepare_request;

/* A parameter block addresses one prepared processor and uses one scalar or
 * one a-rate value array per declared parameter target. Values are laid out
 * parameter-major: values[parameter * frame_count + frame]. */
typedef struct daw_audio_processor_parameter_block {
  uint64_t processor_instance_id;
  uint32_t frame_count;
  uint32_t parameter_count;
  const uint32_t *parameter_targets;
  const float *values;
} daw_audio_processor_parameter_block;

/* Events override the addressed parameter from frame_offset through the end
 * of the current block. Events must be ordered by nondecreasing offset. */
typedef struct daw_audio_processor_event {
  uint64_t processor_instance_id;
  uint32_t parameter_target;
  uint32_t frame_offset;
  float value;
} daw_audio_processor_event;

typedef struct daw_audio_core_process_block {
  uint32_t abi_version;
  uint32_t frame_count;
  uint32_t channel_count;
  uint32_t input_bus_count;
  const float *const *inputs;
  float *const *outputs;
  uint32_t graph_revision;
  uint32_t parameter_block_count;
  const daw_audio_processor_parameter_block *parameter_blocks;
  uint32_t event_count;
  const daw_audio_processor_event *events;
  uint32_t transport_epoch;
  uint32_t instrument_event_count;
  const struct daw_audio_instrument_event *instrument_events;
} daw_audio_core_process_block;

typedef enum daw_audio_utility_polarity {
  DAW_AUDIO_UTILITY_POLARITY_NORMAL = 0,
  DAW_AUDIO_UTILITY_POLARITY_INVERT = 1
} daw_audio_utility_polarity;

typedef enum daw_audio_utility_input_mode {
  DAW_AUDIO_UTILITY_INPUT_MODE_STEREO = 0,
  DAW_AUDIO_UTILITY_INPUT_MODE_MONO_SUM = 1
} daw_audio_utility_input_mode;

typedef enum daw_audio_utility_matrix {
  DAW_AUDIO_UTILITY_MATRIX_STEREO = 0,
  DAW_AUDIO_UTILITY_MATRIX_MID_SIDE_ENCODE = 1,
  DAW_AUDIO_UTILITY_MATRIX_MID_SIDE_DECODE = 2
} daw_audio_utility_matrix;

typedef struct daw_audio_utility_state {
  uint32_t enabled;
  float gain_db;
  uint32_t polarity;
  uint32_t input_mode;
  float pan;
  float balance;
  float width;
  uint32_t matrix;
  uint32_t swap;
  uint32_t dc_block;
} daw_audio_utility_state;

typedef enum daw_audio_saturator_curve {
  DAW_AUDIO_SATURATOR_CURVE_SOFT = 0,
  DAW_AUDIO_SATURATOR_CURVE_MEDIUM = 1,
  DAW_AUDIO_SATURATOR_CURVE_HARD = 2,
  DAW_AUDIO_SATURATOR_CURVE_CLIP = 3
} daw_audio_saturator_curve;

typedef struct daw_audio_saturator_state {
  uint32_t enabled;
  float drive_db;
  uint32_t curve;
  uint32_t color;
  float color_frequency_hz;
  float color_amount;
  float output_db;
  float dry_wet;
} daw_audio_saturator_state;

typedef enum daw_audio_eq_band_type {
  DAW_AUDIO_EQ_BAND_LOWPASS = 0,
  DAW_AUDIO_EQ_BAND_HIGHPASS = 1,
  DAW_AUDIO_EQ_BAND_BANDPASS = 2,
  DAW_AUDIO_EQ_BAND_LOWSHELF = 3,
  DAW_AUDIO_EQ_BAND_HIGHSHELF = 4,
  DAW_AUDIO_EQ_BAND_PEAKING = 5,
  DAW_AUDIO_EQ_BAND_NOTCH = 6,
  DAW_AUDIO_EQ_BAND_ALLPASS = 7
} daw_audio_eq_band_type;

typedef struct daw_audio_eq_band_state {
  uint32_t enabled;
  uint32_t type;
  float frequency_hz;
  float gain_db;
  float q;
  uint32_t reserved;
} daw_audio_eq_band_state;

/* A fixed eight-band RBJ cookbook biquad profile. It intentionally does not
 * claim browser BiquadFilterNode coefficient or AudioParam automation parity. */
typedef struct daw_audio_eq_state {
  uint32_t enabled;
  uint32_t mono;
  daw_audio_eq_band_state bands[8];
} daw_audio_eq_state;

typedef struct daw_audio_delay_modulation_state {
  uint32_t enabled;
  float delay_ms;
  float depth_ms;
  float rate_hz;
  float feedback;
  float stereo_phase;
  float mix;
} daw_audio_delay_modulation_state;

typedef struct daw_audio_phaser_state {
  uint32_t enabled;
  uint32_t stages;
  float center_hz;
  float depth_octaves;
  float rate_hz;
  float feedback;
  float stereo_phase;
  float mix;
} daw_audio_phaser_state;

typedef struct daw_audio_amplitude_modulation_state {
  uint32_t enabled;
  uint32_t waveform;
  float rate_hz;
  float depth;
  float shape;
  float phase;
} daw_audio_amplitude_modulation_state;

typedef struct daw_audio_ensemble_state {
  uint32_t enabled;
  uint32_t voices;
  float delay_ms;
  float depth_ms;
  float rate_hz;
  float spread;
  float mix;
} daw_audio_ensemble_state;

typedef struct daw_audio_gate_state {
  uint32_t enabled;
  uint32_t mode;
  float threshold_db;
  float ratio;
  float attack_ms;
  float hold_ms;
  float release_ms;
  float hysteresis_db;
  float range_db;
  float lookahead_ms;
  uint32_t detector;
  float link;
  uint32_t sidechain_enabled;
  float sidechain_frequency_hz;
  float sidechain_q;
} daw_audio_gate_state;

typedef struct daw_audio_compressor_state {
  uint32_t enabled;
  float threshold_db;
  float ratio;
  float attack_ms;
  float release_ms;
  uint32_t auto_release;
  float makeup_db;
  float output_db;
  float dry_wet;
  float knee_db;
  float lookahead_ms;
  uint32_t detector_mode;
  uint32_t dynamics_mode;
  uint32_t envelope_curve;
  uint32_t sidechain_enabled;
  uint32_t sidechain_filter_type;
  float sidechain_frequency_hz;
  float sidechain_q;
} daw_audio_compressor_state;

typedef struct daw_audio_limiter_state {
  uint32_t enabled;
  float ceiling_dbtp;
  float release_ms;
  float lookahead_ms;
  float link;
  uint32_t detector_oversampling;
} daw_audio_limiter_state;

/* Portable delay preserves the normalized project time and filter controls.
 * Sync division is resolved by the routing authority before this ABI boundary. */
typedef struct daw_audio_delay_state {
  uint32_t enabled;
  float delay_ms;
  float feedback;
  float dry_wet;
  uint32_t ping_pong;
  uint32_t filter_enabled;
  float low_cut_hz;
  float high_cut_hz;
} daw_audio_delay_state;

/* Deterministic bounded feedback-delay profile shared by native, Wasm, and
 * browser AudioWorklet processing. */
typedef struct daw_audio_reverb_state {
  uint32_t enabled;
  float wet;
  float decay_sec;
  float pre_delay_ms;
  float reflections;
  uint32_t reflection_spin;
  float reflection_mod_amount_ms;
  float reflection_mod_rate_hz;
  float reflection_shape;
  float diffuse;
  float size;
  float diffusion;
  float density;
  float low_cut_hz;
  float high_cut_hz;
  float diffusion_low_cut_hz;
  float diffusion_high_cut_hz;
  float stereo_width;
} daw_audio_reverb_state;

typedef enum daw_audio_spectral_mode {
  DAW_AUDIO_SPECTRAL_MODE_FREEZE = 0,
  DAW_AUDIO_SPECTRAL_MODE_GATE = 1,
  DAW_AUDIO_SPECTRAL_MODE_MORPH = 2,
  DAW_AUDIO_SPECTRAL_MODE_SHIFT_BLUR = 3,
  DAW_AUDIO_SPECTRAL_MODE_HPSS = 4,
  DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE = 5
} daw_audio_spectral_mode;

typedef struct daw_audio_spectral_state {
  uint32_t enabled;
  uint32_t fft_size;
  uint32_t overlap;
  uint32_t mode;
  float freeze;
  float gate_threshold_db;
  float gate_attack_ms;
  float gate_release_ms;
  float morph;
  float bin_shift;
  float blur;
  float harmonic_percussive_balance;
  float noise_reduction;
  float profile_learn;
  float mix;
} daw_audio_spectral_state;

typedef enum daw_audio_autofilter_mode {
  DAW_AUDIO_AUTOFILTER_MODE_LOWPASS = 0,
  DAW_AUDIO_AUTOFILTER_MODE_HIGHPASS = 1,
  DAW_AUDIO_AUTOFILTER_MODE_BANDPASS = 2,
  DAW_AUDIO_AUTOFILTER_MODE_NOTCH = 3,
  DAW_AUDIO_AUTOFILTER_MODE_PEAK = 4
} daw_audio_autofilter_mode;

typedef struct daw_audio_autofilter_state {
  uint32_t enabled;
  uint32_t mode;
  uint32_t quality;
  float frequency_hz;
  float resonance;
  float drive_db;
  float mix;
  float envelope_amount_octaves;
  float envelope_attack_ms;
  float envelope_release_ms;
  uint32_t lfo_waveform;
  float lfo_rate_hz;
  float lfo_depth_octaves;
  float lfo_phase_offset;
  float lfo_stereo_phase;
} daw_audio_autofilter_state;

typedef enum daw_audio_lofi_quantization {
  DAW_AUDIO_LOFI_QUANTIZATION_ROUND = 0,
  DAW_AUDIO_LOFI_QUANTIZATION_FLOOR = 1,
  DAW_AUDIO_LOFI_QUANTIZATION_TRUNCATE = 2
} daw_audio_lofi_quantization;

typedef enum daw_audio_lofi_dither {
  DAW_AUDIO_LOFI_DITHER_OFF = 0,
  DAW_AUDIO_LOFI_DITHER_RECTANGULAR = 1,
  DAW_AUDIO_LOFI_DITHER_TRIANGULAR = 2
} daw_audio_lofi_dither;

typedef struct daw_audio_lofi_state {
  uint32_t enabled;
  uint32_t bit_depth;
  float sample_rate_ratio;
  float jitter;
  float noise_db;
  uint32_t quantization;
  uint32_t dither;
  float mix;
  uint32_t seed;
} daw_audio_lofi_state;

typedef struct daw_audio_asset_descriptor {
  uint32_t abi_version;
  uint32_t revision;
  uint64_t byte_length;
  uint64_t content_hash_prefix;
  uint32_t frame_count;
  uint32_t sample_rate_hz;
  uint32_t channel_count;
  const float *const *planes;
} daw_audio_asset_descriptor;

typedef struct daw_audio_transport_state {
  uint32_t epoch;
  uint32_t running;
  int64_t frame;
  double tempo_bpm;
  uint32_t time_signature_numerator;
  uint32_t time_signature_denominator;
  uint32_t cycle_active;
  int64_t cycle_start_frame;
  int64_t cycle_end_frame;
} daw_audio_transport_state;

/* Fixed sample-frame commands. note_id is a control-plane identity, never a
 * runtime handle. Equal frame offsets retain the caller-provided sequence. */
typedef enum daw_audio_instrument_event_type {
  DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON = 1,
  DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF = 2,
  DAW_AUDIO_INSTRUMENT_EVENT_SUSTAIN = 3,
  DAW_AUDIO_INSTRUMENT_EVENT_EXPRESSION = 4,
  /* parameter_target uses the note field; this avoids widening the fixed
   * sample-frame command while retaining separate note IDs and targets. */
  DAW_AUDIO_INSTRUMENT_EVENT_PARAMETER = 5
} daw_audio_instrument_event_type;

typedef struct daw_audio_instrument_event {
  uint64_t node_id;
  uint64_t note_id;
  uint64_t sequence;
  uint32_t epoch;
  uint32_t frame_offset;
  uint32_t type;
  uint32_t channel;
  uint32_t note;
  float value;
} daw_audio_instrument_event;

typedef struct daw_audio_sample_source_event {
  uint32_t abi_version;
  uint32_t epoch;
  uint64_t sequence;
  uint64_t source_node_id;
  daw_audio_asset_handle asset;
  int64_t start_frame;
  int64_t stop_frame;
  uint64_t source_offset_frame;
  uint64_t source_frame_count;
  float gain;
  int64_t fade_in_start_frame;
  int64_t fade_in_end_frame;
  int64_t fade_out_start_frame;
  int64_t fade_out_end_frame;
  float source_offset_fraction;
  float fade_in_curve;
  float fade_in_curve_position;
  float fade_out_curve;
  float fade_out_curve_position;
} daw_audio_sample_source_event;

uint32_t daw_audio_core_get_abi_version(void);

daw_audio_core_result daw_audio_core_create(
  const daw_audio_core_config *config,
  daw_audio_core_handle *out_core);
void daw_audio_core_destroy(daw_audio_core_handle core);

daw_audio_core_result daw_audio_core_prepare(
  daw_audio_core_handle core,
  const daw_audio_core_prepare_request *request);
daw_audio_core_result daw_audio_core_prepare_graph(
  daw_audio_core_handle core,
  const daw_audio_graph_prepare_request *request);
/* Parses the same bounded portable graph envelope used by the Wasm bridge,
 * then prepares it on a native core. This is a control-thread API; process
 * never reads the caller-owned byte buffer. */
daw_audio_core_result daw_audio_core_prepare_graph_bytes(
  daw_audio_core_handle core,
  const uint8_t *graph_bytes,
  uint32_t graph_byte_count);
daw_audio_core_graph_validation_diagnostic daw_audio_core_get_graph_validation_diagnostic(
  daw_audio_core_handle core);
daw_audio_core_result daw_audio_core_publish(
  daw_audio_core_handle core,
  uint32_t expected_revision);

/* Discards an unpublished graph revision without changing the published
 * graph. This is required when a same-core preparation is rolled back. */
daw_audio_core_result daw_audio_core_cancel_prepared_graph(
  daw_audio_core_handle core,
  uint32_t expected_revision);
uint32_t daw_audio_core_prepared_graph_continuity(
  daw_audio_core_handle core);
daw_audio_core_result daw_audio_core_stage_processor_state_patch(
  daw_audio_core_handle core,
  const daw_audio_processor_state_patch *patch);
daw_audio_core_result daw_audio_core_apply_staged_processor_state_patch(
  daw_audio_core_handle core);
daw_audio_core_result daw_audio_core_cancel_staged_processor_state_patch(
  daw_audio_core_handle core);
daw_audio_core_result daw_audio_core_retire(
  daw_audio_core_handle core,
  uint32_t expected_revision);
daw_audio_core_result daw_audio_core_configure_utility(
  daw_audio_core_handle core,
  const daw_audio_utility_state *state);
daw_audio_core_result daw_audio_core_process(
  daw_audio_core_handle core,
  const daw_audio_core_process_block *block);
daw_audio_core_result daw_audio_core_set_transport(
  daw_audio_core_handle core,
  const daw_audio_transport_state *state);
daw_audio_core_result daw_audio_core_configure_synth(
  daw_audio_core_handle core,
  uint64_t node_id,
  const daw_audio_synth_state *state);
daw_audio_core_result daw_audio_core_configure_sampler(
  daw_audio_core_handle core,
  uint64_t node_id,
  const daw_audio_sampler_state *state,
  const daw_audio_sample_zone *zones);
daw_audio_core_result daw_audio_core_configure_granular(
  daw_audio_core_handle core,
  uint64_t node_id,
  const daw_audio_granular_state *state);
daw_audio_core_result daw_audio_core_schedule_sample_source(
  daw_audio_core_handle core,
  const daw_audio_sample_source_event *event);

/* Bounded recording capture C ABI. pcm_block is channel-major and each
 * provided plane must contain frame_count samples. The caller retains input
 * ownership. A queued output block remains valid until release_block. */
daw_audio_core_result daw_audio_recording_capture_create(
  const daw_audio_recording_capture_config *config,
  daw_audio_core_handle *out_capture);
void daw_audio_recording_capture_destroy(daw_audio_core_handle capture);
daw_audio_core_result daw_audio_recording_capture_process(
  daw_audio_core_handle capture,
  const float *const *inputs,
  uint32_t input_channel_count,
  uint32_t frame_count,
  int64_t start_frame);
/* Optional monitoring output is the same mapped/gained/polarity-processed
 * signal written to capture. It is produced for every input frame, independent
 * of punch boundaries; capture ownership and overflow behavior are unchanged. */
daw_audio_core_result daw_audio_recording_capture_process_monitor(
  daw_audio_core_handle capture,
  const float *const *inputs,
  uint32_t input_channel_count,
  float *const *monitor_outputs,
  uint32_t monitor_channel_count,
  uint32_t frame_count,
  int64_t start_frame);
daw_audio_core_result daw_audio_recording_capture_dequeue(
  daw_audio_core_handle capture,
  daw_audio_recording_capture_block *out_block);
daw_audio_core_result daw_audio_recording_capture_release_block(
  daw_audio_core_handle capture,
  uint32_t block_id);
daw_audio_core_result daw_audio_recording_capture_finalize(
  daw_audio_core_handle capture,
  int64_t stop_frame);
daw_audio_core_result daw_audio_recording_capture_cancel(
  daw_audio_core_handle capture);
daw_audio_core_result daw_audio_recording_capture_get_diagnostics(
  daw_audio_core_handle capture,
  daw_audio_recording_capture_diagnostics *out_diagnostics);

/* Fixed-memory AudioWorklet bridge. Initialization happens outside process;
 * the process entry accepts planar Wasm-memory pointers and variable frames. */
daw_audio_core_result daw_audio_core_wasm_utility_initialize(
  uint32_t sample_rate_hz,
  uint32_t max_frames_per_block);
daw_audio_core_result daw_audio_core_wasm_utility_process(
  uint32_t frame_count,
  const float *left_input,
  const float *right_input,
  float *left_output,
  float *right_output,
  const daw_audio_utility_state *state);
daw_audio_core_result daw_audio_core_wasm_asset_initialize(
  uint32_t sample_rate_hz,
  uint32_t max_assets);
daw_audio_core_result daw_audio_core_wasm_register_pcm_asset(
  uint32_t frame_count,
  uint32_t sample_rate_hz,
  uint32_t channel_count,
  const float *const *planes,
  daw_audio_asset_handle *out_asset);
daw_audio_core_result daw_audio_core_wasm_release_asset(
  daw_audio_asset_handle asset);

/* Fixed-memory graph bridge. These functions own one static portable core;
 * callers prepare/publish it off the render path, then invoke process using
 * preallocated Wasm-memory planar buffers. graph_bytes contains the bounded
 * envelope documented above. parameter_bytes contains:
 *   u32 count, then (u64 processor_id, u32 frame_count, u32 target_count,
 *   target_count*u32 targets, target_count*frame_count*f32 values).
 * event_bytes contains: u32 count, then (u64 processor_id, u32 target,
 * u32 frame_offset, f32 value). Passing a null pointer requires zero bytes. */
daw_audio_core_result daw_audio_core_wasm_graph_initialize(
  uint32_t sample_rate_hz,
  uint32_t max_frames_per_block,
  uint32_t max_assets);
/* Extended bridge setup retains the version-one entry point while declaring
 * the fixed planar input capacity consumed by the render entry below. */
daw_audio_core_result daw_audio_core_wasm_graph_initialize_planar(
  uint32_t sample_rate_hz,
  uint32_t max_frames_per_block,
  uint32_t max_input_buses,
  uint32_t max_channels,
  uint32_t max_assets);
daw_audio_core_result daw_audio_core_wasm_graph_prepare(
  const uint8_t *graph_bytes,
  uint32_t graph_byte_count);
daw_audio_core_result daw_audio_core_wasm_graph_publish(uint32_t expected_revision);
daw_audio_core_result daw_audio_core_wasm_graph_process(
  uint32_t frame_count,
  const float *left_input,
  const float *right_input,
  float *left_output,
  float *right_output,
  uint32_t graph_revision,
  const uint8_t *parameter_bytes,
  uint32_t parameter_byte_count,
  const uint8_t *event_bytes,
  uint32_t event_byte_count);
/* Fixed planar bridge for multi-bus graph input. inputs are ordered
 * bus-major, then channel; outputs contains channel_count planes. Instrument
 * events use a bounded little-endian envelope: u32 count followed by
 * (u64 node_id, u64 note_id, u64 sequence, u32 epoch, u32 frame_offset,
 *  u32 type, u32 channel, u32 note, f32 value). */
daw_audio_core_result daw_audio_core_wasm_graph_process_planar(
  uint32_t frame_count,
  uint32_t input_bus_count,
  uint32_t channel_count,
  const float *const *inputs,
  float *const *outputs,
  uint32_t graph_revision,
  const uint8_t *parameter_bytes,
  uint32_t parameter_byte_count,
  const uint8_t *event_bytes,
  uint32_t event_byte_count,
  const uint8_t *instrument_event_bytes,
  uint32_t instrument_event_byte_count);
daw_audio_core_result daw_audio_core_wasm_graph_set_transport(
  uint32_t epoch,
  uint32_t running,
  int64_t frame);
daw_audio_core_result daw_audio_core_wasm_graph_schedule_sample_source(
  uint32_t epoch,
  uint64_t sequence,
  uint64_t source_node_id,
  daw_audio_asset_handle asset,
  int64_t start_frame,
  int64_t stop_frame,
  uint64_t source_offset_frame,
  uint64_t source_frame_count,
  float gain,
  int64_t fade_in_start_frame,
  int64_t fade_in_end_frame,
  int64_t fade_out_start_frame,
  int64_t fade_out_end_frame,
  float source_offset_fraction,
  float fade_in_curve,
  float fade_in_curve_position,
  float fade_out_curve,
  float fade_out_curve_position);
daw_audio_core_result daw_audio_core_wasm_graph_register_pcm_asset(
  uint32_t frame_count,
  uint32_t sample_rate_hz,
  uint32_t channel_count,
  const float *const *planes,
  daw_audio_asset_handle *out_asset);
daw_audio_core_result daw_audio_core_wasm_graph_release_asset(
  daw_audio_asset_handle asset);
daw_audio_core_result daw_audio_core_wasm_graph_configure_synth(
  uint64_t node_id,
  const daw_audio_synth_state *state);
daw_audio_core_result daw_audio_core_wasm_graph_configure_sampler(
  uint64_t node_id,
  const daw_audio_sampler_state *state,
  const daw_audio_sample_zone *zones);
daw_audio_core_result daw_audio_core_wasm_graph_configure_granular(
  uint64_t node_id,
  const daw_audio_granular_state *state);

/* The Wasm bridge owns one fixed capture tap. Calling initialize starts a new
 * generation; captured blocks are copied into caller-provided planar output
 * during dequeue and therefore need no Wasm-side release acknowledgement. */
daw_audio_core_result daw_audio_core_wasm_recording_capture_initialize(
  const daw_audio_recording_capture_config *config);
daw_audio_core_result daw_audio_core_wasm_recording_capture_process(
  const float *const *inputs,
  uint32_t input_channel_count,
  uint32_t frame_count,
  int64_t start_frame);
daw_audio_core_result daw_audio_core_wasm_recording_capture_process_monitor(
  const float *const *inputs,
  uint32_t input_channel_count,
  float *const *monitor_outputs,
  uint32_t monitor_channel_count,
  uint32_t frame_count,
  int64_t start_frame);
daw_audio_core_result daw_audio_core_wasm_recording_capture_dequeue(
  float *const *outputs,
  daw_audio_recording_capture_block *out_block);
daw_audio_core_result daw_audio_core_wasm_recording_capture_finalize(int64_t stop_frame);
daw_audio_core_result daw_audio_core_wasm_recording_capture_cancel(void);
daw_audio_core_result daw_audio_core_wasm_recording_capture_get_diagnostics(
  daw_audio_recording_capture_diagnostics *out_diagnostics);

daw_audio_core_result daw_audio_core_create_asset(
  daw_audio_core_handle core,
  const daw_audio_asset_descriptor *descriptor,
  daw_audio_asset_handle *out_asset);
daw_audio_core_result daw_audio_core_get_asset_revision(
  daw_audio_core_handle core,
  daw_audio_asset_handle asset,
  uint32_t *out_revision);
daw_audio_core_result daw_audio_core_release_asset(
  daw_audio_core_handle core,
  daw_audio_asset_handle asset);

#ifdef __cplusplus
}
#endif
