#include "daw/audio_core.h"
#include "processor_contract_generated.h"
#include "daw/audio_core.h"
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
#include "daw/audio_core_native.h"
#endif

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <atomic>
#include <memory>
#include <new>
#include <type_traits>

namespace {

constexpr uint32_t kMaximumFramesPerBlock = 8192;
constexpr uint32_t kMaximumChannels = 64;
constexpr uint32_t kMaximumAssets = 64;
constexpr uint32_t kMaximumSampleSources = 256;
constexpr uint32_t kMaximumGraphNodes = 64;
constexpr uint32_t kMaximumGraphEdges = 256;
constexpr uint32_t kMaximumGraphProcessors = 512;
constexpr uint32_t kMaximumInstrumentVoices = DAW_AUDIO_CORE_MAX_INSTRUMENT_VOICES;
constexpr uint32_t kMaximumModulationDelayFrames = 4132;
constexpr uint32_t kMaximumDynamicsDelayFrames = 1024;
constexpr uint32_t kMaximumDelayProcessors = DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE;
constexpr uint32_t kMaximumReverbProcessors = DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE;
constexpr uint32_t kMaximumRetirementLanes = 8;
constexpr uint32_t kMaximumRetirementSeconds = 30;
constexpr uint32_t kMaximumSpectralProcessors = DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE;
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
constexpr uint32_t kMaximumNativeGraphStagesPerNode = DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE * 2u;
#endif
constexpr uint32_t kAutoFilterLatencyFrames = 6;
constexpr uint32_t kMaximumSpectralFftSize = 4096;
constexpr uint32_t kMaximumSpectralBins = kMaximumSpectralFftSize / 2 + 1;
constexpr uint32_t kSpectralHpssFrames = 31;
constexpr float kSampleTerminationFadeMilliseconds = 6.0F;
// Port of public/audio-worklets/daw-limiter-processor-v1.js createFir():
// 48 taps, 0.125 cutoff, Blackman-Harris window, normalized for four phases.
constexpr std::array<double, 48> kLimiterTruePeakFir = {
  2.8770393804939532e-19, -8.462079214010202e-05, -0.00036092137667317133, -0.0003633790261733186,
  0.00070568670835497859, 0.0029338012271598784, 0.0046865622501385462, 0.0029440137922481392,
  -0.0042954750165350233, -0.014678888263847801, -0.020272630731593962, -0.011363293681758927,
  0.015119076534081342, 0.047897022892599735, 0.062173748295054919, 0.033175379004903263,
  -0.042571243043840495, -0.13200353510096746, -0.17082947420323963, -0.093211746888245808,
  0.12718490344202485, 0.44935166807937821, 0.77127787554504057, 0.97258547035403053,
  0.97258547035403053, 0.77127787554504068, 0.44935166807937821, 0.12718490344202488,
  -0.09321174688824585, -0.17082947420323963, -0.13200353510096749, -0.042571243043840502,
  0.03317537900490327, 0.062173748295054933, 0.047897022892599735, 0.015119076534081344,
  -0.011363293681758931, -0.020272630731593962, -0.014678888263847821, -0.0042954750165350294,
  0.0029440137922481444, 0.0046865622501385549, 0.0029338012271598744, 0.00070568670835497989,
  -0.00036337902617331893, -0.00036092137667317285, -8.4620792140104189e-05, 2.8770393804939532e-19,
};
// One extra frame lets a 96 kHz processor read the full 3,000 ms contract maximum.
constexpr uint32_t kMaximumTimeEffectDelayFrames = 288001;
// Reverb uses the same fixed ring for pre-delay and its bounded late network.
constexpr uint32_t kMaximumReverbDelayFrames = 24001;
static_assert(sizeof(uintptr_t) <= sizeof(daw_audio_core_handle));
static_assert(DAW_AUDIO_CORE_PROCESSOR_CONTRACT_VERSION == 1u);

enum class ContinuityPreparationResult : uint8_t {
  kAccepted,
  kIncompatible,
  kRetirementCapacityExceeded,
};

struct AssetSlot {
  uint32_t generation = 1;
  uint32_t revision = 0;
  uint64_t frame_count = 0;
  uint32_t sample_rate_hz = 0;
  uint32_t channel_count = 0;
  const float *const *planes = nullptr;
  bool occupied = false;
};

struct SampleSource {
  uint64_t source_node_id = 0;
  daw_audio_asset_handle asset = 0;
  int64_t start_frame = 0;
  int64_t stop_frame = 0;
  uint64_t source_offset_frame = 0;
  float source_offset_fraction = 0.0F;
  uint64_t source_frame_count = 0;
  float gain = 0.0F;
  int64_t fade_in_start_frame = 0;
  int64_t fade_in_end_frame = 0;
  int64_t fade_out_start_frame = 0;
  int64_t fade_out_end_frame = 0;
  float fade_in_curve = 0.0F;
  float fade_in_curve_position = 0.5F;
  float fade_out_curve = 0.0F;
  float fade_out_curve_position = 0.5F;
  bool active = false;
};

struct GraphRevision {
  struct Range {
    uint16_t start = 0;
    uint16_t count = 0;
  };
  uint32_t revision = 0;
  uint32_t node_count = 0;
  uint32_t edge_count = 0;
  uint32_t master_index = kMaximumGraphNodes;
  std::array<daw_audio_graph_node_descriptor, kMaximumGraphNodes> nodes{};
  std::array<uint32_t, kMaximumGraphNodes> node_lookup{};
  std::array<daw_audio_graph_edge_descriptor, kMaximumGraphEdges> edges{};
  std::array<uint16_t, kMaximumGraphEdges> edge_source_indices{};
  std::array<uint16_t, kMaximumGraphEdges> edge_target_indices{};
  std::array<uint16_t, kMaximumGraphEdges> incoming_edge_indices{};
  std::array<Range, kMaximumGraphNodes> incoming_edge_ranges{};
  std::array<uint16_t, kMaximumGraphEdges> sidechain_edge_indices{};
  std::array<uint32_t, kMaximumGraphNodes> process_order{};
  struct Processor {
    uint64_t node_id = 0;
    uint16_t node_index = 0;
    uint64_t instance_id = 0;
    uint32_t kind = 0;
    uint32_t state_version = 0;
    uint32_t bypassed = 0;
    uint32_t input_layout = 0;
    uint32_t output_layout = 0;
    uint32_t latency_frames = 0;
    uint32_t tail_frames = 0;
    uint32_t parameter_count = 0;
    std::array<uint32_t, DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS> parameter_targets{};
    std::array<float, DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS> live_parameter_values{};
    std::array<bool, DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS> live_parameter_valid{};
    uint32_t state_size = 0;
    std::array<uint8_t, DAW_AUDIO_CORE_MAX_PROCESSOR_STATE_BYTES> state{};
    daw_audio_utility_state utility{};
    daw_audio_saturator_state saturator{};
    daw_audio_eq_state eq{};
    daw_audio_delay_modulation_state delay_modulation{};
    daw_audio_phaser_state phaser{};
    daw_audio_amplitude_modulation_state amplitude_modulation{};
    daw_audio_ensemble_state ensemble{};
    daw_audio_gate_state gate{};
    daw_audio_compressor_state compressor{};
    daw_audio_limiter_state limiter{};
    daw_audio_delay_state delay{};
    daw_audio_reverb_state reverb{};
    daw_audio_spectral_state spectral{};
    daw_audio_autofilter_state autofilter{};
    daw_audio_lofi_state lofi{};
    uint32_t control_slot = 0;
    uint32_t history_slot = 0;
    uint32_t delay_slot = kMaximumDelayProcessors;
    uint32_t reverb_slot = kMaximumReverbProcessors;
    uint32_t spectral_slot = kMaximumSpectralProcessors;
  };
  uint32_t processor_count = 0;
  std::array<Processor, kMaximumGraphProcessors> processors{};
  std::array<uint16_t, kMaximumGraphProcessors> processor_indices{};
  std::array<Range, kMaximumGraphNodes> processor_ranges{};
  std::array<Range, kMaximumGraphProcessors> sidechain_edge_ranges{};
};

struct Core;

bool valid_processor_parameter_target(uint32_t kind, uint32_t target);
bool valid_processor_parameter_targets(const daw_audio_processor_descriptor &descriptor);

using ProcessorRenderer = void (*)(
  Core &core,
  GraphRevision::Processor &processor,
  uint32_t frame,
  float input_left,
  float input_right,
  float sidechain_left,
  float sidechain_right,
  float *output_left,
  float *output_right);

struct BiquadHistory {
  float x1 = 0.0F;
  float x2 = 0.0F;
  float y1 = 0.0F;
  float y2 = 0.0F;
};

struct UtilityHistory {
  float dc_x1_left = 0.0F;
  float dc_x1_right = 0.0F;
  float dc_y1_left = 0.0F;
  float dc_y1_right = 0.0F;
  float bypass = 0.0F;
};

struct SaturatorHistory {
  BiquadHistory color_left{};
  BiquadHistory color_right{};
  float previous_left = 0.0F;
  float previous_right = 0.0F;
};

struct EqHistory {
  std::array<std::array<BiquadHistory, 2>, 8> bands{};
};

struct DynamicsHistory {
  std::array<float, kMaximumDynamicsDelayFrames> delay_left{};
  std::array<float, kMaximumDynamicsDelayFrames> delay_right{};
  std::array<float, kMaximumDynamicsDelayFrames> detector_left{};
  std::array<float, kMaximumDynamicsDelayFrames> detector_right{};
  std::array<double, 12> limiter_true_peak_left{};
  std::array<double, 12> limiter_true_peak_right{};
  uint32_t limiter_true_peak_write = 0;
  uint32_t write = 0;
  std::array<float, 2> gain{1.0F, 1.0F};
  std::array<float, 2> rms{};
  std::array<uint32_t, 2> hold{};
  std::array<uint32_t, 2> open{1, 1};
  std::array<uint32_t, 2> started{};
  std::array<BiquadHistory, 2> sidechain{};
  float compressor_envelope_db = 0.0F;
  float compressor_rms = 0.0F;
  float compressor_sc_low = 0.0F;
  float compressor_sc_band = 0.0F;
};

#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
enum class NativeGraphStageKind : uint8_t {
  kBuiltIn,
  kExternal,
};

struct NativeGraphStage {
  NativeGraphStageKind kind = NativeGraphStageKind::kBuiltIn;
  uint16_t processor_index = 0;
  ProcessorRenderer renderer = nullptr;
  void *attachment = nullptr;
  daw::audio_core::NativeGraphStageRole role = daw::audio_core::NativeGraphStageRole::kEffect;
};

static_assert(std::is_trivially_copyable_v<NativeGraphStage>);

struct NativeGraphHooks {
  uint32_t revision = 0;
  daw::audio_core::NativeGraphNodeHook hook = nullptr;
  daw::audio_core::NativeGraphNodeHook observer = nullptr;
  void* observer_attachment = nullptr;
  std::array<std::array<NativeGraphStage, kMaximumNativeGraphStagesPerNode>, kMaximumGraphNodes> stages{};
  std::array<std::uint32_t, kMaximumGraphNodes> stage_counts{};
  std::array<NativeGraphStage, kMaximumGraphNodes> instrument_sources{};
  std::array<bool, kMaximumGraphNodes> has_instrument_sources{};
};

ProcessorRenderer find_processor_renderer(uint32_t kind);

bool initialize_native_graph_stages(NativeGraphHooks &hooks, const GraphRevision &graph) noexcept {
  hooks.revision = graph.revision;
  hooks.stage_counts.fill(0);
  hooks.has_instrument_sources.fill(false);
  for (uint32_t node_index = 0; node_index < graph.node_count; ++node_index) {
    uint32_t stage_count = 0;
    const GraphRevision::Range processor_range = graph.processor_ranges[node_index];
    const uint32_t processor_end = static_cast<uint32_t>(processor_range.start) + processor_range.count;
    for (uint32_t position = processor_range.start; position < processor_end; ++position) {
      const uint16_t processor_index = graph.processor_indices[position];
      if (stage_count >= kMaximumNativeGraphStagesPerNode) return false;
      const ProcessorRenderer renderer = find_processor_renderer(graph.processors[processor_index].kind);
      if (renderer == nullptr) return false;
      hooks.stages[node_index][stage_count++] = {
        .kind = NativeGraphStageKind::kBuiltIn,
        .processor_index = processor_index,
        .renderer = renderer,
      };
    }
    hooks.stage_counts[node_index] = stage_count;
  }
  return true;
}
#endif

struct InstrumentVoice {
  uint64_t note_id = 0;
  uint32_t channel = 0;
  uint32_t note = 0;
  float velocity = 0.0F;
  uint32_t references = 0;
  uint64_t age = 0;
  float oscillator_phase[2]{};
  float lfo_phase = 0.0F;
  uint32_t noise_state = 1;
  float amp_level = 0.0F;
  float filter_level = 0.0F;
  BiquadHistory filter_history[2]{};
  uint32_t amp_stage = 0;
  uint32_t filter_stage = 0;
  bool held = false;
  bool active = false;
  bool released = false;
};

struct SampleVoice {
  uint64_t note_id = 0;
  uint32_t note = 0;
  daw_audio_asset_handle asset = 0;
  double position = 0.0;
  double increment = 1.0;
  uint32_t end_frame = 0;
  uint32_t loop_start_frame = 0;
  uint32_t loop_end_frame = 0;
  uint32_t crossfade_frame_count = 0;
  uint32_t playback_mode = DAW_AUDIO_SAMPLE_PLAYBACK_ONE_SHOT;
  uint32_t choke_group = 0;
  float gain = 0.0F;
  float pan = 0.0F;
  float amp_level = 0.0F;
  float filter_level = 0.0F;
  uint32_t filter_stage = 0;
  float lfo_phase = 0.0F;
  BiquadHistory filter_history[2]{};
  float forced_release_ms = 0.0F;
  uint32_t amp_stage = 0;
  uint64_t age = 0;
  bool active = false;
  bool released = false;
};

struct GranularGrain {
  double cursor = 0.0;
  double step = 1.0;
  uint32_t age = 0;
  uint32_t length = 0;
  float pan = 0.0F;
  bool active = false;
};

struct InstrumentNodeState {
  std::array<InstrumentVoice, kMaximumInstrumentVoices> voices{};
  daw_audio_synth_state synth{};
  bool sustain = false;
  float expression = 1.0F;
  uint64_t next_age = 1;
  daw_audio_sampler_state sampler{};
  std::array<daw_audio_sample_zone, DAW_AUDIO_CORE_MAX_SAMPLE_ZONES> zones{};
  std::array<uint32_t, DAW_AUDIO_CORE_MAX_SAMPLE_ZONES> round_robin_cursors{};
  std::array<SampleVoice, kMaximumInstrumentVoices> sample_voices{};
  daw_audio_granular_state granular{};
  std::array<GranularGrain, DAW_AUDIO_CORE_MAX_GRANULAR_GRAINS> grains{};
  std::array<uint64_t, kMaximumInstrumentVoices> granular_note_ids{};
  uint32_t granular_note_count = 0;
  uint32_t granular_random_state = 1;
  double granular_next_frame = 0.0;
  float granular_frozen_position = -1.0F;
};

struct ModulationHistory {
  std::array<float, kMaximumModulationDelayFrames> delay_left{};
  std::array<float, kMaximumModulationDelayFrames> delay_right{};
  std::array<float, 12> allpass_x_left{};
  std::array<float, 12> allpass_x_right{};
  std::array<float, 12> allpass_y_left{};
  std::array<float, 12> allpass_y_right{};
  uint32_t write = 0;
  float feedback_left = 0.0F;
  float feedback_right = 0.0F;
  double phase = 0.0;
  float bypass = 0.0F;
};

template <size_t DelayFrames>
struct TimeEffectHistory {
  std::array<float, DelayFrames> left{};
  std::array<float, DelayFrames> right{};
  uint32_t write = 0;
  BiquadHistory highpass_left{};
  BiquadHistory highpass_right{};
  BiquadHistory lowpass_left{};
  BiquadHistory lowpass_right{};
  float low_left = 0.0F;
  float low_right = 0.0F;
  float high_input_left = 0.0F;
  float high_input_right = 0.0F;
  float high_left = 0.0F;
  float high_right = 0.0F;
  double phase = 0.0;
  float bypass = 0.0F;
};

using DelayHistory = TimeEffectHistory<kMaximumTimeEffectDelayFrames>;
using ReverbHistory = TimeEffectHistory<kMaximumReverbDelayFrames>;

struct SpectralHistory {
  std::array<std::array<float, kMaximumSpectralFftSize>, 2> input{};
  std::array<std::array<float, kMaximumSpectralFftSize>, 2> sidechain{};
  std::array<std::array<float, kMaximumSpectralFftSize * 2>, 2> output{};
  std::array<std::array<float, kMaximumSpectralFftSize * 2>, 2> dry{};
  std::array<std::array<float, kMaximumSpectralFftSize>, 2> real{};
  std::array<std::array<float, kMaximumSpectralFftSize>, 2> imaginary{};
  std::array<std::array<float, kMaximumSpectralFftSize>, 2> side_real{};
  std::array<std::array<float, kMaximumSpectralFftSize>, 2> side_imaginary{};
  std::array<std::array<float, kMaximumSpectralBins>, 2> frozen_magnitude{};
  std::array<std::array<float, kMaximumSpectralBins>, 2> frozen_phase{};
  std::array<std::array<float, kMaximumSpectralBins>, 2> gate_gain{};
  std::array<std::array<float, kMaximumSpectralBins>, 2> noise_profile{};
  std::array<std::array<float, kMaximumSpectralBins>, 2> scratch{};
  std::array<std::array<float, kMaximumSpectralBins>, 2> hpss_median{};
  std::array<std::array<float, kMaximumSpectralBins * kSpectralHpssFrames>, 2> hpss_history{};
  std::array<uint32_t, 2> hpss_index{};
  std::array<bool, 2> freeze_captured{};
  uint32_t fft_size = 0;
  uint32_t overlap = 0;
  uint32_t hop_size = 0;
  uint32_t write_index = 0;
  uint32_t samples_until_frame = 0;
  float bypass = 0.0F;
};

struct AutoFilterChannelHistory {
  float ic1 = 0.0F;
  float ic2 = 0.0F;
  float envelope = 0.0F;
  float phase = 0.0F;
  float previous = 0.0F;
};

struct AutoFilterHistory {
  std::array<AutoFilterChannelHistory, 2> channels{};
  std::array<std::array<float, kAutoFilterLatencyFrames>, 2> delay{};
  uint32_t delay_index = 0;
  float bypass = 0.0F;
};

struct LoFiChannelHistory {
  float phase = 1.0F;
  float held = 0.0F;
  float interval = 1.0F;
  uint32_t random_state = 0;
};

struct LoFiHistory {
  std::array<LoFiChannelHistory, 2> channels{};
  float bypass = 0.0F;
};

struct ProcessorHistorySlot {
  uint64_t instance_id = 0;
  uint32_t kind = 0;
  uint64_t node_id = 0;
  uint32_t input_layout = 0;
  uint32_t output_layout = 0;
  bool occupied = false;
};

struct Core {
  struct StagedProcessorStatePatch {
    GraphRevision::Processor processor{};
    uint32_t graph_revision = 0;
    std::atomic<uint32_t> state = 0;
  };
  daw_audio_core_config config{};
  daw_audio_core_graph_validation_diagnostic graph_validation_diagnostic{};
  uint32_t prepared_revision = 0;
  uint32_t published_revision = 0;
  ContinuityPreparationResult prepared_continuity = ContinuityPreparationResult::kAccepted;
  daw_audio_utility_state utility{};
  UtilityHistory utility_history{};
  bool utility_configured = false;
  std::array<AssetSlot, kMaximumAssets> assets{};
  daw_audio_transport_state transport{};
  uint64_t last_event_sequence = 0;
  std::array<SampleSource, kMaximumSampleSources> sample_sources{};
  std::array<GraphRevision, 2> graph_slots{};
  GraphRevision *prepared_graph = &graph_slots[0];
  GraphRevision *published_graph = &graph_slots[1];
  std::unique_ptr<StagedProcessorStatePatch[]> staged_processor_state_patches{};
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  NativeGraphHooks prepared_native_hooks{};
  NativeGraphHooks published_native_hooks{};
#endif
  std::array<std::array<std::array<float, kMaximumFramesPerBlock>, 2>, kMaximumGraphNodes> graph_buffers{};
  std::unique_ptr<float[]> graph_stage_buffers{};
  std::array<std::array<std::array<float, kMaximumFramesPerBlock>, 2>, kMaximumGraphEdges> graph_delay_lines{};
  std::array<uint32_t, kMaximumGraphEdges> graph_delay_cursors{};
  std::array<ProcessorHistorySlot, kMaximumGraphProcessors> processor_history_slots{};
  std::array<UtilityHistory, kMaximumGraphProcessors> utility_histories{};
  std::array<SaturatorHistory, kMaximumGraphProcessors> saturator_histories{};
  std::array<EqHistory, kMaximumGraphProcessors> eq_histories{};
  std::array<DynamicsHistory, kMaximumGraphProcessors> dynamics_histories{};
  std::array<ModulationHistory, kMaximumGraphProcessors> modulation_histories{};
  std::array<DelayHistory, kMaximumDelayProcessors> delay_histories{};
  std::array<ReverbHistory, kMaximumReverbProcessors> reverb_histories{};
  std::array<std::atomic<uint64_t>, kMaximumDelayProcessors> delay_slot_owners{};
  std::array<std::atomic<uint64_t>, kMaximumReverbProcessors> reverb_slot_owners{};
  std::array<SpectralHistory, kMaximumSpectralProcessors> spectral_histories{};
  std::array<AutoFilterHistory, kMaximumGraphProcessors> autofilter_histories{};
  std::array<LoFiHistory, kMaximumGraphProcessors> lofi_histories{};
  struct RetirementLane {
    GraphRevision::Processor processor{};
    std::atomic<uint32_t> remaining_frames = 0;
    uint64_t generation = 0;
    uint32_t source_delay_slot = kMaximumDelayProcessors;
    uint32_t source_reverb_slot = kMaximumReverbProcessors;
  };
  std::unique_ptr<std::array<RetirementLane, kMaximumRetirementLanes>[]> retirement_lane_slots{};
  std::array<RetirementLane, kMaximumRetirementLanes> *prepared_retirement_lanes = nullptr;
  std::array<RetirementLane, kMaximumRetirementLanes> *published_retirement_lanes = nullptr;
  uint64_t retirement_generation = 0;
  std::array<bool, kMaximumGraphProcessors> prepared_reset_history{};
  std::array<bool, kMaximumDelayProcessors> prepared_reset_delay{};
  std::array<bool, kMaximumReverbProcessors> prepared_reset_reverb{};
  std::array<bool, kMaximumSpectralProcessors> prepared_reset_spectral{};
  std::array<const daw_audio_processor_parameter_block *, kMaximumGraphProcessors> active_parameter_blocks{};
  std::array<uint32_t, kMaximumGraphProcessors> event_starts{};
  std::array<uint32_t, kMaximumGraphProcessors> event_ends{};
  std::array<uint32_t, kMaximumGraphProcessors> parameter_event_cursors{};
  std::array<std::array<float, DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS>, kMaximumGraphProcessors>
    event_parameter_values{};
  std::array<std::array<bool, DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS>, kMaximumGraphProcessors>
    event_parameter_valid{};
  std::array<std::array<uint8_t, DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS>, kMaximumGraphProcessors>
    parameter_block_indices{};
  std::array<std::array<float, DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS>, kMaximumGraphProcessors>
    resolved_parameter_values{};
  std::array<std::array<bool, DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS>, kMaximumGraphProcessors>
    resolved_parameter_valid{};
  std::array<bool, kMaximumGraphProcessors> parameter_cache_prepared{};
  const daw_audio_processor_event *active_events = nullptr;
  uint32_t active_event_count = 0;
  const daw_audio_instrument_event *active_instrument_events = nullptr;
  uint32_t active_instrument_event_count = 0;
  std::array<std::array<uint16_t, DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS>, kMaximumGraphNodes> instrument_event_indices{};
  std::array<uint16_t, kMaximumGraphNodes> instrument_event_counts{};
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  std::array<std::array<daw_audio_instrument_event, DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS>, kMaximumGraphNodes>
    native_instrument_events{};
#endif
  std::array<uint16_t, kMaximumSampleSources> active_source_indices{};
  std::array<GraphRevision::Range, kMaximumGraphNodes> active_source_ranges{};
  GraphRevision::Range root_source_range{};
  std::array<std::array<InstrumentNodeState, kMaximumGraphNodes>, 2> instrument_slots{};
  std::array<InstrumentNodeState, kMaximumGraphNodes> *prepared_instruments = &instrument_slots[0];
  std::array<InstrumentNodeState, kMaximumGraphNodes> *published_instruments = &instrument_slots[1];
  std::array<std::array<InstrumentNodeState, kMaximumGraphNodes>, 2> instrument_config_slots{};
  std::array<InstrumentNodeState, kMaximumGraphNodes> *prepared_instrument_configs = &instrument_config_slots[0];
  std::array<InstrumentNodeState, kMaximumGraphNodes> *published_instrument_configs = &instrument_config_slots[1];
#if defined(DAW_AUDIO_CORE_USE_PERSISTENT_VALIDATION_SCRATCH)
  std::array<InstrumentNodeState, kMaximumGraphNodes> proposed_instruments{};
#endif
};

bool initialize_core_storage(Core &core) {
  core.staged_processor_state_patches.reset(new (std::nothrow) Core::StagedProcessorStatePatch[2]);
  core.retirement_lane_slots.reset(
    new (std::nothrow) std::array<Core::RetirementLane, kMaximumRetirementLanes>[2]);
  if (core.staged_processor_state_patches == nullptr || core.retirement_lane_slots == nullptr) return false;
  core.prepared_retirement_lanes = &core.retirement_lane_slots[0];
  core.published_retirement_lanes = &core.retirement_lane_slots[1];
  return true;
}

void release_retirement_lane_slot(Core &core, const Core::RetirementLane &lane) {
  if (lane.processor.kind == DAW_AUDIO_PROCESSOR_KIND_DELAY
    && lane.source_delay_slot < kMaximumDelayProcessors) {
    uint64_t expected_generation = lane.generation;
    core.delay_slot_owners[lane.source_delay_slot].compare_exchange_strong(
      expected_generation, 0, std::memory_order_acq_rel);
  } else if (lane.processor.kind == DAW_AUDIO_PROCESSOR_KIND_REVERB
    && lane.source_reverb_slot < kMaximumReverbProcessors) {
    uint64_t expected_generation = lane.generation;
    core.reverb_slot_owners[lane.source_reverb_slot].compare_exchange_strong(
      expected_generation, 0, std::memory_order_acq_rel);
  }
}

Core *to_core(daw_audio_core_handle handle) {
  return reinterpret_cast<Core *>(static_cast<uintptr_t>(handle));
}

daw_audio_core_handle to_handle(Core *core) {
  return static_cast<daw_audio_core_handle>(reinterpret_cast<uintptr_t>(core));
}

bool valid_abi(uint32_t version) {
  return version == DAW_AUDIO_CORE_ABI_VERSION;
}

bool valid_config(const daw_audio_core_config &config) {
  return valid_abi(config.abi_version)
    && config.max_frames_per_block > 0
    && config.max_frames_per_block <= kMaximumFramesPerBlock
    && config.max_channels > 0
    && config.max_channels <= kMaximumChannels
    && config.max_assets > 0
    && config.max_assets <= kMaximumAssets
    && config.sample_rate_hz > 0;
}

bool valid_graph_layout(uint32_t layout) {
  return layout == DAW_AUDIO_GRAPH_LAYOUT_MONO || layout == DAW_AUDIO_GRAPH_LAYOUT_STEREO;
}

bool valid_graph_node_kind(uint32_t kind) {
  return kind == DAW_AUDIO_GRAPH_NODE_SOURCE
    || kind == DAW_AUDIO_GRAPH_NODE_UTILITY
    || kind == DAW_AUDIO_GRAPH_NODE_MIXER
    || kind == DAW_AUDIO_GRAPH_NODE_MASTER
    || kind == DAW_AUDIO_GRAPH_NODE_INSTRUMENT;
}

AssetSlot *find_asset(Core *core, daw_audio_asset_handle handle);

constexpr daw_audio_synth_state default_synth_state() {
  return {
    .version = 1, .seed = 0xA341316CU,
    .oscillators = {
      {.enabled = 1, .waveform = DAW_AUDIO_SYNTH_WAVEFORM_SAWTOOTH, .level = 0.7F, .octave = 0, .semitone = 0, .detune_cents = -7.0F},
      {.enabled = 1, .waveform = DAW_AUDIO_SYNTH_WAVEFORM_SAWTOOTH, .level = 0.45F, .octave = 0, .semitone = 0, .detune_cents = 7.0F},
    },
    .noise_enabled = 0, .noise_level = 0.25F,
    .filter_enabled = 1, .filter_mode = DAW_AUDIO_SYNTH_FILTER_MODE_LOWPASS,
    .filter_cutoff_hz = 12000.0F, .filter_resonance = 0.7F, .filter_key_tracking = 0.0F,
    .filter_envelope_amount_octaves = 0.0F, .filter_attack_ms = 5.0F, .filter_decay_ms = 150.0F,
    .filter_sustain = 0.0F, .filter_release_ms = 150.0F,
    .amp_attack_ms = 5.0F, .amp_decay_ms = 100.0F, .amp_sustain = 0.8F, .amp_release_ms = 120.0F,
    .lfo_enabled = 0, .lfo_waveform = DAW_AUDIO_SYNTH_WAVEFORM_SINE, .lfo_rate_hz = 5.0F,
    .lfo_pitch_cents = 0.0F, .lfo_filter_octaves = 0.0F, .lfo_amplitude = 0.0F, .lfo_pan = 0.0F,
    .output_gain = 0.8F, .output_pan = 0.0F,
  };
}

bool valid_synth_state(const daw_audio_synth_state &state) {
  if (state.version != 1 || state.seed == 0 || state.noise_enabled > 1 || state.filter_enabled > 1
    || state.filter_mode > DAW_AUDIO_SYNTH_FILTER_MODE_NOTCH || state.lfo_enabled > 1
    || state.lfo_waveform > DAW_AUDIO_SYNTH_WAVEFORM_TRIANGLE
    || !std::isfinite(state.noise_level) || state.noise_level < 0.0F || state.noise_level > 1.0F
    || !std::isfinite(state.filter_cutoff_hz) || state.filter_cutoff_hz < 20.0F || state.filter_cutoff_hz > 20000.0F
    || !std::isfinite(state.filter_resonance) || state.filter_resonance < 0.0001F || state.filter_resonance > 30.0F
    || !std::isfinite(state.filter_key_tracking) || state.filter_key_tracking < 0.0F || state.filter_key_tracking > 1.0F
    || !std::isfinite(state.filter_envelope_amount_octaves) || state.filter_envelope_amount_octaves < -6.0F || state.filter_envelope_amount_octaves > 6.0F
    || !std::isfinite(state.filter_attack_ms) || state.filter_attack_ms < 0.0F || state.filter_attack_ms > 60000.0F
    || !std::isfinite(state.filter_decay_ms) || state.filter_decay_ms < 0.0F || state.filter_decay_ms > 60000.0F
    || !std::isfinite(state.filter_sustain) || state.filter_sustain < 0.0F || state.filter_sustain > 1.0F
    || !std::isfinite(state.filter_release_ms) || state.filter_release_ms < 0.0F || state.filter_release_ms > 60000.0F
    || !std::isfinite(state.amp_attack_ms) || state.amp_attack_ms < 0.0F || state.amp_attack_ms > 60000.0F
    || !std::isfinite(state.amp_decay_ms) || state.amp_decay_ms < 0.0F || state.amp_decay_ms > 60000.0F
    || !std::isfinite(state.amp_sustain) || state.amp_sustain < 0.0F || state.amp_sustain > 1.0F
    || !std::isfinite(state.amp_release_ms) || state.amp_release_ms < 0.0F || state.amp_release_ms > 60000.0F
    || !std::isfinite(state.lfo_rate_hz) || state.lfo_rate_hz < 0.01F || state.lfo_rate_hz > 100.0F
    || !std::isfinite(state.lfo_pitch_cents) || state.lfo_pitch_cents < -1200.0F || state.lfo_pitch_cents > 1200.0F
    || !std::isfinite(state.lfo_filter_octaves) || state.lfo_filter_octaves < -6.0F || state.lfo_filter_octaves > 6.0F
    || !std::isfinite(state.lfo_amplitude) || state.lfo_amplitude < 0.0F || state.lfo_amplitude > 1.0F
    || !std::isfinite(state.lfo_pan) || state.lfo_pan < 0.0F || state.lfo_pan > 1.0F
    || !std::isfinite(state.output_gain) || state.output_gain < 0.0F || state.output_gain > 1.5F
    || !std::isfinite(state.output_pan) || state.output_pan < -1.0F || state.output_pan > 1.0F) return false;
  for (const daw_audio_synth_oscillator_state &oscillator : state.oscillators) {
    if (oscillator.enabled > 1 || oscillator.waveform > DAW_AUDIO_SYNTH_WAVEFORM_TRIANGLE
      || !std::isfinite(oscillator.level) || oscillator.level < 0.0F || oscillator.level > 1.0F
      || oscillator.octave < -3 || oscillator.octave > 3 || oscillator.semitone < -12 || oscillator.semitone > 12
      || !std::isfinite(oscillator.detune_cents) || oscillator.detune_cents < -100.0F || oscillator.detune_cents > 100.0F) return false;
  }
  return true;
}

bool valid_sampler_state(const daw_audio_sampler_state &state) {
  return state.version == 1 && state.zone_count <= DAW_AUDIO_CORE_MAX_SAMPLE_ZONES
    && std::isfinite(state.amp_attack_ms) && state.amp_attack_ms >= 0.0F && state.amp_attack_ms <= 60000.0F
    && std::isfinite(state.amp_decay_ms) && state.amp_decay_ms >= 0.0F && state.amp_decay_ms <= 60000.0F
    && std::isfinite(state.amp_sustain) && state.amp_sustain >= 0.0F && state.amp_sustain <= 1.0F
    && std::isfinite(state.amp_release_ms) && state.amp_release_ms >= 0.0F && state.amp_release_ms <= 60000.0F
    && state.filter_enabled <= 1 && state.filter_mode <= DAW_AUDIO_SYNTH_FILTER_MODE_NOTCH
    && std::isfinite(state.filter_cutoff_hz) && state.filter_cutoff_hz >= 20.0F && state.filter_cutoff_hz <= 20000.0F
    && std::isfinite(state.filter_resonance) && state.filter_resonance >= 0.0001F && state.filter_resonance <= 30.0F
    && std::isfinite(state.filter_envelope_amount) && state.filter_envelope_amount >= -1.0F && state.filter_envelope_amount <= 1.0F
    && std::isfinite(state.filter_attack_ms) && state.filter_attack_ms >= 0.0F && state.filter_attack_ms <= 60000.0F
    && std::isfinite(state.filter_decay_ms) && state.filter_decay_ms >= 0.0F && state.filter_decay_ms <= 60000.0F
    && std::isfinite(state.filter_sustain) && state.filter_sustain >= 0.0F && state.filter_sustain <= 1.0F
    && std::isfinite(state.filter_release_ms) && state.filter_release_ms >= 0.0F && state.filter_release_ms <= 60000.0F
    && state.lfo_enabled <= 1
    && std::isfinite(state.lfo_rate_hz) && state.lfo_rate_hz >= 0.01F && state.lfo_rate_hz <= 100.0F
    && std::isfinite(state.lfo_pitch_cents) && state.lfo_pitch_cents >= -2400.0F && state.lfo_pitch_cents <= 2400.0F
    && std::isfinite(state.lfo_filter_hz) && state.lfo_filter_hz >= -20000.0F && state.lfo_filter_hz <= 20000.0F
    && std::isfinite(state.lfo_amplitude) && state.lfo_amplitude >= 0.0F && state.lfo_amplitude <= 1.0F
    && std::isfinite(state.lfo_pan) && state.lfo_pan >= 0.0F && state.lfo_pan <= 1.0F
    && state.retrigger <= 1;
}

bool valid_granular_state(Core &core, const daw_audio_granular_state &state) {
  return state.version == 1 && (state.asset == 0 || find_asset(&core, state.asset) != nullptr) && state.seed != 0
    && state.max_grains > 0 && state.max_grains <= DAW_AUDIO_CORE_MAX_GRANULAR_GRAINS
    && state.window_shape <= DAW_AUDIO_GRANULAR_WINDOW_GAUSSIAN && state.freeze <= 1
    && std::isfinite(state.grain_size_ms) && state.grain_size_ms >= 5.0F && state.grain_size_ms <= 1000.0F
    && std::isfinite(state.density_hz) && state.density_hz >= 0.25F && state.density_hz <= 200.0F
    && std::isfinite(state.position) && state.position >= 0.0F && state.position <= 1.0F
    && std::isfinite(state.spray) && state.spray >= 0.0F && state.spray <= 1.0F
    && std::isfinite(state.pitch_semitones) && state.pitch_semitones >= -48.0F && state.pitch_semitones <= 48.0F
    && std::isfinite(state.reverse_probability) && state.reverse_probability >= 0.0F && state.reverse_probability <= 1.0F
    && std::isfinite(state.stereo_spread) && state.stereo_spread >= 0.0F && state.stereo_spread <= 1.0F;
}

bool valid_sample_zone(Core &core, const daw_audio_sample_zone &zone) {
  AssetSlot *asset = find_asset(&core, zone.asset);
  return asset != nullptr && zone.key_low <= zone.key_high && zone.key_high <= 127
    && zone.velocity_low > 0 && zone.velocity_low <= zone.velocity_high && zone.velocity_high <= 127
    && zone.root_note <= 127 && std::isfinite(zone.tune_cents) && zone.tune_cents >= -4800.0F && zone.tune_cents <= 4800.0F
    && std::isfinite(zone.gain) && zone.gain >= 0.0F && zone.gain <= 4.0F
    && std::isfinite(zone.pan) && zone.pan >= -1.0F && zone.pan <= 1.0F
    && zone.playback_mode <= DAW_AUDIO_SAMPLE_PLAYBACK_CROSSFADE_LOOP
    && zone.start_frame < zone.end_frame && zone.end_frame <= asset->frame_count
    && (zone.playback_mode == DAW_AUDIO_SAMPLE_PLAYBACK_ONE_SHOT
      || (zone.loop_start_frame >= zone.start_frame && zone.loop_start_frame < zone.loop_end_frame && zone.loop_end_frame <= zone.end_frame
        && zone.crossfade_frame_count <= (zone.loop_end_frame - zone.loop_start_frame) / 2));
}

bool valid_instrument_descriptor(const daw_audio_graph_node_descriptor &node) {
  const daw_audio_instrument_state_descriptor &instrument = node.instrument;
  if (node.kind != DAW_AUDIO_GRAPH_NODE_INSTRUMENT) {
    return instrument.kind == DAW_AUDIO_INSTRUMENT_KIND_NONE && instrument.version == 0
      && instrument.voice_capacity == 0 && instrument.parameter_count == 0;
  }
  if (node.input_layout != DAW_AUDIO_GRAPH_LAYOUT_STEREO || node.output_layout != DAW_AUDIO_GRAPH_LAYOUT_STEREO
    || node.input_bus != 0
    || instrument.version != 1 || instrument.voice_capacity == 0
    || instrument.voice_capacity > kMaximumInstrumentVoices
    || instrument.parameter_count > DAW_AUDIO_CORE_MAX_INSTRUMENT_PARAMETERS) return false;
  if (instrument.kind == DAW_AUDIO_INSTRUMENT_KIND_SAMPLER || instrument.kind == DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK
    || instrument.kind == DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) {
    return instrument.parameter_count == 0;
  }
  if (instrument.kind != DAW_AUDIO_INSTRUMENT_KIND_SYNTH) return false;
  for (uint32_t index = 0; index < instrument.parameter_count; ++index) {
    const uint32_t target = instrument.parameter_targets[index];
    if (target < DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_GAIN || target > DAW_AUDIO_SYNTH_PARAMETER_AMP_RELEASE_MS) return false;
    for (uint32_t previous = 0; previous < index; ++previous) {
      if (instrument.parameter_targets[previous] == target) return false;
    }
  }
  return true;
}

GraphRevision &configuration_graph(Core &core) {
  return core.prepared_revision != 0 ? (*core.prepared_graph) : (*core.published_graph);
}

std::array<InstrumentNodeState, kMaximumGraphNodes> &configuration_instruments(Core &core) {
  return core.prepared_revision != 0
    ? (*core.prepared_instruments)
    : (*core.published_instruments);
}

bool valid_mixer_state(const daw_audio_mixer_state &mixer) {
  if (mixer.instance_id == 0) {
    return mixer.gain == 0.0F && mixer.pan == 0.0F && mixer.muted == 0 && mixer.soloed == 0;
  }
  return mixer.instance_id != 0 && std::isfinite(mixer.gain) && mixer.gain >= 0.0F && mixer.gain <= 4.0F
    && std::isfinite(mixer.pan) && mixer.pan >= -1.0F && mixer.pan <= 1.0F
    && mixer.muted <= 1 && mixer.soloed <= 1;
}

bool valid_graph_tap(uint32_t tap) {
  return tap == DAW_AUDIO_GRAPH_EDGE_PRE_FX
    || tap == DAW_AUDIO_GRAPH_EDGE_PRE_FADER
    || tap == DAW_AUDIO_GRAPH_EDGE_POST_FADER;
}

struct ProcessorContract {
  uint32_t kind;
  uint32_t schema_version;
  uint32_t state_bytes;
  bool implemented;
};

constexpr std::array<ProcessorContract, DAW_AUDIO_CORE_PROCESSOR_REGISTRY_COUNT> kProcessorContracts{{
  {DAW_AUDIO_PROCESSOR_KIND_UTILITY, DAW_AUDIO_CORE_PROCESSOR_UTILITY_SCHEMA_VERSION, DAW_AUDIO_CORE_PROCESSOR_UTILITY_STATE_BYTES, true},
  {DAW_AUDIO_PROCESSOR_KIND_SATURATOR, DAW_AUDIO_CORE_PROCESSOR_SATURATOR_SCHEMA_VERSION, DAW_AUDIO_CORE_PROCESSOR_SATURATOR_STATE_BYTES, true},
  {DAW_AUDIO_PROCESSOR_KIND_EQ, DAW_AUDIO_CORE_PROCESSOR_EQ_SCHEMA_VERSION, DAW_AUDIO_CORE_PROCESSOR_EQ_STATE_BYTES, true},
  {DAW_AUDIO_PROCESSOR_KIND_CHORUS, DAW_AUDIO_CORE_PROCESSOR_CHORUS_SCHEMA_VERSION, DAW_AUDIO_CORE_PROCESSOR_CHORUS_STATE_BYTES, true},
  {DAW_AUDIO_PROCESSOR_KIND_FLANGER, DAW_AUDIO_CORE_PROCESSOR_FLANGER_SCHEMA_VERSION, DAW_AUDIO_CORE_PROCESSOR_FLANGER_STATE_BYTES, true},
  {DAW_AUDIO_PROCESSOR_KIND_PHASER, DAW_AUDIO_CORE_PROCESSOR_PHASER_SCHEMA_VERSION, DAW_AUDIO_CORE_PROCESSOR_PHASER_STATE_BYTES, true},
  {DAW_AUDIO_PROCESSOR_KIND_TREMOLO, DAW_AUDIO_CORE_PROCESSOR_TREMOLO_SCHEMA_VERSION, DAW_AUDIO_CORE_PROCESSOR_TREMOLO_STATE_BYTES, true},
  {DAW_AUDIO_PROCESSOR_KIND_AUTOPAN, DAW_AUDIO_CORE_PROCESSOR_AUTOPAN_SCHEMA_VERSION, DAW_AUDIO_CORE_PROCESSOR_AUTOPAN_STATE_BYTES, true},
  {DAW_AUDIO_PROCESSOR_KIND_ENSEMBLE, DAW_AUDIO_CORE_PROCESSOR_ENSEMBLE_SCHEMA_VERSION, DAW_AUDIO_CORE_PROCESSOR_ENSEMBLE_STATE_BYTES, true},
  {DAW_AUDIO_PROCESSOR_KIND_GATE, DAW_AUDIO_CORE_PROCESSOR_GATE_SCHEMA_VERSION, DAW_AUDIO_CORE_PROCESSOR_GATE_STATE_BYTES, true},
  {DAW_AUDIO_PROCESSOR_KIND_COMPRESSOR, DAW_AUDIO_CORE_PROCESSOR_COMPRESSOR_SCHEMA_VERSION, DAW_AUDIO_CORE_PROCESSOR_COMPRESSOR_STATE_BYTES, true},
  {DAW_AUDIO_PROCESSOR_KIND_LIMITER, DAW_AUDIO_CORE_PROCESSOR_LIMITER_SCHEMA_VERSION, DAW_AUDIO_CORE_PROCESSOR_LIMITER_STATE_BYTES, true},
  {DAW_AUDIO_PROCESSOR_KIND_DELAY, DAW_AUDIO_CORE_PROCESSOR_DELAY_SCHEMA_VERSION, DAW_AUDIO_CORE_PROCESSOR_DELAY_STATE_BYTES, true},
  {DAW_AUDIO_PROCESSOR_KIND_REVERB, DAW_AUDIO_CORE_PROCESSOR_REVERB_SCHEMA_VERSION, DAW_AUDIO_CORE_PROCESSOR_REVERB_STATE_BYTES, true},
  {DAW_AUDIO_PROCESSOR_KIND_SPECTRAL, DAW_AUDIO_CORE_PROCESSOR_SPECTRAL_SCHEMA_VERSION, DAW_AUDIO_CORE_PROCESSOR_SPECTRAL_STATE_BYTES, true},
  {DAW_AUDIO_PROCESSOR_KIND_AUTOFILTER, DAW_AUDIO_CORE_PROCESSOR_AUTOFILTER_SCHEMA_VERSION, DAW_AUDIO_CORE_PROCESSOR_AUTOFILTER_STATE_BYTES, true},
  {DAW_AUDIO_PROCESSOR_KIND_LOFI, DAW_AUDIO_CORE_PROCESSOR_LOFI_SCHEMA_VERSION, DAW_AUDIO_CORE_PROCESSOR_LOFI_STATE_BYTES, true},
}};

const ProcessorContract *find_processor_contract(uint32_t kind) {
  for (const ProcessorContract &contract : kProcessorContracts) {
    if (contract.kind == kind) return &contract;
  }
  return nullptr;
}

bool decode_processor_state(
  const daw_audio_processor_descriptor &descriptor,
  GraphRevision::Processor *out_processor);

uint32_t read_u32_le(const uint8_t *input) {
  return static_cast<uint32_t>(input[0])
    | (static_cast<uint32_t>(input[1]) << 8u)
    | (static_cast<uint32_t>(input[2]) << 16u)
    | (static_cast<uint32_t>(input[3]) << 24u);
}

float read_f32_le(const uint8_t *input) {
  const uint32_t bits = read_u32_le(input);
  float value = 0.0F;
  static_assert(sizeof(value) == sizeof(bits));
  __builtin_memcpy(&value, &bits, sizeof(value));
  return value;
}

int32_t graph_node_index_linear(const GraphRevision &graph, uint64_t id) {
  for (uint32_t index = 0; index < graph.node_count; ++index) {
    if (graph.nodes[index].id == id) return static_cast<int32_t>(index);
  }
  return -1;
}

int32_t graph_node_index(const GraphRevision &graph, uint64_t id) {
  uint32_t first = 0;
  uint32_t last = graph.node_count;
  while (first < last) {
    const uint32_t middle = first + (last - first) / 2;
    const uint32_t node_index = graph.node_lookup[middle];
    const uint64_t candidate = graph.nodes[node_index].id;
    if (candidate < id) first = middle + 1;
    else last = middle;
  }
  if (first >= graph.node_count) return -1;
  const uint32_t node_index = graph.node_lookup[first];
  return graph.nodes[node_index].id == id ? static_cast<int32_t>(node_index) : -1;
}

bool processor_is_retirable(const GraphRevision &graph, const GraphRevision::Processor &processor) {
  if (processor.kind != DAW_AUDIO_PROCESSOR_KIND_DELAY
    && processor.kind != DAW_AUDIO_PROCESSOR_KIND_REVERB) return false;
  const uint32_t range_index = processor.node_index;
  if (range_index >= graph.node_count) return false;
  const GraphRevision::Range range = graph.processor_ranges[range_index];
  uint32_t final_processor = kMaximumGraphProcessors;
  for (uint32_t position = range.start;
    position < static_cast<uint32_t>(range.start) + range.count;
    ++position) {
    final_processor = graph.processor_indices[position];
  }
  if (final_processor == kMaximumGraphProcessors
    || final_processor != static_cast<uint32_t>(&processor - graph.processors.data())) return false;
  const uint64_t node_id = graph.nodes[range_index].id;
  for (uint32_t edge_index = 0; edge_index < graph.edge_count; ++edge_index) {
    const auto &edge = graph.edges[edge_index];
    if (edge.from_node_id == node_id && edge.sidechain != 0) return false;
  }
  return true;
}

bool allocate_graph_stage_buffers(Core &core);

daw_audio_core_result prepare_graph_revision(
  Core &core,
  const daw_audio_graph_prepare_request &request,
  GraphRevision *out_graph) {
  core.graph_validation_diagnostic = {};
  if (!valid_abi(request.abi_version)) return DAW_AUDIO_CORE_UNSUPPORTED_VERSION;
  if (request.graph_revision == 0 || request.node_count == 0 || request.node_count > kMaximumGraphNodes
    || request.edge_count > kMaximumGraphEdges || request.nodes == nullptr
    || (request.edge_count > 0 && request.edges == nullptr)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (request.processor_count > kMaximumGraphProcessors) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  if (request.processor_count > 0 && request.processors == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  const auto next_graph = std::unique_ptr<GraphRevision>(new (std::nothrow) GraphRevision{});
  if (!next_graph) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  GraphRevision &graph = *next_graph;
  graph.revision = request.graph_revision;
  graph.node_count = request.node_count;
  graph.edge_count = request.edge_count;
  for (uint32_t index = 0; index < graph.node_count; ++index) {
    const daw_audio_graph_node_descriptor node = request.nodes[index];
    if (node.id == 0 || !valid_graph_node_kind(node.kind) || !valid_graph_layout(node.input_layout)
      || !valid_graph_layout(node.output_layout) || !valid_instrument_descriptor(node) || !valid_mixer_state(node.mixer)
      || (node.kind == DAW_AUDIO_GRAPH_NODE_SOURCE
        && node.input_bus != DAW_AUDIO_GRAPH_INPUT_BUS_DISCONNECTED
        && node.input_bus >= core.config.max_channels)) {
      return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
    if (graph_node_index_linear(graph, node.id) >= 0) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    graph.nodes[index] = node;
    if (node.kind == DAW_AUDIO_GRAPH_NODE_MASTER) {
      if (graph.master_index != kMaximumGraphNodes) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
      graph.master_index = index;
    }
  }
  if (graph.master_index == kMaximumGraphNodes) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  for (uint32_t index = 0; index < graph.node_count; ++index) graph.node_lookup[index] = index;
  std::sort(graph.node_lookup.begin(), graph.node_lookup.begin() + graph.node_count, [&graph](uint32_t left, uint32_t right) {
    return graph.nodes[left].id < graph.nodes[right].id;
  });
  std::array<uint32_t, kMaximumGraphNodes> processor_counts{};
  std::array<bool, kMaximumGraphProcessors> history_slots_available{};
  history_slots_available.fill(true);
  std::array<bool, kMaximumDelayProcessors> delay_slots_available{};
  std::array<bool, kMaximumReverbProcessors> reverb_slots_available{};
  std::array<bool, kMaximumSpectralProcessors> spectral_slots_available{};
  delay_slots_available.fill(true);
  reverb_slots_available.fill(true);
  spectral_slots_available.fill(true);
  for (uint32_t current_index = 0; current_index < (*core.published_graph).processor_count; ++current_index) {
    const GraphRevision::Processor &current = (*core.published_graph).processors[current_index];
    bool retained = false;
    for (uint32_t next_index = 0; next_index < request.processor_count; ++next_index) {
      const daw_audio_processor_descriptor &next = request.processors[next_index];
      if (next.instance_id == current.instance_id && next.kind == current.kind) {
        retained = true;
        break;
      }
    }
    if (!retained) {
      if (current.kind == DAW_AUDIO_PROCESSOR_KIND_DELAY && current.delay_slot < kMaximumDelayProcessors) {
        delay_slots_available[current.delay_slot] = !processor_is_retirable(
          *core.published_graph,
          current);
      }
      if (current.kind == DAW_AUDIO_PROCESSOR_KIND_REVERB && current.reverb_slot < kMaximumReverbProcessors) {
        reverb_slots_available[current.reverb_slot] = !processor_is_retirable(
          *core.published_graph,
          current);
      }
      if (current.kind == DAW_AUDIO_PROCESSOR_KIND_SPECTRAL && current.spectral_slot < kMaximumSpectralProcessors) {
        spectral_slots_available[current.spectral_slot] = true;
      }
    } else {
      history_slots_available[current.history_slot] = false;
      if (current.kind == DAW_AUDIO_PROCESSOR_KIND_DELAY && current.delay_slot < kMaximumDelayProcessors) {
        delay_slots_available[current.delay_slot] = false;
      }
      if (current.kind == DAW_AUDIO_PROCESSOR_KIND_REVERB && current.reverb_slot < kMaximumReverbProcessors) {
        reverb_slots_available[current.reverb_slot] = false;
      }
      if (current.kind == DAW_AUDIO_PROCESSOR_KIND_SPECTRAL && current.spectral_slot < kMaximumSpectralProcessors) {
        spectral_slots_available[current.spectral_slot] = false;
      }
    }
  }
  for (const auto &lane : *core.published_retirement_lanes) {
    if (lane.remaining_frames.load(std::memory_order_acquire) == 0) continue;
    if (lane.processor.kind == DAW_AUDIO_PROCESSOR_KIND_DELAY
      && lane.source_delay_slot < kMaximumDelayProcessors) {
      delay_slots_available[lane.source_delay_slot] = false;
    }
    if (lane.processor.kind == DAW_AUDIO_PROCESSOR_KIND_REVERB
      && lane.source_reverb_slot < kMaximumReverbProcessors) {
      reverb_slots_available[lane.source_reverb_slot] = false;
    }
  }
  for (uint32_t index = 0; index < request.processor_count; ++index) {
    const daw_audio_processor_descriptor &descriptor = request.processors[index];
    const int32_t node_index = graph_node_index(graph, descriptor.node_id);
    if (node_index < 0 || descriptor.instance_id == 0
      || descriptor.bypassed > 1 || !valid_graph_layout(descriptor.input_layout)
      || !valid_graph_layout(descriptor.output_layout)) {
      return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
    const ProcessorContract *contract = find_processor_contract(descriptor.kind);
    if (contract == nullptr) return DAW_AUDIO_CORE_PROCESSOR_KIND_UNKNOWN;
    if (descriptor.state_version != contract->schema_version || descriptor.state_size != contract->state_bytes
      || descriptor.state == nullptr) return DAW_AUDIO_CORE_PROCESSOR_STATE_INVALID;
    if (!contract->implemented) return DAW_AUDIO_CORE_PROCESSOR_IMPLEMENTATION_UNAVAILABLE;
    if (processor_counts[static_cast<uint32_t>(node_index)] >= DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE) {
      return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    }
    for (uint32_t existing = 0; existing < index; ++existing) {
      if (graph.processors[existing].instance_id == descriptor.instance_id) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
    GraphRevision::Processor &processor = graph.processors[index];
    processor.node_index = static_cast<uint16_t>(node_index);
    processor.control_slot = index;
    bool history_slot_assigned = false;
    bool delay_slot_assigned = false;
    bool reverb_slot_assigned = false;
    bool spectral_slot_assigned = false;
    for (uint32_t current_index = 0; current_index < (*core.published_graph).processor_count; ++current_index) {
      const GraphRevision::Processor &current = (*core.published_graph).processors[current_index];
      if (current.instance_id != descriptor.instance_id || current.kind != descriptor.kind) continue;
      processor.history_slot = current.history_slot;
      history_slots_available[processor.history_slot] = false;
      history_slot_assigned = true;
      if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_DELAY) {
        processor.delay_slot = current.delay_slot;
        delay_slots_available[processor.delay_slot] = false;
        delay_slot_assigned = true;
      } else if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_REVERB) {
        processor.reverb_slot = current.reverb_slot;
        reverb_slots_available[processor.reverb_slot] = false;
        reverb_slot_assigned = true;
      } else if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_SPECTRAL) {
        processor.spectral_slot = current.spectral_slot;
        spectral_slots_available[processor.spectral_slot] = false;
        spectral_slot_assigned = true;
      }
      break;
    }
    if (!history_slot_assigned) {
      for (uint32_t slot = 0; slot < kMaximumGraphProcessors; ++slot) {
        if (history_slots_available[slot]) {
          processor.history_slot = slot;
          history_slots_available[slot] = false;
          history_slot_assigned = true;
          break;
        }
      }
    }
    if (!history_slot_assigned) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_DELAY) {
      if (!delay_slot_assigned) {
        for (uint32_t slot = 0; slot < kMaximumDelayProcessors; ++slot) {
          if (delay_slots_available[slot]) {
            processor.delay_slot = slot;
            delay_slots_available[slot] = false;
            delay_slot_assigned = true;
            break;
          }
        }
      }
      if (!delay_slot_assigned) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    }
    if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_REVERB) {
      if (!reverb_slot_assigned) {
        for (uint32_t slot = 0; slot < kMaximumReverbProcessors; ++slot) {
          if (reverb_slots_available[slot]) {
            processor.reverb_slot = slot;
            reverb_slots_available[slot] = false;
            reverb_slot_assigned = true;
            break;
          }
        }
      }
      if (!reverb_slot_assigned) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    }
    if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_SPECTRAL) {
      if (!spectral_slot_assigned) {
        for (uint32_t slot = 0; slot < kMaximumSpectralProcessors; ++slot) {
          if (spectral_slots_available[slot]) {
            processor.spectral_slot = slot;
            spectral_slots_available[slot] = false;
            spectral_slot_assigned = true;
            break;
          }
        }
      }
      if (!spectral_slot_assigned) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    }
    processor.node_id = descriptor.node_id;
    processor.instance_id = descriptor.instance_id;
    processor.kind = descriptor.kind;
    processor.state_version = descriptor.state_version;
    processor.bypassed = descriptor.bypassed;
    processor.input_layout = descriptor.input_layout;
    processor.output_layout = descriptor.output_layout;
    processor.latency_frames = descriptor.latency_frames;
    processor.tail_frames = descriptor.tail_frames;
    processor.state_size = descriptor.state_size;
    for (uint32_t byte = 0; byte < descriptor.state_size; ++byte) processor.state[byte] = descriptor.state[byte];
    if (!decode_processor_state(descriptor, &processor)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    processor.parameter_count = descriptor.parameter_count;
    for (uint32_t parameter = 0; parameter < descriptor.parameter_count; ++parameter) {
      processor.parameter_targets[parameter] = descriptor.parameter_targets[parameter];
    }
    std::sort(
      processor.parameter_targets.begin(),
      processor.parameter_targets.begin() + processor.parameter_count);
    ++processor_counts[static_cast<uint32_t>(node_index)];
    ++graph.processor_count;
  }
  for (uint32_t node_index = 0; node_index < graph.node_count; ++node_index) {
    uint64_t chain_latency = 0;
    bool has_chain = false;
    uint32_t previous_layout = graph.nodes[node_index].input_layout;
    for (uint32_t processor_index = 0; processor_index < graph.processor_count; ++processor_index) {
      const GraphRevision::Processor &processor = graph.processors[processor_index];
      if (processor.node_id == graph.nodes[node_index].id) {
        has_chain = true;
        if (processor.input_layout != previous_layout) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
        previous_layout = processor.output_layout;
        chain_latency += processor.latency_frames;
      }
    }
    if (has_chain && (chain_latency != graph.nodes[node_index].latency_frames
      || previous_layout != graph.nodes[node_index].output_layout)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  std::array<uint32_t, kMaximumGraphNodes> incoming{};
  for (uint32_t index = 0; index < graph.edge_count; ++index) {
    const daw_audio_graph_edge_descriptor edge = request.edges[index];
    const int32_t from_index = graph_node_index(graph, edge.from_node_id);
    const int32_t to_index = graph_node_index(graph, edge.to_node_id);
    if (edge.id == 0 || from_index < 0 || to_index < 0 || from_index == to_index
      || !std::isfinite(edge.gain) || !valid_graph_tap(edge.tap) || edge.sidechain > 1) {
      return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
    if ((edge.sidechain == 0 && edge.target_processor_id != 0) || (edge.sidechain != 0 && edge.target_processor_id == 0)) {
      return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
    if (edge.sidechain != 0) {
      const GraphRevision::Processor *target = nullptr;
      for (uint32_t processor_index = 0; processor_index < graph.processor_count; ++processor_index) {
        const GraphRevision::Processor &processor = graph.processors[processor_index];
        if (processor.instance_id == edge.target_processor_id) {
          target = &processor;
          break;
        }
      }
      if (target == nullptr || target->node_id != edge.to_node_id
        || target->input_layout != graph.nodes[static_cast<uint32_t>(to_index)].input_layout) {
        return DAW_AUDIO_CORE_INVALID_ARGUMENT;
      }
    }
    if (edge.pdc_delay_frames > kMaximumFramesPerBlock) {
      core.graph_validation_diagnostic = {
        .code = DAW_AUDIO_CORE_GRAPH_VALIDATION_PDC_DELAY_EXCEEDS_RING_CAPACITY,
        .index = index,
        .actual = edge.pdc_delay_frames,
        .limit = kMaximumFramesPerBlock,
      };
      return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    }
    for (uint32_t existing = 0; existing < index; ++existing) {
      if (graph.edges[existing].id == edge.id) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
    graph.edges[index] = edge;
    graph.edge_source_indices[index] = static_cast<uint16_t>(from_index);
    graph.edge_target_indices[index] = static_cast<uint16_t>(to_index);
    if (edge.sidechain == 0) ++incoming[static_cast<uint32_t>(to_index)];
  }
  std::array<uint32_t, kMaximumGraphNodes> remaining = incoming;
  uint32_t order_count = 0;
  while (order_count < graph.node_count) {
    uint32_t next = kMaximumGraphNodes;
    for (uint32_t index = 0; index < graph.node_count; ++index) {
      bool already_ordered = false;
      for (uint32_t ordered = 0; ordered < order_count; ++ordered) {
        if (graph.process_order[ordered] == index) {
          already_ordered = true;
          break;
        }
      }
      if (!already_ordered && remaining[index] == 0) {
        next = index;
        break;
      }
    }
    if (next == kMaximumGraphNodes) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    graph.process_order[order_count++] = next;
    for (uint32_t edge_index = 0; edge_index < graph.edge_count; ++edge_index) {
      const daw_audio_graph_edge_descriptor &edge = graph.edges[edge_index];
      if (edge.sidechain == 0 && edge.from_node_id == graph.nodes[next].id) {
        const uint32_t target = graph.edge_target_indices[edge_index];
        if (remaining[target] == 0) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
        --remaining[target];
      }
    }
  }
  for (uint32_t edge_index = 0; edge_index < graph.edge_count; ++edge_index) {
    const daw_audio_graph_edge_descriptor &edge = graph.edges[edge_index];
    if (edge.sidechain == 0) continue;
    uint32_t source_order = graph.node_count;
    uint32_t target_order = graph.node_count;
    for (uint32_t order = 0; order < graph.node_count; ++order) {
      if (graph.nodes[graph.process_order[order]].id == edge.from_node_id) source_order = order;
      if (graph.nodes[graph.process_order[order]].id == edge.to_node_id) target_order = order;
    }
    if (source_order >= target_order) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  std::array<uint32_t, kMaximumGraphNodes> path_latency{};
  const auto effective_node_latency = [&graph](const uint32_t node_index) -> uint32_t {
    const auto &node = graph.nodes[node_index];
    if (node.external_latency_frames > std::numeric_limits<uint32_t>::max() - node.latency_frames) {
      return std::numeric_limits<uint32_t>::max();
    }
    return node.latency_frames + node.external_latency_frames;
  };
  for (uint32_t ordered = 0; ordered < graph.node_count; ++ordered) {
    const uint32_t node_index = graph.process_order[ordered];
    uint32_t upstream_latency = 0;
    for (uint32_t edge_index = 0; edge_index < graph.edge_count; ++edge_index) {
      const daw_audio_graph_edge_descriptor &edge = graph.edges[edge_index];
      if (edge.sidechain != 0 || edge.to_node_id != graph.nodes[node_index].id) continue;
      const uint32_t source_index = graph.edge_source_indices[edge_index];
      uint32_t arrival = path_latency[source_index];
      if (edge.tap == DAW_AUDIO_GRAPH_EDGE_PRE_FX) {
        const uint32_t source_latency = effective_node_latency(source_index);
        if (arrival < source_latency) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
        arrival -= source_latency;
      }
      if (arrival > upstream_latency) upstream_latency = arrival;
    }
    const uint32_t node_latency = effective_node_latency(node_index);
    if (node_latency > std::numeric_limits<uint32_t>::max() - upstream_latency) {
      return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    }
    path_latency[node_index] = upstream_latency + node_latency;
    for (uint32_t edge_index = 0; edge_index < graph.edge_count; ++edge_index) {
      const daw_audio_graph_edge_descriptor &edge = graph.edges[edge_index];
      if (edge.sidechain != 0 || edge.to_node_id != graph.nodes[node_index].id) continue;
      const uint32_t source_index = graph.edge_source_indices[edge_index];
      uint32_t arrival = path_latency[source_index];
      if (edge.tap == DAW_AUDIO_GRAPH_EDGE_PRE_FX) arrival -= effective_node_latency(source_index);
      if (edge.pdc_delay_frames != upstream_latency - arrival) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
  }
  uint16_t incoming_edge_count = 0;
  uint16_t processor_index_count = 0;
  for (uint32_t node_index = 0; node_index < graph.node_count; ++node_index) {
    GraphRevision::Range &edge_range = graph.incoming_edge_ranges[node_index];
    edge_range.start = incoming_edge_count;
    for (uint32_t edge_index = 0; edge_index < graph.edge_count; ++edge_index) {
      if (graph.edges[edge_index].sidechain == 0 && graph.edge_target_indices[edge_index] == node_index) {
        graph.incoming_edge_indices[incoming_edge_count++] = static_cast<uint16_t>(edge_index);
        ++edge_range.count;
      }
    }
    GraphRevision::Range &processor_range = graph.processor_ranges[node_index];
    processor_range.start = processor_index_count;
    for (uint32_t processor_index = 0; processor_index < graph.processor_count; ++processor_index) {
      if (graph.processors[processor_index].node_index == node_index) {
        graph.processor_indices[processor_index_count++] = static_cast<uint16_t>(processor_index);
        ++processor_range.count;
      }
    }
  }
  uint16_t sidechain_edge_count = 0;
  for (uint32_t processor_index = 0; processor_index < graph.processor_count; ++processor_index) {
    GraphRevision::Range &sidechain_range = graph.sidechain_edge_ranges[processor_index];
    sidechain_range.start = sidechain_edge_count;
    for (uint32_t edge_index = 0; edge_index < graph.edge_count; ++edge_index) {
      if (graph.edges[edge_index].sidechain != 0
        && graph.edges[edge_index].target_processor_id == graph.processors[processor_index].instance_id) {
        graph.sidechain_edge_indices[sidechain_edge_count++] = static_cast<uint16_t>(edge_index);
        ++sidechain_range.count;
      }
    }
  }
  if (!allocate_graph_stage_buffers(core)) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  *out_graph = graph;
  return DAW_AUDIO_CORE_OK;
}

bool has_pdc_change(const GraphRevision &current, const GraphRevision &next) {
  if (current.revision == 0) return false;
  for (uint32_t next_index = 0; next_index < next.edge_count; ++next_index) {
    const daw_audio_graph_edge_descriptor &next_edge = next.edges[next_index];
    for (uint32_t current_index = 0; current_index < current.edge_count; ++current_index) {
      const daw_audio_graph_edge_descriptor &current_edge = current.edges[current_index];
      if (current_edge.id == next_edge.id && current_edge.pdc_delay_frames != next_edge.pdc_delay_frames) return true;
    }
  }
  return false;
}

bool valid_utility_state(const daw_audio_utility_state &state) {
  return (state.enabled == 0 || state.enabled == 1)
    && std::isfinite(state.gain_db)
    && state.gain_db >= DAW_AUDIO_CORE_UTILITY_GAIN_DB_MIN
    && state.gain_db <= DAW_AUDIO_CORE_UTILITY_GAIN_DB_MAX
    && (state.polarity == DAW_AUDIO_UTILITY_POLARITY_NORMAL || state.polarity == DAW_AUDIO_UTILITY_POLARITY_INVERT)
    && (state.input_mode == DAW_AUDIO_UTILITY_INPUT_MODE_STEREO || state.input_mode == DAW_AUDIO_UTILITY_INPUT_MODE_MONO_SUM)
    && std::isfinite(state.pan)
    && state.pan >= DAW_AUDIO_CORE_UTILITY_PAN_MIN
    && state.pan <= DAW_AUDIO_CORE_UTILITY_PAN_MAX
    && std::isfinite(state.balance)
    && state.balance >= DAW_AUDIO_CORE_UTILITY_BALANCE_MIN
    && state.balance <= DAW_AUDIO_CORE_UTILITY_BALANCE_MAX
    && std::isfinite(state.width)
    && state.width >= DAW_AUDIO_CORE_UTILITY_WIDTH_MIN
    && state.width <= DAW_AUDIO_CORE_UTILITY_WIDTH_MAX
    && (state.matrix == DAW_AUDIO_UTILITY_MATRIX_STEREO
      || state.matrix == DAW_AUDIO_UTILITY_MATRIX_MID_SIDE_ENCODE
      || state.matrix == DAW_AUDIO_UTILITY_MATRIX_MID_SIDE_DECODE)
    && (state.swap == 0 || state.swap == 1)
    && (state.dc_block == 0 || state.dc_block == 1);
}

bool valid_saturator_state(const daw_audio_saturator_state &state) {
  return (state.enabled == 0 || state.enabled == 1)
    && std::isfinite(state.drive_db) && state.drive_db >= 0.0F && state.drive_db <= 36.0F
    && state.curve <= DAW_AUDIO_SATURATOR_CURVE_CLIP
    && (state.color == 0 || state.color == 1)
    && std::isfinite(state.color_frequency_hz) && state.color_frequency_hz >= 100.0F && state.color_frequency_hz <= 10000.0F
    && std::isfinite(state.color_amount) && state.color_amount >= 0.0F && state.color_amount <= 1.0F
    && std::isfinite(state.output_db) && state.output_db >= -24.0F && state.output_db <= 12.0F
    && std::isfinite(state.dry_wet) && state.dry_wet >= 0.0F && state.dry_wet <= 1.0F;
}

bool valid_eq_band(const daw_audio_eq_band_state &band) {
  return (band.enabled == 0 || band.enabled == 1)
    && band.type <= DAW_AUDIO_EQ_BAND_ALLPASS
    && std::isfinite(band.frequency_hz) && band.frequency_hz >= 20.0F && band.frequency_hz <= 20000.0F
    && std::isfinite(band.gain_db) && band.gain_db >= -24.0F && band.gain_db <= 24.0F
    && std::isfinite(band.q) && band.q >= 0.2F && band.q <= 18.0F;
}

bool valid_eq_state(const daw_audio_eq_state &state) {
  if ((state.enabled != 0 && state.enabled != 1) || state.mono > 1) return false;
  for (const daw_audio_eq_band_state &band : state.bands) {
    if (!valid_eq_band(band)) return false;
  }
  return true;
}

bool valid_delay_modulation_state(const daw_audio_delay_modulation_state &state, bool chorus) {
  return (state.enabled == 0 || state.enabled == 1)
    && std::isfinite(state.delay_ms) && state.delay_ms >= (chorus ? 5.0F : 0.1F) && state.delay_ms <= (chorus ? 30.0F : 10.0F)
    && std::isfinite(state.depth_ms) && state.depth_ms >= 0.0F && state.depth_ms <= (chorus ? 10.0F : 5.0F)
    && std::isfinite(state.rate_hz) && state.rate_hz >= 0.01F && state.rate_hz <= 20.0F
    && std::isfinite(state.feedback) && state.feedback >= (chorus ? 0.0F : -0.95F) && state.feedback <= (chorus ? 0.5F : 0.95F)
    && std::isfinite(state.stereo_phase) && state.stereo_phase >= -0.5F && state.stereo_phase <= 0.5F
    && std::isfinite(state.mix) && state.mix >= 0.0F && state.mix <= 1.0F;
}

bool valid_phaser_state(const daw_audio_phaser_state &state) {
  return (state.enabled == 0 || state.enabled == 1)
    && (state.stages == 4 || state.stages == 6 || state.stages == 8 || state.stages == 12)
    && std::isfinite(state.center_hz) && state.center_hz >= 100.0F && state.center_hz <= 8000.0F
    && std::isfinite(state.depth_octaves) && state.depth_octaves >= 0.0F && state.depth_octaves <= 5.0F
    && std::isfinite(state.rate_hz) && state.rate_hz >= 0.01F && state.rate_hz <= 20.0F
    && std::isfinite(state.feedback) && state.feedback >= -0.95F && state.feedback <= 0.95F
    && std::isfinite(state.stereo_phase) && state.stereo_phase >= -0.5F && state.stereo_phase <= 0.5F
    && std::isfinite(state.mix) && state.mix >= 0.0F && state.mix <= 1.0F;
}

bool valid_amplitude_modulation_state(const daw_audio_amplitude_modulation_state &state) {
  return (state.enabled == 0 || state.enabled == 1) && state.waveform <= 1
    && std::isfinite(state.rate_hz) && state.rate_hz >= 0.01F && state.rate_hz <= 20.0F
    && std::isfinite(state.depth) && state.depth >= 0.0F && state.depth <= 1.0F
    && std::isfinite(state.shape) && state.shape >= 0.0F && state.shape <= 1.0F
    && std::isfinite(state.phase) && state.phase >= 0.0F && state.phase <= 1.0F;
}

bool valid_ensemble_state(const daw_audio_ensemble_state &state) {
  return (state.enabled == 0 || state.enabled == 1) && state.voices == 3
    && std::isfinite(state.delay_ms) && state.delay_ms >= 10.0F && state.delay_ms <= 30.0F
    && std::isfinite(state.depth_ms) && state.depth_ms >= 1.0F && state.depth_ms <= 12.0F
    && std::isfinite(state.rate_hz) && state.rate_hz >= 0.05F && state.rate_hz <= 5.0F
    && std::isfinite(state.spread) && state.spread >= 0.0F && state.spread <= 1.0F
    && std::isfinite(state.mix) && state.mix >= 0.0F && state.mix <= 1.0F;
}

bool valid_gate_state(const daw_audio_gate_state &state) {
  return state.enabled <= 1 && state.mode <= 1
    && std::isfinite(state.threshold_db) && state.threshold_db >= -80.0F && state.threshold_db <= 0.0F
    && std::isfinite(state.ratio) && state.ratio >= 1.0F && state.ratio <= 20.0F
    && std::isfinite(state.attack_ms) && state.attack_ms >= 0.1F && state.attack_ms <= 100.0F
    && std::isfinite(state.hold_ms) && state.hold_ms >= 0.0F && state.hold_ms <= 500.0F
    && std::isfinite(state.release_ms) && state.release_ms >= 5.0F && state.release_ms <= 2000.0F
    && std::isfinite(state.hysteresis_db) && state.hysteresis_db >= 0.0F && state.hysteresis_db <= 24.0F
    && std::isfinite(state.range_db) && state.range_db >= -80.0F && state.range_db <= 0.0F
    && std::isfinite(state.lookahead_ms) && state.lookahead_ms >= 0.0F && state.lookahead_ms <= 2.0F
    && state.detector <= 1 && std::isfinite(state.link) && state.link >= 0.0F && state.link <= 1.0F
    && state.sidechain_enabled <= 1 && std::isfinite(state.sidechain_frequency_hz)
    && state.sidechain_frequency_hz >= 20.0F && state.sidechain_frequency_hz <= 20000.0F
    && std::isfinite(state.sidechain_q) && state.sidechain_q >= 0.1F && state.sidechain_q <= 18.0F;
}

bool valid_compressor_state(const daw_audio_compressor_state &state) {
  return state.enabled <= 1 && std::isfinite(state.threshold_db) && state.threshold_db >= -60.0F && state.threshold_db <= 0.0F
    && std::isfinite(state.ratio) && state.ratio >= 1.0F && state.ratio <= 100.0F
    && std::isfinite(state.attack_ms) && state.attack_ms >= 0.1F && state.attack_ms <= 100.0F
    && std::isfinite(state.release_ms) && state.release_ms >= 5.0F && state.release_ms <= 1000.0F
    && state.auto_release <= 1 && std::isfinite(state.makeup_db) && state.makeup_db >= -36.0F && state.makeup_db <= 36.0F
    && std::isfinite(state.output_db) && state.output_db >= -36.0F && state.output_db <= 36.0F
    && std::isfinite(state.dry_wet) && state.dry_wet >= 0.0F && state.dry_wet <= 1.0F
    && std::isfinite(state.knee_db) && state.knee_db >= 0.0F && state.knee_db <= 24.0F
    && std::isfinite(state.lookahead_ms) && state.lookahead_ms >= 0.0F && state.lookahead_ms <= 10.0F
    && state.detector_mode <= 1 && state.dynamics_mode <= 1 && state.envelope_curve <= 1 && state.sidechain_enabled <= 1
    && state.sidechain_filter_type <= 2 && std::isfinite(state.sidechain_frequency_hz)
    && state.sidechain_frequency_hz >= 20.0F && state.sidechain_frequency_hz <= 20000.0F
    && std::isfinite(state.sidechain_q) && state.sidechain_q >= 0.1F && state.sidechain_q <= 18.0F;
}

bool valid_limiter_state(const daw_audio_limiter_state &state) {
  return state.enabled <= 1 && std::isfinite(state.ceiling_dbtp) && state.ceiling_dbtp >= -12.0F && state.ceiling_dbtp <= 0.0F
    && std::isfinite(state.release_ms) && state.release_ms >= 20.0F && state.release_ms <= 1000.0F
    && std::isfinite(state.lookahead_ms) && state.lookahead_ms >= 1.0F && state.lookahead_ms <= 5.0F
    && std::isfinite(state.link) && state.link >= 0.0F && state.link <= 1.0F && state.detector_oversampling == 4;
}

bool valid_delay_state(const daw_audio_delay_state &state) {
  return state.enabled <= 1 && std::isfinite(state.delay_ms) && state.delay_ms >= DAW_AUDIO_CORE_DELAY_TIME_MS_MIN && state.delay_ms <= DAW_AUDIO_CORE_DELAY_TIME_MS_MAX
    && std::isfinite(state.feedback) && state.feedback >= 0.0F && state.feedback <= 0.95F
    && std::isfinite(state.dry_wet) && state.dry_wet >= 0.0F && state.dry_wet <= 1.0F
    && state.ping_pong <= 1 && state.filter_enabled <= 1
    && std::isfinite(state.low_cut_hz) && state.low_cut_hz >= 20.0F && state.low_cut_hz <= 2000.0F
    && std::isfinite(state.high_cut_hz) && state.high_cut_hz >= 1000.0F && state.high_cut_hz <= 20000.0F
    && state.high_cut_hz >= state.low_cut_hz;
}

bool valid_reverb_state(const daw_audio_reverb_state &state) {
  return state.enabled <= 1 && std::isfinite(state.wet) && state.wet >= 0.0F && state.wet <= 1.0F
    && std::isfinite(state.decay_sec) && state.decay_sec >= 0.05F && state.decay_sec <= 12.0F
    && std::isfinite(state.pre_delay_ms) && state.pre_delay_ms >= 0.0F && state.pre_delay_ms <= 250.0F
    && std::isfinite(state.reflections) && state.reflections >= 0.0F && state.reflections <= 1.0F
    && state.reflection_spin <= 1 && std::isfinite(state.reflection_mod_amount_ms)
    && state.reflection_mod_amount_ms >= 0.0F && state.reflection_mod_amount_ms <= 25.0F
    && std::isfinite(state.reflection_mod_rate_hz) && state.reflection_mod_rate_hz >= 0.01F && state.reflection_mod_rate_hz <= 5.0F
    && std::isfinite(state.reflection_shape) && state.reflection_shape >= 0.0F && state.reflection_shape <= 1.0F
    && std::isfinite(state.diffuse) && state.diffuse >= 0.0F && state.diffuse <= 1.0F
    && std::isfinite(state.size) && state.size >= 0.0F && state.size <= 1.0F
    && std::isfinite(state.diffusion) && state.diffusion >= 0.0F && state.diffusion <= 1.0F
    && std::isfinite(state.density) && state.density >= 0.0F && state.density <= 1.0F
    && std::isfinite(state.low_cut_hz) && state.low_cut_hz >= 20.0F && state.low_cut_hz <= 1200.0F
    && std::isfinite(state.high_cut_hz) && state.high_cut_hz >= 1200.0F && state.high_cut_hz <= 20000.0F
    && std::isfinite(state.diffusion_low_cut_hz) && state.diffusion_low_cut_hz >= 20.0F && state.diffusion_low_cut_hz <= 1200.0F
    && std::isfinite(state.diffusion_high_cut_hz) && state.diffusion_high_cut_hz >= 1200.0F && state.diffusion_high_cut_hz <= 20000.0F
    && std::isfinite(state.stereo_width) && state.stereo_width >= 0.0F && state.stereo_width <= 2.0F;
}

bool valid_spectral_state(const daw_audio_spectral_state &state) {
  return state.enabled <= 1
    && (state.fft_size == 512 || state.fft_size == 1024 || state.fft_size == 2048 || state.fft_size == 4096)
    && (state.overlap == 2 || state.overlap == 4)
    && state.mode <= DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE
    && std::isfinite(state.freeze) && state.freeze >= 0.0F && state.freeze <= 1.0F
    && std::isfinite(state.gate_threshold_db) && state.gate_threshold_db >= -120.0F && state.gate_threshold_db <= 0.0F
    && std::isfinite(state.gate_attack_ms) && state.gate_attack_ms >= 0.1F && state.gate_attack_ms <= 1000.0F
    && std::isfinite(state.gate_release_ms) && state.gate_release_ms >= 1.0F && state.gate_release_ms <= 5000.0F
    && std::isfinite(state.morph) && state.morph >= 0.0F && state.morph <= 1.0F
    && std::isfinite(state.bin_shift) && state.bin_shift >= -2048.0F && state.bin_shift <= 2048.0F
    && std::isfinite(state.blur) && state.blur >= 0.0F && state.blur <= 1.0F
    && std::isfinite(state.harmonic_percussive_balance) && state.harmonic_percussive_balance >= -1.0F && state.harmonic_percussive_balance <= 1.0F
    && std::isfinite(state.noise_reduction) && state.noise_reduction >= 0.0F && state.noise_reduction <= 1.0F
    && std::isfinite(state.profile_learn) && state.profile_learn >= 0.0F && state.profile_learn <= 1.0F
    && std::isfinite(state.mix) && state.mix >= 0.0F && state.mix <= 1.0F;
}

bool valid_autofilter_state(const daw_audio_autofilter_state &state) {
  return state.enabled <= 1 && state.mode <= DAW_AUDIO_AUTOFILTER_MODE_PEAK && state.quality == 0
    && std::isfinite(state.frequency_hz) && state.frequency_hz >= 20.0F && state.frequency_hz <= 20000.0F
    && std::isfinite(state.resonance) && state.resonance >= 0.0F && state.resonance <= 1.0F
    && std::isfinite(state.drive_db) && state.drive_db >= 0.0F && state.drive_db <= 24.0F
    && std::isfinite(state.mix) && state.mix >= 0.0F && state.mix <= 1.0F
    && std::isfinite(state.envelope_amount_octaves) && state.envelope_amount_octaves >= -6.0F && state.envelope_amount_octaves <= 6.0F
    && std::isfinite(state.envelope_attack_ms) && state.envelope_attack_ms >= 0.5F && state.envelope_attack_ms <= 500.0F
    && std::isfinite(state.envelope_release_ms) && state.envelope_release_ms >= 5.0F && state.envelope_release_ms <= 2000.0F
    && state.lfo_waveform <= 1 && std::isfinite(state.lfo_rate_hz) && state.lfo_rate_hz >= 0.01F && state.lfo_rate_hz <= 20.0F
    && std::isfinite(state.lfo_depth_octaves) && state.lfo_depth_octaves >= 0.0F && state.lfo_depth_octaves <= 6.0F
    && std::isfinite(state.lfo_phase_offset) && state.lfo_phase_offset >= 0.0F && state.lfo_phase_offset <= 1.0F
    && std::isfinite(state.lfo_stereo_phase) && state.lfo_stereo_phase >= -0.5F && state.lfo_stereo_phase <= 0.5F;
}

bool valid_lofi_state(const daw_audio_lofi_state &state) {
  return state.enabled <= 1
    && state.bit_depth >= 2 && state.bit_depth <= 24
    && std::isfinite(state.sample_rate_ratio) && state.sample_rate_ratio >= 0.01F && state.sample_rate_ratio <= 1.0F
    && std::isfinite(state.jitter) && state.jitter >= 0.0F && state.jitter <= 1.0F
    && std::isfinite(state.noise_db) && state.noise_db >= -120.0F && state.noise_db <= -24.0F
    && state.quantization <= DAW_AUDIO_LOFI_QUANTIZATION_TRUNCATE
    && state.dither <= DAW_AUDIO_LOFI_DITHER_TRIANGULAR
    && std::isfinite(state.mix) && state.mix >= 0.0F && state.mix <= 1.0F
    && state.seed != 0;
}

bool decode_processor_state(
  const daw_audio_processor_descriptor &descriptor,
  GraphRevision::Processor *out_processor) {
  if (descriptor.state_version != DAW_AUDIO_CORE_PROCESSOR_CONTRACT_VERSION
    || descriptor.state == nullptr
    || !valid_processor_parameter_targets(descriptor)) return false;
  if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_UTILITY && descriptor.state_size == 40) {
    const daw_audio_utility_state state{
      .enabled = read_u32_le(descriptor.state), .gain_db = read_f32_le(descriptor.state + 4),
      .polarity = read_u32_le(descriptor.state + 8), .input_mode = read_u32_le(descriptor.state + 12),
      .pan = read_f32_le(descriptor.state + 16), .balance = read_f32_le(descriptor.state + 20),
      .width = read_f32_le(descriptor.state + 24), .matrix = read_u32_le(descriptor.state + 28),
      .swap = read_u32_le(descriptor.state + 32), .dc_block = read_u32_le(descriptor.state + 36),
    };
    if (!valid_utility_state(state)) return false;
    out_processor->utility = state;
    return true;
  }
  if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_SATURATOR && descriptor.state_size == 32) {
    const daw_audio_saturator_state state{
      .enabled = read_u32_le(descriptor.state), .drive_db = read_f32_le(descriptor.state + 4),
      .curve = read_u32_le(descriptor.state + 8), .color = read_u32_le(descriptor.state + 12),
      .color_frequency_hz = read_f32_le(descriptor.state + 16), .color_amount = read_f32_le(descriptor.state + 20),
      .output_db = read_f32_le(descriptor.state + 24), .dry_wet = read_f32_le(descriptor.state + 28),
    };
    if (!valid_saturator_state(state) || descriptor.latency_frames != 0
      || descriptor.tail_frames != 0) return false;
    out_processor->saturator = state;
    return true;
  }
  if ((descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_CHORUS || descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_FLANGER) && descriptor.state_size == 28) {
    const daw_audio_delay_modulation_state state{
      .enabled = read_u32_le(descriptor.state), .delay_ms = read_f32_le(descriptor.state + 4),
      .depth_ms = read_f32_le(descriptor.state + 8), .rate_hz = read_f32_le(descriptor.state + 12),
      .feedback = read_f32_le(descriptor.state + 16), .stereo_phase = read_f32_le(descriptor.state + 20), .mix = read_f32_le(descriptor.state + 24),
    };
    if (!valid_delay_modulation_state(state, descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_CHORUS)) return false;
    out_processor->delay_modulation = state;
    return true;
  }
  if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_PHASER && descriptor.state_size == 32) {
    const daw_audio_phaser_state state{
      .enabled = read_u32_le(descriptor.state), .stages = read_u32_le(descriptor.state + 4),
      .center_hz = read_f32_le(descriptor.state + 8), .depth_octaves = read_f32_le(descriptor.state + 12),
      .rate_hz = read_f32_le(descriptor.state + 16), .feedback = read_f32_le(descriptor.state + 20),
      .stereo_phase = read_f32_le(descriptor.state + 24), .mix = read_f32_le(descriptor.state + 28),
    };
    if (!valid_phaser_state(state)) return false;
    out_processor->phaser = state;
    return true;
  }
  if ((descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_TREMOLO || descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_AUTOPAN) && descriptor.state_size == 24) {
    const daw_audio_amplitude_modulation_state state{
      .enabled = read_u32_le(descriptor.state), .waveform = read_u32_le(descriptor.state + 4),
      .rate_hz = read_f32_le(descriptor.state + 8), .depth = read_f32_le(descriptor.state + 12),
      .shape = read_f32_le(descriptor.state + 16), .phase = read_f32_le(descriptor.state + 20),
    };
    if (!valid_amplitude_modulation_state(state)) return false;
    out_processor->amplitude_modulation = state;
    return true;
  }
  if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_ENSEMBLE && descriptor.state_size == 28) {
    const daw_audio_ensemble_state state{
      .enabled = read_u32_le(descriptor.state), .voices = read_u32_le(descriptor.state + 4),
      .delay_ms = read_f32_le(descriptor.state + 8), .depth_ms = read_f32_le(descriptor.state + 12),
      .rate_hz = read_f32_le(descriptor.state + 16), .spread = read_f32_le(descriptor.state + 20), .mix = read_f32_le(descriptor.state + 24),
    };
    if (!valid_ensemble_state(state)) return false;
    out_processor->ensemble = state;
    return true;
  }
  if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_GATE && descriptor.state_size == 60) {
    const daw_audio_gate_state state{
      .enabled = read_u32_le(descriptor.state), .mode = read_u32_le(descriptor.state + 4),
      .threshold_db = read_f32_le(descriptor.state + 8), .ratio = read_f32_le(descriptor.state + 12),
      .attack_ms = read_f32_le(descriptor.state + 16), .hold_ms = read_f32_le(descriptor.state + 20),
      .release_ms = read_f32_le(descriptor.state + 24), .hysteresis_db = read_f32_le(descriptor.state + 28),
      .range_db = read_f32_le(descriptor.state + 32), .lookahead_ms = read_f32_le(descriptor.state + 36),
      .detector = read_u32_le(descriptor.state + 40), .link = read_f32_le(descriptor.state + 44),
      .sidechain_enabled = read_u32_le(descriptor.state + 48), .sidechain_frequency_hz = read_f32_le(descriptor.state + 52),
      .sidechain_q = read_f32_le(descriptor.state + 56),
    };
    if (!valid_gate_state(state)) return false;
    out_processor->gate = state;
    return true;
  }
  if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_COMPRESSOR && descriptor.state_size == 72) {
    const daw_audio_compressor_state state{
      .enabled = read_u32_le(descriptor.state), .threshold_db = read_f32_le(descriptor.state + 4),
      .ratio = read_f32_le(descriptor.state + 8), .attack_ms = read_f32_le(descriptor.state + 12),
      .release_ms = read_f32_le(descriptor.state + 16), .auto_release = read_u32_le(descriptor.state + 20),
      .makeup_db = read_f32_le(descriptor.state + 24), .output_db = read_f32_le(descriptor.state + 28),
      .dry_wet = read_f32_le(descriptor.state + 32), .knee_db = read_f32_le(descriptor.state + 36),
      .lookahead_ms = read_f32_le(descriptor.state + 40), .detector_mode = read_u32_le(descriptor.state + 44),
      .dynamics_mode = read_u32_le(descriptor.state + 48), .envelope_curve = read_u32_le(descriptor.state + 52),
      .sidechain_enabled = read_u32_le(descriptor.state + 56), .sidechain_filter_type = read_u32_le(descriptor.state + 60),
      .sidechain_frequency_hz = read_f32_le(descriptor.state + 64), .sidechain_q = read_f32_le(descriptor.state + 68),
    };
    if (!valid_compressor_state(state)) return false;
    out_processor->compressor = state;
    return true;
  }
  if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_LIMITER && descriptor.state_size == 24) {
    const daw_audio_limiter_state state{
      .enabled = read_u32_le(descriptor.state), .ceiling_dbtp = read_f32_le(descriptor.state + 4),
      .release_ms = read_f32_le(descriptor.state + 8), .lookahead_ms = read_f32_le(descriptor.state + 12),
      .link = read_f32_le(descriptor.state + 16), .detector_oversampling = read_u32_le(descriptor.state + 20),
    };
    if (!valid_limiter_state(state)) return false;
    out_processor->limiter = state;
    return true;
  }
  if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_DELAY && descriptor.state_size == 32) {
    const daw_audio_delay_state state{
      .enabled = read_u32_le(descriptor.state), .delay_ms = read_f32_le(descriptor.state + 4),
      .feedback = read_f32_le(descriptor.state + 8), .dry_wet = read_f32_le(descriptor.state + 12),
      .ping_pong = read_u32_le(descriptor.state + 16), .filter_enabled = read_u32_le(descriptor.state + 20),
      .low_cut_hz = read_f32_le(descriptor.state + 24), .high_cut_hz = read_f32_le(descriptor.state + 28),
    };
    if (!valid_delay_state(state)) return false;
    out_processor->delay = state;
    return true;
  }
  if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_REVERB && descriptor.state_size == 72) {
    const daw_audio_reverb_state state{
      .enabled = read_u32_le(descriptor.state), .wet = read_f32_le(descriptor.state + 4),
      .decay_sec = read_f32_le(descriptor.state + 8), .pre_delay_ms = read_f32_le(descriptor.state + 12),
      .reflections = read_f32_le(descriptor.state + 16), .reflection_spin = read_u32_le(descriptor.state + 20),
      .reflection_mod_amount_ms = read_f32_le(descriptor.state + 24), .reflection_mod_rate_hz = read_f32_le(descriptor.state + 28),
      .reflection_shape = read_f32_le(descriptor.state + 32), .diffuse = read_f32_le(descriptor.state + 36),
      .size = read_f32_le(descriptor.state + 40), .diffusion = read_f32_le(descriptor.state + 44),
      .density = read_f32_le(descriptor.state + 48), .low_cut_hz = read_f32_le(descriptor.state + 52),
      .high_cut_hz = read_f32_le(descriptor.state + 56), .diffusion_low_cut_hz = read_f32_le(descriptor.state + 60),
      .diffusion_high_cut_hz = read_f32_le(descriptor.state + 64), .stereo_width = read_f32_le(descriptor.state + 68),
    };
    if (!valid_reverb_state(state)) return false;
    out_processor->reverb = state;
    return true;
  }
  if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_SPECTRAL && descriptor.state_size == 60) {
    const daw_audio_spectral_state state{
      .enabled = read_u32_le(descriptor.state), .fft_size = read_u32_le(descriptor.state + 4),
      .overlap = read_u32_le(descriptor.state + 8), .mode = read_u32_le(descriptor.state + 12),
      .freeze = read_f32_le(descriptor.state + 16), .gate_threshold_db = read_f32_le(descriptor.state + 20),
      .gate_attack_ms = read_f32_le(descriptor.state + 24), .gate_release_ms = read_f32_le(descriptor.state + 28),
      .morph = read_f32_le(descriptor.state + 32), .bin_shift = read_f32_le(descriptor.state + 36),
      .blur = read_f32_le(descriptor.state + 40), .harmonic_percussive_balance = read_f32_le(descriptor.state + 44),
      .noise_reduction = read_f32_le(descriptor.state + 48), .profile_learn = read_f32_le(descriptor.state + 52),
      .mix = read_f32_le(descriptor.state + 56),
    };
    if (!valid_spectral_state(state) || descriptor.latency_frames != state.fft_size || descriptor.tail_frames != 0) return false;
    out_processor->spectral = state;
    return true;
  }
  if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_AUTOFILTER && descriptor.state_size == 60) {
    const daw_audio_autofilter_state state{
      .enabled = read_u32_le(descriptor.state), .mode = read_u32_le(descriptor.state + 4),
      .quality = read_u32_le(descriptor.state + 8), .frequency_hz = read_f32_le(descriptor.state + 12),
      .resonance = read_f32_le(descriptor.state + 16), .drive_db = read_f32_le(descriptor.state + 20),
      .mix = read_f32_le(descriptor.state + 24), .envelope_amount_octaves = read_f32_le(descriptor.state + 28),
      .envelope_attack_ms = read_f32_le(descriptor.state + 32), .envelope_release_ms = read_f32_le(descriptor.state + 36),
      .lfo_waveform = read_u32_le(descriptor.state + 40), .lfo_rate_hz = read_f32_le(descriptor.state + 44),
      .lfo_depth_octaves = read_f32_le(descriptor.state + 48), .lfo_phase_offset = read_f32_le(descriptor.state + 52),
      .lfo_stereo_phase = read_f32_le(descriptor.state + 56),
    };
    if (!valid_autofilter_state(state) || descriptor.latency_frames != kAutoFilterLatencyFrames
      || descriptor.tail_frames != 0) return false;
    out_processor->autofilter = state;
    return true;
  }
  if (descriptor.kind == DAW_AUDIO_PROCESSOR_KIND_LOFI && descriptor.state_size == 36) {
    const daw_audio_lofi_state state{
      .enabled = read_u32_le(descriptor.state), .bit_depth = read_u32_le(descriptor.state + 4),
      .sample_rate_ratio = read_f32_le(descriptor.state + 8), .jitter = read_f32_le(descriptor.state + 12),
      .noise_db = read_f32_le(descriptor.state + 16), .quantization = read_u32_le(descriptor.state + 20),
      .dither = read_u32_le(descriptor.state + 24), .mix = read_f32_le(descriptor.state + 28),
      .seed = read_u32_le(descriptor.state + 32),
    };
    if (!valid_lofi_state(state) || descriptor.latency_frames != 0 || descriptor.tail_frames != 0) return false;
    out_processor->lofi = state;
    return true;
  }
  if (descriptor.kind != DAW_AUDIO_PROCESSOR_KIND_EQ || descriptor.state_size != 200) return false;
  daw_audio_eq_state state{
    .enabled = read_u32_le(descriptor.state),
    .mono = read_u32_le(descriptor.state + 4),
    .bands = {},
  };
  for (uint32_t index = 0; index < 8; ++index) {
    const uint32_t offset = 8 + index * 24;
    state.bands[index] = {
      .enabled = read_u32_le(descriptor.state + offset), .type = read_u32_le(descriptor.state + offset + 4),
      .frequency_hz = read_f32_le(descriptor.state + offset + 8), .gain_db = read_f32_le(descriptor.state + offset + 12),
      .q = read_f32_le(descriptor.state + offset + 16), .reserved = 0,
    };
  }
  if (!valid_eq_state(state) || descriptor.latency_frames != 0
    || descriptor.tail_frames != 0) return false;
  out_processor->eq = state;
  return true;
}

template <typename Descriptor>
bool valid_asset_descriptor(const Descriptor &descriptor) {
  if (!valid_abi(descriptor.abi_version)
    || descriptor.revision == 0
    || descriptor.frame_count == 0
    || descriptor.sample_rate_hz == 0
    || descriptor.channel_count == 0
    || descriptor.channel_count > kMaximumChannels
    || descriptor.planes == nullptr) return false;
  if (descriptor.frame_count
    > UINT64_MAX / static_cast<uint64_t>(descriptor.channel_count) / sizeof(float)) return false;
  const uint64_t expected_byte_length = static_cast<uint64_t>(descriptor.frame_count)
    * static_cast<uint64_t>(descriptor.channel_count)
    * sizeof(float);
  if (descriptor.byte_length != expected_byte_length) return false;
  for (uint32_t channel = 0; channel < descriptor.channel_count; ++channel) {
    if (descriptor.planes[channel] == nullptr) return false;
  }
  return true;
}

float summed_input(const daw_audio_core_process_block &block, uint32_t channel, uint32_t frame) {
  float value = 0.0F;
  if (block.inputs == nullptr) return value;
  for (uint32_t bus = 0; bus < block.input_bus_count; ++bus) {
    const float *input = block.inputs[bus * block.channel_count + channel];
    if (input != nullptr) value += input[frame];
  }
  return value;
}

float processor_parameter_value(
  const Core &core,
  const GraphRevision::Processor &processor,
  uint32_t target,
  uint32_t frame,
  float fallback) {
  const uint32_t slot = processor.control_slot;
  static_cast<void>(frame);
  const auto parameter_begin = processor.parameter_targets.begin();
  const auto parameter_end = parameter_begin + processor.parameter_count;
  const auto parameter = std::lower_bound(parameter_begin, parameter_end, target);
  if (parameter == parameter_end || *parameter != target) return fallback;
  const auto index = static_cast<size_t>(parameter - parameter_begin);
  return core.resolved_parameter_valid[slot][index]
    ? core.resolved_parameter_values[slot][index]
    : fallback;
}

void resolve_processor_parameter_frame(
  Core &core,
  GraphRevision::Processor &processor,
  uint32_t frame) {
  const uint32_t slot = processor.control_slot;
  const daw_audio_processor_parameter_block *parameters = core.active_parameter_blocks[slot];
  uint32_t &event_cursor = core.parameter_event_cursors[slot];
  while (event_cursor < core.event_ends[slot]
    && core.active_events[event_cursor].frame_offset <= frame) {
    const daw_audio_processor_event &event = core.active_events[event_cursor++];
    const auto parameter_begin = processor.parameter_targets.begin();
    const auto parameter_end = parameter_begin + processor.parameter_count;
    const auto parameter = std::lower_bound(parameter_begin, parameter_end, event.parameter_target);
    if (parameter == parameter_end || *parameter != event.parameter_target) continue;
    const auto index = static_cast<size_t>(parameter - parameter_begin);
    core.event_parameter_values[slot][index] = event.value;
    core.event_parameter_valid[slot][index] = true;
  }
  for (uint32_t index = 0; index < processor.parameter_count; ++index) {
    bool valid = processor.live_parameter_valid[index];
    float value = processor.live_parameter_values[index];
    const uint32_t block_parameter = core.parameter_block_indices[slot][index];
    if (parameters != nullptr && block_parameter < parameters->parameter_count) {
      value = parameters->values[block_parameter * parameters->frame_count
        + (parameters->frame_count == 1 ? 0 : frame)];
      valid = true;
    }
    if (core.event_parameter_valid[slot][index]) {
      value = core.event_parameter_values[slot][index];
      valid = true;
    }
    core.resolved_parameter_values[slot][index] = value;
    core.resolved_parameter_valid[slot][index] = valid;
  }
}

void prepare_processor_parameter_cache(
  Core &core,
  GraphRevision::Processor &processor) {
  const uint32_t slot = processor.control_slot;
  core.parameter_event_cursors[slot] = core.event_starts[slot];
  core.event_parameter_valid[slot].fill(false);
  core.resolved_parameter_valid[slot].fill(false);
  core.parameter_block_indices[slot].fill(
    static_cast<uint8_t>(DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS));
  const daw_audio_processor_parameter_block *parameters = core.active_parameter_blocks[slot];
  if (parameters != nullptr) {
    for (uint32_t parameter = 0; parameter < parameters->parameter_count; ++parameter) {
      const auto parameter_begin = processor.parameter_targets.begin();
      const auto parameter_end = parameter_begin + processor.parameter_count;
      const auto target = std::lower_bound(
        parameter_begin, parameter_end, parameters->parameter_targets[parameter]);
      if (target == parameter_end || *target != parameters->parameter_targets[parameter]) continue;
      const auto index = static_cast<size_t>(target - parameter_begin);
      core.parameter_block_indices[slot][index] = static_cast<uint8_t>(parameter);
    }
  }
  core.parameter_cache_prepared[slot] = true;
}

void materialize_latched_time_effect_state(
  GraphRevision::Processor &processor,
  uint32_t sample_rate_hz) {
  if (processor.kind == DAW_AUDIO_PROCESSOR_KIND_DELAY) {
    for (uint32_t index = 0; index < processor.parameter_count; ++index) {
      if (!processor.live_parameter_valid[index]) continue;
      const uint32_t target = processor.parameter_targets[index];
      const float value = processor.live_parameter_values[index];
      if (target == DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_TIME_MS) processor.delay.delay_ms = value;
      else if (target == DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_FEEDBACK) processor.delay.feedback = value;
      else if (target == DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_DRY_WET) processor.delay.dry_wet = value;
      else if (target == DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_LOW_CUT_HZ) processor.delay.low_cut_hz = value;
      else if (target == DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_HIGH_CUT_HZ) processor.delay.high_cut_hz = value;
    }
    processor.tail_frames = 0;
    if (processor.delay.enabled != 0 && processor.delay.dry_wet != 0.0F) {
      const double feedback = std::max(static_cast<double>(processor.delay.feedback), 1e-6);
      const double repeats = std::max(1.0, std::ceil(std::log(1e-4) / std::log(feedback)));
      const double frames = std::ceil(
        static_cast<double>(processor.delay.delay_ms)
        * static_cast<double>(sample_rate_hz) / 1000.0
        * repeats);
      const double maximum = static_cast<double>(sample_rate_hz) * kMaximumRetirementSeconds;
      processor.tail_frames = static_cast<uint32_t>(std::min(frames, maximum));
    }
    return;
  }
  if (processor.kind != DAW_AUDIO_PROCESSOR_KIND_REVERB) return;
  for (uint32_t index = 0; index < processor.parameter_count; ++index) {
    if (!processor.live_parameter_valid[index]) continue;
    const uint32_t target = processor.parameter_targets[index];
    const float value = processor.live_parameter_values[index];
    if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_WET) processor.reverb.wet = value;
    else if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_PRE_DELAY_MS) processor.reverb.pre_delay_ms = value;
    else if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_LOW_CUT_HZ) processor.reverb.low_cut_hz = value;
    else if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_HIGH_CUT_HZ) processor.reverb.high_cut_hz = value;
    else if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_STEREO_WIDTH) processor.reverb.stereo_width = value;
    else if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DECAY_SEC) processor.reverb.decay_sec = value;
    else if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_REFLECTIONS) processor.reverb.reflections = value;
    else if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_REFLECTION_MOD_AMOUNT_MS) processor.reverb.reflection_mod_amount_ms = value;
    else if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_REFLECTION_MOD_RATE_HZ) processor.reverb.reflection_mod_rate_hz = value;
    else if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_REFLECTION_SHAPE) processor.reverb.reflection_shape = value;
    else if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DIFFUSE) processor.reverb.diffuse = value;
    else if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_SIZE) processor.reverb.size = value;
    else if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DIFFUSION) processor.reverb.diffusion = value;
    else if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DENSITY) processor.reverb.density = value;
    else if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DIFFUSION_LOW_CUT_HZ) processor.reverb.diffusion_low_cut_hz = value;
    else if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DIFFUSION_HIGH_CUT_HZ) processor.reverb.diffusion_high_cut_hz = value;
  }
  processor.tail_frames = processor.reverb.enabled == 0 || processor.reverb.wet == 0.0F
    ? 0
    : static_cast<uint32_t>(std::min(
      std::ceil((static_cast<double>(processor.reverb.pre_delay_ms) / 1000.0
        + static_cast<double>(processor.reverb.decay_sec)) * static_cast<double>(sample_rate_hz)),
      static_cast<double>(sample_rate_hz) * kMaximumRetirementSeconds));
}

void latch_processor_parameter_values(Core &core) {
  for (uint32_t processor_index = 0; processor_index < (*core.published_graph).processor_count; ++processor_index) {
    GraphRevision::Processor &processor = (*core.published_graph).processors[processor_index];
    const uint32_t slot = processor.control_slot;
    if (!core.parameter_cache_prepared[slot]) continue;
    for (uint32_t index = 0; index < processor.parameter_count; ++index) {
      if (!core.resolved_parameter_valid[slot][index]) continue;
      processor.live_parameter_values[index] = core.resolved_parameter_values[slot][index];
      processor.live_parameter_valid[index] = true;
    }
  }
}

float mixer_parameter_value(
  const Core &core,
  uint64_t instance_id,
  uint32_t target,
  uint32_t frame,
  float fallback) {
  float value = fallback;
  for (uint32_t index = 0; index < core.active_event_count; ++index) {
    const daw_audio_processor_event &event = core.active_events[index];
    if (event.processor_instance_id == instance_id && event.parameter_target == target && event.frame_offset <= frame) {
      value = event.value;
    }
  }
  return value;
}

bool mixer_solo_active(const Core &core, uint32_t frame) {
  for (uint32_t index = 0; index < (*core.published_graph).node_count; ++index) {
    const daw_audio_mixer_state &mixer = (*core.published_graph).nodes[index].mixer;
    if (mixer.instance_id != 0
      && mixer_parameter_value(core, mixer.instance_id, DAW_AUDIO_MIXER_PARAMETER_SOLO, frame,
        mixer.soloed == 0 ? 0.0F : 1.0F) == 1.0F) return true;
  }
  return false;
}

void apply_mixer_frame(const Core &core, const daw_audio_mixer_state &mixer, uint32_t frame,
  float *left, float *right) {
  if (mixer.instance_id == 0) return;
  const float muted = mixer_parameter_value(core, mixer.instance_id, DAW_AUDIO_MIXER_PARAMETER_MUTE, frame,
    mixer.muted == 0 ? 0.0F : 1.0F);
  const float soloed = mixer_parameter_value(core, mixer.instance_id, DAW_AUDIO_MIXER_PARAMETER_SOLO, frame,
    mixer.soloed == 0 ? 0.0F : 1.0F);
  if (muted == 1.0F || (mixer_solo_active(core, frame) && soloed != 1.0F)) {
    *left = 0.0F;
    *right = 0.0F;
    return;
  }
  const float gain = mixer_parameter_value(core, mixer.instance_id, DAW_AUDIO_MIXER_PARAMETER_GAIN, frame, mixer.gain);
  const float pan = mixer_parameter_value(core, mixer.instance_id, DAW_AUDIO_MIXER_PARAMETER_PAN, frame, mixer.pan);
  const float left_gain = std::min(1.0F, 1.0F - pan) * gain;
  const float right_gain = std::min(1.0F, 1.0F + pan) * gain;
  *left *= left_gain;
  *right *= right_gain;
}

float clamp_bypass_step(float current, float target, float step) {
  if (target > current + step) return current + step;
  if (target < current - step) return current - step;
  return target;
}

void process_utility_frame(
  Core &core,
  const GraphRevision::Processor *processor,
  UtilityHistory &history,
  uint32_t frame,
  float dry_left,
  float dry_right,
  float *left_output,
  float *right_output) {
  float left = dry_left;
  float right = dry_right;
  if (!std::isfinite(left) || !std::isfinite(right)) left = right = 0.0F;
  const float sanitized_dry_left = left;
  const float sanitized_dry_right = right;

  daw_audio_utility_state state = processor == nullptr ? core.utility : processor->utility;
  if (processor != nullptr) {
    state.gain_db = processor_parameter_value(core, *processor, DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB, frame, state.gain_db);
    state.pan = processor_parameter_value(core, *processor, DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_PAN, frame, state.pan);
    state.balance = processor_parameter_value(core, *processor, DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_BALANCE, frame, state.balance);
    state.width = processor_parameter_value(core, *processor, DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_WIDTH, frame, state.width);
  }
  if (state.input_mode == DAW_AUDIO_UTILITY_INPUT_MODE_MONO_SUM) left = right = 0.5F * left + 0.5F * right;
  if (state.polarity == DAW_AUDIO_UTILITY_POLARITY_INVERT) {
    left = -left;
    right = -right;
  }

  constexpr float sqrt_half = 0.7071067811865475244F;
  if (state.matrix == DAW_AUDIO_UTILITY_MATRIX_MID_SIDE_ENCODE) {
    const float mid = (left + right) * sqrt_half;
    right = (left - right) * sqrt_half;
    left = mid;
  } else if (state.matrix == DAW_AUDIO_UTILITY_MATRIX_MID_SIDE_DECODE) {
    const float mid = left;
    left = (mid + right) * sqrt_half;
    right = (mid - right) * sqrt_half;
  }

  if (state.swap != 0) {
    const float swapped = left;
    left = right;
    right = swapped;
  }

  const float mid = (left + right) * sqrt_half;
  const float side = (left - right) * sqrt_half * state.width;
  left = (mid + side) * sqrt_half;
  right = (mid - side) * sqrt_half;
  if (state.balance > 0.0F) left *= 1.0F - state.balance;
  if (state.balance < 0.0F) right *= 1.0F + state.balance;
  const float pan_angle = (state.pan + 1.0F) * 0.7853981633974483096F;
  left *= std::cos(pan_angle) * 1.4142135623730950488F;
  right *= std::sin(pan_angle) * 1.4142135623730950488F;
  const float gain = std::pow(10.0F, state.gain_db / 20.0F);
  left *= gain;
  right *= gain;

  if (state.dc_block != 0) {
    const float dc_coefficient = std::exp(-6.2831853071795864769F * 10.0F / static_cast<float>(core.config.sample_rate_hz));
    const float next_left = left - history.dc_x1_left + dc_coefficient * history.dc_y1_left;
    const float next_right = right - history.dc_x1_right + dc_coefficient * history.dc_y1_right;
    history.dc_x1_left = left;
    history.dc_x1_right = right;
    history.dc_y1_left = next_left;
    history.dc_y1_right = next_right;
    left = next_left;
    right = next_right;
  }

  if (!std::isfinite(left) || !std::isfinite(right)) {
    left = right = 0.0F;
    history.dc_x1_left = history.dc_x1_right = history.dc_y1_left = history.dc_y1_right = 0.0F;
  }

  const uint32_t bypass_frames = (core.config.sample_rate_hz + 50u) / 100u;
  const float bypass_step = 1.0F / static_cast<float>(bypass_frames == 0 ? 1u : bypass_frames);
  history.bypass = clamp_bypass_step(history.bypass, state.enabled != 0 ? 0.0F : 1.0F, bypass_step);
  *left_output = left + (sanitized_dry_left - left) * history.bypass;
  *right_output = right + (sanitized_dry_right - right) * history.bypass;
}

void render_utility_processor(
  Core &core,
  GraphRevision::Processor &processor,
  uint32_t frame,
  float input_left,
  float input_right,
  float,
  float,
  float *output_left,
  float *output_right) {
  daw_audio_utility_state state = processor.utility;
  state.enabled = processor.bypassed == 0 ? state.enabled : 0;
  const daw_audio_utility_state previous_state = core.utility;
  const bool previous_configured = core.utility_configured;
  core.utility = state;
  core.utility_configured = true;
  process_utility_frame(
    core, processor.parameter_count == 0 ? nullptr : &processor,
    core.utility_histories[processor.history_slot], frame, input_left, input_right, output_left, output_right);
  core.utility = previous_state;
  core.utility_configured = previous_configured;
}

struct BiquadCoefficients {
  float b0;
  float b1;
  float b2;
  float a1;
  float a2;
};

BiquadCoefficients rbj_coefficients(uint32_t type, float frequency_hz, float q, float gain_db, uint32_t sample_rate_hz) {
  const float frequency = std::fmin(frequency_hz, static_cast<float>(sample_rate_hz) * 0.49F);
  const float omega = 6.2831853071795864769F * frequency / static_cast<float>(sample_rate_hz);
  const float cosine = std::cos(omega);
  const float sine = std::sin(omega);
  const float alpha = sine / (2.0F * q);
  const float amplitude = std::pow(10.0F, gain_db / 40.0F);
  const float root_amplitude = std::sqrt(amplitude);
  float b0 = 1.0F;
  float b1 = 0.0F;
  float b2 = 0.0F;
  float a0 = 1.0F;
  float a1 = 0.0F;
  float a2 = 0.0F;
  if (type == DAW_AUDIO_EQ_BAND_LOWPASS) {
    b0 = (1.0F - cosine) * 0.5F; b1 = 1.0F - cosine; b2 = b0; a0 = 1.0F + alpha; a1 = -2.0F * cosine; a2 = 1.0F - alpha;
  } else if (type == DAW_AUDIO_EQ_BAND_HIGHPASS) {
    b0 = (1.0F + cosine) * 0.5F; b1 = -(1.0F + cosine); b2 = b0; a0 = 1.0F + alpha; a1 = -2.0F * cosine; a2 = 1.0F - alpha;
  } else if (type == DAW_AUDIO_EQ_BAND_BANDPASS) {
    b0 = alpha; b2 = -alpha; a0 = 1.0F + alpha; a1 = -2.0F * cosine; a2 = 1.0F - alpha;
  } else if (type == DAW_AUDIO_EQ_BAND_NOTCH) {
    b0 = 1.0F; b1 = -2.0F * cosine; b2 = 1.0F; a0 = 1.0F + alpha; a1 = b1; a2 = 1.0F - alpha;
  } else if (type == DAW_AUDIO_EQ_BAND_ALLPASS) {
    b0 = 1.0F - alpha; b1 = -2.0F * cosine; b2 = 1.0F + alpha; a0 = b2; a1 = b1; a2 = b0;
  } else if (type == DAW_AUDIO_EQ_BAND_LOWSHELF || type == DAW_AUDIO_EQ_BAND_HIGHSHELF) {
    const float beta = 2.0F * root_amplitude * alpha;
    if (type == DAW_AUDIO_EQ_BAND_LOWSHELF) {
      b0 = amplitude * ((amplitude + 1.0F) - (amplitude - 1.0F) * cosine + beta);
      b1 = 2.0F * amplitude * ((amplitude - 1.0F) - (amplitude + 1.0F) * cosine);
      b2 = amplitude * ((amplitude + 1.0F) - (amplitude - 1.0F) * cosine - beta);
      a0 = (amplitude + 1.0F) + (amplitude - 1.0F) * cosine + beta;
      a1 = -2.0F * ((amplitude - 1.0F) + (amplitude + 1.0F) * cosine);
      a2 = (amplitude + 1.0F) + (amplitude - 1.0F) * cosine - beta;
    } else {
      b0 = amplitude * ((amplitude + 1.0F) + (amplitude - 1.0F) * cosine + beta);
      b1 = -2.0F * amplitude * ((amplitude - 1.0F) + (amplitude + 1.0F) * cosine);
      b2 = amplitude * ((amplitude + 1.0F) + (amplitude - 1.0F) * cosine - beta);
      a0 = (amplitude + 1.0F) - (amplitude - 1.0F) * cosine + beta;
      a1 = 2.0F * ((amplitude - 1.0F) - (amplitude + 1.0F) * cosine);
      a2 = (amplitude + 1.0F) - (amplitude - 1.0F) * cosine - beta;
    }
  } else {
    b0 = 1.0F + alpha * amplitude; b1 = -2.0F * cosine; b2 = 1.0F - alpha * amplitude;
    a0 = 1.0F + alpha / amplitude; a1 = b1; a2 = 1.0F - alpha / amplitude;
  }
  return {.b0 = b0 / a0, .b1 = b1 / a0, .b2 = b2 / a0, .a1 = a1 / a0, .a2 = a2 / a0};
}

float process_biquad(float input, const BiquadCoefficients &coefficients, BiquadHistory &history) {
  const float output = coefficients.b0 * input + coefficients.b1 * history.x1 + coefficients.b2 * history.x2
    - coefficients.a1 * history.y1 - coefficients.a2 * history.y2;
  history.x2 = history.x1; history.x1 = input; history.y2 = history.y1; history.y1 = output;
  return output;
}

float saturator_curve(uint32_t curve, float input) {
  if (curve == DAW_AUDIO_SATURATOR_CURVE_SOFT) return std::tanh(1.8F * input);
  if (curve == DAW_AUDIO_SATURATOR_CURVE_MEDIUM) return input < -0.666F ? -1.0F : input > 0.666F ? 1.0F : 1.5F * input - 0.5F * input * input * input;
  if (curve == DAW_AUDIO_SATURATOR_CURVE_HARD) return std::atan(4.0F * input) / std::atan(4.0F);
  return std::fmax(-0.82F, std::fmin(0.82F, input)) / 0.82F;
}

float render_saturator_channel(
  Core &core, GraphRevision::Processor &processor, uint32_t frame, float input, float *previous,
  BiquadHistory &color_history) {
  daw_audio_saturator_state state = processor.saturator;
  state.drive_db = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_DRIVE_DB, frame, state.drive_db);
  state.color_frequency_hz = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_COLOR_FREQUENCY_HZ, frame, state.color_frequency_hz);
  state.color_amount = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_COLOR_AMOUNT, frame, state.color_amount);
  state.output_db = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_OUTPUT_DB, frame, state.output_db);
  state.dry_wet = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_DRY_WET, frame, state.dry_wet);
  const float dry = std::isfinite(input) ? input : 0.0F;
  if (processor.bypassed != 0 || state.enabled == 0) return dry;
  const float drive = std::pow(10.0F, state.drive_db / 20.0F);
  const BiquadCoefficients color = rbj_coefficients(DAW_AUDIO_EQ_BAND_PEAKING, state.color_frequency_hz, 0.8F,
    state.color != 0 ? state.color_amount * 12.0F : 0.0F, core.config.sample_rate_hz);
  float wet = 0.0F;
  for (uint32_t phase = 1; phase <= 4; ++phase) {
    const float interpolated = *previous + (dry - *previous) * static_cast<float>(phase) * 0.25F;
    wet += saturator_curve(state.curve, process_biquad(interpolated * drive, color, color_history));
  }
  *previous = dry;
  wet = wet * 0.25F * std::pow(10.0F, state.output_db / 20.0F);
  return dry + (wet - dry) * state.dry_wet;
}

void render_saturator_processor(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  float input_left, float input_right, float, float, float *output_left, float *output_right) {
  SaturatorHistory &history = core.saturator_histories[processor.history_slot];
  *output_left = render_saturator_channel(core, processor, frame, input_left, &history.previous_left, history.color_left);
  *output_right = render_saturator_channel(core, processor, frame, input_right, &history.previous_right, history.color_right);
}

void render_eq_processor(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  float input_left, float input_right, float, float, float *output_left, float *output_right) {
  EqHistory &history = core.eq_histories[processor.history_slot];
  float left = std::isfinite(input_left) ? input_left : 0.0F;
  float right = std::isfinite(input_right) ? input_right : 0.0F;
  if (processor.bypassed != 0 || processor.eq.enabled == 0) {
    *output_left = left; *output_right = right; return;
  }
  if (processor.eq.mono != 0) left = right = 0.5F * (left + right);
  for (uint32_t index = 0; index < 8; ++index) {
    const daw_audio_eq_band_state &band = processor.eq.bands[index];
    if (band.enabled == 0) continue;
    const float frequency = processor_parameter_value(
      core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_FREQUENCY_HZ(index), frame, band.frequency_hz);
    const float gain_db = processor_parameter_value(
      core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_GAIN_DB(index), frame, band.gain_db);
    const float q = processor_parameter_value(
      core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_Q(index), frame, band.q);
    const BiquadCoefficients coefficients = rbj_coefficients(
      band.type, frequency, q, gain_db, core.config.sample_rate_hz);
    left = process_biquad(left, coefficients, history.bands[index][0]);
    right = process_biquad(right, coefficients, history.bands[index][1]);
  }
  *output_left = std::isfinite(left) ? left : 0.0F;
  *output_right = std::isfinite(right) ? right : 0.0F;
}

float autofilter_lfo(uint32_t waveform, float phase) {
  const float wrapped = phase - std::floor(phase);
  return waveform == 1
    ? 1.0F - 4.0F * std::abs(wrapped - 0.5F)
    : std::sin(6.2831853071795864769F * wrapped);
}

float autofilter_filter(
  AutoFilterChannelHistory &channel,
  float input,
  float cutoff,
  float q,
  uint32_t mode,
  uint32_t sample_rate_hz) {
  const float g = std::tan(3.14159265358979323846F * cutoff / (static_cast<float>(sample_rate_hz) * 2.0F));
  const float k = 1.0F / q;
  const float a1 = 1.0F / (1.0F + g * (g + k));
  const float v1 = a1 * (channel.ic1 + g * (input - channel.ic2));
  const float v2 = channel.ic2 + g * v1;
  channel.ic1 = 2.0F * v1 - channel.ic1;
  channel.ic2 = 2.0F * v2 - channel.ic2;
  const float high = input - k * v1 - v2;
  if (mode == DAW_AUDIO_AUTOFILTER_MODE_HIGHPASS) return high;
  if (mode == DAW_AUDIO_AUTOFILTER_MODE_BANDPASS) return v1;
  if (mode == DAW_AUDIO_AUTOFILTER_MODE_NOTCH) return high + v2;
  if (mode == DAW_AUDIO_AUTOFILTER_MODE_PEAK) return v2 - high;
  return v2;
}

float render_autofilter_channel(
  Core &core,
  GraphRevision::Processor &processor,
  AutoFilterChannelHistory &channel,
  uint32_t channel_index,
  uint32_t frame,
  float input) {
  const daw_audio_autofilter_state &state = processor.autofilter;
  const float attack_ms = processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_ENVELOPE_ATTACK_MS, frame, state.envelope_attack_ms);
  const float release_ms = processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_ENVELOPE_RELEASE_MS, frame, state.envelope_release_ms);
  const float attack = std::exp(-1.0F / (std::fmax(0.5F, attack_ms) * 0.001F * static_cast<float>(core.config.sample_rate_hz)));
  const float release = std::exp(-1.0F / (std::fmax(5.0F, release_ms) * 0.001F * static_cast<float>(core.config.sample_rate_hz)));
  const float peak = std::abs(input);
  channel.envelope = peak > channel.envelope
    ? attack * channel.envelope + (1.0F - attack) * peak
    : release * channel.envelope + (1.0F - release) * peak;
  const float rate = processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_LFO_RATE_HZ, frame, state.lfo_rate_hz);
  const float phase_offset = processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_LFO_PHASE_OFFSET, frame, state.lfo_phase_offset);
  const float stereo_phase = channel_index == 0 ? 0.0F : processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_LFO_STEREO_PHASE, frame, state.lfo_stereo_phase);
  const float lfo = autofilter_lfo(state.lfo_waveform, static_cast<float>(channel.phase) + phase_offset + stereo_phase);
  channel.phase += static_cast<double>(rate) / static_cast<double>(core.config.sample_rate_hz);
  channel.phase -= std::floor(channel.phase);
  const float envelope_amount = processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_ENVELOPE_AMOUNT_OCTAVES, frame, state.envelope_amount_octaves);
  const float lfo_depth = processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_LFO_DEPTH_OCTAVES, frame, state.lfo_depth_octaves);
  const float frequency = processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_FREQUENCY_HZ, frame, state.frequency_hz);
  const float cutoff = std::fmax(
    20.0F,
    std::fmin(
      frequency * std::pow(2.0F, envelope_amount * channel.envelope + lfo_depth * lfo),
      0.45F * static_cast<float>(core.config.sample_rate_hz)));
  const float resonance = processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_RESONANCE, frame, state.resonance);
  const float q = 0.5F + 19.5F * resonance;
  const float drive_db = processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_DRIVE_DB, frame, state.drive_db);
  const float driven = std::tanh(input * std::pow(10.0F, drive_db / 20.0F));
  const float midpoint = 0.5F * (channel.previous + driven);
  autofilter_filter(channel, midpoint, cutoff, q, state.mode, core.config.sample_rate_hz);
  const float wet = autofilter_filter(channel, driven, cutoff, q, state.mode, core.config.sample_rate_hz);
  channel.previous = driven;
  const float mix = processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_MIX, frame, state.mix);
  return input + (wet - input) * mix;
}

void render_autofilter_processor(
  Core &core,
  GraphRevision::Processor &processor,
  uint32_t frame,
  float input_left,
  float input_right,
  float,
  float,
  float *output_left,
  float *output_right) {
  AutoFilterHistory &history = core.autofilter_histories[processor.history_slot];
  const float left = std::isfinite(input_left) ? input_left : 0.0F;
  const float right = std::isfinite(input_right) ? input_right : 0.0F;
  const float bypass_step = 1.0F / std::fmax(1.0F, std::round(0.01F * static_cast<float>(core.config.sample_rate_hz)));
  const float target_bypass = processor.bypassed != 0 || processor.autofilter.enabled == 0 ? 1.0F : 0.0F;
  history.bypass = clamp_bypass_step(history.bypass, target_bypass, bypass_step);
  const float processed_left = render_autofilter_channel(core, processor, history.channels[0], 0, frame, left);
  const float processed_right = render_autofilter_channel(core, processor, history.channels[1], 1, frame, right);
  const float mixed_left = std::isfinite(processed_left) ? processed_left + (left - processed_left) * history.bypass : 0.0F;
  const float mixed_right = std::isfinite(processed_right) ? processed_right + (right - processed_right) * history.bypass : 0.0F;
  if (!std::isfinite(processed_left)) history.channels[0] = {};
  if (!std::isfinite(processed_right)) history.channels[1] = {};
  *output_left = history.delay[0][history.delay_index];
  *output_right = history.delay[1][history.delay_index];
  history.delay[0][history.delay_index] = mixed_left;
  history.delay[1][history.delay_index] = mixed_right;
  history.delay_index = (history.delay_index + 1) % kAutoFilterLatencyFrames;
}

uint32_t lofi_next_random(uint32_t *state) {
  uint32_t value = *state;
  value ^= value << 13u;
  value ^= value >> 17u;
  value ^= value << 5u;
  *state = value == 0 ? 1u : value;
  return *state;
}

float lofi_random(uint32_t *state) {
  return static_cast<float>(lofi_next_random(state)) / 4294967296.0F;
}

float lofi_quantize(float scaled, uint32_t mode) {
  if (mode == DAW_AUDIO_LOFI_QUANTIZATION_FLOOR) return std::floor(scaled);
  if (mode == DAW_AUDIO_LOFI_QUANTIZATION_TRUNCATE) return std::trunc(scaled);
  // JavaScript Math.round rounds ties toward positive infinity.
  return std::floor(scaled + 0.5F);
}

void render_lofi_processor(
  Core &core,
  GraphRevision::Processor &processor,
  uint32_t frame,
  float input_left,
  float input_right,
  float,
  float,
  float *output_left,
  float *output_right) {
  LoFiHistory &history = core.lofi_histories[processor.history_slot];
  daw_audio_lofi_state state = processor.lofi;
  state.bit_depth = static_cast<uint32_t>(processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_BIT_DEPTH, frame, static_cast<float>(state.bit_depth)));
  const float dry_left = std::isfinite(input_left) ? input_left : 0.0F;
  const float dry_right = std::isfinite(input_right) ? input_right : 0.0F;
  const float bit_depth = static_cast<float>(state.bit_depth);
  const float levels = std::pow(2.0F, bit_depth - 1.0F) - 1.0F;
  const float lsb = 1.0F / levels;
  const float ratio = processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_SAMPLE_RATE_RATIO, frame, state.sample_rate_ratio);
  const float jitter = processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_JITTER, frame, state.jitter);
  const float noise_db = processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_NOISE_DB, frame, state.noise_db);
  const float mix = processor_parameter_value(
    core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_MIX, frame, state.mix);
  for (uint32_t channel_index = 0; channel_index < 2; ++channel_index) {
    LoFiChannelHistory &channel = history.channels[channel_index];
    if (channel.random_state == 0) {
      channel.random_state = state.seed ^ (channel_index == 0 ? 0u : 0x9e3779b9u);
      if (channel.random_state == 0) channel.random_state = 1u;
    }
    const float dry = channel_index == 0 ? dry_left : dry_right;
    channel.phase += ratio;
    if (channel.phase >= channel.interval) {
      channel.phase -= channel.interval;
      channel.interval = 1.0F + (lofi_random(&channel.random_state) - 0.5F) * jitter;
      const float noise = (lofi_random(&channel.random_state) * 2.0F - 1.0F) * std::pow(10.0F, noise_db / 20.0F);
      float sample = dry + noise;
      if (state.dither == DAW_AUDIO_LOFI_DITHER_RECTANGULAR) {
        sample += (lofi_random(&channel.random_state) - 0.5F) * lsb;
      } else if (state.dither == DAW_AUDIO_LOFI_DITHER_TRIANGULAR) {
        sample += (lofi_random(&channel.random_state) - lofi_random(&channel.random_state)) * lsb;
      }
      const float quantized = lofi_quantize(sample * levels, state.quantization);
      channel.held = std::fmax(-1.0F, std::fmin(1.0F, quantized / levels));
    }
    const float processed = dry + (channel.held - dry) * mix;
    if (channel_index == 0) *output_left = processed;
    else *output_right = processed;
  }
  const uint32_t bypass_frames = (core.config.sample_rate_hz + 50u) / 100u;
  const float bypass_step = 1.0F / static_cast<float>(bypass_frames == 0 ? 1u : bypass_frames);
  history.bypass = clamp_bypass_step(
    history.bypass,
    processor.bypassed != 0 || state.enabled == 0 ? 1.0F : 0.0F,
    bypass_step);
  *output_left = std::isfinite(*output_left)
    ? *output_left + (dry_left - *output_left) * history.bypass : dry_left;
  *output_right = std::isfinite(*output_right)
    ? *output_right + (dry_right - *output_right) * history.bypass : dry_right;
}

float modulation_lfo(uint32_t waveform, float phase) {
  const float wrapped = phase - std::floor(phase);
  return waveform == 1 ? 1.0F - 4.0F * std::abs(wrapped - 0.5F) : std::sin(6.2831853071795864769F * wrapped);
}

float shaped_unipolar(const daw_audio_amplitude_modulation_state &state, float phase) {
  return std::pow(0.5F + 0.5F * modulation_lfo(state.waveform, phase), std::pow(2.0F, 4.0F * (state.shape - 0.5F)));
}

float read_modulation_delay(const std::array<float, kMaximumModulationDelayFrames> &buffer, uint32_t write, float delay_frames) {
  float position = static_cast<float>(write) - delay_frames;
  while (position < 0.0F) position += static_cast<float>(buffer.size());
  const uint32_t index1 = static_cast<uint32_t>(std::floor(position)) % buffer.size();
  const float fraction = position - std::floor(position);
  const uint32_t index0 = (index1 + buffer.size() - 1) % buffer.size();
  const uint32_t index2 = (index1 + 1) % buffer.size();
  const uint32_t index3 = (index1 + 2) % buffer.size();
  const float a = buffer[index1];
  const float b = 0.5F * (-buffer[index0] + buffer[index2]);
  const float c = 0.5F * (2.0F * buffer[index0] - 5.0F * buffer[index1] + 4.0F * buffer[index2] - buffer[index3]);
  const float d = 0.5F * (-buffer[index0] + 3.0F * buffer[index1] - 3.0F * buffer[index2] + buffer[index3]);
  return ((d * fraction + c) * fraction + b) * fraction + a;
}

float phaser_sample(
  Core &core, const daw_audio_phaser_state &state, ModulationHistory &history,
  float input, uint32_t channel, float lfo) {
  const float center = state.center_hz * std::pow(2.0F, state.depth_octaves * lfo);
  const float frequency = std::fmax(20.0F, std::fmin(static_cast<float>(core.config.sample_rate_hz) * 0.49F, center));
  const float tangent = std::tan(3.14159265358979323846F * frequency / static_cast<float>(core.config.sample_rate_hz));
  const float coefficient = (tangent - 1.0F) / (tangent + 1.0F);
  auto &xs = channel == 0 ? history.allpass_x_left : history.allpass_x_right;
  auto &ys = channel == 0 ? history.allpass_y_left : history.allpass_y_right;
  float value = input + (channel == 0 ? history.feedback_left : history.feedback_right) * state.feedback;
  for (uint32_t stage = 0; stage < state.stages; ++stage) {
    const float output = coefficient * value + xs[stage] - coefficient * ys[stage];
    xs[stage] = value; ys[stage] = output; value = output;
  }
  if (channel == 0) history.feedback_left = value; else history.feedback_right = value;
  return value;
}

void render_modulation_processor(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  float input_left, float input_right, float, float, float *output_left, float *output_right) {
  ModulationHistory &history = core.modulation_histories[processor.history_slot];
  const float dry_left = std::isfinite(input_left) ? input_left : 0.0F;
  const float dry_right = std::isfinite(input_right) ? input_right : 0.0F;
  float left = dry_left;
  float right = dry_right;
  const bool is_delay = processor.kind == DAW_AUDIO_PROCESSOR_KIND_CHORUS || processor.kind == DAW_AUDIO_PROCESSOR_KIND_FLANGER;
  const bool is_amplitude = processor.kind == DAW_AUDIO_PROCESSOR_KIND_TREMOLO || processor.kind == DAW_AUDIO_PROCESSOR_KIND_AUTOPAN;
  float rate = 0.0F;
  bool enabled = false;
  if (is_delay) {
    daw_audio_delay_modulation_state state = processor.delay_modulation;
    const uint32_t base = processor.kind == DAW_AUDIO_PROCESSOR_KIND_CHORUS
      ? DAW_AUDIO_PROCESSOR_PARAMETER_CHORUS_DELAY_MS : DAW_AUDIO_PROCESSOR_PARAMETER_FLANGER_DELAY_MS;
    state.delay_ms = processor_parameter_value(core, processor, base, frame, state.delay_ms);
    state.depth_ms = processor_parameter_value(core, processor, base + 1, frame, state.depth_ms);
    state.rate_hz = processor_parameter_value(core, processor, base + 2, frame, state.rate_hz);
    state.feedback = processor_parameter_value(core, processor, base + 3, frame, state.feedback);
    state.stereo_phase = processor_parameter_value(core, processor, base + 4, frame, state.stereo_phase);
    state.mix = processor_parameter_value(core, processor, base + 5, frame, state.mix);
    const float phase_left = static_cast<float>(history.phase);
    const float phase_right = phase_left + state.stereo_phase;
    history.delay_left[history.write] = dry_left + history.feedback_left * state.feedback;
    history.delay_right[history.write] = dry_right + history.feedback_right * state.feedback;
    const float left_delay = std::fmax(1.0F, (state.delay_ms + state.depth_ms * modulation_lfo(0, phase_left)) * static_cast<float>(core.config.sample_rate_hz) / 1000.0F);
    const float right_delay = std::fmax(1.0F, (state.delay_ms + state.depth_ms * modulation_lfo(0, phase_right)) * static_cast<float>(core.config.sample_rate_hz) / 1000.0F);
    const float wet_left = read_modulation_delay(history.delay_left, history.write, left_delay);
    const float wet_right = read_modulation_delay(history.delay_right, history.write, right_delay);
    history.feedback_left = wet_left; history.feedback_right = wet_right;
    history.write = (history.write + 1) % kMaximumModulationDelayFrames;
    left = dry_left * (1.0F - state.mix) + wet_left * state.mix;
    right = dry_right * (1.0F - state.mix) + wet_right * state.mix;
    rate = state.rate_hz; enabled = state.enabled != 0;
  } else if (processor.kind == DAW_AUDIO_PROCESSOR_KIND_ENSEMBLE) {
    daw_audio_ensemble_state state = processor.ensemble;
    state.delay_ms = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_DELAY_MS, frame, state.delay_ms);
    state.depth_ms = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_DEPTH_MS, frame, state.depth_ms);
    state.rate_hz = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_RATE_HZ, frame, state.rate_hz);
    state.spread = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_SPREAD, frame, state.spread);
    state.mix = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_MIX, frame, state.mix);
    history.delay_left[history.write] = dry_left; history.delay_right[history.write] = dry_right;
    float wet_left = 0.0F; float wet_right = 0.0F;
    for (uint32_t voice = 0; voice < 3; ++voice) {
      const float voice_phase = static_cast<float>(history.phase) + static_cast<float>(voice) / 3.0F;
      const float spread = state.spread * (static_cast<float>(voice) - 1.0F) * 0.25F;
      wet_left += read_modulation_delay(history.delay_left, history.write, std::fmax(1.0F, (state.delay_ms + state.depth_ms * modulation_lfo(0, voice_phase - spread)) * static_cast<float>(core.config.sample_rate_hz) / 1000.0F));
      wet_right += read_modulation_delay(history.delay_right, history.write, std::fmax(1.0F, (state.delay_ms + state.depth_ms * modulation_lfo(0, voice_phase + spread)) * static_cast<float>(core.config.sample_rate_hz) / 1000.0F));
    }
    history.write = (history.write + 1) % kMaximumModulationDelayFrames;
    left = dry_left * (1.0F - state.mix) + wet_left * state.mix / 3.0F;
    right = dry_right * (1.0F - state.mix) + wet_right * state.mix / 3.0F;
    rate = state.rate_hz; enabled = state.enabled != 0;
  } else if (processor.kind == DAW_AUDIO_PROCESSOR_KIND_PHASER) {
    daw_audio_phaser_state state = processor.phaser;
    state.center_hz = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_CENTER_HZ, frame, state.center_hz);
    state.depth_octaves = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_DEPTH_OCTAVES, frame, state.depth_octaves);
    state.rate_hz = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_RATE_HZ, frame, state.rate_hz);
    state.feedback = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_FEEDBACK, frame, state.feedback);
    state.stereo_phase = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_STEREO_PHASE, frame, state.stereo_phase);
    state.mix = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_MIX, frame, state.mix);
    const float wet_left = phaser_sample(core, state, history, dry_left, 0, modulation_lfo(0, static_cast<float>(history.phase)));
    const float wet_right = phaser_sample(core, state, history, dry_right, 1, modulation_lfo(0, static_cast<float>(history.phase) + state.stereo_phase));
    left = dry_left * (1.0F - state.mix) + wet_left * state.mix;
    right = dry_right * (1.0F - state.mix) + wet_right * state.mix;
    rate = state.rate_hz; enabled = state.enabled != 0;
  } else if (is_amplitude) {
    daw_audio_amplitude_modulation_state state = processor.amplitude_modulation;
    const uint32_t base = processor.kind == DAW_AUDIO_PROCESSOR_KIND_TREMOLO
      ? DAW_AUDIO_PROCESSOR_PARAMETER_TREMOLO_RATE_HZ : DAW_AUDIO_PROCESSOR_PARAMETER_AUTOPAN_RATE_HZ;
    state.rate_hz = processor_parameter_value(core, processor, base, frame, state.rate_hz);
    state.depth = processor_parameter_value(core, processor, base + 1, frame, state.depth);
    state.shape = processor_parameter_value(core, processor, base + 2, frame, state.shape);
    state.phase = processor_parameter_value(core, processor, base + 3, frame, state.phase);
    const float shaped = shaped_unipolar(state, static_cast<float>(history.phase) + state.phase);
    if (processor.kind == DAW_AUDIO_PROCESSOR_KIND_TREMOLO) {
      const float gain = 1.0F - state.depth + state.depth * shaped;
      left = dry_left * gain; right = dry_right * gain;
    } else {
      const float position = state.depth * (2.0F * shaped - 1.0F);
      left = dry_left * std::cos((position + 1.0F) * 0.7853981633974483096F) * 1.4142135623730950488F;
      right = dry_right * std::sin((position + 1.0F) * 0.7853981633974483096F) * 1.4142135623730950488F;
    }
    rate = state.rate_hz; enabled = state.enabled != 0;
  }
  history.phase += static_cast<double>(rate) / static_cast<double>(core.config.sample_rate_hz);
  history.phase -= std::floor(history.phase);
  if (!std::isfinite(left) || !std::isfinite(right)) {
    left = right = 0.0F; history.feedback_left = history.feedback_right = 0.0F;
  }
  const float target_bypass = !enabled || processor.bypassed != 0 ? 1.0F : 0.0F;
  history.bypass = clamp_bypass_step(history.bypass, target_bypass, 1.0F / std::fmax(1.0F, std::round(0.01F * static_cast<float>(core.config.sample_rate_hz))));
  *output_left = left + (dry_left - left) * history.bypass;
  *output_right = right + (dry_right - right) * history.bypass;
}

template <size_t DelayFrames>
float read_time_effect_delay(
  const std::array<float, DelayFrames> &buffer,
  uint32_t write,
  float delay_frames) {
  const float delay = std::fmax(1.0F, std::fmin(delay_frames, static_cast<float>(DelayFrames - 1)));
  const float read = static_cast<float>(write) - delay;
  const float base = std::floor(read);
  const float fraction = read - base;
  const auto index = [&buffer, base](int32_t offset) {
    const int64_t size = static_cast<int64_t>(buffer.size());
    int64_t value = static_cast<int64_t>(base) + offset;
    value %= size;
    if (value < 0) value += size;
    return static_cast<size_t>(value);
  };
  const float older = buffer[index(0)];
  const float newer = buffer[index(1)];
  return older + (newer - older) * fraction;
}

struct TimeEffectBiquadCoefficients {
  float b0 = 0.0F;
  float b1 = 0.0F;
  float b2 = 0.0F;
  float a1 = 0.0F;
  float a2 = 0.0F;
};

TimeEffectBiquadCoefficients time_effect_biquad_coefficients(
  bool highpass,
  float frequency_hz,
  uint32_t sample_rate_hz) {
  const float rate = static_cast<float>(sample_rate_hz);
  const float frequency = std::fmax(0.0F, std::fmin(frequency_hz, rate * 0.5F));
  const float omega = 6.2831853071795864769F * frequency / rate;
  const float cosine = std::cos(omega);
  const float alpha = std::sin(omega) / (2.0F * 0.707F);
  const float a0 = 1.0F + alpha;
  return {
    (highpass ? (1.0F + cosine) * 0.5F : (1.0F - cosine) * 0.5F) / a0,
    (highpass ? -(1.0F + cosine) : 1.0F - cosine) / a0,
    (highpass ? (1.0F + cosine) * 0.5F : (1.0F - cosine) * 0.5F) / a0,
    -2.0F * cosine / a0,
    (1.0F - alpha) / a0,
  };
}

float process_time_effect_biquad(
  float input,
  const TimeEffectBiquadCoefficients &coefficients,
  BiquadHistory &history) {
  const float output = coefficients.b0 * input
    + coefficients.b1 * history.x1
    + coefficients.b2 * history.x2
    - coefficients.a1 * history.y1
    - coefficients.a2 * history.y2;
  history.x2 = history.x1;
  history.x1 = input;
  history.y2 = history.y1;
  history.y1 = output;
  return output;
}

float filter_reverb_sample(
  float input,
  float low_cut_hz,
  float high_cut_hz,
  Core &core,
  float *low,
  float *high_input,
  float *high) {
  const float rate = static_cast<float>(core.config.sample_rate_hz);
  const float lowpass_alpha = 1.0F - std::exp(-6.2831853071795864769F * std::fmin(high_cut_hz, rate * 0.49F) / rate);
  *low += lowpass_alpha * (input - *low);
  const float highpass_alpha = std::exp(-6.2831853071795864769F * low_cut_hz / rate);
  *high = highpass_alpha * (*high + *low - *high_input);
  *high_input = *low;
  return *high;
}

template <typename History>
void render_time_effect_processor_impl(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  History &history, float input_left, float input_right, float, float,
  float *output_left, float *output_right) {
  const float dry_left = std::isfinite(input_left) ? input_left : 0.0F;
  const float dry_right = std::isfinite(input_right) ? input_right : 0.0F;
  const bool delay = processor.kind == DAW_AUDIO_PROCESSOR_KIND_DELAY;
  const float rate = static_cast<float>(core.config.sample_rate_hz);
  float left = 0.0F;
  float right = 0.0F;
  bool enabled = false;
  if (delay) {
    daw_audio_delay_state delay_state = processor.delay;
    const float delay_parameter_ms = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_TIME_MS, frame, delay_state.delay_ms);
    const float delay_feedback = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_FEEDBACK, frame, delay_state.feedback);
    const float delay_dry_wet = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_DRY_WET, frame, delay_state.dry_wet);
    const float delay_low_cut = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_LOW_CUT_HZ, frame, delay_state.low_cut_hz);
    const float delay_high_cut = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_HIGH_CUT_HZ, frame, delay_state.high_cut_hz);
    if (delay_state.enabled == 0 || processor.bypassed != 0) {
      const float bypass = history.bypass;
      history = History{};
      history.bypass = bypass;
    }
    const float bounded_delay_ms = std::fmax(1.0F, std::fmin(delay_parameter_ms, 3000.0F));
    const float bounded_feedback = std::fmax(0.0F, std::fmin(delay_feedback, 0.95F));
    const float bounded_dry_wet = std::fmax(0.0F, std::fmin(delay_dry_wet, 1.0F));
    const float delay_frames = std::fmax(1.0F, bounded_delay_ms * rate / 1000.0F);
    const float raw_left = read_time_effect_delay(history.left, history.write, delay_frames);
    const float raw_right = read_time_effect_delay(history.right, history.write, delay_frames);
    const float low_cut = delay_state.filter_enabled != 0
      ? std::fmax(20.0F, std::fmin(delay_low_cut, 2000.0F)) : 20.0F;
    const float high_cut = delay_state.filter_enabled != 0
      ? std::fmax(1000.0F, std::fmin(delay_high_cut, 20000.0F)) : 20000.0F;
    const TimeEffectBiquadCoefficients highpass = time_effect_biquad_coefficients(
      true, low_cut, core.config.sample_rate_hz);
    const TimeEffectBiquadCoefficients lowpass = time_effect_biquad_coefficients(
      false, high_cut, core.config.sample_rate_hz);
    const float wet_left = process_time_effect_biquad(
      process_time_effect_biquad(raw_left, highpass, history.highpass_left),
      lowpass, history.lowpass_left);
    const float wet_right = process_time_effect_biquad(
      process_time_effect_biquad(raw_right, highpass, history.highpass_right),
      lowpass, history.lowpass_right);
    const float feedback_left = delay_state.ping_pong != 0 ? wet_right : wet_left;
    const float feedback_right = delay_state.ping_pong != 0 ? wet_left : wet_right;
    history.left[history.write] = dry_left + feedback_left * bounded_feedback;
    history.right[history.write] = dry_right + feedback_right * bounded_feedback;
    history.write = (history.write + 1) % static_cast<uint32_t>(history.left.size());
    left = dry_left * (1.0F - bounded_dry_wet) + wet_left * bounded_dry_wet;
    right = dry_right * (1.0F - bounded_dry_wet) + wet_right * bounded_dry_wet;
    enabled = delay_state.enabled != 0;
  } else {
    daw_audio_reverb_state reverb_state = processor.reverb;
    reverb_state.wet = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_WET, frame, reverb_state.wet);
    reverb_state.pre_delay_ms = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_PRE_DELAY_MS, frame, reverb_state.pre_delay_ms);
    reverb_state.low_cut_hz = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_LOW_CUT_HZ, frame, reverb_state.low_cut_hz);
    reverb_state.high_cut_hz = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_HIGH_CUT_HZ, frame, reverb_state.high_cut_hz);
    reverb_state.stereo_width = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_STEREO_WIDTH, frame, reverb_state.stereo_width);
    reverb_state.decay_sec = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DECAY_SEC, frame, reverb_state.decay_sec);
    reverb_state.reflections = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_REFLECTIONS, frame, reverb_state.reflections);
    reverb_state.reflection_mod_amount_ms = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_REFLECTION_MOD_AMOUNT_MS, frame, reverb_state.reflection_mod_amount_ms);
    reverb_state.reflection_mod_rate_hz = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_REFLECTION_MOD_RATE_HZ, frame, reverb_state.reflection_mod_rate_hz);
    reverb_state.reflection_shape = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_REFLECTION_SHAPE, frame, reverb_state.reflection_shape);
    reverb_state.diffuse = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DIFFUSE, frame, reverb_state.diffuse);
    reverb_state.size = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_SIZE, frame, reverb_state.size);
    reverb_state.diffusion = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DIFFUSION, frame, reverb_state.diffusion);
    reverb_state.density = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DENSITY, frame, reverb_state.density);
    reverb_state.diffusion_low_cut_hz = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DIFFUSION_LOW_CUT_HZ, frame, reverb_state.diffusion_low_cut_hz);
    reverb_state.diffusion_high_cut_hz = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DIFFUSION_HIGH_CUT_HZ, frame, reverb_state.diffusion_high_cut_hz);
    const float reverb_modulation_ms = reverb_state.reflections > 0.0F && reverb_state.reflection_spin != 0
      ? std::sin(static_cast<float>(history.phase) * 6.2831853071795864769F) * reverb_state.reflection_mod_amount_ms * 0.5F
      : 0.0F;
    const float bounded_wet = std::fmax(0.0F, std::fmin(reverb_state.wet, 1.0F));
    const float bounded_pre_delay_ms = std::fmax(0.0F, std::fmin(reverb_state.pre_delay_ms, 250.0F));
    const float bounded_low_cut_hz = std::fmax(20.0F, std::fmin(reverb_state.low_cut_hz, 1200.0F));
    const float bounded_high_cut_hz = std::fmax(1200.0F, std::fmin(reverb_state.high_cut_hz, 20000.0F));
    const float bounded_width = std::fmax(0.0F, std::fmin(reverb_state.stereo_width, 2.0F));
    const float bounded_size = std::fmax(0.0F, std::fmin(reverb_state.size, 1.0F));
    const float pre_delay_frames = std::fmax(
      1.0F,
      bounded_pre_delay_ms * rate / 1000.0F + reverb_modulation_ms * rate / 1000.0F);
    const float stereo_spread_frames = processor.input_layout == DAW_AUDIO_GRAPH_LAYOUT_MONO
      ? (6.0F + bounded_size * 8.0F) * rate / 1000.0F
      : 0.0F;
    const float raw_left = read_time_effect_delay(history.left, history.write, pre_delay_frames);
    const float raw_right = read_time_effect_delay(history.right, history.write, pre_delay_frames + stereo_spread_frames);
    const float diffusion_delay_ms = std::fmax(20.0F, std::fmin(20.0F + bounded_size * 80.0F, 100.0F));
    const float network_delay_frames = std::fmax(
      1.0F,
      pre_delay_frames + diffusion_delay_ms * rate / 1000.0F);
    const float late_raw_left = read_time_effect_delay(history.left, history.write, network_delay_frames);
    const float late_raw_right = read_time_effect_delay(
      history.right, history.write, network_delay_frames + stereo_spread_frames);
    const float low_cut = std::fmax(bounded_low_cut_hz, reverb_state.diffusion_low_cut_hz);
    const float high_cut = std::fmin(bounded_high_cut_hz, reverb_state.diffusion_high_cut_hz);
    const float late_left = filter_reverb_sample(
      late_raw_left, low_cut, high_cut, core, &history.low_left, &history.high_input_left, &history.high_left);
    const float late_right = filter_reverb_sample(
      late_raw_right, low_cut, high_cut, core, &history.low_right, &history.high_input_right, &history.high_right);
    const float decay = std::fmax(0.05F, reverb_state.decay_sec);
    const float feedback_gain = std::fmin(
      0.9999F,
      std::pow(1.0e-4F, network_delay_frames / (decay * rate)));
    const float texture_gain = std::fmax(0.0F, std::fmin(
      reverb_state.diffuse * reverb_state.density
      * (0.5F + 0.5F * reverb_state.diffusion), 1.0F));
    const float reflection_gain = reverb_state.reflections * (0.65F + reverb_state.reflection_shape * 0.7F);
    const float early_left = raw_left * reflection_gain;
    const float early_right = raw_right * reflection_gain;
    const bool has_late_texture = reverb_state.diffuse > 0.0F
      && reverb_state.density > 0.0F
      && reverb_state.diffusion > 0.0F;
    const float late_write_gain = has_late_texture ? texture_gain * feedback_gain : 0.0F;
    history.left[history.write] = dry_left + late_left * late_write_gain;
    history.right[history.write] = dry_right + late_right * late_write_gain;
    history.write = (history.write + 1) % static_cast<uint32_t>(history.left.size());
    const float output_late_left = has_late_texture ? late_left * texture_gain : 0.0F;
    const float output_late_right = has_late_texture ? late_right * texture_gain : 0.0F;
    const float wide_left = output_late_left * (1.0F + bounded_width) * 0.5F
      + output_late_right * (1.0F - bounded_width) * 0.5F;
    const float wide_right = output_late_right * (1.0F + bounded_width) * 0.5F
      + output_late_left * (1.0F - bounded_width) * 0.5F;
    left = dry_left * (1.0F - bounded_wet) + (wide_left + early_left) * bounded_wet;
    right = dry_right * (1.0F - bounded_wet) + (wide_right + early_right) * bounded_wet;
    history.phase += static_cast<double>(reverb_state.reflection_mod_rate_hz) / static_cast<double>(core.config.sample_rate_hz);
    history.phase -= std::floor(history.phase);
    enabled = reverb_state.enabled != 0;
  }
  if (!std::isfinite(left) || !std::isfinite(right)) {
    left = right = 0.0F;
    history = History{};
  }
  const float target_bypass = !enabled || processor.bypassed != 0 ? 1.0F : 0.0F;
  history.bypass = clamp_bypass_step(history.bypass, target_bypass, 1.0F / std::fmax(1.0F, std::round(0.01F * rate)));
  *output_left = left + (dry_left - left) * history.bypass;
  *output_right = right + (dry_right - right) * history.bypass;
}

void render_time_effect_processor(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  float input_left, float input_right, float sidechain_left, float sidechain_right,
  float *output_left, float *output_right) {
  if (processor.kind == DAW_AUDIO_PROCESSOR_KIND_DELAY) {
    render_time_effect_processor_impl(
      core, processor, frame, core.delay_histories[processor.delay_slot],
      input_left, input_right, sidechain_left, sidechain_right, output_left, output_right);
    return;
  }
  render_time_effect_processor_impl(
      core, processor, frame, core.reverb_histories[processor.reverb_slot],
    input_left, input_right, sidechain_left, sidechain_right, output_left, output_right);
}

void render_retirement_processor(
  Core &core, Core::RetirementLane &lane, uint32_t frame,
  float input_left, float input_right, float sidechain_left, float sidechain_right,
  float *output_left, float *output_right) {
  if (lane.processor.kind == DAW_AUDIO_PROCESSOR_KIND_DELAY) {
    render_time_effect_processor_impl(
      core, lane.processor, frame, core.delay_histories[lane.source_delay_slot],
      input_left, input_right, sidechain_left, sidechain_right, output_left, output_right);
    return;
  }
  render_time_effect_processor_impl(
      core, lane.processor, frame, core.reverb_histories[lane.source_reverb_slot],
    input_left, input_right, sidechain_left, sidechain_right, output_left, output_right);
}


float dynamics_db_to_gain(float db) {
  return std::pow(10.0F, db / 20.0F);
}

float dynamics_gain_to_db(float gain) {
  return gain > 0.0F ? 20.0F * std::log10(gain) : -120.0F;
}

uint32_t dynamics_delay_frames(float milliseconds, uint32_t sample_rate) {
  return std::min(kMaximumDynamicsDelayFrames - 1, static_cast<uint32_t>(std::ceil(milliseconds * static_cast<float>(sample_rate) / 1000.0F)));
}

double limiter_true_peak(const std::array<double, 12> &history, uint32_t history_write) {
  double peak = 0.0;
  for (uint32_t phase = 0; phase < 4; ++phase) {
    double value = 0.0;
    for (uint32_t tap = 0; tap < 12; ++tap) {
      const uint32_t history_index = (history_write + 11 - tap) % 12;
      value += history[history_index] * kLimiterTruePeakFir[tap * 4 + phase];
    }
    peak = std::max(peak, std::abs(value));
  }
  return peak;
}

float compressor_curve_db(float input_db, const daw_audio_compressor_state &state) {
  if (state.dynamics_mode != 0) {
    if (input_db >= state.threshold_db) return input_db;
    const float expanded = state.threshold_db + (input_db - state.threshold_db) * state.ratio;
    if (state.knee_db <= 0.0F || input_db <= state.threshold_db - state.knee_db * 0.5F) return expanded;
    const float distance = state.threshold_db - input_db;
    return input_db - (2.0F * (state.ratio - 1.0F) * distance * distance) / state.knee_db;
  }
  const float compressed = state.threshold_db + (input_db - state.threshold_db) / state.ratio;
  if (state.knee_db <= 0.0F) return input_db <= state.threshold_db ? input_db : compressed;
  const float lower = state.threshold_db - state.knee_db * 0.5F;
  const float upper = state.threshold_db + state.knee_db * 0.5F;
  if (input_db <= lower) return input_db;
  if (input_db >= upper) return compressed;
  const float x = input_db - lower;
  return input_db + ((1.0F / state.ratio - 1.0F) * x * x) / (2.0F * state.knee_db);
}

void render_dynamics_processor(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  float input_left, float input_right, float sidechain_left, float sidechain_right, float *output_left, float *output_right) {
  DynamicsHistory &history = core.dynamics_histories[processor.history_slot];
  const float dry_left = std::isfinite(input_left) ? input_left : 0.0F;
  const float dry_right = std::isfinite(input_right) ? input_right : 0.0F;
  const bool gate = processor.kind == DAW_AUDIO_PROCESSOR_KIND_GATE;
  const bool compressor = processor.kind == DAW_AUDIO_PROCESSOR_KIND_COMPRESSOR;
  const uint32_t fixed_delay = dynamics_delay_frames(
    gate ? 2.0F : compressor ? 10.0F : 5.0F, core.config.sample_rate_hz);
  const uint32_t write = history.write;
  const uint32_t read = (write + kMaximumDynamicsDelayFrames - fixed_delay) % kMaximumDynamicsDelayFrames;
  history.delay_left[write] = dry_left;
  history.delay_right[write] = dry_right;
  history.detector_left[write] = dry_left;
  history.detector_right[write] = dry_right;
  float left = history.delay_left[read];
  float right = history.delay_right[read];
  if (gate) {
    daw_audio_gate_state state = processor.gate;
    state.threshold_db = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_GATE_THRESHOLD_DB, frame, state.threshold_db);
    state.ratio = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_GATE_RATIO, frame, state.ratio);
    state.attack_ms = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_GATE_ATTACK_MS, frame, state.attack_ms);
    state.hold_ms = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_GATE_HOLD_MS, frame, state.hold_ms);
    state.release_ms = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_GATE_RELEASE_MS, frame, state.release_ms);
    state.hysteresis_db = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_GATE_HYSTERESIS_DB, frame, state.hysteresis_db);
    state.range_db = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_GATE_RANGE_DB, frame, state.range_db);
    state.lookahead_ms = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_GATE_LOOKAHEAD_MS, frame, state.lookahead_ms);
    state.link = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_GATE_LINK, frame, state.link);
    state.sidechain_frequency_hz = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_GATE_SIDECHAIN_FREQUENCY_HZ, frame, state.sidechain_frequency_hz);
    state.sidechain_q = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_GATE_SIDECHAIN_Q, frame, state.sidechain_q);
    float detector_left = sidechain_left;
    float detector_right = sidechain_right;
    if (state.sidechain_enabled != 0) {
      const BiquadCoefficients filter = rbj_coefficients(DAW_AUDIO_EQ_BAND_HIGHPASS, state.sidechain_frequency_hz, state.sidechain_q, 0.0F, core.config.sample_rate_hz);
      detector_left = process_biquad(detector_left, filter, history.sidechain[0]);
      detector_right = process_biquad(detector_right, filter, history.sidechain[1]);
    }
    history.detector_left[write] = detector_left;
    history.detector_right[write] = detector_right;
    const uint32_t detector_delay = fixed_delay - std::min(fixed_delay, dynamics_delay_frames(state.lookahead_ms, core.config.sample_rate_hz));
    const uint32_t detector_read = (write + kMaximumDynamicsDelayFrames - detector_delay) % kMaximumDynamicsDelayFrames;
    const std::array<float, 2> detector{history.detector_left[detector_read], history.detector_right[detector_read]};
    std::array<float, 2> levels{std::abs(detector[0]), std::abs(detector[1])};
    if (state.detector != 0) {
      const float alpha = std::exp(-1.0F / (0.01F * static_cast<float>(core.config.sample_rate_hz)));
      for (uint32_t channel = 0; channel < 2; ++channel) {
        history.rms[channel] = alpha * history.rms[channel] + (1.0F - alpha) * detector[channel] * detector[channel];
        levels[channel] = std::sqrt(history.rms[channel]);
      }
    }
    const float linked = std::fmax(levels[0], levels[1]);
    for (uint32_t channel = 0; channel < 2; ++channel) {
      const float level = levels[channel] + (linked - levels[channel]) * state.link;
      const float db = dynamics_gain_to_db(std::fmax(level, 1e-8F));
      if (level > 1e-8F) history.started[channel] = 1;
      const uint32_t hold = static_cast<uint32_t>(std::round(state.hold_ms * static_cast<float>(core.config.sample_rate_hz) / 1000.0F));
      if (history.open[channel] == 0 && db >= state.threshold_db) {
        history.open[channel] = 1; history.hold[channel] = hold;
      } else if (history.open[channel] != 0 && history.started[channel] != 0) {
        if (db >= state.threshold_db - state.hysteresis_db) history.hold[channel] = hold;
        else if (history.hold[channel] > 0) --history.hold[channel];
        else history.open[channel] = 0;
      }
      const float target_db = history.open[channel] != 0 ? 0.0F
        : state.mode != 0 ? std::fmax(state.range_db, (db - state.threshold_db) * (state.ratio - 1.0F)) : state.range_db;
      const float target = state.enabled != 0 && processor.bypassed == 0 ? dynamics_db_to_gain(target_db) : 1.0F;
      const float milliseconds = target > history.gain[channel] ? state.attack_ms : state.release_ms;
      const float coefficient = std::exp(-1.0F / (std::fmax(0.1F, milliseconds) * 0.001F * static_cast<float>(core.config.sample_rate_hz)));
      history.gain[channel] = target + coefficient * (history.gain[channel] - target);
    }
  } else if (compressor) {
    daw_audio_compressor_state state = processor.compressor;
    state.threshold_db = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_THRESHOLD_DB, frame, state.threshold_db);
    state.ratio = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_RATIO, frame, state.ratio);
    state.attack_ms = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_ATTACK_MS, frame, state.attack_ms);
    state.release_ms = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_RELEASE_MS, frame, state.release_ms);
    state.makeup_db = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_MAKEUP_DB, frame, state.makeup_db);
    state.output_db = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_OUTPUT_DB, frame, state.output_db);
    state.dry_wet = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_DRY_WET, frame, state.dry_wet);
    state.knee_db = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_KNEE_DB, frame, state.knee_db);
    state.lookahead_ms = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_LOOKAHEAD_MS, frame, state.lookahead_ms);
    state.sidechain_frequency_hz = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_SIDECHAIN_FREQUENCY_HZ, frame, state.sidechain_frequency_hz);
    state.sidechain_q = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_SIDECHAIN_Q, frame, state.sidechain_q);
    const uint32_t detector_read = (write + kMaximumDynamicsDelayFrames - (fixed_delay - std::min(fixed_delay, dynamics_delay_frames(state.lookahead_ms, core.config.sample_rate_hz)))) % kMaximumDynamicsDelayFrames;
    history.detector_left[write] = 0.5F * (sidechain_left + sidechain_right);
    float detector = history.detector_left[detector_read];
    if (state.sidechain_enabled != 0) {
      const float coefficient = 1.0F - std::exp(-6.2831853071795864769F * std::fmin(state.sidechain_frequency_hz, static_cast<float>(core.config.sample_rate_hz) * 0.45F) / static_cast<float>(core.config.sample_rate_hz));
      history.compressor_sc_low += coefficient * (detector - history.compressor_sc_low);
      history.compressor_sc_band += coefficient * (detector - history.compressor_sc_low - history.compressor_sc_band / state.sidechain_q);
      detector = state.sidechain_filter_type == 1 ? history.compressor_sc_low : state.sidechain_filter_type == 2 ? history.compressor_sc_band : detector - history.compressor_sc_low;
    }
    const float level = state.detector_mode != 0
      ? std::sqrt(history.compressor_rms = history.compressor_rms * 0.99F + detector * detector * 0.01F)
      : std::abs(detector);
    const float target_db = state.enabled != 0 && processor.bypassed == 0 ? compressor_curve_db(dynamics_gain_to_db(level), state) - dynamics_gain_to_db(level) : 0.0F;
    const float release_ms = state.auto_release != 0 ? std::fmax(state.release_ms, state.release_ms * (1.0F + std::fmin(1.0F, -history.compressor_envelope_db / 24.0F))) : state.release_ms;
    if (state.envelope_curve != 0) {
      const float milliseconds = target_db < history.compressor_envelope_db ? state.attack_ms : release_ms;
      const float step_db = 60.0F / std::fmax(1.0F, static_cast<float>(core.config.sample_rate_hz) * milliseconds / 1000.0F);
      history.compressor_envelope_db += std::fmax(-step_db, std::fmin(step_db, target_db - history.compressor_envelope_db));
    } else {
      const float milliseconds = target_db < history.compressor_envelope_db ? state.attack_ms : release_ms;
      const float coefficient = std::exp(-1.0F / std::fmax(1.0F, static_cast<float>(core.config.sample_rate_hz) * milliseconds / 1000.0F));
      history.compressor_envelope_db = target_db + coefficient * (history.compressor_envelope_db - target_db);
    }
    const float gain = dynamics_db_to_gain(history.compressor_envelope_db + state.makeup_db + state.output_db);
    left = left * (1.0F - state.dry_wet) + left * gain * state.dry_wet;
    right = right * (1.0F - state.dry_wet) + right * gain * state.dry_wet;
  } else {
    daw_audio_limiter_state state = processor.limiter;
    state.ceiling_dbtp = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_CEILING, frame, state.ceiling_dbtp);
    state.release_ms = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_RELEASE, frame, state.release_ms);
    state.lookahead_ms = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_LOOKAHEAD_MS, frame, state.lookahead_ms);
    state.link = processor_parameter_value(core, processor, DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_LINK, frame, state.link);
    const uint32_t detector_read = (write + kMaximumDynamicsDelayFrames - (fixed_delay - std::min(fixed_delay, dynamics_delay_frames(state.lookahead_ms, core.config.sample_rate_hz)))) % kMaximumDynamicsDelayFrames;
    const uint32_t true_peak_write = history.limiter_true_peak_write;
    history.limiter_true_peak_left[true_peak_write] = history.detector_left[detector_read];
    history.limiter_true_peak_right[true_peak_write] = history.detector_right[detector_read];
    const double detector_left = limiter_true_peak(history.limiter_true_peak_left, true_peak_write);
    const double detector_right = limiter_true_peak(history.limiter_true_peak_right, true_peak_write);
    history.limiter_true_peak_write = (true_peak_write + 1) % 12;
    const float ceiling = dynamics_db_to_gain(state.ceiling_dbtp);
    const float target_left = static_cast<float>(std::fmin(1.0, static_cast<double>(ceiling) / std::fmax(detector_left, 1e-12)));
    const float target_right = static_cast<float>(std::fmin(1.0, static_cast<double>(ceiling) / std::fmax(detector_right, 1e-12)));
    const float linked = std::fmin(target_left, target_right);
    const std::array<float, 2> targets{target_left + (linked - target_left) * state.link, target_right + (linked - target_right) * state.link};
    const float release = std::exp(-1.0F / (state.release_ms * 0.001F * static_cast<float>(core.config.sample_rate_hz)));
    for (uint32_t channel = 0; channel < 2; ++channel) history.gain[channel] = targets[channel] < history.gain[channel] ? targets[channel] : 1.0F + release * (history.gain[channel] - 1.0F);
    if (state.enabled == 0 || processor.bypassed != 0) history.gain = {1.0F, 1.0F};
  }
  history.write = (write + 1) % kMaximumDynamicsDelayFrames;
  if (gate) {
    left *= history.gain[0];
    right *= history.gain[1];
  } else if (!compressor) {
    left *= history.gain[0];
    right *= history.gain[1];
  }
  *output_left = std::isfinite(left) ? left : 0.0F;
  *output_right = std::isfinite(right) ? right : 0.0F;
}

float spectral_parameter(
  const Core &core, const GraphRevision::Processor &processor, uint32_t target, uint32_t frame, float fallback) {
  return processor_parameter_value(core, processor, target, frame, fallback);
}

float spectral_transform_parameter(
  const Core &core, const GraphRevision::Processor &processor, uint32_t target, uint32_t frame, float fallback) {
  return processor_parameter_value(core, processor, target, frame, fallback);
}

void spectral_fft(std::array<float, kMaximumSpectralFftSize> &real,
                  std::array<float, kMaximumSpectralFftSize> &imaginary,
                  uint32_t size, bool inverse) {
  for (uint32_t index = 1, reversed = 0; index < size; ++index) {
    uint32_t bit = size >> 1u;
    while ((reversed & bit) != 0) {
      reversed ^= bit;
      bit >>= 1u;
    }
    reversed ^= bit;
    if (index < reversed) {
      const float real_value = real[index]; real[index] = real[reversed]; real[reversed] = real_value;
      const float imaginary_value = imaginary[index]; imaginary[index] = imaginary[reversed]; imaginary[reversed] = imaginary_value;
    }
  }
  for (uint32_t length = 2; length <= size; length <<= 1u) {
    const float angle = (inverse ? 2.0F : -2.0F) * 3.14159265358979323846F / static_cast<float>(length);
    const float step_real = std::cos(angle);
    const float step_imaginary = std::sin(angle);
    for (uint32_t start = 0; start < size; start += length) {
      float twiddle_real = 1.0F;
      float twiddle_imaginary = 0.0F;
      for (uint32_t offset = 0; offset < length / 2; ++offset) {
        const uint32_t even = start + offset;
        const uint32_t odd = even + length / 2;
        const float odd_real = real[odd] * twiddle_real - imaginary[odd] * twiddle_imaginary;
        const float odd_imaginary = real[odd] * twiddle_imaginary + imaginary[odd] * twiddle_real;
        real[odd] = real[even] - odd_real; imaginary[odd] = imaginary[even] - odd_imaginary;
        real[even] += odd_real; imaginary[even] += odd_imaginary;
        const float next_real = twiddle_real * step_real - twiddle_imaginary * step_imaginary;
        twiddle_imaginary = twiddle_real * step_imaginary + twiddle_imaginary * step_real;
        twiddle_real = next_real;
      }
    }
  }
  if (inverse) for (uint32_t index = 0; index < size; ++index) {
    real[index] /= static_cast<float>(size); imaginary[index] /= static_cast<float>(size);
  }
}

float spectral_median(std::array<float, kMaximumSpectralBins> &values, uint32_t count) {
  for (uint32_t index = 1; index < count; ++index) {
    const float value = values[index];
    uint32_t cursor = index;
    while (cursor > 0 && values[cursor - 1] > value) {
      values[cursor] = values[cursor - 1];
      --cursor;
    }
    values[cursor] = value;
  }
  return values[count / 2];
}

void reset_spectral_history(SpectralHistory &history, const daw_audio_spectral_state &state) {
  if (history.fft_size == state.fft_size && history.overlap == state.overlap) return;
  history = SpectralHistory{};
  history.fft_size = state.fft_size;
  history.overlap = state.overlap;
  history.hop_size = state.fft_size / state.overlap;
  history.samples_until_frame = state.fft_size;
  for (auto &gain : history.gate_gain) gain.fill(1.0F);
}

void transform_spectrum(
  Core &core, GraphRevision::Processor &processor, SpectralHistory &history, uint32_t channel, uint32_t frame) {
  const daw_audio_spectral_state &state = processor.spectral;
  auto &real = history.real[channel];
  auto &imaginary = history.imaginary[channel];
  auto &side_real = history.side_real[channel];
  auto &side_imaginary = history.side_imaginary[channel];
  const uint32_t bins = state.fft_size / 2 + 1;
  const float freeze = spectral_transform_parameter(core, processor, 15, frame, state.freeze);
  const float threshold_db = spectral_transform_parameter(core, processor, 16, frame, state.gate_threshold_db);
  const float attack_ms = spectral_transform_parameter(core, processor, 17, frame, state.gate_attack_ms);
  const float release_ms = spectral_transform_parameter(core, processor, 18, frame, state.gate_release_ms);
  const float morph = spectral_transform_parameter(core, processor, 19, frame, state.morph);
  const float bin_shift = spectral_transform_parameter(core, processor, 20, frame, state.bin_shift);
  const float blur = spectral_transform_parameter(core, processor, 21, frame, state.blur);
  const float hpss_balance = spectral_transform_parameter(core, processor, 22, frame, state.harmonic_percussive_balance);
  const float noise_reduction = spectral_transform_parameter(core, processor, 23, frame, state.noise_reduction);
  const float profile_learn = spectral_transform_parameter(core, processor, 24, frame, state.profile_learn);
  if (state.mode == DAW_AUDIO_SPECTRAL_MODE_FREEZE) {
    if (freeze > 0.0F && !history.freeze_captured[channel]) {
      for (uint32_t bin = 0; bin < bins; ++bin) {
        history.frozen_magnitude[channel][bin] = std::hypot(real[bin], imaginary[bin]);
        history.frozen_phase[channel][bin] = std::atan2(imaginary[bin], real[bin]);
      }
      history.freeze_captured[channel] = true;
    } else if (freeze == 0.0F) history.freeze_captured[channel] = false;
    if (history.freeze_captured[channel]) for (uint32_t bin = 0; bin < bins; ++bin) {
      real[bin] = history.frozen_magnitude[channel][bin] * std::cos(history.frozen_phase[channel][bin]);
      imaginary[bin] = history.frozen_magnitude[channel][bin] * std::sin(history.frozen_phase[channel][bin]);
    }
  } else if (state.mode == DAW_AUDIO_SPECTRAL_MODE_GATE) {
    const float threshold = std::pow(10.0F, threshold_db / 20.0F);
    const float attack = std::exp(-static_cast<float>(history.hop_size) / std::fmax(1.0F, attack_ms * 0.001F * core.config.sample_rate_hz));
    const float release = std::exp(-static_cast<float>(history.hop_size) / std::fmax(1.0F, release_ms * 0.001F * core.config.sample_rate_hz));
    for (uint32_t bin = 0; bin < bins; ++bin) {
      const float target = std::hypot(real[bin], imaginary[bin]) >= threshold ? 1.0F : 0.0F;
      const float coefficient = target > history.gate_gain[channel][bin] ? attack : release;
      history.gate_gain[channel][bin] = target + coefficient * (history.gate_gain[channel][bin] - target);
      real[bin] *= history.gate_gain[channel][bin]; imaginary[bin] *= history.gate_gain[channel][bin];
    }
  } else if (state.mode == DAW_AUDIO_SPECTRAL_MODE_MORPH) {
    for (uint32_t bin = 0; bin < bins; ++bin) {
      const float phase = std::atan2(imaginary[bin], real[bin]);
      const float magnitude = std::hypot(real[bin], imaginary[bin]) * (1.0F - morph)
        + std::hypot(side_real[bin], side_imaginary[bin]) * morph;
      real[bin] = magnitude * std::cos(phase); imaginary[bin] = magnitude * std::sin(phase);
    }
  } else if (state.mode == DAW_AUDIO_SPECTRAL_MODE_SHIFT_BLUR) {
    for (uint32_t bin = 0; bin < bins; ++bin) history.scratch[channel][bin] = std::hypot(real[bin], imaginary[bin]);
    const int32_t radius = std::min(15, static_cast<int32_t>(std::ceil(blur * 15.0F)));
    for (uint32_t bin = 0; bin < bins; ++bin) {
      const float source = static_cast<float>(bin) - bin_shift;
      const int32_t lower = static_cast<int32_t>(std::floor(source));
      const float fraction = source - static_cast<float>(lower);
      const float shifted = lower >= 0 && static_cast<uint32_t>(lower + 1) < bins
        ? history.scratch[channel][static_cast<uint32_t>(lower)] * (1.0F - fraction) + history.scratch[channel][static_cast<uint32_t>(lower + 1)] * fraction : 0.0F;
      float sum = 0.0F; uint32_t count = 0;
      for (int32_t offset = -radius; offset <= radius; ++offset) {
        const int32_t candidate = lower + offset;
        if (candidate >= 0 && static_cast<uint32_t>(candidate) < bins) {
          sum += history.scratch[channel][static_cast<uint32_t>(candidate)]; ++count;
        }
      }
      const float magnitude = shifted * (1.0F - blur) + (count == 0 ? 0.0F : sum / static_cast<float>(count)) * blur;
      const float phase = std::atan2(imaginary[bin], real[bin]);
      real[bin] = magnitude * std::cos(phase); imaginary[bin] = magnitude * std::sin(phase);
    }
  } else if (state.mode == DAW_AUDIO_SPECTRAL_MODE_HPSS) {
    const uint32_t history_offset = history.hpss_index[channel] * kMaximumSpectralBins;
    for (uint32_t bin = 0; bin < bins; ++bin) history.hpss_history[channel][history_offset + bin] = std::hypot(real[bin], imaginary[bin]);
    history.hpss_index[channel] = (history.hpss_index[channel] + 1) % kSpectralHpssFrames;
    for (uint32_t bin = 0; bin < bins; ++bin) {
      uint32_t count = 0;
      for (int32_t offset = -15; offset <= 15; ++offset) {
        const int32_t candidate = static_cast<int32_t>(bin) + offset;
        if (candidate >= 0 && static_cast<uint32_t>(candidate) < bins) history.scratch[channel][count++] = history.hpss_history[channel][history_offset + static_cast<uint32_t>(candidate)];
      }
      const float percussive = spectral_median(history.scratch[channel], count);
      for (uint32_t sample = 0; sample < kSpectralHpssFrames; ++sample) history.scratch[channel][sample] = history.hpss_history[channel][sample * kMaximumSpectralBins + bin];
      const float harmonic = spectral_median(history.scratch[channel], kSpectralHpssFrames);
      const float balance = (hpss_balance + 1.0F) * 0.5F;
      const float mask = (harmonic * balance + percussive * (1.0F - balance)) / std::fmax(1e-12F, harmonic + percussive);
      real[bin] *= mask; imaginary[bin] *= mask;
    }
  } else {
    for (uint32_t bin = 0; bin < bins; ++bin) {
      const float magnitude = std::hypot(real[bin], imaginary[bin]);
      const float detector = std::hypot(side_real[bin], side_imaginary[bin]);
      const float profile_input = detector > 0.0F ? detector : magnitude;
      history.noise_profile[channel][bin] += (profile_input - history.noise_profile[channel][bin]) * profile_learn;
      const float gain = magnitude > 0.0F ? std::fmax(0.0F, 1.0F - noise_reduction * history.noise_profile[channel][bin] / magnitude) : 0.0F;
      real[bin] *= gain; imaginary[bin] *= gain;
    }
  }
  for (uint32_t bin = 1; bin < state.fft_size / 2; ++bin) {
    real[state.fft_size - bin] = real[bin]; imaginary[state.fft_size - bin] = -imaginary[bin];
  }
}

void process_spectral_frame(Core &core, GraphRevision::Processor &processor, SpectralHistory &history, uint32_t frame) {
  const uint32_t input_mask = kMaximumSpectralFftSize - 1;
  const uint32_t output_mask = kMaximumSpectralFftSize * 2 - 1;
  const uint32_t frame_start = (history.write_index - processor.spectral.fft_size + kMaximumSpectralFftSize) & input_mask;
  for (uint32_t channel = 0; channel < 2; ++channel) {
    for (uint32_t index = 0; index < processor.spectral.fft_size; ++index) {
      const uint32_t source = (frame_start + index) & input_mask;
      const float window = std::sqrt(0.5F - 0.5F * std::cos(6.2831853071795864769F * static_cast<float>(index) / processor.spectral.fft_size));
      history.real[channel][index] = history.input[channel][source] * window; history.imaginary[channel][index] = 0.0F;
      history.side_real[channel][index] = history.sidechain[channel][source] * window; history.side_imaginary[channel][index] = 0.0F;
    }
    spectral_fft(history.real[channel], history.imaginary[channel], processor.spectral.fft_size, false);
    if (processor.spectral.mode == DAW_AUDIO_SPECTRAL_MODE_MORPH || processor.spectral.mode == DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE) {
      spectral_fft(history.side_real[channel], history.side_imaginary[channel], processor.spectral.fft_size, false);
    }
    transform_spectrum(core, processor, history, channel, frame);
    spectral_fft(history.real[channel], history.imaginary[channel], processor.spectral.fft_size, true);
    for (uint32_t index = 0; index < processor.spectral.fft_size; ++index) {
      const float window = std::sqrt(0.5F - 0.5F * std::cos(6.2831853071795864769F * static_cast<float>(index) / processor.spectral.fft_size));
      const uint32_t target = (history.write_index + index) & output_mask;
      history.output[channel][target] += history.real[channel][index] * window * (2.0F / processor.spectral.overlap);
    }
  }
}

void render_spectral_processor(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  float input_left, float input_right, float sidechain_left, float sidechain_right, float *output_left, float *output_right) {
  SpectralHistory &history = core.spectral_histories[processor.spectral_slot];
  reset_spectral_history(history, processor.spectral);
  const uint32_t input_mask = kMaximumSpectralFftSize - 1;
  const uint32_t output_mask = kMaximumSpectralFftSize * 2 - 1;
  const std::array<float, 2> input{std::isfinite(input_left) ? input_left : 0.0F, std::isfinite(input_right) ? input_right : 0.0F};
  const std::array<float, 2> sidechain{std::isfinite(sidechain_left) ? sidechain_left : 0.0F, std::isfinite(sidechain_right) ? sidechain_right : 0.0F};
  const float bypass_step = 1.0F / std::fmax(1.0F, std::round(0.01F * core.config.sample_rate_hz));
  history.bypass = clamp_bypass_step(history.bypass, processor.bypassed != 0 || processor.spectral.enabled == 0 ? 1.0F : 0.0F, bypass_step);
  std::array<float, 2> output{};
  for (uint32_t channel = 0; channel < 2; ++channel) {
    history.input[channel][history.write_index & input_mask] = input[channel];
    history.sidechain[channel][history.write_index & input_mask] = sidechain[channel];
    history.dry[channel][(history.write_index + processor.spectral.fft_size) & output_mask] = input[channel];
    const float wet = history.output[channel][history.write_index];
    const float dry = history.dry[channel][history.write_index];
    history.output[channel][history.write_index] = 0.0F;
    history.dry[channel][history.write_index] = 0.0F;
    const float mix = spectral_parameter(core, processor, 25, frame, processor.spectral.mix);
    const float processed = dry * (1.0F - mix) + wet * mix;
    output[channel] = processed + (dry - processed) * history.bypass;
  }
  history.write_index = (history.write_index + 1) & output_mask;
  if (--history.samples_until_frame == 0) {
    process_spectral_frame(core, processor, history, frame);
    history.samples_until_frame = history.hop_size;
  }
  *output_left = output[0];
  *output_right = output[1];
}

struct ProcessorImplementation {
  uint32_t kind;
  ProcessorRenderer render;
};

constexpr std::array<ProcessorImplementation, 17> kProcessorImplementations{{
  {DAW_AUDIO_PROCESSOR_KIND_UTILITY, render_utility_processor},
  {DAW_AUDIO_PROCESSOR_KIND_SATURATOR, render_saturator_processor},
  {DAW_AUDIO_PROCESSOR_KIND_EQ, render_eq_processor},
  {DAW_AUDIO_PROCESSOR_KIND_CHORUS, render_modulation_processor},
  {DAW_AUDIO_PROCESSOR_KIND_FLANGER, render_modulation_processor},
  {DAW_AUDIO_PROCESSOR_KIND_PHASER, render_modulation_processor},
  {DAW_AUDIO_PROCESSOR_KIND_TREMOLO, render_modulation_processor},
  {DAW_AUDIO_PROCESSOR_KIND_AUTOPAN, render_modulation_processor},
  {DAW_AUDIO_PROCESSOR_KIND_ENSEMBLE, render_modulation_processor},
  {DAW_AUDIO_PROCESSOR_KIND_GATE, render_dynamics_processor},
  {DAW_AUDIO_PROCESSOR_KIND_COMPRESSOR, render_dynamics_processor},
  {DAW_AUDIO_PROCESSOR_KIND_LIMITER, render_dynamics_processor},
  {DAW_AUDIO_PROCESSOR_KIND_DELAY, render_time_effect_processor},
  {DAW_AUDIO_PROCESSOR_KIND_REVERB, render_time_effect_processor},
  {DAW_AUDIO_PROCESSOR_KIND_SPECTRAL, render_spectral_processor},
  {DAW_AUDIO_PROCESSOR_KIND_AUTOFILTER, render_autofilter_processor},
  {DAW_AUDIO_PROCESSOR_KIND_LOFI, render_lofi_processor},
}};

ProcessorRenderer find_processor_renderer(uint32_t kind) {
  for (const ProcessorImplementation &implementation : kProcessorImplementations) {
    if (implementation.kind == kind) return implementation.render;
  }
  return nullptr;
}

daw_audio_asset_handle make_asset_handle(uint32_t index, uint32_t generation) {
  return (static_cast<daw_audio_asset_handle>(generation) << 32u) | static_cast<daw_audio_asset_handle>(index + 1u);
}

bool decode_asset_handle(daw_audio_asset_handle handle, uint32_t *index, uint32_t *generation) {
  const uint32_t encoded_index = static_cast<uint32_t>(handle);
  if (encoded_index == 0) return false;
  *index = encoded_index - 1u;
  *generation = static_cast<uint32_t>(handle >> 32u);
  return true;
}

AssetSlot *find_asset(Core *core, daw_audio_asset_handle handle) {
  uint32_t index = 0;
  uint32_t generation = 0;
  if (!decode_asset_handle(handle, &index, &generation) || index >= core->config.max_assets) return nullptr;
  AssetSlot &slot = core->assets[index];
  if (!slot.occupied || slot.generation != generation) return nullptr;
  return &slot;
}

bool valid_transport_state(const daw_audio_transport_state &state) {
  return (state.running == 0 || state.running == 1)
    && state.epoch != 0
    && (state.tempo_bpm == 0.0 || (std::isfinite(state.tempo_bpm) && state.tempo_bpm > 0.0))
    && (state.time_signature_numerator == 0 || state.time_signature_numerator <= 32)
    && (state.time_signature_denominator == 0 || state.time_signature_denominator <= 32)
    && (state.cycle_active == 0 || state.cycle_active == 1)
    && (state.cycle_active == 0
      || (state.cycle_start_frame >= 0 && state.cycle_end_frame > state.cycle_start_frame));
}

[[maybe_unused]] std::int64_t project_time_frame(const Core &core) {
  if (core.transport.cycle_active == 0
    || core.transport.frame < core.transport.cycle_end_frame) return core.transport.frame;
  const auto length = core.transport.cycle_end_frame - core.transport.cycle_start_frame;
  if (length <= 0) return core.transport.frame;
  return core.transport.cycle_start_frame
    + (core.transport.frame - core.transport.cycle_start_frame) % length;
}

[[maybe_unused]] double project_time_music(const Core &core, const std::int64_t frame) {
  if (core.transport.tempo_bpm <= 0.0 || core.config.sample_rate_hz == 0) return 0.0;
  return static_cast<double>(frame) * core.transport.tempo_bpm
    / (60.0 * static_cast<double>(core.config.sample_rate_hz));
}

bool valid_sample_source_event(const daw_audio_sample_source_event &event) {
  return valid_abi(event.abi_version)
    && event.epoch != 0
    && event.sequence != 0
    && event.asset != 0
    && event.stop_frame > event.start_frame
    && event.source_frame_count > 0
    && std::isfinite(event.gain)
    && std::isfinite(event.source_offset_fraction)
    && event.source_offset_fraction >= 0.0F
    && event.source_offset_fraction < 1.0F
    && event.fade_in_start_frame <= event.fade_in_end_frame
    && event.fade_out_start_frame <= event.fade_out_end_frame
    && std::isfinite(event.fade_in_curve)
    && event.fade_in_curve >= -1.0F && event.fade_in_curve <= 1.0F
    && std::isfinite(event.fade_in_curve_position)
    && event.fade_in_curve_position >= 0.0F && event.fade_in_curve_position <= 1.0F
    && std::isfinite(event.fade_out_curve)
    && event.fade_out_curve >= -1.0F && event.fade_out_curve <= 1.0F
    && std::isfinite(event.fade_out_curve_position)
    && event.fade_out_curve_position >= 0.0F && event.fade_out_curve_position <= 1.0F;
}

void clear_sample_sources(Core &core) {
  for (SampleSource &source : core.sample_sources) source.active = false;
}

bool asset_is_active(const Core &core, daw_audio_asset_handle asset) {
  for (const SampleSource &source : core.sample_sources) {
    if (source.active && source.asset == asset) return true;
  }
  for (const InstrumentNodeState &instrument : (*core.published_instruments)) {
    for (uint32_t index = 0; index < instrument.sampler.zone_count; ++index) {
      if (instrument.zones[index].asset == asset) return true;
    }
    for (const SampleVoice &voice : instrument.sample_voices) {
      if (voice.active && voice.asset == asset) return true;
    }
    if (instrument.granular.asset == asset && (instrument.granular_note_count > 0
      || std::any_of(instrument.grains.begin(), instrument.grains.end(), [](const GranularGrain &grain) { return grain.active; }))) return true;
  }
  return false;
}

float linear_fade_gain(int64_t frame, int64_t start, int64_t end, float before, float after) {
  if (end <= start) return frame < end ? before : after;
  if (frame <= start) return before;
  if (frame >= end) return after;
  const double normalized = (static_cast<double>(frame) - static_cast<double>(start))
    / (static_cast<double>(end) - static_cast<double>(start));
  return before + (after - before) * static_cast<float>(normalized);
}

float curved_fade_gain(
  int64_t frame,
  int64_t start,
  int64_t end,
  float before,
  float after,
  float curve,
  float position) {
  if (end <= start) return frame < end ? before : after;
  if (frame <= start) return before;
  if (frame >= end) return after;
  if (curve == 0.0F) {
    return linear_fade_gain(frame, start, end, before, after);
  }
  const double u = (static_cast<double>(frame) - static_cast<double>(start))
    / (static_cast<double>(end) - static_cast<double>(start));
  const double p = static_cast<double>(position);
  const double c = static_cast<double>(curve);
  const double linear_gain = static_cast<double>(before) + (static_cast<double>(after) - static_cast<double>(before)) * p;
  const double control_gain = c >= 0.0
    ? linear_gain + (1.0 - linear_gain) * c
    : linear_gain + linear_gain * c;
  const double discriminant = std::max(0.0, p * p + (1.0 - 2.0 * p) * u);
  const double denominator = p + std::sqrt(discriminant);
  double t = denominator > 0.0 ? u / denominator : 0.0;
  t = std::min(1.0, std::max(0.0, t));
  const double inverse = 1.0 - t;
  const double gain = inverse * inverse * static_cast<double>(before)
    + 2.0 * inverse * t * control_gain
    + t * t * static_cast<double>(after);
  return static_cast<float>(std::min(1.0, std::max(0.0, gain)));
}

float source_envelope_gain(const SampleSource &source, int64_t transport_frame) {
  const float fade_in = curved_fade_gain(
    transport_frame, source.fade_in_start_frame, source.fade_in_end_frame, 0.0F, 1.0F,
    source.fade_in_curve, source.fade_in_curve_position);
  const float fade_out = curved_fade_gain(
    transport_frame, source.fade_out_start_frame, source.fade_out_end_frame, 1.0F, 0.0F,
    source.fade_out_curve, source.fade_out_curve_position);
  return source.gain * fade_in * fade_out;
}

void prepare_active_source_ranges(Core &core, const GraphRevision *graph) {
  core.active_source_ranges = {};
  core.root_source_range = {};
  uint16_t count = 0;
  if (graph != nullptr) {
    for (uint32_t node_index = 0; node_index < graph->node_count; ++node_index) {
      GraphRevision::Range &range = core.active_source_ranges[node_index];
      range.start = count;
      if (graph->nodes[node_index].kind != DAW_AUDIO_GRAPH_NODE_SOURCE) continue;
      for (uint32_t source_index = 0; source_index < core.sample_sources.size(); ++source_index) {
        const SampleSource &source = core.sample_sources[source_index];
        if (source.active && source.source_node_id == graph->nodes[node_index].id) {
          core.active_source_indices[count++] = static_cast<uint16_t>(source_index);
          ++range.count;
        }
      }
    }
  }
  core.root_source_range.start = count;
  for (uint32_t source_index = 0; source_index < core.sample_sources.size(); ++source_index) {
    const SampleSource &source = core.sample_sources[source_index];
    if (source.active && source.source_node_id == 0) {
      core.active_source_indices[count++] = static_cast<uint16_t>(source_index);
      ++core.root_source_range.count;
    }
  }
}

void render_sample_source_range(
  Core &core,
  GraphRevision::Range range,
  int64_t transport_frame,
  float *left_output,
  float *right_output) {
  if (core.transport.running == 0) return;
  const uint32_t end = static_cast<uint32_t>(range.start) + range.count;
  for (uint32_t position = range.start; position < end; ++position) {
    SampleSource &source = core.sample_sources[core.active_source_indices[position]];
    if (!source.active) continue;
    if (transport_frame >= source.stop_frame) {
      source.active = false;
      continue;
    }
    if (transport_frame < source.start_frame) continue;
    AssetSlot *asset = find_asset(&core, source.asset);
    if (asset == nullptr) {
      source.active = false;
      continue;
    }
    const uint64_t elapsed_output_frames = static_cast<uint64_t>(transport_frame - source.start_frame);
    const double source_position = static_cast<double>(source.source_offset_frame)
      + static_cast<double>(source.source_offset_fraction)
      + static_cast<double>(elapsed_output_frames) * static_cast<double>(asset->sample_rate_hz)
        / static_cast<double>(core.config.sample_rate_hz);
    const double source_end = static_cast<double>(source.source_offset_frame)
      + static_cast<double>(source.source_offset_fraction)
      + static_cast<double>(source.source_frame_count);
    if (source_position >= source_end
      || source.source_offset_frame >= asset->frame_count
      || source_position < 0.0
      || source_position >= static_cast<double>(asset->frame_count)) {
      source.active = false;
      continue;
    }
    const uint64_t source_frame = static_cast<uint64_t>(std::floor(source_position));
    const uint64_t next_source_frame = std::min(source_frame + 1, static_cast<uint64_t>(asset->frame_count - 1));
    const float fraction = static_cast<float>(source_position - static_cast<double>(source_frame));
    const float gain = source_envelope_gain(source, transport_frame);
    const float left = fraction == 0.0F
      ? asset->planes[0][source_frame]
      : asset->planes[0][source_frame]
        + (asset->planes[0][next_source_frame] - asset->planes[0][source_frame]) * fraction;
    const uint32_t right_channel = asset->channel_count > 1 ? 1 : 0;
    const float right = fraction == 0.0F
      ? asset->planes[right_channel][source_frame]
      : asset->planes[right_channel][source_frame]
        + (asset->planes[right_channel][next_source_frame] - asset->planes[right_channel][source_frame]) * fraction;
    *left_output += std::isfinite(left) ? left * gain : 0.0F;
    if (right_output != left_output) *right_output += std::isfinite(right) ? right * gain : 0.0F;
  }
}

constexpr uint32_t kGraphPreFxStage = 0;
constexpr uint32_t kGraphPreFaderStage = 1;

bool allocate_graph_stage_buffers(Core &core) {
  const std::size_t graph_stage_samples = static_cast<std::size_t>(2u) * kMaximumGraphNodes * 2u
    * core.config.max_frames_per_block;
  std::unique_ptr<float[]> buffers(new (std::nothrow) float[graph_stage_samples]);
  if (!buffers) return false;
  core.graph_stage_buffers = std::move(buffers);
  return true;
}

float *graph_stage_sample(
  Core &core,
  uint32_t stage,
  uint32_t node_index,
  uint32_t channel,
  uint32_t frame) {
  const std::size_t offset = (((static_cast<std::size_t>(stage) * kMaximumGraphNodes + node_index) * 2u + channel)
    * core.config.max_frames_per_block) + frame;
  return core.graph_stage_buffers.get() + offset;
}

float graph_edge_sample(
  Core &core,
  const GraphRevision &graph,
  uint32_t edge_index,
  uint32_t channel,
  uint32_t frame) {
  const daw_audio_graph_edge_descriptor &edge = graph.edges[edge_index];
  const uint32_t source_index = graph.edge_source_indices[edge_index];
  const uint32_t delay = edge.pdc_delay_frames;
  const float source = edge.tap == DAW_AUDIO_GRAPH_EDGE_PRE_FX
    ? *graph_stage_sample(core, kGraphPreFxStage, source_index, channel, frame) * edge.gain
    : edge.tap == DAW_AUDIO_GRAPH_EDGE_PRE_FADER
      ? *graph_stage_sample(core, kGraphPreFaderStage, source_index, channel, frame) * edge.gain
      : core.graph_buffers[source_index][channel][frame] * edge.gain;
  if (delay == 0) return source;
  const uint32_t cursor = (core.graph_delay_cursors[edge_index] + frame) % delay;
  float &stored = core.graph_delay_lines[edge_index][channel][cursor];
  const float delayed = stored;
  stored = source;
  return delayed;
}

void clear_instrument_state(InstrumentNodeState &instrument);
void release_instrument_state(InstrumentNodeState &instrument);

void clear_instrument_voices(Core &core) {
  for (InstrumentNodeState &instrument : (*core.published_instruments)) {
    clear_instrument_state(instrument);
  }
}

#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
void release_instrument_voices(Core &core) {
  for (InstrumentNodeState &instrument : (*core.published_instruments)) release_instrument_state(instrument);
}
#endif

void release_instrument_state(InstrumentNodeState &instrument) {
  for (InstrumentVoice &voice : instrument.voices) {
    if (!voice.active) continue;
    voice.held = false;
    voice.references = 0;
    voice.released = true;
  }
  for (SampleVoice &voice : instrument.sample_voices) {
    if (voice.active) voice.released = true;
  }
  instrument.sustain = false;
}

void clear_instrument_state(InstrumentNodeState &instrument) {
  instrument.voices = {};
  instrument.sample_voices = {};
  instrument.grains = {};
  instrument.granular_note_ids = {};
  instrument.granular_note_count = 0;
  instrument.granular_next_frame = 0.0;
  instrument.granular_frozen_position = -1.0F;
  instrument.granular_random_state = instrument.granular.seed == 0 ? 1 : instrument.granular.seed;
  instrument.expression = 1.0F;
  instrument.sustain = false;
  instrument.next_age = 1;
}

bool is_native_instrument_event(const std::uint32_t type) {
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  return type >= static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOn)
    && type <= static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kAllSoundOff);
#else
  static_cast<void>(type);
  return false;
#endif
}

bool is_native_transport_release(const std::uint32_t type) {
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  return type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kTransportRelease);
#else
  static_cast<void>(type);
  return false;
#endif
}

bool is_native_all_sound_off(const std::uint32_t type) {
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  return type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kAllSoundOff);
#else
  static_cast<void>(type);
  return false;
#endif
}

bool is_native_live_note_on(const std::uint32_t type) {
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  return type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOn);
#else
  static_cast<void>(type);
  return false;
#endif
}

bool is_native_live_note_off(const std::uint32_t type) {
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  return type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOff);
#else
  static_cast<void>(type);
  return false;
#endif
}

std::uint32_t portable_instrument_event_type(const std::uint32_t type) {
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  if (type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOn)) {
    return DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON;
  }
  if (type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOff)) {
    return DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF;
  }
#endif
  return type;
}

float next_granular_random(InstrumentNodeState &instrument) {
  instrument.granular_random_state = instrument.granular_random_state * 1664525U + 1013904223U;
  return static_cast<float>(instrument.granular_random_state) / 4294967296.0F;
}

float granular_window(uint32_t shape, float phase) {
  const float x = std::fmax(0.0F, std::fmin(1.0F, phase));
  if (shape == DAW_AUDIO_GRANULAR_WINDOW_TUKEY) {
    if (x < 0.25F) return 0.5F * (1.0F - std::cos(12.5663706143591729538F * x));
    if (x > 0.75F) return 0.5F * (1.0F - std::cos(12.5663706143591729538F * (1.0F - x)));
    return 1.0F;
  }
  if (shape == DAW_AUDIO_GRANULAR_WINDOW_GAUSSIAN) {
    const float normalized = (x - 0.5F) / 0.18F;
    return std::exp(-0.5F * normalized * normalized);
  }
  return 0.5F - 0.5F * std::cos(6.2831853071795864769F * x);
}

float midi_frequency(uint32_t note) {
  return 440.0F * std::pow(2.0F, (static_cast<float>(note) - 69.0F) / 12.0F);
}

float next_noise(InstrumentVoice &voice) {
  uint32_t value = voice.noise_state;
  value ^= value << 13U;
  value ^= value >> 17U;
  value ^= value << 5U;
  voice.noise_state = value == 0 ? 0xA341316CU : value;
  return static_cast<float>(voice.noise_state) / 2147483647.5F - 1.0F;
}

float waveform(uint32_t shape, float phase) {
  if (shape == DAW_AUDIO_SYNTH_WAVEFORM_SQUARE) return phase < 0.5F ? 1.0F : -1.0F;
  if (shape == DAW_AUDIO_SYNTH_WAVEFORM_SAWTOOTH) return 2.0F * phase - 1.0F;
  if (shape == DAW_AUDIO_SYNTH_WAVEFORM_TRIANGLE) return 1.0F - 4.0F * std::fabs(phase - 0.5F);
  return std::sin(6.2831853071795864769F * phase);
}

float envelope_step(float level, uint32_t *stage, bool released, float attack, float decay, float sustain, float release) {
  if (released) {
    *stage = 3;
    return std::fmax(0.0F, level - release);
  }
  if (*stage == 0) {
    level += attack;
    if (level >= 1.0F) {
      level = 1.0F;
      *stage = 1;
    }
    return level;
  }
  if (*stage == 1) {
    level -= decay;
    if (level <= sustain) {
      level = sustain;
      *stage = 2;
    }
  }
  return level;
}

float synth_parameter_value(const InstrumentNodeState &instrument, uint32_t target, float fallback) {
  if (target == DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_GAIN) return instrument.synth.output_gain;
  if (target == DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_PAN) return instrument.synth.output_pan;
  if (target == DAW_AUDIO_SYNTH_PARAMETER_FILTER_CUTOFF_HZ) return instrument.synth.filter_cutoff_hz;
  if (target == DAW_AUDIO_SYNTH_PARAMETER_FILTER_RESONANCE) return instrument.synth.filter_resonance;
  if (target == DAW_AUDIO_SYNTH_PARAMETER_AMP_ATTACK_MS) return instrument.synth.amp_attack_ms;
  if (target == DAW_AUDIO_SYNTH_PARAMETER_AMP_DECAY_MS) return instrument.synth.amp_decay_ms;
  if (target == DAW_AUDIO_SYNTH_PARAMETER_AMP_SUSTAIN) return instrument.synth.amp_sustain;
  if (target == DAW_AUDIO_SYNTH_PARAMETER_AMP_RELEASE_MS) return instrument.synth.amp_release_ms;
  return fallback;
}

bool instrument_declares_target(const daw_audio_instrument_state_descriptor &descriptor, uint32_t target) {
  for (uint32_t index = 0; index < descriptor.parameter_count; ++index) {
    if (descriptor.parameter_targets[index] == target) return true;
  }
  return false;
}

bool set_synth_parameter(InstrumentNodeState &instrument, uint32_t target, float value) {
  if (!std::isfinite(value)) return false;
  if (target == DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_GAIN && value >= 0.0F && value <= 1.5F) instrument.synth.output_gain = value;
  else if (target == DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_PAN && value >= -1.0F && value <= 1.0F) instrument.synth.output_pan = value;
  else if (target == DAW_AUDIO_SYNTH_PARAMETER_FILTER_CUTOFF_HZ && value >= 20.0F && value <= 20000.0F) instrument.synth.filter_cutoff_hz = value;
  else if (target == DAW_AUDIO_SYNTH_PARAMETER_FILTER_RESONANCE && value >= 0.0001F && value <= 30.0F) instrument.synth.filter_resonance = value;
  else if (target == DAW_AUDIO_SYNTH_PARAMETER_AMP_ATTACK_MS && value >= 0.0F && value <= 60000.0F) instrument.synth.amp_attack_ms = value;
  else if (target == DAW_AUDIO_SYNTH_PARAMETER_AMP_DECAY_MS && value >= 0.0F && value <= 60000.0F) instrument.synth.amp_decay_ms = value;
  else if (target == DAW_AUDIO_SYNTH_PARAMETER_AMP_SUSTAIN && value >= 0.0F && value <= 1.0F) instrument.synth.amp_sustain = value;
  else if (target == DAW_AUDIO_SYNTH_PARAMETER_AMP_RELEASE_MS && value >= 0.0F && value <= 60000.0F) instrument.synth.amp_release_ms = value;
  else return false;
  return true;
}

void render_instrument_frame(
  InstrumentNodeState &instrument,
  const daw_audio_instrument_state_descriptor &descriptor,
  uint32_t sample_rate_hz,
  float *left_output,
  float *right_output) {
  float left = 0.0F;
  float right = 0.0F;
  const daw_audio_synth_state &synth = instrument.synth;
  const float amp_attack = 1.0F / std::fmax(1.0F, synth_parameter_value(instrument, DAW_AUDIO_SYNTH_PARAMETER_AMP_ATTACK_MS, synth.amp_attack_ms) * sample_rate_hz / 1000.0F);
  const float amp_decay = 1.0F / std::fmax(1.0F, synth_parameter_value(instrument, DAW_AUDIO_SYNTH_PARAMETER_AMP_DECAY_MS, synth.amp_decay_ms) * sample_rate_hz / 1000.0F);
  const float amp_release = 1.0F / std::fmax(1.0F, synth_parameter_value(instrument, DAW_AUDIO_SYNTH_PARAMETER_AMP_RELEASE_MS, synth.amp_release_ms) * sample_rate_hz / 1000.0F);
  const float amp_sustain = synth_parameter_value(instrument, DAW_AUDIO_SYNTH_PARAMETER_AMP_SUSTAIN, synth.amp_sustain);
  for (uint32_t index = 0; index < descriptor.voice_capacity; ++index) {
    InstrumentVoice &voice = instrument.voices[index];
    if (!voice.active) continue;
    voice.amp_level = envelope_step(voice.amp_level, &voice.amp_stage, voice.released, amp_attack, amp_decay, amp_sustain, amp_release);
    const float filter_attack = 1.0F / std::fmax(1.0F, synth.filter_attack_ms * sample_rate_hz / 1000.0F);
    const float filter_decay = 1.0F / std::fmax(1.0F, synth.filter_decay_ms * sample_rate_hz / 1000.0F);
    const float filter_release = 1.0F / std::fmax(1.0F, synth.filter_release_ms * sample_rate_hz / 1000.0F);
    voice.filter_level = envelope_step(voice.filter_level, &voice.filter_stage, voice.released, filter_attack, filter_decay, synth.filter_sustain, filter_release);
    if (voice.amp_level <= 0.0F && voice.released) {
      voice = {};
      continue;
    }
    voice.lfo_phase += synth.lfo_rate_hz / static_cast<float>(sample_rate_hz);
    voice.lfo_phase -= std::floor(voice.lfo_phase);
    const float lfo = synth.lfo_enabled == 0 ? 0.0F : waveform(synth.lfo_waveform, voice.lfo_phase);
    const float base_frequency = midi_frequency(voice.note);
    float sample = synth.noise_enabled != 0 ? next_noise(voice) * synth.noise_level : 0.0F;
    for (uint32_t oscillator_index = 0; oscillator_index < 2; ++oscillator_index) {
      const daw_audio_synth_oscillator_state &oscillator = synth.oscillators[oscillator_index];
      if (oscillator.enabled == 0) continue;
      const float semitones = static_cast<float>(oscillator.octave * 12 + oscillator.semitone)
        + (oscillator.detune_cents + lfo * synth.lfo_pitch_cents) / 100.0F;
      const float increment = base_frequency * std::pow(2.0F, semitones / 12.0F) / static_cast<float>(sample_rate_hz);
      voice.oscillator_phase[oscillator_index] += increment;
      voice.oscillator_phase[oscillator_index] -= std::floor(voice.oscillator_phase[oscillator_index]);
      sample += waveform(oscillator.waveform, voice.oscillator_phase[oscillator_index]) * oscillator.level;
    }
    float cutoff = synth_parameter_value(instrument, DAW_AUDIO_SYNTH_PARAMETER_FILTER_CUTOFF_HZ, synth.filter_cutoff_hz);
    cutoff *= std::pow(2.0F, (static_cast<float>(voice.note) - 60.0F) / 12.0F * synth.filter_key_tracking
      + voice.filter_level * synth.filter_envelope_amount_octaves + lfo * synth.lfo_filter_octaves);
    cutoff = std::fmax(20.0F, std::fmin(cutoff, static_cast<float>(sample_rate_hz) * 0.45F));
    const float resonance = synth_parameter_value(instrument, DAW_AUDIO_SYNTH_PARAMETER_FILTER_RESONANCE, synth.filter_resonance);
    const uint32_t filter_type = synth.filter_mode == DAW_AUDIO_SYNTH_FILTER_MODE_HIGHPASS
      ? DAW_AUDIO_EQ_BAND_HIGHPASS
      : synth.filter_mode == DAW_AUDIO_SYNTH_FILTER_MODE_BANDPASS
        ? DAW_AUDIO_EQ_BAND_BANDPASS
        : synth.filter_mode == DAW_AUDIO_SYNTH_FILTER_MODE_NOTCH
          ? DAW_AUDIO_EQ_BAND_NOTCH
          : DAW_AUDIO_EQ_BAND_LOWPASS;
    const BiquadCoefficients filter_coefficients = rbj_coefficients(
      filter_type, cutoff, std::fmax(0.0001F, resonance), 0.0F, sample_rate_hz);
    const float filtered = synth.filter_enabled == 0
      ? sample
      : process_biquad(sample, filter_coefficients, voice.filter_history[0]);
    const float amplitude = voice.amp_level * voice.velocity * instrument.expression * synth.output_gain
      * std::fmax(0.0F, 1.0F - lfo * synth.lfo_amplitude);
    const float pan = std::fmax(-1.0F, std::fmin(1.0F, synth.output_pan + lfo * synth.lfo_pan));
    left += filtered * amplitude * std::cos((pan + 1.0F) * 0.7853981633974483096F) * 1.4142135623730950488F;
    right += filtered * amplitude * std::sin((pan + 1.0F) * 0.7853981633974483096F) * 1.4142135623730950488F;
  }
  *left_output = std::isfinite(left) ? left : 0.0F;
  *right_output = std::isfinite(right) ? right : 0.0F;
}

void render_sample_instrument_frame(
  Core &core,
  InstrumentNodeState &instrument,
  const daw_audio_instrument_state_descriptor &descriptor,
  float *left_output,
  float *right_output) {
  float left = 0.0F;
  float right = 0.0F;
  const daw_audio_sampler_state &state = instrument.sampler;
  const float attack = 1.0F / std::fmax(1.0F, state.amp_attack_ms * core.config.sample_rate_hz / 1000.0F);
  const float decay = 1.0F / std::fmax(1.0F, state.amp_decay_ms * core.config.sample_rate_hz / 1000.0F);
  const float filter_attack = 1.0F / std::fmax(1.0F, state.filter_attack_ms * core.config.sample_rate_hz / 1000.0F);
  const float filter_decay = 1.0F / std::fmax(1.0F, state.filter_decay_ms * core.config.sample_rate_hz / 1000.0F);
  for (uint32_t index = 0; index < descriptor.voice_capacity; ++index) {
    SampleVoice &voice = instrument.sample_voices[index];
    if (!voice.active) continue;
    const float release_ms = voice.forced_release_ms > 0.0F ? voice.forced_release_ms : state.amp_release_ms;
    const float release = 1.0F / std::fmax(1.0F, release_ms * core.config.sample_rate_hz / 1000.0F);
    voice.amp_level = envelope_step(voice.amp_level, &voice.amp_stage, voice.released, attack, decay, state.amp_sustain, release);
    const float filter_release = 1.0F / std::fmax(1.0F, state.filter_release_ms * core.config.sample_rate_hz / 1000.0F);
    voice.filter_level = envelope_step(voice.filter_level, &voice.filter_stage, voice.released, filter_attack, filter_decay, state.filter_sustain, filter_release);
    AssetSlot *asset = find_asset(&core, voice.asset);
    if (asset == nullptr || (voice.amp_level <= 0.0F && voice.released)) {
      voice = {};
      continue;
    }
    if (voice.position >= static_cast<double>(voice.end_frame)) {
      if (voice.playback_mode == DAW_AUDIO_SAMPLE_PLAYBACK_ONE_SHOT) {
        voice = {};
        continue;
      }
      const double loop_length = static_cast<double>(voice.loop_end_frame - voice.loop_start_frame);
      voice.position = static_cast<double>(voice.loop_start_frame) + std::fmod(
        voice.position - static_cast<double>(voice.loop_start_frame), loop_length);
    }
    auto sample_at = [asset](double position, uint32_t channel) {
      const double bounded = std::fmax(0.0, std::fmin(position, static_cast<double>(asset->frame_count - 1)));
      const uint32_t frame = static_cast<uint32_t>(bounded);
      const uint32_t next = frame + 1 < asset->frame_count ? frame + 1 : frame;
      const float fraction = static_cast<float>(bounded - static_cast<double>(frame));
      return asset->planes[channel][frame]
        + (asset->planes[channel][next] - asset->planes[channel][frame]) * fraction;
    };
    const uint32_t right_channel = asset->channel_count > 1 ? 1 : 0;
    float sample_left = sample_at(voice.position, 0);
    float sample_right = sample_at(voice.position, right_channel);
    if (voice.playback_mode == DAW_AUDIO_SAMPLE_PLAYBACK_CROSSFADE_LOOP
      && voice.crossfade_frame_count > 0
      && voice.position >= static_cast<double>(voice.loop_end_frame - voice.crossfade_frame_count)) {
      const double fade = (voice.position - static_cast<double>(voice.loop_end_frame - voice.crossfade_frame_count))
        / static_cast<double>(voice.crossfade_frame_count);
      const double loop_position = static_cast<double>(voice.loop_start_frame)
        + (voice.position - static_cast<double>(voice.loop_end_frame - voice.crossfade_frame_count));
      sample_left = sample_left * static_cast<float>(1.0 - fade) + sample_at(loop_position, 0) * static_cast<float>(fade);
      sample_right = sample_right * static_cast<float>(1.0 - fade) + sample_at(loop_position, right_channel) * static_cast<float>(fade);
    }
    voice.lfo_phase += state.lfo_rate_hz / static_cast<float>(core.config.sample_rate_hz);
    voice.lfo_phase -= std::floor(voice.lfo_phase);
    const float lfo = state.lfo_enabled == 0 ? 0.0F : std::sin(6.2831853071795864769F * voice.lfo_phase);
    float filtered_left = sample_left;
    float filtered_right = sample_right;
    if (state.filter_enabled != 0) {
      const float cutoff = std::fmax(20.0F, std::fmin(
        state.filter_cutoff_hz + state.filter_envelope_amount * 20000.0F * voice.filter_level + lfo * state.lfo_filter_hz,
        static_cast<float>(core.config.sample_rate_hz) * 0.45F));
      const uint32_t filter_type = state.filter_mode == DAW_AUDIO_SYNTH_FILTER_MODE_HIGHPASS
        ? DAW_AUDIO_EQ_BAND_HIGHPASS
        : state.filter_mode == DAW_AUDIO_SYNTH_FILTER_MODE_BANDPASS
          ? DAW_AUDIO_EQ_BAND_BANDPASS
          : state.filter_mode == DAW_AUDIO_SYNTH_FILTER_MODE_NOTCH
            ? DAW_AUDIO_EQ_BAND_NOTCH
            : DAW_AUDIO_EQ_BAND_LOWPASS;
      const BiquadCoefficients coefficients = rbj_coefficients(filter_type, cutoff, state.filter_resonance, 0.0F, core.config.sample_rate_hz);
      filtered_left = process_biquad(sample_left, coefficients, voice.filter_history[0]);
      filtered_right = process_biquad(sample_right, coefficients, voice.filter_history[1]);
    }
    const float gain = voice.gain * voice.amp_level * std::fmax(0.0F, 1.0F - lfo * state.lfo_amplitude);
    const float pan_angle = (std::fmax(-1.0F, std::fmin(1.0F, voice.pan + lfo * state.lfo_pan)) + 1.0F) * 0.7853981633974483096F;
    left += filtered_left * gain * std::cos(pan_angle) * 1.4142135623730950488F;
    right += filtered_right * gain * std::sin(pan_angle) * 1.4142135623730950488F;
    voice.position += voice.increment * std::pow(2.0, static_cast<double>(lfo * state.lfo_pitch_cents) / 1200.0);
  }
  *left_output = std::isfinite(left) ? left : 0.0F;
  *right_output = std::isfinite(right) ? right : 0.0F;
}

void render_granular_instrument_frame(
  Core &core,
  InstrumentNodeState &instrument,
  float *left_output,
  float *right_output) {
  const daw_audio_granular_state &state = instrument.granular;
  AssetSlot *asset = find_asset(&core, state.asset);
  if (asset == nullptr || instrument.granular_note_count == 0) {
    *left_output = 0.0F;
    *right_output = 0.0F;
    return;
  }
  if (instrument.granular_next_frame <= 0.0) {
    GranularGrain *grain = nullptr;
    for (uint32_t index = 0; index < state.max_grains; ++index) {
      if (!instrument.grains[index].active) {
        grain = &instrument.grains[index];
        break;
      }
    }
    if (grain != nullptr) {
      const float requested_position = state.position;
      if (state.freeze != 0 && instrument.granular_frozen_position < 0.0F) instrument.granular_frozen_position = requested_position;
      const float position = state.freeze != 0 ? instrument.granular_frozen_position : requested_position;
      const float spray = state.freeze != 0 ? 0.0F : (next_granular_random(instrument) * 2.0F - 1.0F) * state.spray * asset->frame_count;
      const bool reverse = next_granular_random(instrument) < state.reverse_probability;
      const double rate = std::pow(2.0, static_cast<double>(state.pitch_semitones) / 12.0)
        * static_cast<double>(asset->sample_rate_hz) / core.config.sample_rate_hz;
      *grain = {
        .cursor = std::fmax(0.0, std::fmin(static_cast<double>(asset->frame_count - 1),
          static_cast<double>(position) * static_cast<double>(asset->frame_count - 1) + spray)),
        .step = reverse ? -rate : rate,
        .age = 0,
        .length = std::max(1U, static_cast<uint32_t>(std::lround(state.grain_size_ms * 0.001F * core.config.sample_rate_hz))),
        .pan = (next_granular_random(instrument) * 2.0F - 1.0F) * state.stereo_spread,
        .active = true,
      };
    }
    instrument.granular_next_frame += std::fmax(1.0, static_cast<double>(core.config.sample_rate_hz) / state.density_hz);
  }
  instrument.granular_next_frame -= 1.0;
  float left = 0.0F;
  float right = 0.0F;
  for (uint32_t index = 0; index < state.max_grains; ++index) {
    GranularGrain &grain = instrument.grains[index];
    if (!grain.active) continue;
    const int64_t base = static_cast<int64_t>(std::floor(grain.cursor));
    if (base < 0 || static_cast<uint64_t>(base + 1) >= asset->frame_count || grain.age >= grain.length) {
      grain = {};
      continue;
    }
    const uint32_t frame = static_cast<uint32_t>(base);
    const float fraction = static_cast<float>(grain.cursor - base);
    const float source_left = asset->planes[0][frame] + (asset->planes[0][frame + 1] - asset->planes[0][frame]) * fraction;
    const uint32_t right_channel = asset->channel_count > 1 ? 1 : 0;
    const float source_right = asset->planes[right_channel][frame]
      + (asset->planes[right_channel][frame + 1] - asset->planes[right_channel][frame]) * fraction;
    const float window = granular_window(state.window_shape, static_cast<float>(grain.age) / std::max(1U, grain.length - 1));
    const float pan = grain.pan;
    left += source_left * window * std::sqrt((1.0F - pan) * 0.5F);
    right += source_right * window * std::sqrt((1.0F + pan) * 0.5F);
    grain.cursor += grain.step;
    ++grain.age;
  }
  *left_output = std::isfinite(left) ? left : 0.0F;
  *right_output = std::isfinite(right) ? right : 0.0F;
}

bool apply_granular_instrument_event(
  InstrumentNodeState &instrument,
  const daw_audio_instrument_event &event) {
  const std::uint32_t type = portable_instrument_event_type(event.type);
  if (type == DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON) {
    for (uint64_t &note_id : instrument.granular_note_ids) {
      if (note_id == event.note_id) return true;
      if (note_id == 0) {
        note_id = event.note_id;
        ++instrument.granular_note_count;
        return true;
      }
    }
    return false;
  }
  if (type == DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF) {
    for (uint64_t &note_id : instrument.granular_note_ids) {
      if (note_id == event.note_id) {
        note_id = 0;
        --instrument.granular_note_count;
        if (instrument.granular_note_count == 0) instrument.grains = {};
        return true;
      }
    }
    return true;
  }
  return type == DAW_AUDIO_INSTRUMENT_EVENT_SUSTAIN || type == DAW_AUDIO_INSTRUMENT_EVENT_EXPRESSION;
}

bool apply_sample_instrument_event(
  Core &core,
  InstrumentNodeState &instrument,
  const daw_audio_instrument_state_descriptor &descriptor,
  const daw_audio_instrument_event &event) {
  const std::uint32_t type = portable_instrument_event_type(event.type);
  if (type == DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF) {
    for (SampleVoice &voice : instrument.sample_voices) if (voice.active && voice.note_id == event.note_id) voice.released = true;
    return true;
  }
  if (type != DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON) return type != DAW_AUDIO_INSTRUMENT_EVENT_PARAMETER;
  const daw_audio_sample_zone *selected = nullptr;
  uint32_t matching_group = 0;
  for (uint32_t index = 0; index < instrument.sampler.zone_count; ++index) {
    const daw_audio_sample_zone &zone = instrument.zones[index];
    if (event.note >= zone.key_low && event.note <= zone.key_high
      && event.value * 127.0F >= zone.velocity_low && event.value * 127.0F <= zone.velocity_high) {
      matching_group = zone.round_robin_group;
      if (matching_group == 0) {
        selected = &zone;
        break;
      }
      const uint32_t cursor = instrument.round_robin_cursors[matching_group % DAW_AUDIO_CORE_MAX_SAMPLE_ZONES]++;
      uint32_t group_count = 0;
      for (uint32_t group_index = 0; group_index < instrument.sampler.zone_count; ++group_index) {
        const daw_audio_sample_zone &candidate = instrument.zones[group_index];
        if (candidate.round_robin_group == matching_group
          && event.note >= candidate.key_low && event.note <= candidate.key_high
          && event.value * 127.0F >= candidate.velocity_low && event.value * 127.0F <= candidate.velocity_high) {
          ++group_count;
        }
      }
      const uint32_t selected_rank = cursor % group_count;
      for (uint32_t group_index = 0; group_index < instrument.sampler.zone_count; ++group_index) {
        const daw_audio_sample_zone &candidate = instrument.zones[group_index];
        if (candidate.round_robin_group != matching_group
          || event.note < candidate.key_low || event.note > candidate.key_high
          || event.value * 127.0F < candidate.velocity_low || event.value * 127.0F > candidate.velocity_high) continue;
        uint32_t rank = 0;
        for (uint32_t other_index = 0; other_index < instrument.sampler.zone_count; ++other_index) {
          const daw_audio_sample_zone &other = instrument.zones[other_index];
          if (other.round_robin_group == matching_group
            && event.note >= other.key_low && event.note <= other.key_high
            && event.value * 127.0F >= other.velocity_low && event.value * 127.0F <= other.velocity_high
            && (other.round_robin_index < candidate.round_robin_index
              || (other.round_robin_index == candidate.round_robin_index && other_index < group_index))) {
            ++rank;
          }
        }
        if (rank == selected_rank) {
          selected = &candidate;
          break;
        }
      }
      if (selected == nullptr) selected = &zone;
      break;
    }
  }
  if (selected == nullptr) return true;
  if (instrument.sampler.retrigger != 0) {
    for (SampleVoice &voice : instrument.sample_voices) {
      if (voice.active && voice.note == event.note) {
        voice.released = true;
        voice.forced_release_ms = kSampleTerminationFadeMilliseconds;
      }
    }
  }
  if (selected->choke_group != 0) {
    for (SampleVoice &voice : instrument.sample_voices) {
      if (voice.active && voice.choke_group == selected->choke_group) {
        voice.released = true;
        voice.forced_release_ms = kSampleTerminationFadeMilliseconds;
      }
    }
  }
  SampleVoice *voice = nullptr;
  for (uint32_t index = 0; index < descriptor.voice_capacity; ++index) {
    if (!instrument.sample_voices[index].active) {
      voice = &instrument.sample_voices[index];
      break;
    }
  }
  if (voice == nullptr) {
    voice = &instrument.sample_voices[0];
    for (uint32_t index = 1; index < descriptor.voice_capacity; ++index) {
      if (instrument.sample_voices[index].age < voice->age) voice = &instrument.sample_voices[index];
    }
  }
  AssetSlot *asset = find_asset(&core, selected->asset);
  if (asset == nullptr) return false;
  const float cents = (static_cast<float>(event.note) - static_cast<float>(selected->root_note)) * 100.0F + selected->tune_cents;
  *voice = {.note_id = event.note_id, .note = event.note, .asset = selected->asset, .position = static_cast<double>(selected->start_frame),
    .increment = std::pow(2.0, cents / 1200.0) * static_cast<double>(asset->sample_rate_hz) / core.config.sample_rate_hz,
    .end_frame = selected->end_frame, .loop_start_frame = selected->loop_start_frame, .loop_end_frame = selected->loop_end_frame,
    .crossfade_frame_count = selected->crossfade_frame_count,
    .playback_mode = selected->playback_mode, .choke_group = selected->choke_group,
    .gain = selected->gain * event.value, .pan = selected->pan, .age = instrument.next_age++, .active = true};
  return true;
}

bool apply_instrument_event(
  InstrumentNodeState &instrument,
  const daw_audio_instrument_state_descriptor &descriptor,
  const daw_audio_instrument_event &event) {
  const uint32_t capacity = descriptor.voice_capacity;
  const std::uint32_t type = portable_instrument_event_type(event.type);
  if (type == DAW_AUDIO_INSTRUMENT_EVENT_PARAMETER) {
    return instrument_declares_target(descriptor, event.note)
      && set_synth_parameter(instrument, event.note, event.value);
  }
  if (type == DAW_AUDIO_INSTRUMENT_EVENT_SUSTAIN) {
    instrument.sustain = event.value >= 0.5F;
    if (!instrument.sustain) {
      for (InstrumentVoice &voice : instrument.voices) {
        if (voice.active && !voice.held && voice.references == 0) voice.released = true;
      }
    }
    return true;
  }
  if (type == DAW_AUDIO_INSTRUMENT_EVENT_EXPRESSION) {
    instrument.expression = event.value;
    return true;
  }
  if (type == DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF) {
    for (InstrumentVoice &voice : instrument.voices) {
      if (voice.active && voice.note_id == event.note_id) {
        if (voice.references > 1) {
          --voice.references;
          return true;
        }
        voice.references = 0;
        voice.held = false;
        voice.released = !instrument.sustain;
        return true;
      }
    }
    return true;
  }
  if (type != DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON) return false;
  for (uint32_t index = 0; index < capacity; ++index) {
    InstrumentVoice &voice = instrument.voices[index];
    if (voice.active && voice.note_id == event.note_id) {
      ++voice.references;
      voice.held = true;
      voice.released = false;
      return true;
    }
    if (!voice.active) {
      uint32_t seed = instrument.synth.seed ^ static_cast<uint32_t>(event.note_id) ^ (event.note * 0x9E3779B1U);
      if (seed == 0) seed = 0xA341316CU;
      voice = {.note_id = event.note_id, .channel = event.channel, .note = event.note, .velocity = event.value, .references = 1,
        .age = instrument.next_age++, .noise_state = seed, .held = true, .active = true, .released = false};
      return true;
    }
  }
  InstrumentVoice *victim = nullptr;
  for (uint32_t index = 0; index < capacity; ++index) {
    InstrumentVoice &candidate = instrument.voices[index];
    if (victim == nullptr || (candidate.released && !victim->released) || (candidate.released == victim->released && candidate.age < victim->age)) {
      victim = &candidate;
    }
  }
  if (victim == nullptr) return false;
  uint32_t seed = instrument.synth.seed ^ static_cast<uint32_t>(event.note_id) ^ (event.note * 0x9E3779B1U);
  if (seed == 0) seed = 0xA341316CU;
  *victim = {.note_id = event.note_id, .channel = event.channel, .note = event.note, .velocity = event.value, .references = 1,
    .age = instrument.next_age++, .noise_state = seed, .held = true, .active = true, .released = false};
  return true;
}

void process_graph(Core &core, const daw_audio_core_process_block &block) {
  GraphRevision &graph = (*core.published_graph);
  for (uint32_t ordered = 0; ordered < graph.node_count; ++ordered) {
    const uint32_t node_index = graph.process_order[ordered];
    const daw_audio_graph_node_descriptor &node = graph.nodes[node_index];
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
    const uint32_t hook_layout = node.output_layout;
    const uint32_t hook_channel_count = hook_layout == DAW_AUDIO_GRAPH_LAYOUT_MONO ? 1U : 2U;
#endif
    std::array<Core::RetirementLane *, kMaximumRetirementLanes> retirement_lanes{};
    uint32_t retirement_lane_count = 0;
    for (auto &lane : *core.published_retirement_lanes) {
      if (lane.processor.node_id == node.id
        && lane.remaining_frames.load(std::memory_order_relaxed) != 0) {
        retirement_lanes[retirement_lane_count++] = &lane;
      }
    }
    uint16_t instrument_event_cursor = 0;
    const uint16_t instrument_event_count = core.instrument_event_counts[node_index];
    for (uint32_t frame = 0; frame < block.frame_count; ++frame) {
      float left = 0.0F;
      float right = 0.0F;
      if (node.kind == DAW_AUDIO_GRAPH_NODE_INSTRUMENT) {
        while (instrument_event_cursor < instrument_event_count) {
          const uint16_t event_index = core.instrument_event_indices[node_index][instrument_event_cursor];
          const daw_audio_instrument_event &event = core.active_instrument_events[event_index];
          if (event.frame_offset != frame) break;
          ++instrument_event_cursor;
          if (is_native_transport_release(event.type)) {
            release_instrument_state((*core.published_instruments)[node_index]);
          } else if (is_native_all_sound_off(event.type)) {
            clear_instrument_state((*core.published_instruments)[node_index]);
          } else if (node.instrument.kind == DAW_AUDIO_INSTRUMENT_KIND_SYNTH) {
            (void)apply_instrument_event((*core.published_instruments)[node_index], node.instrument, event);
          } else if (node.instrument.kind == DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) {
            (void)apply_granular_instrument_event((*core.published_instruments)[node_index], event);
          } else {
            (void)apply_sample_instrument_event(core, (*core.published_instruments)[node_index], node.instrument, event);
          }
        }
        if (node.instrument.kind == DAW_AUDIO_INSTRUMENT_KIND_SYNTH) {
          render_instrument_frame((*core.published_instruments)[node_index], node.instrument, core.config.sample_rate_hz, &left, &right);
        } else if (node.instrument.kind == DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) {
          render_granular_instrument_frame(core, (*core.published_instruments)[node_index], &left, &right);
        } else {
          render_sample_instrument_frame(core, (*core.published_instruments)[node_index], node.instrument, &left, &right);
        }
      }
      if (node.kind == DAW_AUDIO_GRAPH_NODE_SOURCE
        && node.input_bus != DAW_AUDIO_GRAPH_INPUT_BUS_DISCONNECTED
        && node.input_bus < block.input_bus_count && block.inputs != nullptr) {
        const float *source_left = block.inputs[node.input_bus * block.channel_count];
        const float *source_right = block.channel_count > 1 ? block.inputs[node.input_bus * block.channel_count + 1] : source_left;
        left = source_left == nullptr ? 0.0F : source_left[frame];
        right = source_right == nullptr ? left : source_right[frame];
      }
      if (node.kind == DAW_AUDIO_GRAPH_NODE_SOURCE) {
        render_sample_source_range(
          core, core.active_source_ranges[node_index],
          core.transport.frame + static_cast<int64_t>(frame), &left, &right);
      }
      if (node.kind != DAW_AUDIO_GRAPH_NODE_INSTRUMENT) {
        const GraphRevision::Range incoming_range = graph.incoming_edge_ranges[node_index];
        const uint32_t incoming_end = static_cast<uint32_t>(incoming_range.start) + incoming_range.count;
        for (uint32_t position = incoming_range.start; position < incoming_end; ++position) {
          const uint32_t edge_index = graph.incoming_edge_indices[position];
          left += graph_edge_sample(core, graph, edge_index, 0, frame);
          right += graph_edge_sample(core, graph, edge_index, 1, frame);
        }
      }
      if (node.input_layout == DAW_AUDIO_GRAPH_LAYOUT_MONO) left = right = 0.5F * (left + right);
      *graph_stage_sample(core, kGraphPreFxStage, node_index, 0, frame) = std::isfinite(left) ? left : 0.0F;
      *graph_stage_sample(core, kGraphPreFxStage, node_index, 1, frame) = std::isfinite(right) ? right : 0.0F;
      *graph_stage_sample(core, kGraphPreFaderStage, node_index, 0, frame) =
        *graph_stage_sample(core, kGraphPreFxStage, node_index, 0, frame);
      *graph_stage_sample(core, kGraphPreFaderStage, node_index, 1, frame) =
        *graph_stage_sample(core, kGraphPreFxStage, node_index, 1, frame);
    }
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
    const NativeGraphHooks &native_stages = core.published_native_hooks;
#endif
    bool processed_chain = false;
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
    if (native_stages.has_instrument_sources[node_index] && native_stages.hook != nullptr) {
      const NativeGraphStage &source = native_stages.instrument_sources[node_index];
      const auto project_frame = project_time_frame(core);
      const daw::audio_core::NativeGraphNodeRender render{
        .graph_revision = graph.revision,
        .node_index = node_index,
        .node_id = node.id,
        .frame_count = block.frame_count,
        .channel_count = hook_channel_count,
        .sample_rate_hz = core.config.sample_rate_hz,
        .transport_epoch = core.transport.epoch,
        .transport_running = core.transport.running != 0,
        .transport_frame = core.transport.frame,
        .project_time_samples = project_frame,
        .tempo_bpm = core.transport.tempo_bpm,
        .project_time_music = project_time_music(core, project_frame),
        .time_signature_numerator = core.transport.time_signature_numerator,
        .time_signature_denominator = core.transport.time_signature_denominator,
        .cycle_active = core.transport.cycle_active != 0,
        .cycle_start_music = project_time_music(core, core.transport.cycle_start_frame),
        .cycle_end_music = project_time_music(core, core.transport.cycle_end_frame),
        .stage_index = 0,
        .stage_role = daw::audio_core::NativeGraphStageRole::kInstrument,
        .planes = {
          graph_stage_sample(core, kGraphPreFaderStage, node_index, 0, 0),
          graph_stage_sample(core, kGraphPreFaderStage, node_index, 1, 0),
        },
        .instrument_events = std::span<const daw_audio_instrument_event>(
          core.native_instrument_events[node_index].data(),
          core.instrument_event_counts[node_index]),
        .attachment = source.attachment,
      };
      native_stages.hook(render);
      processed_chain = true;
      for (std::uint32_t frame = 0; frame < block.frame_count; ++frame) {
        float &left = *graph_stage_sample(core, kGraphPreFaderStage, node_index, 0, frame);
        float &right = *graph_stage_sample(core, kGraphPreFaderStage, node_index, 1, frame);
        if (!std::isfinite(left)) left = 0.0F;
        if (!std::isfinite(right)) right = 0.0F;
      }
    }
    for (std::uint32_t stage_index = 0; stage_index < native_stages.stage_counts[node_index]; ++stage_index) {
      const NativeGraphStage &stage = native_stages.stages[node_index][stage_index];
      if (stage.kind == NativeGraphStageKind::kExternal) {
        if (native_stages.hook == nullptr) continue;
        const auto project_frame = project_time_frame(core);
        const daw::audio_core::NativeGraphNodeRender render{
          .graph_revision = graph.revision,
          .node_index = node_index,
          .node_id = node.id,
          .frame_count = block.frame_count,
          .channel_count = hook_channel_count,
          .sample_rate_hz = core.config.sample_rate_hz,
          .transport_epoch = core.transport.epoch,
          .transport_running = core.transport.running != 0,
          .transport_frame = core.transport.frame,
          .project_time_samples = project_frame,
          .tempo_bpm = core.transport.tempo_bpm,
          .project_time_music = project_time_music(core, project_frame),
          .time_signature_numerator = core.transport.time_signature_numerator,
          .time_signature_denominator = core.transport.time_signature_denominator,
          .cycle_active = core.transport.cycle_active != 0,
          .cycle_start_music = project_time_music(core, core.transport.cycle_start_frame),
          .cycle_end_music = project_time_music(core, core.transport.cycle_end_frame),
          .stage_index = stage_index,
          .stage_role = stage.role,
          .planes = {
            graph_stage_sample(core, kGraphPreFaderStage, node_index, 0, 0),
            graph_stage_sample(core, kGraphPreFaderStage, node_index, 1, 0),
          },
          .instrument_events = {},
          .attachment = stage.attachment,
        };
        native_stages.hook(render);
        processed_chain = true;
        for (std::uint32_t frame = 0; frame < block.frame_count; ++frame) {
          float &left = *graph_stage_sample(core, kGraphPreFaderStage, node_index, 0, frame);
          float &right = *graph_stage_sample(core, kGraphPreFaderStage, node_index, 1, frame);
          if (!std::isfinite(left)) left = 0.0F;
          if (!std::isfinite(right)) right = 0.0F;
        }
        continue;
      }
      GraphRevision::Processor &processor = graph.processors[stage.processor_index];
      const ProcessorRenderer render = stage.renderer;
      processed_chain = true;
      prepare_processor_parameter_cache(core, processor);
      for (std::uint32_t frame = 0; frame < block.frame_count; ++frame) {
        resolve_processor_parameter_frame(core, processor, frame);
        float &left = *graph_stage_sample(core, kGraphPreFaderStage, node_index, 0, frame);
        float &right = *graph_stage_sample(core, kGraphPreFaderStage, node_index, 1, frame);
        float sidechain_left = processor.kind == DAW_AUDIO_PROCESSOR_KIND_SPECTRAL ? 0.0F : left;
        float sidechain_right = processor.kind == DAW_AUDIO_PROCESSOR_KIND_SPECTRAL ? 0.0F : right;
        const GraphRevision::Range sidechain_range = graph.sidechain_edge_ranges[stage.processor_index];
        if (sidechain_range.count > 0) {
          sidechain_left = 0.0F;
          sidechain_right = 0.0F;
        }
        const uint32_t sidechain_end = static_cast<uint32_t>(sidechain_range.start) + sidechain_range.count;
        for (uint32_t sidechain_position = sidechain_range.start; sidechain_position < sidechain_end; ++sidechain_position) {
          const uint32_t edge_index = graph.sidechain_edge_indices[sidechain_position];
          sidechain_left += graph_edge_sample(core, graph, edge_index, 0, frame);
          sidechain_right += graph_edge_sample(core, graph, edge_index, 1, frame);
        }
        float processed_left = 0.0F;
        float processed_right = 0.0F;
        render(core, processor, frame, left, right, sidechain_left, sidechain_right, &processed_left, &processed_right);
        left = std::isfinite(processed_left) ? processed_left : 0.0F;
        right = std::isfinite(processed_right) ? processed_right : 0.0F;
      }
    }
#else
    const GraphRevision::Range processor_range = graph.processor_ranges[node_index];
    const uint32_t processor_end = static_cast<uint32_t>(processor_range.start) + processor_range.count;
    for (uint32_t position = processor_range.start; position < processor_end; ++position) {
      const uint32_t processor_index = graph.processor_indices[position];
      GraphRevision::Processor &processor = graph.processors[processor_index];
      const ProcessorRenderer render = find_processor_renderer(processor.kind);
      if (render == nullptr) continue;
      processed_chain = true;
      prepare_processor_parameter_cache(core, processor);
      for (uint32_t frame = 0; frame < block.frame_count; ++frame) {
        resolve_processor_parameter_frame(core, processor, frame);
        float &left = *graph_stage_sample(core, kGraphPreFaderStage, node_index, 0, frame);
        float &right = *graph_stage_sample(core, kGraphPreFaderStage, node_index, 1, frame);
        float sidechain_left = processor.kind == DAW_AUDIO_PROCESSOR_KIND_SPECTRAL ? 0.0F : left;
        float sidechain_right = processor.kind == DAW_AUDIO_PROCESSOR_KIND_SPECTRAL ? 0.0F : right;
        const GraphRevision::Range sidechain_range = graph.sidechain_edge_ranges[processor_index];
        if (sidechain_range.count > 0) {
          sidechain_left = 0.0F;
          sidechain_right = 0.0F;
        }
        const uint32_t sidechain_end = static_cast<uint32_t>(sidechain_range.start) + sidechain_range.count;
        for (uint32_t sidechain_position = sidechain_range.start; sidechain_position < sidechain_end; ++sidechain_position) {
          const uint32_t edge_index = graph.sidechain_edge_indices[sidechain_position];
          sidechain_left += graph_edge_sample(core, graph, edge_index, 0, frame);
          sidechain_right += graph_edge_sample(core, graph, edge_index, 1, frame);
        }
        float processed_left = 0.0F;
        float processed_right = 0.0F;
        render(core, processor, frame, left, right, sidechain_left, sidechain_right, &processed_left, &processed_right);
        left = std::isfinite(processed_left) ? processed_left : 0.0F;
        right = std::isfinite(processed_right) ? processed_right : 0.0F;
      }
    }
#endif
    if (!processed_chain && node.kind == DAW_AUDIO_GRAPH_NODE_UTILITY && core.utility_configured) {
      for (uint32_t frame = 0; frame < block.frame_count; ++frame) {
        float utility_left = 0.0F;
        float utility_right = 0.0F;
        process_utility_frame(
          core, nullptr, core.utility_history, frame,
          *graph_stage_sample(core, kGraphPreFaderStage, node_index, 0, frame),
          *graph_stage_sample(core, kGraphPreFaderStage, node_index, 1, frame),
          &utility_left, &utility_right);
        *graph_stage_sample(core, kGraphPreFaderStage, node_index, 0, frame) = utility_left;
        *graph_stage_sample(core, kGraphPreFaderStage, node_index, 1, frame) = utility_right;
      }
    }
    for (uint32_t frame = 0; frame < block.frame_count; ++frame) {
      float left = *graph_stage_sample(core, kGraphPreFaderStage, node_index, 0, frame);
      float right = *graph_stage_sample(core, kGraphPreFaderStage, node_index, 1, frame);
      for (uint32_t retirement_index = 0; retirement_index < retirement_lane_count; ++retirement_index) {
        Core::RetirementLane &lane = *retirement_lanes[retirement_index];
        uint32_t remaining = lane.remaining_frames.load(std::memory_order_relaxed);
        if (remaining == 0) continue;
        float tail_left = 0.0F;
        float tail_right = 0.0F;
        const ProcessorRenderer render = find_processor_renderer(lane.processor.kind);
        if (render == nullptr) {
          lane.remaining_frames.store(0, std::memory_order_relaxed);
          continue;
        }
        if (lane.processor.kind == DAW_AUDIO_PROCESSOR_KIND_DELAY
          || lane.processor.kind == DAW_AUDIO_PROCESSOR_KIND_REVERB) {
          render_retirement_processor(
            core, lane, frame, 0.0F, 0.0F, 0.0F, 0.0F, &tail_left, &tail_right);
        } else {
          render(core, lane.processor, frame, 0.0F, 0.0F, 0.0F, 0.0F, &tail_left, &tail_right);
        }
        left += std::isfinite(tail_left) ? tail_left : 0.0F;
        right += std::isfinite(tail_right) ? tail_right : 0.0F;
        const uint32_t next_remaining = remaining - 1;
        lane.remaining_frames.store(next_remaining, std::memory_order_relaxed);
        if (next_remaining == 0) release_retirement_lane_slot(core, lane);
      }
      *graph_stage_sample(core, kGraphPreFaderStage, node_index, 0, frame) = std::isfinite(left) ? left : 0.0F;
      *graph_stage_sample(core, kGraphPreFaderStage, node_index, 1, frame) = std::isfinite(right) ? right : 0.0F;
      apply_mixer_frame(core, node.mixer, frame, &left, &right);
      if (node.output_layout == DAW_AUDIO_GRAPH_LAYOUT_MONO) left = right = 0.5F * (left + right);
      core.graph_buffers[node_index][0][frame] = std::isfinite(left) ? left : 0.0F;
      core.graph_buffers[node_index][1][frame] = std::isfinite(right) ? right : 0.0F;
    }
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
    if (core.published_native_hooks.observer != nullptr) {
      const auto project_frame = project_time_frame(core);
      core.published_native_hooks.observer({
        .graph_revision = graph.revision,
        .node_index = node_index,
        .node_id = node.id,
        .frame_count = block.frame_count,
        .channel_count = node.output_layout == DAW_AUDIO_GRAPH_LAYOUT_MONO ? 1U : 2U,
        .sample_rate_hz = core.config.sample_rate_hz,
        .transport_epoch = core.transport.epoch,
        .transport_running = core.transport.running != 0,
        .transport_frame = core.transport.frame,
        .project_time_samples = project_frame,
        .tempo_bpm = core.transport.tempo_bpm,
        .project_time_music = project_time_music(core, project_frame),
        .time_signature_numerator = core.transport.time_signature_numerator,
        .time_signature_denominator = core.transport.time_signature_denominator,
        .cycle_active = core.transport.cycle_active != 0,
        .cycle_start_music = project_time_music(core, core.transport.cycle_start_frame),
        .cycle_end_music = project_time_music(core, core.transport.cycle_end_frame),
        .planes = {core.graph_buffers[node_index][0].data(), core.graph_buffers[node_index][1].data()},
        .instrument_events = {},
        .attachment = core.published_native_hooks.observer_attachment,
      });
    }
#endif
  }
  for (uint32_t edge_index = 0; edge_index < graph.edge_count; ++edge_index) {
    const uint32_t delay = graph.edges[edge_index].pdc_delay_frames;
    if (delay > 0) core.graph_delay_cursors[edge_index] = (core.graph_delay_cursors[edge_index] + block.frame_count) % delay;
  }
  for (uint32_t channel = 0; channel < block.channel_count; ++channel) {
    const uint32_t graph_channel = channel == 0 ? 0 : 1;
    for (uint32_t frame = 0; frame < block.frame_count; ++frame) {
      block.outputs[channel][frame] = core.graph_buffers[graph.master_index][graph_channel][frame];
    }
  }
}

bool valid_processor_parameter_target(uint32_t kind, uint32_t target) {
  switch (kind) {
    case DAW_AUDIO_PROCESSOR_KIND_UTILITY:
      return target >= DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_GAIN_DB
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_UTILITY_WIDTH;
    case DAW_AUDIO_PROCESSOR_KIND_SATURATOR:
      return target >= DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_DRIVE_DB
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_DRY_WET;
    case DAW_AUDIO_PROCESSOR_KIND_EQ:
      return target >= DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_TARGET_BASE
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_TARGET_LAST;
    case DAW_AUDIO_PROCESSOR_KIND_CHORUS:
      return target >= DAW_AUDIO_PROCESSOR_PARAMETER_CHORUS_DELAY_MS
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_CHORUS_MIX;
    case DAW_AUDIO_PROCESSOR_KIND_FLANGER:
      return target >= DAW_AUDIO_PROCESSOR_PARAMETER_FLANGER_DELAY_MS
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_FLANGER_MIX;
    case DAW_AUDIO_PROCESSOR_KIND_PHASER:
      return target >= DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_CENTER_HZ
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_MIX;
    case DAW_AUDIO_PROCESSOR_KIND_TREMOLO:
      return target >= DAW_AUDIO_PROCESSOR_PARAMETER_TREMOLO_RATE_HZ
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_TREMOLO_PHASE;
    case DAW_AUDIO_PROCESSOR_KIND_AUTOPAN:
      return target >= DAW_AUDIO_PROCESSOR_PARAMETER_AUTOPAN_RATE_HZ
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_AUTOPAN_PHASE;
    case DAW_AUDIO_PROCESSOR_KIND_ENSEMBLE:
      return target >= DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_DELAY_MS
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_MIX;
    case DAW_AUDIO_PROCESSOR_KIND_GATE:
      return target >= DAW_AUDIO_PROCESSOR_PARAMETER_GATE_THRESHOLD_DB
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_GATE_SIDECHAIN_Q;
    case DAW_AUDIO_PROCESSOR_KIND_COMPRESSOR:
      return target >= DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_THRESHOLD_DB
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_SIDECHAIN_Q;
    case DAW_AUDIO_PROCESSOR_KIND_LIMITER:
      return target >= DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_CEILING
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_LINK;
    case DAW_AUDIO_PROCESSOR_KIND_DELAY:
      return target >= DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_TIME_MS
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_DELAY_HIGH_CUT_HZ;
    case DAW_AUDIO_PROCESSOR_KIND_REVERB:
      return (target >= DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_WET
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_STEREO_WIDTH)
        || (target >= DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DECAY_SEC
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DIFFUSION_HIGH_CUT_HZ);
    case DAW_AUDIO_PROCESSOR_KIND_SPECTRAL:
      return target >= DAW_AUDIO_PROCESSOR_PARAMETER_SPECTRAL_FREEZE
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_SPECTRAL_MIX;
    case DAW_AUDIO_PROCESSOR_KIND_AUTOFILTER:
      return target >= DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_FREQUENCY_HZ
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_LFO_STEREO_PHASE;
    case DAW_AUDIO_PROCESSOR_KIND_LOFI:
      return (target >= DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_SAMPLE_RATE_RATIO
        && target <= DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_MIX)
        || target == DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_BIT_DEPTH;
    default:
      return false;
  }
}

bool valid_processor_parameter_targets(const daw_audio_processor_descriptor &descriptor) {
  if (descriptor.parameter_count > DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS
    || (descriptor.parameter_count > 0 && descriptor.parameter_targets == nullptr)) return false;
  for (uint32_t parameter = 0; parameter < descriptor.parameter_count; ++parameter) {
    const uint32_t target = descriptor.parameter_targets[parameter];
    if (!valid_processor_parameter_target(descriptor.kind, target)) return false;
    for (uint32_t previous = 0; previous < parameter; ++previous) {
      if (descriptor.parameter_targets[previous] == target) return false;
    }
  }
  return true;
}

bool valid_processor_parameter_value(uint32_t target, float value) {
  if (!std::isfinite(value)) return false;
  if (target == 1) return value >= -60.0F && value <= 24.0F;
  if (target == 2 || target == 3) return value >= -1.0F && value <= 1.0F;
  if (target == 4) return value >= 0.0F && value <= 2.0F;
  if (target == 5) return value >= 1.0F && value <= 3000.0F;
  if (target == 6) return value >= 0.0F && value <= 0.95F;
  if (target == 7 || target == 10) return value >= 0.0F && value <= 1.0F;
  if (target == 8) return value >= 20.0F && value <= 2000.0F;
  if (target == 9 || target == 13) return value >= 1000.0F && value <= 20000.0F;
  if (target == 11) return value >= 0.0F && value <= 250.0F;
  if (target == 12) return value >= 20.0F && value <= 1200.0F;
  if (target == 13) return value >= 1000.0F && value <= 20000.0F;
  if (target == 14) return value >= 0.0F && value <= 2.0F;
  if (target == 15 || target == 19 || target == 21 || target == 23 || target == 24 || target == 25) return value >= 0.0F && value <= 1.0F;
  if (target == 16) return value >= -120.0F && value <= 0.0F;
  if (target == 17) return value >= 0.1F && value <= 1000.0F;
  if (target == 18) return value >= 1.0F && value <= 5000.0F;
  if (target == 20) return value >= -2048.0F && value <= 2048.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_FREQUENCY_HZ) return value >= 20.0F && value <= 20000.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_RESONANCE) return value >= 0.0F && value <= 1.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_DRIVE_DB) return value >= 0.0F && value <= 24.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_MIX) return value >= 0.0F && value <= 1.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_ENVELOPE_AMOUNT_OCTAVES) return value >= -6.0F && value <= 6.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_ENVELOPE_ATTACK_MS) return value >= 0.5F && value <= 500.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_ENVELOPE_RELEASE_MS) return value >= 5.0F && value <= 2000.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_LFO_RATE_HZ) return value >= 0.01F && value <= 20.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_LFO_DEPTH_OCTAVES) return value >= 0.0F && value <= 6.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_LFO_PHASE_OFFSET) return value >= 0.0F && value <= 1.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOFILTER_LFO_STEREO_PHASE) return value >= -0.5F && value <= 0.5F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_SAMPLE_RATE_RATIO) return value >= 0.01F && value <= 1.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_JITTER) return value >= 0.0F && value <= 1.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_NOISE_DB) return value >= -120.0F && value <= -24.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_MIX) return value >= 0.0F && value <= 1.0F;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_LOFI_BIT_DEPTH) {
    return value >= DAW_AUDIO_CORE_LOFI_BIT_DEPTH_MIN
      && value <= DAW_AUDIO_CORE_LOFI_BIT_DEPTH_MAX
      && std::floor(value) == value;
  }
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_DRIVE_DB) {
    return value >= DAW_AUDIO_CORE_SATURATOR_DRIVE_DB_MIN
      && value <= DAW_AUDIO_CORE_SATURATOR_DRIVE_DB_MAX;
  }
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_COLOR_FREQUENCY_HZ) {
    return value >= DAW_AUDIO_CORE_SATURATOR_COLOR_FREQUENCY_HZ_MIN
      && value <= DAW_AUDIO_CORE_SATURATOR_COLOR_FREQUENCY_HZ_MAX;
  }
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_COLOR_AMOUNT) {
    return value >= DAW_AUDIO_CORE_SATURATOR_COLOR_AMOUNT_MIN
      && value <= DAW_AUDIO_CORE_SATURATOR_COLOR_AMOUNT_MAX;
  }
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_OUTPUT_DB) {
    return value >= DAW_AUDIO_CORE_SATURATOR_OUTPUT_DB_MIN
      && value <= DAW_AUDIO_CORE_SATURATOR_OUTPUT_DB_MAX;
  }
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_SATURATOR_DRY_WET) {
    return value >= DAW_AUDIO_CORE_SATURATOR_DRY_WET_MIN
      && value <= DAW_AUDIO_CORE_SATURATOR_DRY_WET_MAX;
  }
  if (target >= DAW_AUDIO_PROCESSOR_PARAMETER_CHORUS_DELAY_MS && target <= DAW_AUDIO_PROCESSOR_PARAMETER_CHORUS_MIX) {
    if (target == DAW_AUDIO_PROCESSOR_PARAMETER_CHORUS_DELAY_MS) return value >= DAW_AUDIO_CORE_CHORUS_DELAY_MS_MIN && value <= DAW_AUDIO_CORE_CHORUS_DELAY_MS_MAX;
    if (target == DAW_AUDIO_PROCESSOR_PARAMETER_CHORUS_DEPTH_MS) return value >= DAW_AUDIO_CORE_CHORUS_DEPTH_MS_MIN && value <= DAW_AUDIO_CORE_CHORUS_DEPTH_MS_MAX;
    if (target == DAW_AUDIO_PROCESSOR_PARAMETER_CHORUS_RATE_HZ) return value >= DAW_AUDIO_CORE_CHORUS_RATE_HZ_MIN && value <= DAW_AUDIO_CORE_CHORUS_RATE_HZ_MAX;
    if (target == DAW_AUDIO_PROCESSOR_PARAMETER_CHORUS_FEEDBACK) return value >= DAW_AUDIO_CORE_CHORUS_FEEDBACK_MIN && value <= DAW_AUDIO_CORE_CHORUS_FEEDBACK_MAX;
    if (target == DAW_AUDIO_PROCESSOR_PARAMETER_CHORUS_STEREO_PHASE) return value >= DAW_AUDIO_CORE_CHORUS_STEREO_PHASE_MIN && value <= DAW_AUDIO_CORE_CHORUS_STEREO_PHASE_MAX;
    return value >= DAW_AUDIO_CORE_CHORUS_MIX_MIN && value <= DAW_AUDIO_CORE_CHORUS_MIX_MAX;
  }
  if (target >= DAW_AUDIO_PROCESSOR_PARAMETER_FLANGER_DELAY_MS && target <= DAW_AUDIO_PROCESSOR_PARAMETER_FLANGER_MIX) {
    if (target == DAW_AUDIO_PROCESSOR_PARAMETER_FLANGER_DELAY_MS) return value >= DAW_AUDIO_CORE_FLANGER_DELAY_MS_MIN && value <= DAW_AUDIO_CORE_FLANGER_DELAY_MS_MAX;
    if (target == DAW_AUDIO_PROCESSOR_PARAMETER_FLANGER_DEPTH_MS) return value >= DAW_AUDIO_CORE_FLANGER_DEPTH_MS_MIN && value <= DAW_AUDIO_CORE_FLANGER_DEPTH_MS_MAX;
    if (target == DAW_AUDIO_PROCESSOR_PARAMETER_FLANGER_RATE_HZ) return value >= DAW_AUDIO_CORE_FLANGER_RATE_HZ_MIN && value <= DAW_AUDIO_CORE_FLANGER_RATE_HZ_MAX;
    if (target == DAW_AUDIO_PROCESSOR_PARAMETER_FLANGER_FEEDBACK) return value >= DAW_AUDIO_CORE_FLANGER_FEEDBACK_MIN && value <= DAW_AUDIO_CORE_FLANGER_FEEDBACK_MAX;
    if (target == DAW_AUDIO_PROCESSOR_PARAMETER_FLANGER_STEREO_PHASE) return value >= DAW_AUDIO_CORE_FLANGER_STEREO_PHASE_MIN && value <= DAW_AUDIO_CORE_FLANGER_STEREO_PHASE_MAX;
    return value >= DAW_AUDIO_CORE_FLANGER_MIX_MIN && value <= DAW_AUDIO_CORE_FLANGER_MIX_MAX;
  }
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_CENTER_HZ) return value >= DAW_AUDIO_CORE_PHASER_CENTER_HZ_MIN && value <= DAW_AUDIO_CORE_PHASER_CENTER_HZ_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_DEPTH_OCTAVES) return value >= DAW_AUDIO_CORE_PHASER_DEPTH_OCTAVES_MIN && value <= DAW_AUDIO_CORE_PHASER_DEPTH_OCTAVES_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_RATE_HZ) return value >= DAW_AUDIO_CORE_PHASER_RATE_HZ_MIN && value <= DAW_AUDIO_CORE_PHASER_RATE_HZ_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_FEEDBACK) return value >= DAW_AUDIO_CORE_PHASER_FEEDBACK_MIN && value <= DAW_AUDIO_CORE_PHASER_FEEDBACK_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_STEREO_PHASE) return value >= DAW_AUDIO_CORE_PHASER_STEREO_PHASE_MIN && value <= DAW_AUDIO_CORE_PHASER_STEREO_PHASE_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_PHASER_MIX) return value >= DAW_AUDIO_CORE_PHASER_MIX_MIN && value <= DAW_AUDIO_CORE_PHASER_MIX_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_TREMOLO_RATE_HZ) return value >= DAW_AUDIO_CORE_TREMOLO_RATE_HZ_MIN && value <= DAW_AUDIO_CORE_TREMOLO_RATE_HZ_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_TREMOLO_DEPTH) return value >= DAW_AUDIO_CORE_TREMOLO_DEPTH_MIN && value <= DAW_AUDIO_CORE_TREMOLO_DEPTH_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_TREMOLO_SHAPE) return value >= DAW_AUDIO_CORE_TREMOLO_SHAPE_MIN && value <= DAW_AUDIO_CORE_TREMOLO_SHAPE_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_TREMOLO_PHASE) return value >= DAW_AUDIO_CORE_TREMOLO_PHASE_MIN && value <= DAW_AUDIO_CORE_TREMOLO_PHASE_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOPAN_RATE_HZ) return value >= DAW_AUDIO_CORE_AUTOPAN_RATE_HZ_MIN && value <= DAW_AUDIO_CORE_AUTOPAN_RATE_HZ_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOPAN_DEPTH) return value >= DAW_AUDIO_CORE_AUTOPAN_DEPTH_MIN && value <= DAW_AUDIO_CORE_AUTOPAN_DEPTH_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOPAN_SHAPE) return value >= DAW_AUDIO_CORE_AUTOPAN_SHAPE_MIN && value <= DAW_AUDIO_CORE_AUTOPAN_SHAPE_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_AUTOPAN_PHASE) return value >= DAW_AUDIO_CORE_AUTOPAN_PHASE_MIN && value <= DAW_AUDIO_CORE_AUTOPAN_PHASE_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_DELAY_MS) return value >= DAW_AUDIO_CORE_ENSEMBLE_DELAY_MS_MIN && value <= DAW_AUDIO_CORE_ENSEMBLE_DELAY_MS_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_DEPTH_MS) return value >= DAW_AUDIO_CORE_ENSEMBLE_DEPTH_MS_MIN && value <= DAW_AUDIO_CORE_ENSEMBLE_DEPTH_MS_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_RATE_HZ) return value >= DAW_AUDIO_CORE_ENSEMBLE_RATE_HZ_MIN && value <= DAW_AUDIO_CORE_ENSEMBLE_RATE_HZ_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_SPREAD) return value >= DAW_AUDIO_CORE_ENSEMBLE_SPREAD_MIN && value <= DAW_AUDIO_CORE_ENSEMBLE_SPREAD_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_ENSEMBLE_MIX) return value >= DAW_AUDIO_CORE_ENSEMBLE_MIX_MIN && value <= DAW_AUDIO_CORE_ENSEMBLE_MIX_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_GATE_THRESHOLD_DB) return value >= DAW_AUDIO_CORE_GATE_THRESHOLD_DB_MIN && value <= DAW_AUDIO_CORE_GATE_THRESHOLD_DB_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_GATE_RATIO) return value >= DAW_AUDIO_CORE_GATE_RATIO_MIN && value <= DAW_AUDIO_CORE_GATE_RATIO_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_GATE_ATTACK_MS) return value >= DAW_AUDIO_CORE_GATE_ATTACK_MS_MIN && value <= DAW_AUDIO_CORE_GATE_ATTACK_MS_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_GATE_HOLD_MS) return value >= DAW_AUDIO_CORE_GATE_HOLD_MS_MIN && value <= DAW_AUDIO_CORE_GATE_HOLD_MS_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_GATE_RELEASE_MS) return value >= DAW_AUDIO_CORE_GATE_RELEASE_MS_MIN && value <= DAW_AUDIO_CORE_GATE_RELEASE_MS_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_GATE_HYSTERESIS_DB) return value >= DAW_AUDIO_CORE_GATE_HYSTERESIS_DB_MIN && value <= DAW_AUDIO_CORE_GATE_HYSTERESIS_DB_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_GATE_RANGE_DB) return value >= DAW_AUDIO_CORE_GATE_RANGE_DB_MIN && value <= DAW_AUDIO_CORE_GATE_RANGE_DB_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_GATE_LOOKAHEAD_MS) return value >= DAW_AUDIO_CORE_GATE_LOOKAHEAD_MS_MIN && value <= DAW_AUDIO_CORE_GATE_LOOKAHEAD_MS_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_GATE_LINK) return value >= DAW_AUDIO_CORE_GATE_LINK_MIN && value <= DAW_AUDIO_CORE_GATE_LINK_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_GATE_SIDECHAIN_FREQUENCY_HZ) return value >= DAW_AUDIO_CORE_GATE_SIDECHAIN_FREQUENCY_HZ_MIN && value <= DAW_AUDIO_CORE_GATE_SIDECHAIN_FREQUENCY_HZ_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_GATE_SIDECHAIN_Q) return value >= DAW_AUDIO_CORE_GATE_SIDECHAIN_Q_MIN && value <= DAW_AUDIO_CORE_GATE_SIDECHAIN_Q_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_THRESHOLD_DB) return value >= DAW_AUDIO_CORE_COMPRESSOR_THRESHOLD_DB_MIN && value <= DAW_AUDIO_CORE_COMPRESSOR_THRESHOLD_DB_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_RATIO) return value >= DAW_AUDIO_CORE_COMPRESSOR_RATIO_MIN && value <= DAW_AUDIO_CORE_COMPRESSOR_RATIO_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_ATTACK_MS) return value >= DAW_AUDIO_CORE_COMPRESSOR_ATTACK_MS_MIN && value <= DAW_AUDIO_CORE_COMPRESSOR_ATTACK_MS_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_RELEASE_MS) return value >= DAW_AUDIO_CORE_COMPRESSOR_RELEASE_MS_MIN && value <= DAW_AUDIO_CORE_COMPRESSOR_RELEASE_MS_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_MAKEUP_DB) return value >= DAW_AUDIO_CORE_COMPRESSOR_MAKEUP_DB_MIN && value <= DAW_AUDIO_CORE_COMPRESSOR_MAKEUP_DB_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_OUTPUT_DB) return value >= DAW_AUDIO_CORE_COMPRESSOR_OUTPUT_DB_MIN && value <= DAW_AUDIO_CORE_COMPRESSOR_OUTPUT_DB_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_DRY_WET) return value >= DAW_AUDIO_CORE_COMPRESSOR_DRY_WET_MIN && value <= DAW_AUDIO_CORE_COMPRESSOR_DRY_WET_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_KNEE_DB) return value >= DAW_AUDIO_CORE_COMPRESSOR_KNEE_DB_MIN && value <= DAW_AUDIO_CORE_COMPRESSOR_KNEE_DB_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_LOOKAHEAD_MS) return value >= DAW_AUDIO_CORE_COMPRESSOR_LOOKAHEAD_MS_MIN && value <= DAW_AUDIO_CORE_COMPRESSOR_LOOKAHEAD_MS_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_SIDECHAIN_FREQUENCY_HZ) return value >= DAW_AUDIO_CORE_COMPRESSOR_SIDECHAIN_FREQUENCY_HZ_MIN && value <= DAW_AUDIO_CORE_COMPRESSOR_SIDECHAIN_FREQUENCY_HZ_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_COMPRESSOR_SIDECHAIN_Q) return value >= DAW_AUDIO_CORE_COMPRESSOR_SIDECHAIN_Q_MIN && value <= DAW_AUDIO_CORE_COMPRESSOR_SIDECHAIN_Q_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_CEILING) return value >= DAW_AUDIO_CORE_LIMITER_CEILING_MIN && value <= DAW_AUDIO_CORE_LIMITER_CEILING_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_RELEASE) return value >= DAW_AUDIO_CORE_LIMITER_RELEASE_MIN && value <= DAW_AUDIO_CORE_LIMITER_RELEASE_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_LOOKAHEAD_MS) return value >= DAW_AUDIO_CORE_LIMITER_LOOKAHEAD_MS_MIN && value <= DAW_AUDIO_CORE_LIMITER_LOOKAHEAD_MS_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_LIMITER_LINK) return value >= DAW_AUDIO_CORE_LIMITER_LINK_MIN && value <= DAW_AUDIO_CORE_LIMITER_LINK_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DECAY_SEC) return value >= DAW_AUDIO_CORE_REVERB_DECAY_SEC_MIN && value <= DAW_AUDIO_CORE_REVERB_DECAY_SEC_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_REFLECTIONS) return value >= DAW_AUDIO_CORE_REVERB_REFLECTIONS_MIN && value <= DAW_AUDIO_CORE_REVERB_REFLECTIONS_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_REFLECTION_SHAPE) return value >= DAW_AUDIO_CORE_REVERB_REFLECTION_SHAPE_MIN && value <= DAW_AUDIO_CORE_REVERB_REFLECTION_SHAPE_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DIFFUSE) return value >= DAW_AUDIO_CORE_REVERB_DIFFUSE_MIN && value <= DAW_AUDIO_CORE_REVERB_DIFFUSE_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_SIZE) return value >= DAW_AUDIO_CORE_REVERB_SIZE_MIN && value <= DAW_AUDIO_CORE_REVERB_SIZE_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DIFFUSION) return value >= DAW_AUDIO_CORE_REVERB_DIFFUSION_MIN && value <= DAW_AUDIO_CORE_REVERB_DIFFUSION_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DENSITY) return value >= DAW_AUDIO_CORE_REVERB_DENSITY_MIN && value <= DAW_AUDIO_CORE_REVERB_DENSITY_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_REFLECTION_MOD_AMOUNT_MS) return value >= DAW_AUDIO_CORE_REVERB_REFLECTION_MOD_AMOUNT_MS_MIN && value <= DAW_AUDIO_CORE_REVERB_REFLECTION_MOD_AMOUNT_MS_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_REFLECTION_MOD_RATE_HZ) return value >= DAW_AUDIO_CORE_REVERB_REFLECTION_MOD_RATE_HZ_MIN && value <= DAW_AUDIO_CORE_REVERB_REFLECTION_MOD_RATE_HZ_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DIFFUSION_LOW_CUT_HZ) return value >= DAW_AUDIO_CORE_REVERB_DIFFUSION_LOW_CUT_HZ_MIN && value <= DAW_AUDIO_CORE_REVERB_DIFFUSION_LOW_CUT_HZ_MAX;
  if (target == DAW_AUDIO_PROCESSOR_PARAMETER_REVERB_DIFFUSION_HIGH_CUT_HZ) return value >= DAW_AUDIO_CORE_REVERB_DIFFUSION_HIGH_CUT_HZ_MIN && value <= DAW_AUDIO_CORE_REVERB_DIFFUSION_HIGH_CUT_HZ_MAX;
  if (target >= DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_TARGET_BASE
    && target <= DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_TARGET_LAST) {
    switch ((target - DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_TARGET_BASE) % DAW_AUDIO_PROCESSOR_PARAMETER_EQ_BAND_TARGET_STRIDE) {
      case 0: return value >= 20.0F && value <= 20000.0F;
      case 1: return value >= -24.0F && value <= 24.0F;
      default: return value >= 0.2F && value <= 18.0F;
    }
  }
  return target == 22 && value >= -1.0F && value <= 1.0F;
}

const GraphRevision::Processor *find_processor(
  const GraphRevision &graph,
  uint64_t instance_id,
  uint32_t *out_index) {
  for (uint32_t index = 0; index < graph.processor_count; ++index) {
    if (graph.processors[index].instance_id == instance_id) {
      *out_index = index;
      return &graph.processors[index];
    }
  }
  return nullptr;
}

bool processor_declares_target(const GraphRevision::Processor &processor, uint32_t target) {
  const auto begin = processor.parameter_targets.begin();
  const auto end = begin + processor.parameter_count;
  const auto parameter = std::lower_bound(begin, end, target);
  return parameter != end && *parameter == target;
}

const daw_audio_graph_node_descriptor *find_mixer_node(
  const GraphRevision &graph,
  uint64_t instance_id) {
  for (uint32_t index = 0; index < graph.node_count; ++index) {
    if (graph.nodes[index].mixer.instance_id == instance_id) return &graph.nodes[index];
  }
  return nullptr;
}

bool valid_mixer_parameter_value(uint32_t target, float value) {
  if (!std::isfinite(value)) return false;
  if (target == DAW_AUDIO_MIXER_PARAMETER_GAIN) return value >= 0.0F && value <= 4.0F;
  if (target == DAW_AUDIO_MIXER_PARAMETER_PAN) return value >= -1.0F && value <= 1.0F;
  return (target == DAW_AUDIO_MIXER_PARAMETER_MUTE || target == DAW_AUDIO_MIXER_PARAMETER_SOLO)
    && (value == 0.0F || value == 1.0F);
}

bool bind_process_transport(Core &core, const daw_audio_core_process_block &block) {
  core.parameter_cache_prepared.fill(false);
  if (block.parameter_block_count > DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETER_BLOCKS
    || block.event_count > DAW_AUDIO_CORE_MAX_PROCESSOR_EVENTS
    || block.instrument_event_count > DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS
    || (block.parameter_block_count > 0 && block.parameter_blocks == nullptr)
    || (block.event_count > 0 && block.events == nullptr)
    || (block.instrument_event_count > 0 && block.instrument_events == nullptr)) return false;
  core.active_parameter_blocks.fill(nullptr);
  core.event_starts.fill(0);
  core.event_ends.fill(0);
  core.active_events = nullptr;
  core.active_event_count = 0;
  core.active_instrument_events = nullptr;
  core.active_instrument_event_count = 0;
  core.instrument_event_counts.fill(0);
  if (block.parameter_block_count == 0 && block.event_count == 0 && block.instrument_event_count == 0) return true;
  if (block.graph_revision != (*core.published_graph).revision
    || (block.instrument_event_count > 0 && block.transport_epoch != core.transport.epoch)) return false;
  core.active_events = block.events;
  core.active_event_count = block.event_count;
  for (uint32_t block_index = 0; block_index < block.parameter_block_count; ++block_index) {
    const daw_audio_processor_parameter_block &parameters = block.parameter_blocks[block_index];
    uint32_t processor_index = 0;
    const GraphRevision::Processor *processor = find_processor((*core.published_graph), parameters.processor_instance_id, &processor_index);
    if (processor == nullptr || core.active_parameter_blocks[processor_index] != nullptr
      || parameters.frame_count == 0 || (parameters.frame_count != 1 && parameters.frame_count != block.frame_count)
      || parameters.parameter_count == 0 || parameters.parameter_count > processor->parameter_count
      || parameters.parameter_targets == nullptr || parameters.values == nullptr) return false;
    for (uint32_t parameter = 0; parameter < parameters.parameter_count; ++parameter) {
      const uint32_t target = parameters.parameter_targets[parameter];
      if (!processor_declares_target(*processor, target)) return false;
      for (uint32_t previous = 0; previous < parameter; ++previous) {
        if (parameters.parameter_targets[previous] == target) return false;
      }
      for (uint32_t frame = 0; frame < parameters.frame_count; ++frame) {
        if (!valid_processor_parameter_value(target, parameters.values[parameter * parameters.frame_count + frame])) return false;
      }
    }
    core.active_parameter_blocks[processor_index] = &parameters;
  }
  uint64_t previous_processor = 0;
  uint32_t previous_offset = 0;
  bool has_previous = false;
  for (uint32_t event_index = 0; event_index < block.event_count; ++event_index) {
    const daw_audio_processor_event &event = block.events[event_index];
    uint32_t processor_index = 0;
    const GraphRevision::Processor *processor = find_processor((*core.published_graph), event.processor_instance_id, &processor_index);
    const daw_audio_graph_node_descriptor *mixer = processor == nullptr
      ? find_mixer_node((*core.published_graph), event.processor_instance_id)
      : nullptr;
    if ((processor == nullptr && mixer == nullptr) || event.frame_offset >= block.frame_count
      || (processor != nullptr && (!processor_declares_target(*processor, event.parameter_target)
        || !valid_processor_parameter_value(event.parameter_target, event.value)))
      || (mixer != nullptr && !valid_mixer_parameter_value(event.parameter_target, event.value))
      || (has_previous && (event.processor_instance_id < previous_processor
        || (event.processor_instance_id == previous_processor && event.frame_offset < previous_offset)))) return false;
    if (processor != nullptr && (!has_previous || event.processor_instance_id != previous_processor)) {
      core.event_starts[processor_index] = event_index;
      if (has_previous && find_processor((*core.published_graph), previous_processor, &processor_index) != nullptr) {
        uint32_t previous_index = 0;
        find_processor((*core.published_graph), previous_processor, &previous_index);
        core.event_ends[previous_index] = event_index;
      }
    }
    previous_processor = event.processor_instance_id;
    previous_offset = event.frame_offset;
    has_previous = true;
  }
  if (has_previous && find_processor((*core.published_graph), previous_processor, &previous_offset) != nullptr) {
    uint32_t previous_index = 0;
    find_processor((*core.published_graph), previous_processor, &previous_index);
    core.event_ends[previous_index] = block.event_count;
  }
#if defined(DAW_AUDIO_CORE_USE_PERSISTENT_VALIDATION_SCRATCH)
  std::copy((*core.published_instruments).begin(), (*core.published_instruments).end(), core.proposed_instruments.begin());
  auto &proposed_instruments = core.proposed_instruments;
#else
  auto proposed_instruments = (*core.published_instruments);
#endif
  for (auto &indices : core.instrument_event_indices) indices.fill(0);
  core.instrument_event_counts.fill(0);
  uint32_t previous_instrument_offset = 0;
  uint64_t previous_instrument_sequence = 0;
  bool has_previous_instrument = false;
  for (uint32_t event_index = 0; event_index < block.instrument_event_count; ++event_index) {
    const daw_audio_instrument_event &event = block.instrument_events[event_index];
    const bool native_event = is_native_instrument_event(event.type);
    const std::uint32_t portable_type = portable_instrument_event_type(event.type);
    const int32_t node_index = graph_node_index((*core.published_graph), event.node_id);
    if (node_index < 0 || (*core.published_graph).nodes[static_cast<uint32_t>(node_index)].kind != DAW_AUDIO_GRAPH_NODE_INSTRUMENT
      || event.epoch != core.transport.epoch || event.sequence == 0 || event.frame_offset >= block.frame_count
      || (!native_event && (portable_type < DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON
        || portable_type > DAW_AUDIO_INSTRUMENT_EVENT_PARAMETER))
      || event.channel > 15 || event.note > 127 || !std::isfinite(event.value)
      || ((portable_type == DAW_AUDIO_INSTRUMENT_EVENT_NOTE_ON || is_native_live_note_on(event.type))
        && (event.note_id == 0 || event.value < 0.0F || event.value > 1.0F))
      || ((portable_type == DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF || is_native_live_note_off(event.type))
        && event.note_id == 0)
      || ((portable_type == DAW_AUDIO_INSTRUMENT_EVENT_SUSTAIN || portable_type == DAW_AUDIO_INSTRUMENT_EVENT_EXPRESSION)
        && (event.value < 0.0F || event.value > 1.0F))
      || (portable_type == DAW_AUDIO_INSTRUMENT_EVENT_PARAMETER
        && !instrument_declares_target((*core.published_graph).nodes[static_cast<uint32_t>(node_index)].instrument, event.note))
      || (has_previous_instrument && (event.frame_offset < previous_instrument_offset
        || event.sequence <= previous_instrument_sequence))) return false;
    const uint32_t index = static_cast<uint32_t>(node_index);
    if (is_native_transport_release(event.type)) {
      release_instrument_state(proposed_instruments[index]);
    } else if (is_native_all_sound_off(event.type)) {
      clear_instrument_state(proposed_instruments[index]);
    } else if ((*core.published_graph).nodes[index].instrument.kind == DAW_AUDIO_INSTRUMENT_KIND_SYNTH) {
      if (!apply_instrument_event(proposed_instruments[index], (*core.published_graph).nodes[index].instrument, event)) return false;
    } else if ((*core.published_graph).nodes[index].instrument.kind == DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) {
      if (!apply_granular_instrument_event(proposed_instruments[index], event)) return false;
    } else if (!apply_sample_instrument_event(core, proposed_instruments[index], (*core.published_graph).nodes[index].instrument, event)) {
      return false;
    }
    const uint16_t count = core.instrument_event_counts[index];
    if (count >= DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS) return false;
    core.instrument_event_indices[index][count] = static_cast<uint16_t>(event_index);
    core.instrument_event_counts[index] = static_cast<uint16_t>(count + 1);
    previous_instrument_offset = event.frame_offset;
    previous_instrument_sequence = event.sequence;
    has_previous_instrument = true;
  }
  core.active_instrument_events = block.instrument_events;
  core.active_instrument_event_count = block.instrument_event_count;
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  for (uint32_t node_index = 0; node_index < (*core.published_graph).node_count; ++node_index) {
    const uint16_t count = core.instrument_event_counts[node_index];
    for (uint16_t event_index = 0; event_index < count; ++event_index) {
      core.native_instrument_events[node_index][event_index] =
        core.active_instrument_events[core.instrument_event_indices[node_index][event_index]];
    }
  }
#endif
  return true;
}

std::unique_ptr<Core> wasm_utility_core{};
bool wasm_utility_initialized = false;
std::unique_ptr<Core> wasm_asset_core{};
bool wasm_asset_initialized = false;
/* Asset-only and graph bridges are mutually exclusive Wasm control planes.
 * Reuse their fixed storage so enabling graph processing does not inflate the
 * fixed linear-memory artifact by an additional Core instance. */
Core *wasm_graph_core = nullptr;
bool wasm_graph_initialized = false;
uint32_t wasm_graph_max_input_buses = 0;
daw_audio_core_handle wasm_recording_capture = 0;

bool wasm_read_u32(const uint8_t *bytes, uint32_t byte_count, uint32_t *offset, uint32_t *out) {
  if (*offset > byte_count || byte_count - *offset < 4) return false;
  *out = read_u32_le(bytes + *offset);
  *offset += 4;
  return true;
}

bool wasm_read_u64(const uint8_t *bytes, uint32_t byte_count, uint32_t *offset, uint64_t *out) {
  uint32_t low = 0;
  uint32_t high = 0;
  if (!wasm_read_u32(bytes, byte_count, offset, &low) || !wasm_read_u32(bytes, byte_count, offset, &high)) return false;
  *out = static_cast<uint64_t>(low) | (static_cast<uint64_t>(high) << 32u);
  return true;
}

bool wasm_read_f32(const uint8_t *bytes, uint32_t byte_count, uint32_t *offset, float *out) {
  uint32_t bits = 0;
  if (!wasm_read_u32(bytes, byte_count, offset, &bits)) return false;
  __builtin_memcpy(out, &bits, sizeof(bits));
  return true;
}

uint32_t wasm_graph_kind(uint32_t kind) {
  if (kind == 1) return DAW_AUDIO_GRAPH_NODE_SOURCE;
  if (kind == 2) return DAW_AUDIO_GRAPH_NODE_INSTRUMENT;
  if (kind == 6) return DAW_AUDIO_GRAPH_NODE_MASTER;
  return DAW_AUDIO_GRAPH_NODE_MIXER;
}

bool wasm_parse_graph(
  const uint8_t *bytes,
  uint32_t byte_count,
  daw_audio_graph_prepare_request *out_request,
  std::array<daw_audio_graph_node_descriptor, kMaximumGraphNodes> *nodes,
  std::array<daw_audio_graph_edge_descriptor, kMaximumGraphEdges> *edges,
  std::array<daw_audio_processor_descriptor, kMaximumGraphProcessors> *processors,
  std::array<std::array<uint32_t, DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS>, kMaximumGraphProcessors> *targets,
  std::array<std::array<uint8_t, DAW_AUDIO_CORE_MAX_PROCESSOR_STATE_BYTES>, kMaximumGraphProcessors> *states) {
  if (bytes == nullptr || byte_count < DAW_AUDIO_CORE_WASM_GRAPH_HEADER_BYTES) return false;
  uint32_t offset = 0;
  uint32_t version = 0;
  uint32_t revision = 0;
  uint32_t node_count = 0;
  uint32_t edge_count = 0;
  uint32_t processor_count = 0;
  uint32_t reserved = 0;
  if (!wasm_read_u32(bytes, byte_count, &offset, &version) || !wasm_read_u32(bytes, byte_count, &offset, &revision)
    || !wasm_read_u32(bytes, byte_count, &offset, &node_count) || !wasm_read_u32(bytes, byte_count, &offset, &edge_count)
    || !wasm_read_u32(bytes, byte_count, &offset, &processor_count) || !wasm_read_u32(bytes, byte_count, &offset, &reserved)
    || (version != DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION
      && version != DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION_EXTERNAL_LATENCY
      && version != DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION_LEGACY_2
      && version != DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION_LEGACY) || reserved != 0
    || revision == 0 || node_count == 0 || node_count > kMaximumGraphNodes || edge_count > kMaximumGraphEdges
    || processor_count > kMaximumGraphProcessors) return false;
  for (uint32_t index = 0; index < node_count; ++index) {
    uint64_t id = 0;
    uint32_t kind = 0;
    uint32_t input_layout = 0;
    uint32_t output_layout = 0;
    uint32_t input_bus = 0;
    uint32_t latency = 0;
    uint32_t external_latency = 0;
    if (!wasm_read_u64(bytes, byte_count, &offset, &id) || !wasm_read_u32(bytes, byte_count, &offset, &kind)
      || !wasm_read_u32(bytes, byte_count, &offset, &input_layout) || !wasm_read_u32(bytes, byte_count, &offset, &output_layout)
      || !wasm_read_u32(bytes, byte_count, &offset, &input_bus) || !wasm_read_u32(bytes, byte_count, &offset, &latency)) return false;
    if (version == DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION_EXTERNAL_LATENCY
      && !wasm_read_u32(bytes, byte_count, &offset, &external_latency)) return false;
    daw_audio_instrument_state_descriptor instrument{};
    if (version != DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION_LEGACY) {
      if (!wasm_read_u32(bytes, byte_count, &offset, &instrument.kind)
        || !wasm_read_u32(bytes, byte_count, &offset, &instrument.version)
        || !wasm_read_u32(bytes, byte_count, &offset, &instrument.voice_capacity)
        || !wasm_read_u32(bytes, byte_count, &offset, &instrument.parameter_count)
        || instrument.parameter_count > DAW_AUDIO_CORE_MAX_INSTRUMENT_PARAMETERS) return false;
      for (uint32_t target = 0; target < instrument.parameter_count; ++target) {
        if (!wasm_read_u32(bytes, byte_count, &offset, &instrument.parameter_targets[target])) return false;
      }
      for (uint32_t target = instrument.parameter_count; target < DAW_AUDIO_CORE_MAX_INSTRUMENT_PARAMETERS; ++target) {
        uint32_t ignored = 0;
        if (!wasm_read_u32(bytes, byte_count, &offset, &ignored)) return false;
      }
    }
    daw_audio_mixer_state mixer{};
    if (version == DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION
      || version == DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION_EXTERNAL_LATENCY) {
      if (!wasm_read_u64(bytes, byte_count, &offset, &mixer.instance_id)
        || !wasm_read_f32(bytes, byte_count, &offset, &mixer.gain)
        || !wasm_read_f32(bytes, byte_count, &offset, &mixer.pan)
        || !wasm_read_u32(bytes, byte_count, &offset, &mixer.muted)
        || !wasm_read_u32(bytes, byte_count, &offset, &mixer.soloed)) return false;
    }
    (*nodes)[index] = {
      .id = id, .kind = wasm_graph_kind(kind), .input_layout = input_layout, .output_layout = output_layout,
      .input_bus = input_bus, .latency_frames = latency, .external_latency_frames = external_latency,
      .instrument = instrument, .mixer = mixer,
    };
  }
  for (uint32_t index = 0; index < edge_count; ++index) {
    uint64_t id = 0;
    uint64_t from = 0;
    uint64_t to = 0;
    uint64_t target = 0;
    float gain = 0.0F;
    uint32_t tap = 0;
    uint32_t sidechain = 0;
    uint32_t delay = 0;
    if (!wasm_read_u64(bytes, byte_count, &offset, &id) || !wasm_read_u64(bytes, byte_count, &offset, &from)
      || !wasm_read_u64(bytes, byte_count, &offset, &to) || !wasm_read_u64(bytes, byte_count, &offset, &target)
      || !wasm_read_f32(bytes, byte_count, &offset, &gain) || !wasm_read_u32(bytes, byte_count, &offset, &tap)
      || !wasm_read_u32(bytes, byte_count, &offset, &sidechain) || !wasm_read_u32(bytes, byte_count, &offset, &delay)) return false;
    (*edges)[index] = {
      .id = id, .from_node_id = from, .to_node_id = to, .target_processor_id = target,
      .gain = gain, .tap = tap, .sidechain = sidechain, .pdc_delay_frames = delay,
    };
  }
  for (uint32_t index = 0; index < processor_count; ++index) {
    uint64_t node_id = 0;
    uint32_t kind = 0;
    uint32_t schema = 0;
    uint32_t state_size = 0;
    uint32_t instance = 0;
    uint32_t bypassed = 0;
    uint32_t input_layout = 0;
    uint32_t output_layout = 0;
    uint32_t target_count = 0;
    uint32_t latency = 0;
    uint32_t tail = 0;
    if (!wasm_read_u64(bytes, byte_count, &offset, &node_id) || !wasm_read_u32(bytes, byte_count, &offset, &kind)
      || !wasm_read_u32(bytes, byte_count, &offset, &schema) || !wasm_read_u32(bytes, byte_count, &offset, &state_size)
      || !wasm_read_u32(bytes, byte_count, &offset, &instance) || !wasm_read_u32(bytes, byte_count, &offset, &bypassed)
      || !wasm_read_u32(bytes, byte_count, &offset, &input_layout) || !wasm_read_u32(bytes, byte_count, &offset, &output_layout)
      || !wasm_read_u32(bytes, byte_count, &offset, &target_count) || !wasm_read_u32(bytes, byte_count, &offset, &latency)
      || !wasm_read_u32(bytes, byte_count, &offset, &tail) || state_size > DAW_AUDIO_CORE_MAX_PROCESSOR_STATE_BYTES
      || target_count > DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS || offset > byte_count || byte_count - offset < state_size) return false;
    for (uint32_t byte = 0; byte < state_size; ++byte) (*states)[index][byte] = bytes[offset + byte];
    offset += state_size;
    for (uint32_t target = 0; target < target_count; ++target) {
      if (!wasm_read_u32(bytes, byte_count, &offset, &(*targets)[index][target])) return false;
    }
    (*processors)[index] = {
      .node_id = node_id, .instance_id = instance, .kind = kind, .state_version = schema, .state_size = state_size,
      .bypassed = bypassed, .input_layout = input_layout, .output_layout = output_layout, .latency_frames = latency,
      .tail_frames = tail, .parameter_count = target_count, .parameter_targets = (*targets)[index].data(), .state = (*states)[index].data(),
    };
  }
  if (offset != byte_count) return false;
  *out_request = {
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .graph_revision = revision, .node_count = node_count,
    .edge_count = edge_count, .processor_count = processor_count, .reserved0 = 0, .nodes = nodes->data(),
    .edges = edges->data(), .processors = processors->data(),
  };
  return true;
}

enum class RecordingBlockOwner : uint8_t {
  available,
  capture,
  queued,
  transport,
};

struct RecordingCaptureBlock {
  std::array<std::array<float, DAW_AUDIO_RECORDING_CAPTURE_BLOCK_FRAMES>,
    DAW_AUDIO_RECORDING_CAPTURE_MAX_CHANNELS> planes{};
  std::atomic<RecordingBlockOwner> owner{RecordingBlockOwner::available};
  uint32_t sequence = 0;
  uint32_t frame_count = 0;
  int64_t start_frame = 0;
};

struct RecordingCapture {
  daw_audio_recording_capture_config config{};
  std::array<RecordingCaptureBlock, DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS> blocks{};
  uint32_t current = DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS;
  uint32_t pending = DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS;
  uint32_t next_sequence = 0;
  std::atomic<uint64_t> captured_frames{0};
  std::atomic<uint64_t> dropped_frames{0};
  std::atomic<uint32_t> dropped_blocks{0};
  std::atomic<float> rms{0.0F};
  std::atomic<float> peak{0.0F};
  std::atomic<bool> fatal{false};
  std::atomic<bool> active{true};
};

RecordingCapture *to_capture(daw_audio_core_handle handle) {
  return reinterpret_cast<RecordingCapture *>(static_cast<uintptr_t>(handle));
}

daw_audio_core_handle to_capture_handle(RecordingCapture *capture) {
  return static_cast<daw_audio_core_handle>(reinterpret_cast<uintptr_t>(capture));
}

bool valid_recording_capture_config(const daw_audio_recording_capture_config &config) {
  if (!valid_abi(config.abi_version)
    || config.channel_count == 0 || config.channel_count > DAW_AUDIO_RECORDING_CAPTURE_MAX_CHANNELS
    || !std::isfinite(config.gain) || config.gain < 0.0F
    || (config.polarity != 1 && config.polarity != -1)
    || config.punch_start_frame < 0
    || (config.punch_end_frame != -1 && config.punch_end_frame < config.punch_start_frame)) return false;
  for (uint32_t channel = 0; channel < config.channel_count; ++channel) {
    if (config.input_channels[channel] >= kMaximumChannels) return false;
  }
  return true;
}

uint32_t recording_acquire_block(RecordingCapture &capture) {
  for (uint32_t index = 0; index < capture.blocks.size(); ++index) {
    RecordingBlockOwner expected = RecordingBlockOwner::available;
    if (!capture.blocks[index].owner.compare_exchange_strong(
      expected, RecordingBlockOwner::capture, std::memory_order_acq_rel)) continue;
    return index;
  }
  return DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS;
}

void recording_update_meter(RecordingCapture &capture, const RecordingCaptureBlock &block) {
  double sum = 0.0;
  float peak = 0.0F;
  for (uint32_t channel = 0; channel < capture.config.channel_count; ++channel) {
    for (uint32_t frame = 0; frame < block.frame_count; ++frame) {
      const float value = block.planes[channel][frame];
      sum += static_cast<double>(value) * static_cast<double>(value);
      peak = std::fmax(peak, std::abs(value));
    }
  }
  const uint64_t samples = static_cast<uint64_t>(block.frame_count) * capture.config.channel_count;
  capture.rms.store(samples == 0 ? 0.0F : static_cast<float>(std::sqrt(sum / samples)), std::memory_order_release);
  capture.peak.store(peak, std::memory_order_release);
}

void recording_queue_pending(RecordingCapture &capture) {
  if (capture.pending == DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS) return;
  RecordingCaptureBlock &block = capture.blocks[capture.pending];
  block.sequence = capture.next_sequence++;
  block.owner.store(RecordingBlockOwner::queued, std::memory_order_release);
  recording_update_meter(capture, block);
  capture.pending = DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS;
}

void recording_discard_current(RecordingCapture &capture) {
  if (capture.current == DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS) return;
  RecordingCaptureBlock &block = capture.blocks[capture.current];
  capture.captured_frames.fetch_sub(block.frame_count, std::memory_order_relaxed);
  block.sequence = 0;
  block.frame_count = 0;
  block.start_frame = 0;
  block.owner.store(RecordingBlockOwner::available, std::memory_order_release);
  capture.current = DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS;
}

void recording_complete_current(RecordingCapture &capture) {
  if (capture.current == DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS) return;
  recording_queue_pending(capture);
  capture.pending = capture.current;
  capture.current = DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS;
}

float recording_processed_sample(
  const RecordingCapture &capture,
  const float *const *inputs,
  uint32_t input_channel_count,
  uint32_t output_channel,
  uint32_t frame) {
  const uint32_t input_channel = capture.config.input_channels[output_channel];
  const float *input = input_channel < input_channel_count ? inputs[input_channel] : nullptr;
  const float sample = input == nullptr ? 0.0F : input[frame];
  return std::isfinite(sample)
    ? sample * capture.config.gain * static_cast<float>(capture.config.polarity)
    : 0.0F;
}

daw_audio_core_result recording_capture_process(
  RecordingCapture &capture,
  const float *const *inputs,
  uint32_t input_channel_count,
  float *const *monitor_outputs,
  uint32_t monitor_channel_count,
  uint32_t frame_count,
  int64_t start_frame) {
  if (!capture.active.load(std::memory_order_acquire) || capture.fatal.load(std::memory_order_acquire)) {
    return DAW_AUDIO_CORE_NOT_PREPARED;
  }
  if (frame_count > DAW_AUDIO_RECORDING_CAPTURE_BLOCK_FRAMES || start_frame < 0) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  if (monitor_channel_count > 0 && monitor_outputs == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  for (uint32_t channel = 0; channel < monitor_channel_count; ++channel) {
    if (monitor_outputs[channel] == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  for (uint32_t frame = 0; frame < frame_count; ++frame) {
    for (uint32_t channel = 0; channel < monitor_channel_count; ++channel) {
      monitor_outputs[channel][frame] = channel < capture.config.channel_count
        ? recording_processed_sample(capture, inputs, input_channel_count, channel, frame)
        : 0.0F;
    }
    const int64_t absolute_frame = start_frame + static_cast<int64_t>(frame);
    if (absolute_frame < capture.config.punch_start_frame
      || (capture.config.punch_end_frame != -1 && absolute_frame >= capture.config.punch_end_frame)) continue;
    if (capture.current == DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS) {
      capture.current = recording_acquire_block(capture);
      if (capture.current != DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS) {
        capture.blocks[capture.current].start_frame = absolute_frame;
      }
    }
    if (capture.current == DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS) {
      const uint64_t dropped = capture.dropped_frames.fetch_add(1, std::memory_order_relaxed) + 1;
      if ((dropped - 1) % DAW_AUDIO_RECORDING_CAPTURE_BLOCK_FRAMES == 0) {
        capture.dropped_blocks.fetch_add(1, std::memory_order_relaxed);
      }
      capture.fatal.store(true, std::memory_order_release);
      return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    }
    RecordingCaptureBlock &block = capture.blocks[capture.current];
    for (uint32_t channel = 0; channel < capture.config.channel_count; ++channel) {
      block.planes[channel][block.frame_count] =
        recording_processed_sample(capture, inputs, input_channel_count, channel, frame);
    }
    ++block.frame_count;
    capture.captured_frames.fetch_add(1, std::memory_order_relaxed);
    if (block.frame_count == DAW_AUDIO_RECORDING_CAPTURE_BLOCK_FRAMES) recording_complete_current(capture);
  }
  return DAW_AUDIO_CORE_OK;
}

}  // namespace

extern "C" uint32_t daw_audio_core_get_abi_version(void) {
  return DAW_AUDIO_CORE_ABI_VERSION;
}

extern "C" daw_audio_core_result daw_audio_recording_capture_create(
  const daw_audio_recording_capture_config *config,
  daw_audio_core_handle *out_capture) {
  if (config == nullptr || out_capture == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (!valid_abi(config->abi_version)) return DAW_AUDIO_CORE_UNSUPPORTED_VERSION;
  if (!valid_recording_capture_config(*config)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  RecordingCapture *capture = new (std::nothrow) RecordingCapture{};
  if (capture == nullptr) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  capture->config = *config;
  *out_capture = to_capture_handle(capture);
  return DAW_AUDIO_CORE_OK;
}

extern "C" void daw_audio_recording_capture_destroy(daw_audio_core_handle capture) {
  delete to_capture(capture);
}

extern "C" daw_audio_core_result daw_audio_recording_capture_process(
  daw_audio_core_handle capture_handle,
  const float *const *inputs,
  uint32_t input_channel_count,
  uint32_t frame_count,
  int64_t start_frame) {
  RecordingCapture *capture = to_capture(capture_handle);
  if (capture == nullptr || (input_channel_count > 0 && inputs == nullptr)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  return recording_capture_process(*capture, inputs, input_channel_count, nullptr, 0, frame_count, start_frame);
}

extern "C" daw_audio_core_result daw_audio_recording_capture_process_monitor(
  daw_audio_core_handle capture_handle,
  const float *const *inputs,
  uint32_t input_channel_count,
  float *const *monitor_outputs,
  uint32_t monitor_channel_count,
  uint32_t frame_count,
  int64_t start_frame) {
  RecordingCapture *capture = to_capture(capture_handle);
  if (capture == nullptr || (input_channel_count > 0 && inputs == nullptr)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  return recording_capture_process(
    *capture, inputs, input_channel_count, monitor_outputs, monitor_channel_count, frame_count, start_frame);
}

extern "C" daw_audio_core_result daw_audio_recording_capture_dequeue(
  daw_audio_core_handle capture_handle,
  daw_audio_recording_capture_block *out_block) {
  RecordingCapture *capture = to_capture(capture_handle);
  if (capture == nullptr || out_block == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  uint32_t selected = DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS;
  uint32_t sequence = UINT32_MAX;
  for (uint32_t index = 0; index < capture->blocks.size(); ++index) {
    const RecordingCaptureBlock &block = capture->blocks[index];
    if (block.owner.load(std::memory_order_acquire) == RecordingBlockOwner::queued && block.sequence < sequence) {
      selected = index;
      sequence = block.sequence;
    }
  }
  if (selected == DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS) return DAW_AUDIO_CORE_NO_DATA;
  RecordingCaptureBlock &block = capture->blocks[selected];
  block.owner.store(RecordingBlockOwner::transport, std::memory_order_release);
  *out_block = {
    .generation = capture->config.generation,
    .session_id = capture->config.session_id,
    .sequence = block.sequence,
    .block_id = selected,
    .frame_count = block.frame_count,
    .channel_count = capture->config.channel_count,
    .planes = {block.planes[0].data(), block.planes[1].data()},
    .rms = capture->rms.load(std::memory_order_acquire),
    .peak = capture->peak.load(std::memory_order_acquire),
  };
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_recording_capture_release_block(
  daw_audio_core_handle capture_handle,
  uint32_t block_id) {
  RecordingCapture *capture = to_capture(capture_handle);
  if (capture == nullptr || block_id >= capture->blocks.size()) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  RecordingCaptureBlock &block = capture->blocks[block_id];
  if (block.owner.load(std::memory_order_acquire) != RecordingBlockOwner::transport) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  block.sequence = 0;
  block.frame_count = 0;
  block.start_frame = 0;
  block.owner.store(RecordingBlockOwner::available, std::memory_order_release);
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_recording_capture_finalize(
  daw_audio_core_handle capture_handle,
  int64_t stop_frame) {
  RecordingCapture *capture = to_capture(capture_handle);
  if (capture == nullptr || stop_frame < 0) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (!capture->active.load(std::memory_order_acquire)) return DAW_AUDIO_CORE_OK;
  if (capture->fatal.load(std::memory_order_acquire)) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  if (capture->current != DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS) {
    RecordingCaptureBlock &current = capture->blocks[capture->current];
    const int64_t retained = std::clamp(stop_frame - current.start_frame, int64_t{0}, static_cast<int64_t>(current.frame_count));
    capture->captured_frames.fetch_sub(current.frame_count - static_cast<uint32_t>(retained), std::memory_order_relaxed);
    current.frame_count = static_cast<uint32_t>(retained);
    if (current.frame_count == 0) recording_discard_current(*capture);
    else recording_complete_current(*capture);
  }
  recording_queue_pending(*capture);
  capture->active.store(false, std::memory_order_release);
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_recording_capture_cancel(daw_audio_core_handle capture_handle) {
  RecordingCapture *capture = to_capture(capture_handle);
  if (capture == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (capture->current != DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS) {
    RecordingCaptureBlock &current = capture->blocks[capture->current];
    current.sequence = 0;
    current.frame_count = 0;
    current.start_frame = 0;
    current.owner.store(RecordingBlockOwner::available, std::memory_order_release);
  }
  if (capture->pending != DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS) {
    RecordingCaptureBlock &pending = capture->blocks[capture->pending];
    pending.sequence = 0;
    pending.frame_count = 0;
    pending.start_frame = 0;
    pending.owner.store(RecordingBlockOwner::available, std::memory_order_release);
  }
  capture->current = DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS;
  capture->pending = DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS;
  capture->captured_frames.store(0, std::memory_order_release);
  capture->rms.store(0.0F, std::memory_order_release);
  capture->peak.store(0.0F, std::memory_order_release);
  capture->active.store(false, std::memory_order_release);
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_recording_capture_get_diagnostics(
  daw_audio_core_handle capture_handle,
  daw_audio_recording_capture_diagnostics *out_diagnostics) {
  RecordingCapture *capture = to_capture(capture_handle);
  if (capture == nullptr || out_diagnostics == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  uint32_t available = 0;
  uint32_t queued = 0;
  for (const RecordingCaptureBlock &block : capture->blocks) {
    const RecordingBlockOwner owner = block.owner.load(std::memory_order_acquire);
    available += owner == RecordingBlockOwner::available ? 1 : 0;
    queued += owner == RecordingBlockOwner::queued || owner == RecordingBlockOwner::transport ? 1 : 0;
  }
  *out_diagnostics = {
    .generation = capture->config.generation, .session_id = capture->config.session_id,
    .captured_frames = capture->captured_frames.load(std::memory_order_acquire),
    .dropped_frames = capture->dropped_frames.load(std::memory_order_acquire),
    .dropped_blocks = capture->dropped_blocks.load(std::memory_order_acquire),
    .available_blocks = available, .queued_blocks = queued,
    .rms = capture->rms.load(std::memory_order_acquire),
    .peak = capture->peak.load(std::memory_order_acquire),
    .fatal = capture->fatal.load(std::memory_order_acquire) ? 1u : 0u,
    .active = capture->active.load(std::memory_order_acquire) ? 1u : 0u,
  };
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_create(
  const daw_audio_core_config *config,
  daw_audio_core_handle *out_core) {
  if (config == nullptr || out_core == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (!valid_abi(config->abi_version)) return DAW_AUDIO_CORE_UNSUPPORTED_VERSION;
  if (!valid_config(*config)) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  Core *core = new (std::nothrow) Core;
  if (core == nullptr) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  if (!initialize_core_storage(*core)) {
    delete core;
    return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
  core->config = *config;
  *out_core = to_handle(core);
  return DAW_AUDIO_CORE_OK;
}

extern "C" void daw_audio_core_destroy(daw_audio_core_handle core) {
  delete to_core(core);
}

ContinuityPreparationResult prepare_continuity_state(Core &core);

extern "C" daw_audio_core_result daw_audio_core_prepare(
  daw_audio_core_handle core_handle,
  const daw_audio_core_prepare_request *request) {
  Core *core = to_core(core_handle);
  if (core == nullptr || request == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (!valid_abi(request->abi_version)) return DAW_AUDIO_CORE_UNSUPPORTED_VERSION;
  if (request->graph_revision == 0) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  core->prepared_revision = request->graph_revision;
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_prepare_graph(
  daw_audio_core_handle core_handle,
  const daw_audio_graph_prepare_request *request) {
  Core *core = to_core(core_handle);
  if (core == nullptr || request == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  const auto prepared = std::unique_ptr<GraphRevision>(new (std::nothrow) GraphRevision{});
  if (!prepared) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  const daw_audio_core_result result = prepare_graph_revision(*core, *request, prepared.get());
  if (result != DAW_AUDIO_CORE_OK) return result;
  /* PDC delay storage belongs to a revision. Resizing it while rendering
   * would click and violate RT ownership, so callers retire then publish. */
  if (has_pdc_change((*core->published_graph), *prepared)) return DAW_AUDIO_CORE_LATENCY_CHANGE_DEFERRED;
  (*core->prepared_graph) = *prepared;
  core->prepared_revision = request->graph_revision;
  core->prepared_continuity = prepare_continuity_state(*core);
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  core->prepared_native_hooks = {};
  if (!initialize_native_graph_stages(core->prepared_native_hooks, *core->prepared_graph)) {
    return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
#endif
  return DAW_AUDIO_CORE_OK;
}

#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
daw_audio_core_result daw::audio_core::RegisterNativeGraphHook(
  const daw_audio_core_handle core_handle,
  const NativeGraphHookRegistration& registration
) noexcept {
  Core *core = to_core(core_handle);
  if (core == nullptr || registration.graph_revision == 0
    || (registration.hook == nullptr && (registration.observer == nullptr || !registration.bindings.empty()))
    || registration.bindings.size() > kMaximumGraphNodes
    || core->prepared_revision != registration.graph_revision
    || (*core->prepared_graph).revision != registration.graph_revision) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  NativeGraphHooks next{};
  if (!initialize_native_graph_stages(next, *core->prepared_graph)) {
    return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
  next.revision = registration.graph_revision;
  next.hook = registration.hook;
  next.observer = registration.observer;
  next.observer_attachment = registration.observer_attachment;
  if (next.observer != nullptr && next.observer_attachment == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  std::array<std::array<NativeGraphHookBinding, DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE>, kMaximumGraphNodes> node_bindings{};
  std::array<std::uint32_t, kMaximumGraphNodes> node_binding_counts{};
  for (const NativeGraphHookBinding& binding : registration.bindings) {
    const int32_t node_index = graph_node_index((*core->prepared_graph), binding.node_id);
    if (node_index < 0 || binding.attachment == nullptr
      || node_binding_counts[static_cast<uint32_t>(node_index)] >= DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE
      || (binding.stage_role != daw::audio_core::NativeGraphStageRole::kEffect
        && binding.stage_role != daw::audio_core::NativeGraphStageRole::kInstrument)
      || (*core->prepared_graph).nodes[static_cast<uint32_t>(node_index)].output_layout != binding.output_layout
      || (*core->prepared_graph).nodes[static_cast<uint32_t>(node_index)].external_latency_frames
        != binding.external_latency_frames
      || (binding.pdc_latency_frames != 0
        && ((*core->prepared_graph).nodes[static_cast<uint32_t>(node_index)].latency_frames
          > std::numeric_limits<uint32_t>::max() - binding.external_latency_frames
          || (*core->prepared_graph).nodes[static_cast<uint32_t>(node_index)].latency_frames
            + binding.external_latency_frames != binding.pdc_latency_frames))
      || (binding.stage_index != daw::audio_core::kNativeGraphStageAppend
        && binding.stage_index >= kMaximumNativeGraphStagesPerNode)
      || (binding.stage_role == daw::audio_core::NativeGraphStageRole::kInstrument
        && ((*core->prepared_graph).nodes[static_cast<uint32_t>(node_index)].kind != DAW_AUDIO_GRAPH_NODE_INSTRUMENT
          || binding.stage_index != 0))) {
      return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
    node_bindings[static_cast<uint32_t>(node_index)][node_binding_counts[static_cast<uint32_t>(node_index)]++] = binding;
  }
  for (std::uint32_t node_index = 0; node_index < (*core->prepared_graph).node_count; ++node_index) {
    const std::uint32_t binding_count = node_binding_counts[node_index];
    if (binding_count == 0) continue;
    std::array<NativeGraphStage, kMaximumNativeGraphStagesPerNode> ordinary_stages{};
    std::uint32_t ordinary_count = 0;
    for (std::uint32_t stage_index = 0; stage_index < next.stage_counts[node_index]; ++stage_index) {
      const NativeGraphStage &stage = next.stages[node_index][stage_index];
      ordinary_stages[ordinary_count++] = stage;
    }
    std::uint32_t effect_count = 0;
    for (std::uint32_t binding_index = 0; binding_index < binding_count; ++binding_index) {
      const NativeGraphHookBinding &binding = node_bindings[node_index][binding_index];
      if (binding.stage_role == daw::audio_core::NativeGraphStageRole::kInstrument) {
        if (next.has_instrument_sources[node_index]) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
        next.instrument_sources[node_index] = {
          .kind = NativeGraphStageKind::kExternal,
          .processor_index = 0,
          .attachment = binding.attachment,
          .role = binding.stage_role,
        };
        next.has_instrument_sources[node_index] = true;
      } else {
        ++effect_count;
      }
    }
    const std::uint32_t final_count = ordinary_count + effect_count;
    const std::uint32_t chain_end = final_count;
    if (final_count > kMaximumNativeGraphStagesPerNode) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    std::array<NativeGraphStage, kMaximumNativeGraphStagesPerNode> rebuilt{};
    std::array<bool, kMaximumNativeGraphStagesPerNode> occupied{};
    for (std::uint32_t binding_index = 0; binding_index < binding_count; ++binding_index) {
      const NativeGraphHookBinding &binding = node_bindings[node_index][binding_index];
      if (binding.stage_role == daw::audio_core::NativeGraphStageRole::kInstrument
        || binding.stage_index == daw::audio_core::kNativeGraphStageAppend) continue;
      const std::uint32_t position = binding.stage_index;
      if (position >= chain_end || occupied[position]) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
      occupied[position] = true;
      rebuilt[position] = {
        .kind = NativeGraphStageKind::kExternal,
        .processor_index = 0,
        .attachment = binding.attachment,
        .role = binding.stage_role,
      };
    }
    for (std::uint32_t binding_index = 0; binding_index < binding_count; ++binding_index) {
      const NativeGraphHookBinding &binding = node_bindings[node_index][binding_index];
      if (binding.stage_role == daw::audio_core::NativeGraphStageRole::kInstrument
        || binding.stage_index != daw::audio_core::kNativeGraphStageAppend) continue;
      std::uint32_t position = ordinary_count;
      while (position < chain_end && occupied[position]) ++position;
      if (position == chain_end) {
        position = 0;
        while (position < chain_end && occupied[position]) ++position;
      }
      if (position == chain_end) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
      occupied[position] = true;
      rebuilt[position] = {
        .kind = NativeGraphStageKind::kExternal,
        .processor_index = 0,
        .attachment = binding.attachment,
        .role = binding.stage_role,
      };
    }
    std::uint32_t built_in_index = 0;
    for (std::uint32_t position = 0; position < chain_end; ++position) {
      if (occupied[position]) continue;
      if (built_in_index >= ordinary_count) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
      rebuilt[position] = ordinary_stages[built_in_index++];
    }
    if (built_in_index != ordinary_count) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    next.stages[node_index] = rebuilt;
    next.stage_counts[node_index] = final_count;
  }
  core->prepared_native_hooks = next;
  return DAW_AUDIO_CORE_OK;
}
#endif

extern "C" daw_audio_core_result daw_audio_core_prepare_graph_bytes(
  daw_audio_core_handle core_handle,
  const uint8_t *graph_bytes,
  const uint32_t graph_byte_count) {
  Core *core = to_core(core_handle);
  if (core == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  core->graph_validation_diagnostic = {};
  std::array<daw_audio_graph_node_descriptor, kMaximumGraphNodes> nodes{};
  std::array<daw_audio_graph_edge_descriptor, kMaximumGraphEdges> edges{};
  std::array<daw_audio_processor_descriptor, kMaximumGraphProcessors> processors{};
  std::array<std::array<uint32_t, DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS>, kMaximumGraphProcessors> targets{};
  std::array<std::array<uint8_t, DAW_AUDIO_CORE_MAX_PROCESSOR_STATE_BYTES>, kMaximumGraphProcessors> states{};
  daw_audio_graph_prepare_request request{};
  if (!wasm_parse_graph(
    graph_bytes,
    graph_byte_count,
    &request,
    &nodes,
    &edges,
    &processors,
    &targets,
    &states
  )) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  return daw_audio_core_prepare_graph(core_handle, &request);
}

extern "C" daw_audio_core_graph_validation_diagnostic daw_audio_core_get_graph_validation_diagnostic(
  const daw_audio_core_handle core_handle) {
  const Core *core = to_core(core_handle);
  return core == nullptr ? daw_audio_core_graph_validation_diagnostic{} : core->graph_validation_diagnostic;
}

bool same_float(float left, float right) {
  return left == right;
}

bool same_instrument_configuration(
  const daw_audio_graph_node_descriptor &current_node,
  const daw_audio_graph_node_descriptor &next_node,
  const InstrumentNodeState &current,
  const InstrumentNodeState &next) {
  if (current_node.instrument.kind != next_node.instrument.kind
    || current_node.instrument.version != next_node.instrument.version
    || current_node.instrument.voice_capacity != next_node.instrument.voice_capacity
    || current_node.instrument.parameter_count != next_node.instrument.parameter_count) return false;
  for (uint32_t index = 0; index < DAW_AUDIO_CORE_MAX_INSTRUMENT_PARAMETERS; ++index) {
    if (current_node.instrument.parameter_targets[index] != next_node.instrument.parameter_targets[index]) return false;
  }
  switch (next_node.instrument.kind) {
    case DAW_AUDIO_INSTRUMENT_KIND_SYNTH:
      return std::memcmp(&current.synth, &next.synth, sizeof(current.synth)) == 0;
    case DAW_AUDIO_INSTRUMENT_KIND_SAMPLER:
    case DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK:
      return std::memcmp(&current.sampler, &next.sampler, sizeof(current.sampler)) == 0
        && std::memcmp(current.zones.data(), next.zones.data(), sizeof(current.zones)) == 0;
    case DAW_AUDIO_INSTRUMENT_KIND_GRANULAR:
      return std::memcmp(&current.granular, &next.granular, sizeof(current.granular)) == 0;
    default:
      return true;
  }
}

bool compatible_processor_history(
  const GraphRevision::Processor &current,
  const GraphRevision::Processor &next) {
  if (current.instance_id != next.instance_id
    || current.kind != next.kind
    || current.state_version != next.state_version
    || current.state_size != next.state_size
    || current.input_layout != next.input_layout
    || current.output_layout != next.output_layout
    || current.bypassed != next.bypassed) return false;
  switch (next.kind) {
    case DAW_AUDIO_PROCESSOR_KIND_UTILITY:
      return current.utility.enabled == next.utility.enabled
        && current.utility.dc_block == next.utility.dc_block
        && current.utility.input_mode == next.utility.input_mode
        && current.utility.matrix == next.utility.matrix
        && current.utility.swap == next.utility.swap;
    case DAW_AUDIO_PROCESSOR_KIND_SATURATOR:
      return current.saturator.enabled == next.saturator.enabled
        && current.saturator.curve == next.saturator.curve
        && current.saturator.color == next.saturator.color
        && same_float(current.saturator.color_frequency_hz, next.saturator.color_frequency_hz);
    case DAW_AUDIO_PROCESSOR_KIND_EQ:
      if (current.eq.enabled != next.eq.enabled || current.eq.mono != next.eq.mono) return false;
      for (uint32_t band = 0; band < 8; ++band) {
        if (current.eq.bands[band].enabled != next.eq.bands[band].enabled
          || current.eq.bands[band].type != next.eq.bands[band].type) return false;
      }
      return true;
    case DAW_AUDIO_PROCESSOR_KIND_GATE:
      return current.gate.enabled == next.gate.enabled
        && current.gate.mode == next.gate.mode
        && current.gate.detector == next.gate.detector
        && current.gate.sidechain_enabled == next.gate.sidechain_enabled
        && same_float(current.gate.lookahead_ms, next.gate.lookahead_ms)
        && same_float(current.gate.sidechain_frequency_hz, next.gate.sidechain_frequency_hz)
        && same_float(current.gate.sidechain_q, next.gate.sidechain_q);
    case DAW_AUDIO_PROCESSOR_KIND_COMPRESSOR:
      return current.compressor.enabled == next.compressor.enabled
        && current.compressor.auto_release == next.compressor.auto_release
        && current.compressor.detector_mode == next.compressor.detector_mode
        && current.compressor.dynamics_mode == next.compressor.dynamics_mode
        && current.compressor.envelope_curve == next.compressor.envelope_curve
        && current.compressor.sidechain_enabled == next.compressor.sidechain_enabled
        && current.compressor.sidechain_filter_type == next.compressor.sidechain_filter_type
        && same_float(current.compressor.lookahead_ms, next.compressor.lookahead_ms)
        && same_float(current.compressor.sidechain_frequency_hz, next.compressor.sidechain_frequency_hz)
        && same_float(current.compressor.sidechain_q, next.compressor.sidechain_q);
    case DAW_AUDIO_PROCESSOR_KIND_LIMITER:
      return current.limiter.enabled == next.limiter.enabled
        && current.limiter.detector_oversampling == next.limiter.detector_oversampling
        && same_float(current.limiter.lookahead_ms, next.limiter.lookahead_ms);
    case DAW_AUDIO_PROCESSOR_KIND_SPECTRAL:
      return current.spectral.enabled == next.spectral.enabled
        && current.spectral.fft_size == next.spectral.fft_size
        && current.spectral.overlap == next.spectral.overlap;
    case DAW_AUDIO_PROCESSOR_KIND_AUTOFILTER:
      return current.autofilter.enabled == next.autofilter.enabled
        && current.autofilter.mode == next.autofilter.mode
        && current.autofilter.quality == next.autofilter.quality;
    case DAW_AUDIO_PROCESSOR_KIND_LOFI:
      return current.lofi.enabled == next.lofi.enabled
        && current.lofi.bit_depth == next.lofi.bit_depth
        && current.lofi.quantization == next.lofi.quantization
        && current.lofi.dither == next.lofi.dither
        && current.lofi.seed == next.lofi.seed;
    default:
      return current.kind == DAW_AUDIO_PROCESSOR_KIND_DELAY
        || current.kind == DAW_AUDIO_PROCESSOR_KIND_REVERB
        || current.kind == DAW_AUDIO_PROCESSOR_KIND_CHORUS
        || current.kind == DAW_AUDIO_PROCESSOR_KIND_FLANGER
        || current.kind == DAW_AUDIO_PROCESSOR_KIND_PHASER
        || current.kind == DAW_AUDIO_PROCESSOR_KIND_TREMOLO
        || current.kind == DAW_AUDIO_PROCESSOR_KIND_AUTOPAN
        || current.kind == DAW_AUDIO_PROCESSOR_KIND_ENSEMBLE;
  }
}

bool same_core_graph_shape(const GraphRevision &current, const GraphRevision &next) {
  if (current.revision == 0
    || current.edge_count != next.edge_count) return false;
  bool has_continuity_state = current.processor_count > 0;
  for (uint32_t index = 0; index < current.node_count; ++index) {
    const auto &left = current.nodes[index];
    const daw_audio_graph_node_descriptor *right = nullptr;
    for (uint32_t next_index = 0; next_index < next.node_count; ++next_index) {
      if (next.nodes[next_index].id == left.id) {
        right = &next.nodes[next_index];
        break;
      }
    }
    if (right == nullptr) return false;
    if (left.kind != right->kind
      || left.input_layout != right->input_layout
      || left.output_layout != right->output_layout
      || left.input_bus != right->input_bus
      || left.latency_frames != right->latency_frames
      || left.external_latency_frames != right->external_latency_frames) return false;
    has_continuity_state = has_continuity_state || left.kind == DAW_AUDIO_GRAPH_NODE_INSTRUMENT;
  }
  if (!has_continuity_state) return false;
  for (uint32_t index = 0; index < current.edge_count; ++index) {
    const auto &left = current.edges[index];
    const auto &right = next.edges[index];
    if (left.id != right.id || left.from_node_id != right.from_node_id
      || left.to_node_id != right.to_node_id
      || left.target_processor_id != right.target_processor_id
      || left.tap != right.tap || left.sidechain != right.sidechain
      || left.pdc_delay_frames != right.pdc_delay_frames) return false;
  }
  for (uint32_t index = 0; index < current.processor_count; ++index) {
    const auto &processor = current.processors[index];
    const GraphRevision::Processor *match = nullptr;
    for (uint32_t next_index = 0; next_index < next.processor_count; ++next_index) {
      if (next.processors[next_index].instance_id == processor.instance_id) {
        match = &next.processors[next_index];
        break;
      }
    }
    if (match == nullptr) {
      if (!processor_is_retirable(current, processor)) return false;
      continue;
    }
    if (!compatible_processor_history(processor, *match)) return false;
  }
  return true;
}

ContinuityPreparationResult prepare_continuity_state(Core &core) {
  const GraphRevision &current_graph = (*core.published_graph);
  GraphRevision &next_graph = (*core.prepared_graph);
  for (uint32_t index = 0; index < kMaximumGraphNodes; ++index) {
    (*core.prepared_instruments)[index] = (*core.published_instrument_configs)[index];
  }
  if (core.published_revision != 0 && !same_core_graph_shape(current_graph, next_graph)) {
    return ContinuityPreparationResult::kIncompatible;
  }

  std::array<bool, kMaximumGraphProcessors> preserve_history{};
  std::array<bool, kMaximumDelayProcessors> preserve_delay{};
  std::array<bool, kMaximumReverbProcessors> preserve_reverb{};
  std::array<bool, kMaximumSpectralProcessors> preserve_spectral{};
  std::array<bool, kMaximumDelayProcessors> used_delay{};
  std::array<bool, kMaximumReverbProcessors> used_reverb{};
  for (uint32_t index = 0; index < kMaximumRetirementLanes; ++index) {
    auto &prepared = (*core.prepared_retirement_lanes)[index];
    const auto &published = (*core.published_retirement_lanes)[index];
    prepared.processor = published.processor;
    prepared.generation = published.generation;
    prepared.remaining_frames.store(
      published.remaining_frames.load(std::memory_order_relaxed),
      std::memory_order_relaxed);
    prepared.source_delay_slot = published.source_delay_slot;
    prepared.source_reverb_slot = published.source_reverb_slot;
  }
  for (uint32_t index = 0; index < next_graph.processor_count; ++index) {
    const auto &processor = next_graph.processors[index];
    if (processor.kind == DAW_AUDIO_PROCESSOR_KIND_DELAY && processor.delay_slot < kMaximumDelayProcessors) {
      used_delay[processor.delay_slot] = true;
    }
    if (processor.kind == DAW_AUDIO_PROCESSOR_KIND_REVERB && processor.reverb_slot < kMaximumReverbProcessors) {
      used_reverb[processor.reverb_slot] = true;
    }
    for (uint32_t current_index = 0; current_index < current_graph.processor_count; ++current_index) {
      const auto &current = current_graph.processors[current_index];
      if (!compatible_processor_history(current, processor)) continue;
      preserve_history[processor.history_slot] = true;
      if (processor.kind == DAW_AUDIO_PROCESSOR_KIND_DELAY
        && processor.delay_slot < kMaximumDelayProcessors
        && current.delay_slot == processor.delay_slot) preserve_delay[processor.delay_slot] = true;
      if (processor.kind == DAW_AUDIO_PROCESSOR_KIND_REVERB
        && processor.reverb_slot < kMaximumReverbProcessors
        && current.reverb_slot == processor.reverb_slot) preserve_reverb[processor.reverb_slot] = true;
      if (processor.kind == DAW_AUDIO_PROCESSOR_KIND_SPECTRAL
        && processor.spectral_slot < kMaximumSpectralProcessors
        && current.spectral_slot == processor.spectral_slot) preserve_spectral[processor.spectral_slot] = true;
      break;
    }
  }
  for (uint32_t index = 0; index < current_graph.processor_count; ++index) {
    const auto &current = current_graph.processors[index];
    bool retained = false;
    for (uint32_t next_index = 0; next_index < next_graph.processor_count; ++next_index) {
      const auto &next = next_graph.processors[next_index];
      if (current.instance_id == next.instance_id && current.kind == next.kind) {
        retained = true;
        break;
      }
    }
    if (retained || !processor_is_retirable(current_graph, current)) continue;
    if ((current.kind == DAW_AUDIO_PROCESSOR_KIND_DELAY
      && current.delay_slot < kMaximumDelayProcessors && used_delay[current.delay_slot])
      || (current.kind == DAW_AUDIO_PROCESSOR_KIND_REVERB
      && current.reverb_slot < kMaximumReverbProcessors && used_reverb[current.reverb_slot])) {
      return ContinuityPreparationResult::kIncompatible;
    }
    uint32_t lane_index = kMaximumRetirementLanes;
    for (uint32_t candidate = 0; candidate < kMaximumRetirementLanes; ++candidate) {
      if (!(*core.prepared_retirement_lanes)[candidate].remaining_frames.load(std::memory_order_relaxed)) {
        lane_index = candidate;
        break;
      }
    }
    if (lane_index == kMaximumRetirementLanes) {
      return ContinuityPreparationResult::kRetirementCapacityExceeded;
    }
    auto &lane = (*core.prepared_retirement_lanes)[lane_index];
    lane.processor = current;
    materialize_latched_time_effect_state(lane.processor, core.config.sample_rate_hz);
    lane.processor.control_slot = kMaximumGraphProcessors - 1;
    lane.processor.parameter_count = 0;
    lane.processor.live_parameter_valid.fill(false);
    lane.processor.live_parameter_values.fill(0.0F);
    lane.generation = ++core.retirement_generation;
    lane.source_delay_slot = current.delay_slot;
    lane.source_reverb_slot = current.reverb_slot;
    lane.remaining_frames.store(
      std::min(
        lane.processor.tail_frames,
        core.config.sample_rate_hz * kMaximumRetirementSeconds),
      std::memory_order_relaxed);
    if (current.kind == DAW_AUDIO_PROCESSOR_KIND_DELAY && current.delay_slot < kMaximumDelayProcessors) {
      preserve_delay[current.delay_slot] = true;
    }
    if (current.kind == DAW_AUDIO_PROCESSOR_KIND_REVERB && current.reverb_slot < kMaximumReverbProcessors) {
      preserve_reverb[current.reverb_slot] = true;
    }
  }

  for (uint32_t slot = 0; slot < kMaximumGraphProcessors; ++slot) {
    core.prepared_reset_history[slot] = !preserve_history[slot];
  }
  for (uint32_t slot = 0; slot < kMaximumDelayProcessors; ++slot) {
    core.prepared_reset_delay[slot] = !preserve_delay[slot];
  }
  for (uint32_t slot = 0; slot < kMaximumReverbProcessors; ++slot) {
    core.prepared_reset_reverb[slot] = !preserve_reverb[slot];
  }
  for (uint32_t slot = 0; slot < kMaximumSpectralProcessors; ++slot) {
    core.prepared_reset_spectral[slot] = !preserve_spectral[slot];
  }
  for (uint32_t index = 0; index < next_graph.processor_count; ++index) {
    auto &processor = next_graph.processors[index];
    processor.control_slot = index;
    processor.live_parameter_values.fill(0.0F);
    processor.live_parameter_valid.fill(false);
  }
  *core.prepared_instrument_configs = *core.published_instrument_configs;
  for (uint32_t node_index = 0; node_index < next_graph.node_count; ++node_index) {
    const auto &node = next_graph.nodes[node_index];
    bool retained = false;
    for (uint32_t current_index = 0; current_index < current_graph.node_count; ++current_index) {
      const auto &current = current_graph.nodes[current_index];
      if (current.id == node.id && current.kind == node.kind
        && current.instrument.kind == node.instrument.kind) {
        retained = true;
        break;
      }
    }
    if (!retained) (*core.prepared_instruments)[node_index] = {};
    if (node.kind == DAW_AUDIO_GRAPH_NODE_INSTRUMENT
      && node.instrument.kind == DAW_AUDIO_INSTRUMENT_KIND_SYNTH
      && (*core.prepared_instruments)[node_index].synth.version == 0) {
      (*core.prepared_instruments)[node_index].synth = default_synth_state();
    }
  }
  return ContinuityPreparationResult::kAccepted;
}

bool instrument_configurations_compatible(Core &core) {
  if (core.published_revision == 0) return true;
  const GraphRevision &current_graph = *core.published_graph;
  const GraphRevision &next_graph = *core.prepared_graph;
  for (uint32_t next_index = 0; next_index < next_graph.node_count; ++next_index) {
    const auto &next_node = next_graph.nodes[next_index];
    if (next_node.kind != DAW_AUDIO_GRAPH_NODE_INSTRUMENT) continue;
    for (uint32_t current_index = 0; current_index < current_graph.node_count; ++current_index) {
      const auto &current_node = current_graph.nodes[current_index];
      if (current_node.id != next_node.id || current_node.kind != next_node.kind) continue;
      if (!same_instrument_configuration(
        current_node, next_node,
        (*core.published_instrument_configs)[current_index],
        (*core.prepared_instruments)[next_index])) return false;
      break;
    }
  }
  return true;
}

void snapshot_instrument_configurations(Core &core) {
  for (uint32_t index = 0; index < kMaximumGraphNodes; ++index) {
    (*core.prepared_instrument_configs)[index].synth = (*core.prepared_instruments)[index].synth;
    (*core.prepared_instrument_configs)[index].sampler = (*core.prepared_instruments)[index].sampler;
    (*core.prepared_instrument_configs)[index].zones = (*core.prepared_instruments)[index].zones;
    (*core.prepared_instrument_configs)[index].round_robin_cursors = (*core.prepared_instruments)[index].round_robin_cursors;
    (*core.prepared_instrument_configs)[index].granular = (*core.prepared_instruments)[index].granular;
  }
}

void clear_retirement_lanes(
  Core &core,
  std::array<Core::RetirementLane, kMaximumRetirementLanes> &lanes,
  const bool release_slots) {
  for (auto &lane : lanes) {
    if (release_slots) release_retirement_lane_slot(core, lane);
    lane.processor = {};
    lane.generation = 0;
    lane.source_delay_slot = kMaximumDelayProcessors;
    lane.source_reverb_slot = kMaximumReverbProcessors;
    lane.remaining_frames.store(0, std::memory_order_relaxed);
  }
}

void merge_prepared_retirement_runtime(Core &core) {
  for (uint32_t index = 0; index < kMaximumRetirementLanes; ++index) {
    auto &prepared = (*core.prepared_retirement_lanes)[index];
    const auto &published = (*core.published_retirement_lanes)[index];
    if (prepared.remaining_frames.load(std::memory_order_relaxed) == 0) continue;
    if (prepared.generation == published.generation) continue;
    if (prepared.processor.kind == DAW_AUDIO_PROCESSOR_KIND_DELAY
      && prepared.source_delay_slot < kMaximumDelayProcessors) {
      core.delay_slot_owners[prepared.source_delay_slot].store(
        prepared.generation, std::memory_order_release);
    } else if (prepared.processor.kind == DAW_AUDIO_PROCESSOR_KIND_REVERB
      && prepared.source_reverb_slot < kMaximumReverbProcessors) {
      core.reverb_slot_owners[prepared.source_reverb_slot].store(
        prepared.generation, std::memory_order_release);
    }
  }
}

void merge_prepared_instrument_runtime(Core &core) {
  if (core.published_revision == 0) return;
  const GraphRevision &current_graph = *core.published_graph;
  const GraphRevision &next_graph = *core.prepared_graph;
  for (uint32_t next_index = 0; next_index < next_graph.node_count; ++next_index) {
    const auto &next_node = next_graph.nodes[next_index];
    if (next_node.kind != DAW_AUDIO_GRAPH_NODE_INSTRUMENT) continue;
    for (uint32_t current_index = 0; current_index < current_graph.node_count; ++current_index) {
      const auto &current_node = current_graph.nodes[current_index];
      if (current_node.id != next_node.id || current_node.kind != next_node.kind
        || current_node.instrument.kind != next_node.instrument.kind) continue;
      const InstrumentNodeState staged = (*core.prepared_instruments)[next_index];
      (*core.prepared_instruments)[next_index] = (*core.published_instruments)[current_index];
      auto &merged = (*core.prepared_instruments)[next_index];
      merged.synth = staged.synth;
      merged.sampler = staged.sampler;
      merged.zones = staged.zones;
      merged.round_robin_cursors = staged.round_robin_cursors;
      merged.granular = staged.granular;
      break;
    }
  }
}

extern "C" daw_audio_core_result daw_audio_core_publish(
  daw_audio_core_handle core_handle,
  uint32_t expected_revision) {
  Core *core = to_core(core_handle);
  if (core == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (expected_revision == 0) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (core->prepared_revision != expected_revision) return DAW_AUDIO_CORE_STALE_REVISION;
  if ((*core->prepared_graph).revision == expected_revision) {
    if (core->prepared_continuity == ContinuityPreparationResult::kAccepted
      && !instrument_configurations_compatible(*core)) {
      core->prepared_continuity = ContinuityPreparationResult::kIncompatible;
    }
    switch (core->prepared_continuity) {
    case ContinuityPreparationResult::kAccepted:
      for (uint32_t slot = 0; slot < kMaximumGraphProcessors; ++slot) {
        if (!core->prepared_reset_history[slot]) continue;
        core->utility_histories[slot] = {};
        core->saturator_histories[slot] = {};
        core->eq_histories[slot] = {};
        core->dynamics_histories[slot] = {};
        core->modulation_histories[slot] = {};
        core->autofilter_histories[slot] = {};
        core->lofi_histories[slot] = {};
      }
      for (uint32_t slot = 0; slot < kMaximumDelayProcessors; ++slot) {
        if (core->prepared_reset_delay[slot]) core->delay_histories[slot] = {};
      }
      for (uint32_t slot = 0; slot < kMaximumReverbProcessors; ++slot) {
        if (core->prepared_reset_reverb[slot]) core->reverb_histories[slot] = {};
      }
      for (uint32_t slot = 0; slot < kMaximumSpectralProcessors; ++slot) {
        if (core->prepared_reset_spectral[slot]) core->spectral_histories[slot] = {};
      }
      merge_prepared_instrument_runtime(*core);
      merge_prepared_retirement_runtime(*core);
      break;
    case ContinuityPreparationResult::kIncompatible:
    case ContinuityPreparationResult::kRetirementCapacityExceeded:
      std::memset(core->utility_histories.data(), 0, sizeof(core->utility_histories));
      std::memset(core->saturator_histories.data(), 0, sizeof(core->saturator_histories));
      std::memset(core->eq_histories.data(), 0, sizeof(core->eq_histories));
      std::memset(core->dynamics_histories.data(), 0, sizeof(core->dynamics_histories));
      std::memset(core->modulation_histories.data(), 0, sizeof(core->modulation_histories));
      std::memset(core->delay_histories.data(), 0, sizeof(core->delay_histories));
      std::memset(core->reverb_histories.data(), 0, sizeof(core->reverb_histories));
      std::memset(core->spectral_histories.data(), 0, sizeof(core->spectral_histories));
      std::memset(core->autofilter_histories.data(), 0, sizeof(core->autofilter_histories));
      std::memset(core->lofi_histories.data(), 0, sizeof(core->lofi_histories));
      clear_retirement_lanes(*core, *core->published_retirement_lanes, true);
      clear_retirement_lanes(*core, *core->prepared_retirement_lanes, false);
      break;
    }
    snapshot_instrument_configurations(*core);
    std::swap(core->published_graph, core->prepared_graph);
    std::swap(core->published_instruments, core->prepared_instruments);
    std::swap(core->published_instrument_configs, core->prepared_instrument_configs);
    std::swap(core->published_retirement_lanes, core->prepared_retirement_lanes);
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
    std::swap(core->published_native_hooks, core->prepared_native_hooks);
#endif
  }
  core->published_revision = expected_revision;
  core->prepared_revision = 0;
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_cancel_prepared_graph(
  daw_audio_core_handle core_handle,
  uint32_t expected_revision) {
  Core *core = to_core(core_handle);
  if (core == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (expected_revision == 0 || core->prepared_revision != expected_revision) {
    return DAW_AUDIO_CORE_STALE_REVISION;
  }
  core->prepared_revision = 0;
  core->prepared_continuity = ContinuityPreparationResult::kAccepted;
  clear_retirement_lanes(*core, *core->prepared_retirement_lanes, false);
  return DAW_AUDIO_CORE_OK;
}

extern "C" uint32_t daw_audio_core_prepared_graph_continuity(
  daw_audio_core_handle core_handle) {
  Core *core = to_core(core_handle);
  return core != nullptr
    && core->prepared_continuity == ContinuityPreparationResult::kAccepted
    && instrument_configurations_compatible(*core) ? 1U : 0U;
}

extern "C" daw_audio_core_result daw_audio_core_stage_processor_state_patch(
  daw_audio_core_handle core_handle,
  const daw_audio_processor_state_patch *patch) {
  Core *core = to_core(core_handle);
  if (core == nullptr || patch == nullptr || patch->graph_revision == 0
    || patch->node_id == 0 || patch->instance_id == 0 || patch->kind == 0
    || patch->state == nullptr || patch->state_size > DAW_AUDIO_CORE_MAX_PROCESSOR_STATE_BYTES
    || patch->parameter_count > DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS
    || (patch->parameter_count > 0 && patch->parameter_targets == nullptr)
    || patch->bypassed > 1 || !valid_graph_layout(patch->input_layout)
    || !valid_graph_layout(patch->output_layout)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (core->published_revision != patch->graph_revision) return DAW_AUDIO_CORE_STALE_REVISION;
  Core::StagedProcessorStatePatch *slot = nullptr;
  for (uint32_t index = 0; index < 2; ++index) {
    auto &candidate = core->staged_processor_state_patches[index];
    uint32_t expected = 0;
    if (candidate.state.compare_exchange_strong(expected, 1, std::memory_order_acquire, std::memory_order_relaxed)) {
      slot = &candidate;
      break;
    }
  }
  if (slot == nullptr) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  const GraphRevision::Processor *current = nullptr;
  for (uint32_t index = 0; index < (*core->published_graph).processor_count; ++index) {
    const auto &candidate = (*core->published_graph).processors[index];
    if (candidate.node_id == patch->node_id && candidate.instance_id == patch->instance_id) {
      current = &candidate;
      break;
    }
  }
  if (current == nullptr || current->kind != patch->kind
    || current->state_size != patch->state_size
    || current->bypassed != patch->bypassed
    || current->input_layout != patch->input_layout
    || current->output_layout != patch->output_layout
    || current->latency_frames != patch->latency_frames
    || current->parameter_count != patch->parameter_count) {
    slot->state.store(0, std::memory_order_release);
    return DAW_AUDIO_CORE_STALE_REVISION;
  }
  for (uint32_t index = 0; index < patch->parameter_count; ++index) {
    if (!processor_declares_target(*current, patch->parameter_targets[index])) {
      slot->state.store(0, std::memory_order_release);
      return DAW_AUDIO_CORE_STALE_REVISION;
    }
  }
  const daw_audio_processor_descriptor descriptor{
    .node_id = patch->node_id,
    .instance_id = patch->instance_id,
    .kind = patch->kind,
    .state_version = patch->state_version,
    .state_size = patch->state_size,
    .bypassed = patch->bypassed,
    .input_layout = patch->input_layout,
    .output_layout = patch->output_layout,
    .latency_frames = patch->latency_frames,
    .tail_frames = patch->tail_frames,
    .parameter_count = patch->parameter_count,
    .parameter_targets = patch->parameter_targets,
    .state = patch->state,
  };
  GraphRevision::Processor staged{};
  staged.node_id = current->node_id;
  staged.node_index = current->node_index;
  staged.instance_id = current->instance_id;
  staged.kind = current->kind;
  staged.bypassed = current->bypassed;
  staged.input_layout = current->input_layout;
  staged.output_layout = current->output_layout;
  staged.latency_frames = current->latency_frames;
  staged.tail_frames = patch->tail_frames;
  staged.parameter_count = current->parameter_count;
  staged.parameter_targets = current->parameter_targets;
  staged.control_slot = current->control_slot;
  staged.history_slot = current->history_slot;
  staged.delay_slot = current->delay_slot;
  staged.reverb_slot = current->reverb_slot;
  staged.spectral_slot = current->spectral_slot;
  staged.state_size = patch->state_size;
  for (uint32_t index = 0; index < patch->state_size; ++index) staged.state[index] = patch->state[index];
  if (!decode_processor_state(descriptor, &staged)) {
    slot->state.store(0, std::memory_order_release);
    return DAW_AUDIO_CORE_PROCESSOR_STATE_INVALID;
  }
  slot->processor = staged;
  slot->graph_revision = patch->graph_revision;
  slot->state.store(2, std::memory_order_release);
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_apply_staged_processor_state_patch(
  daw_audio_core_handle core_handle) {
  Core *core = to_core(core_handle);
  if (core == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  Core::StagedProcessorStatePatch *slot = nullptr;
  for (uint32_t index = 0; index < 2; ++index) {
    auto &candidate = core->staged_processor_state_patches[index];
    uint32_t expected = 2;
    if (candidate.state.compare_exchange_strong(expected, 3, std::memory_order_acquire, std::memory_order_relaxed)) {
      slot = &candidate;
      break;
    }
  }
  if (slot == nullptr) return DAW_AUDIO_CORE_NO_DATA;
  const auto &staged = slot->processor;
  daw_audio_core_result result = DAW_AUDIO_CORE_STALE_REVISION;
  if (staged.node_id == 0 || staged.instance_id == 0
    || slot->graph_revision == 0
    || slot->graph_revision != core->published_revision
    || (*core->published_graph).revision != core->published_revision) {
    slot->state.store(0, std::memory_order_release);
    return result;
  }
  for (uint32_t index = 0; index < (*core->published_graph).processor_count; ++index) {
    auto &current = (*core->published_graph).processors[index];
    if (current.node_id == staged.node_id && current.instance_id == staged.instance_id) {
      if (current.kind != staged.kind || current.state_size != staged.state_size) {
        break;
      }
      current.state_size = staged.state_size;
      current.tail_frames = staged.tail_frames;
      current.state = staged.state;
      current.utility = staged.utility;
      current.saturator = staged.saturator;
      current.eq = staged.eq;
      current.delay_modulation = staged.delay_modulation;
      current.phaser = staged.phaser;
      current.amplitude_modulation = staged.amplitude_modulation;
      current.ensemble = staged.ensemble;
      current.gate = staged.gate;
      current.compressor = staged.compressor;
      current.limiter = staged.limiter;
      current.delay = staged.delay;
      current.reverb = staged.reverb;
      current.spectral = staged.spectral;
      current.autofilter = staged.autofilter;
      current.lofi = staged.lofi;
      current.live_parameter_values.fill(0.0F);
      current.live_parameter_valid.fill(false);
      result = DAW_AUDIO_CORE_OK;
      break;
    }
  }
  slot->state.store(0, std::memory_order_release);
  return result;
}

extern "C" daw_audio_core_result daw_audio_core_cancel_staged_processor_state_patch(
  daw_audio_core_handle core_handle) {
  Core *core = to_core(core_handle);
  if (core == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  for (uint32_t index = 0; index < 2; ++index) {
    auto &slot = core->staged_processor_state_patches[index];
    uint32_t expected = 2;
    if (slot.state.compare_exchange_strong(expected, 0, std::memory_order_acq_rel, std::memory_order_acquire)) {
      return DAW_AUDIO_CORE_OK;
    }
  }
  return DAW_AUDIO_CORE_NO_DATA;
}

extern "C" daw_audio_core_result daw_audio_core_retire(
  daw_audio_core_handle core_handle,
  uint32_t expected_revision) {
  Core *core = to_core(core_handle);
  if (core == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (expected_revision == 0) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (core->published_revision != expected_revision) return DAW_AUDIO_CORE_STALE_REVISION;
  core->published_revision = 0;
  (*core->published_graph).revision = 0;
  (*core->published_graph).node_count = 0;
  (*core->published_graph).edge_count = 0;
  (*core->published_graph).processor_count = 0;
  (*core->published_graph).master_index = kMaximumGraphNodes;
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  core->published_native_hooks = {};
#endif
  clear_instrument_voices(*core);
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_configure_utility(
  daw_audio_core_handle core_handle,
  const daw_audio_utility_state *state) {
  Core *core = to_core(core_handle);
  if (core == nullptr || state == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (!valid_utility_state(*state)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  core->utility = *state;
  core->utility_configured = true;
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_process(
  daw_audio_core_handle core_handle,
  const daw_audio_core_process_block *block) {
  Core *core = to_core(core_handle);
  if (core == nullptr || block == nullptr || block->outputs == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (!valid_abi(block->abi_version)) return DAW_AUDIO_CORE_UNSUPPORTED_VERSION;
  if (core->published_revision == 0) return DAW_AUDIO_CORE_NOT_PREPARED;
  if (block->frame_count == 0 || block->frame_count > core->config.max_frames_per_block
    || block->channel_count > core->config.max_channels
    || block->input_bus_count > kMaximumChannels) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  if (block->parameter_block_count > DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETER_BLOCKS
    || block->event_count > DAW_AUDIO_CORE_MAX_PROCESSOR_EVENTS
    || block->instrument_event_count > DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  if (block->instrument_event_count > 0 && block->transport_epoch != core->transport.epoch) return DAW_AUDIO_CORE_STALE_REVISION;
  for (uint32_t channel = 0; channel < block->channel_count; ++channel) {
    if (block->outputs[channel] == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  if (!bind_process_transport(*core, *block)) {
    return (block->parameter_block_count > 0 || block->event_count > 0 || block->instrument_event_count > 0)
      && block->graph_revision != (*core->published_graph).revision ? DAW_AUDIO_CORE_STALE_REVISION : DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  if ((*core->published_graph).revision == core->published_revision) {
    prepare_active_source_ranges(*core, &(*core->published_graph));
    process_graph(*core, *block);
    latch_processor_parameter_values(*core);
    if (core->transport.running != 0) core->transport.frame += static_cast<int64_t>(block->frame_count);
    return DAW_AUDIO_CORE_OK;
  }
  prepare_active_source_ranges(*core, nullptr);
  for (uint32_t channel = 0; channel < block->channel_count; ++channel) {
    float *output = block->outputs[channel];
    for (uint32_t frame = 0; frame < block->frame_count; ++frame) output[frame] = summed_input(*block, channel, frame);
  }
  for (uint32_t frame = 0; frame < block->frame_count; ++frame) {
    render_sample_source_range(*core, core->root_source_range, core->transport.frame + static_cast<int64_t>(frame), &block->outputs[0][frame],
      block->channel_count > 1 ? &block->outputs[1][frame] : &block->outputs[0][frame]);
  }
  if (core->utility_configured && block->channel_count > 0) {
    float *left_output = block->outputs[0];
    float *right_output = block->channel_count > 1 ? block->outputs[1] : nullptr;
    for (uint32_t frame = 0; frame < block->frame_count; ++frame) {
      const float dry_left = left_output[frame];
      const float dry_right = right_output == nullptr ? dry_left : right_output[frame];
      float left = 0.0F;
      float right = 0.0F;
      process_utility_frame(
        *core, nullptr, core->utility_history, frame, dry_left, dry_right, &left, &right);
      left_output[frame] = left;
      if (right_output != nullptr) right_output[frame] = right;
    }
  }
  if (core->transport.running != 0) core->transport.frame += static_cast<int64_t>(block->frame_count);
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_set_transport(
  daw_audio_core_handle core_handle,
  const daw_audio_transport_state *state) {
  Core *core = to_core(core_handle);
  if (core == nullptr || state == nullptr || !valid_transport_state(*state)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (state->epoch < core->transport.epoch) return DAW_AUDIO_CORE_STALE_REVISION;
  if (state->epoch != core->transport.epoch) {
    clear_sample_sources(*core);
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
    release_instrument_voices(*core);
#else
    clear_instrument_voices(*core);
#endif
    core->last_event_sequence = 0;
  }
  core->transport = *state;
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_configure_synth(
  daw_audio_core_handle core_handle,
  uint64_t node_id,
  const daw_audio_synth_state *state) {
  Core *core = to_core(core_handle);
  if (core == nullptr || state == nullptr || !valid_synth_state(*state)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  const GraphRevision &graph = configuration_graph(*core);
  const int32_t node_index = graph_node_index(graph, node_id);
  if (node_index < 0 || graph.nodes[static_cast<uint32_t>(node_index)].kind != DAW_AUDIO_GRAPH_NODE_INSTRUMENT) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  configuration_instruments(*core)[static_cast<uint32_t>(node_index)].synth = *state;
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_configure_sampler(
  daw_audio_core_handle core_handle,
  uint64_t node_id,
  const daw_audio_sampler_state *state,
  const daw_audio_sample_zone *zones) {
  Core *core = to_core(core_handle);
  if (core == nullptr || state == nullptr || (state->zone_count > 0 && zones == nullptr) || !valid_sampler_state(*state)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  const GraphRevision &graph = configuration_graph(*core);
  const int32_t node_index = graph_node_index(graph, node_id);
  if (node_index < 0) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  const daw_audio_graph_node_descriptor &node = graph.nodes[static_cast<uint32_t>(node_index)];
  if (node.kind != DAW_AUDIO_GRAPH_NODE_INSTRUMENT
    || (node.instrument.kind != DAW_AUDIO_INSTRUMENT_KIND_SAMPLER && node.instrument.kind != DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK)) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  for (uint32_t index = 0; index < state->zone_count; ++index) {
    if (!valid_sample_zone(*core, zones[index])) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    if (node.instrument.kind == DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK
      && (zones[index].key_low != zones[index].key_high || zones[index].round_robin_group != 0)) {
      return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
  }
  InstrumentNodeState &instrument = configuration_instruments(*core)[static_cast<uint32_t>(node_index)];
  instrument.sampler = *state;
  for (uint32_t index = 0; index < state->zone_count; ++index) instrument.zones[index] = zones[index];
  for (uint32_t index = state->zone_count; index < instrument.zones.size(); ++index) instrument.zones[index] = {};
  instrument.round_robin_cursors.fill(0);
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_configure_granular(
  daw_audio_core_handle core_handle,
  uint64_t node_id,
  const daw_audio_granular_state *state) {
  Core *core = to_core(core_handle);
  if (core == nullptr || state == nullptr || !valid_granular_state(*core, *state)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  const GraphRevision &graph = configuration_graph(*core);
  const int32_t node_index = graph_node_index(graph, node_id);
  if (node_index < 0) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  const daw_audio_graph_node_descriptor &node = graph.nodes[static_cast<uint32_t>(node_index)];
  if (node.kind != DAW_AUDIO_GRAPH_NODE_INSTRUMENT || node.instrument.kind != DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  InstrumentNodeState &instrument = configuration_instruments(*core)[static_cast<uint32_t>(node_index)];
  instrument.granular = *state;
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_schedule_sample_source(
  daw_audio_core_handle core_handle,
  const daw_audio_sample_source_event *event) {
  Core *core = to_core(core_handle);
  if (core == nullptr || event == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (!valid_abi(event->abi_version)) return DAW_AUDIO_CORE_UNSUPPORTED_VERSION;
  if (!valid_sample_source_event(*event)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (event->epoch != core->transport.epoch || event->sequence <= core->last_event_sequence) return DAW_AUDIO_CORE_STALE_REVISION;
  AssetSlot *asset = find_asset(core, event->asset);
  if (asset == nullptr
    || event->source_offset_frame >= asset->frame_count
    || event->source_frame_count > asset->frame_count - event->source_offset_frame) return DAW_AUDIO_CORE_INVALID_HANDLE;
  if ((*core->published_graph).revision == core->published_revision) {
    const int32_t node_index = graph_node_index((*core->published_graph), event->source_node_id);
    if (node_index < 0 || (*core->published_graph).nodes[static_cast<uint32_t>(node_index)].kind != DAW_AUDIO_GRAPH_NODE_SOURCE) {
      return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
  } else if (event->source_node_id != 0) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  SampleSource *target = nullptr;
  for (SampleSource &source : core->sample_sources) {
    if (!source.active) {
      target = &source;
      break;
    }
  }
  if (target == nullptr) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  *target = {
    .source_node_id = event->source_node_id,
    .asset = event->asset,
    .start_frame = event->start_frame,
    .stop_frame = event->stop_frame,
    .source_offset_frame = event->source_offset_frame,
    .source_offset_fraction = event->source_offset_fraction,
    .source_frame_count = event->source_frame_count,
    .gain = event->gain,
    .fade_in_start_frame = event->fade_in_start_frame,
    .fade_in_end_frame = event->fade_in_end_frame,
    .fade_out_start_frame = event->fade_out_start_frame,
    .fade_out_end_frame = event->fade_out_end_frame,
    .fade_in_curve = event->fade_in_curve,
    .fade_in_curve_position = event->fade_in_curve_position,
    .fade_out_curve = event->fade_out_curve,
    .fade_out_curve_position = event->fade_out_curve_position,
    .active = true,
  };
  core->last_event_sequence = event->sequence;
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_wasm_utility_initialize(
  uint32_t sample_rate_hz,
  uint32_t max_frames_per_block) {
  const daw_audio_core_config config{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .max_frames_per_block = max_frames_per_block,
    .max_channels = 2,
    .max_assets = 1,
    .sample_rate_hz = sample_rate_hz,
  };
  if (!valid_config(config)) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  wasm_utility_core.reset();
  wasm_utility_core.reset(new (std::nothrow) Core{});
  if (wasm_utility_core == nullptr || !initialize_core_storage(*wasm_utility_core)) {
    wasm_utility_core.reset();
    return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
  wasm_utility_core->config = config;
  wasm_utility_core->prepared_revision = 1;
  wasm_utility_core->published_revision = 1;
  wasm_utility_initialized = true;
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_wasm_utility_process(
  uint32_t frame_count,
  const float *left_input,
  const float *right_input,
  float *left_output,
  float *right_output,
  const daw_audio_utility_state *state) {
  if (!wasm_utility_initialized || left_output == nullptr || right_output == nullptr || state == nullptr) return DAW_AUDIO_CORE_NOT_PREPARED;
  if (wasm_utility_core == nullptr
    || frame_count > wasm_utility_core->config.max_frames_per_block
    || !valid_utility_state(*state)) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  wasm_utility_core->utility = *state;
  wasm_utility_core->utility_configured = true;
  const float *inputs[2]{left_input, right_input == nullptr ? left_input : right_input};
  float *outputs[2]{left_output, right_output};
  const daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .frame_count = frame_count,
    .channel_count = 2,
    .input_bus_count = 1,
    .inputs = inputs,
    .outputs = outputs,
    .graph_revision = 0,
    .parameter_block_count = 0,
    .parameter_blocks = nullptr,
    .event_count = 0,
    .events = nullptr,
    .transport_epoch = 0,
    .instrument_event_count = 0,
    .instrument_events = nullptr,
  };
  return daw_audio_core_process(to_handle(wasm_utility_core.get()), &block);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_asset_initialize(
  uint32_t sample_rate_hz,
  uint32_t max_assets) {
  const daw_audio_core_config config{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .max_frames_per_block = 1,
    .max_channels = kMaximumChannels,
    .max_assets = max_assets,
    .sample_rate_hz = sample_rate_hz,
  };
  if (!valid_config(config)) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  wasm_asset_core.reset();
  wasm_asset_core.reset(new (std::nothrow) Core{});
  if (wasm_asset_core == nullptr || !initialize_core_storage(*wasm_asset_core)) {
    wasm_asset_core.reset();
    wasm_graph_core = nullptr;
    return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
  wasm_asset_core->config = config;
  wasm_graph_core = wasm_asset_core.get();
  wasm_asset_initialized = true;
  wasm_graph_initialized = false;
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_wasm_register_pcm_asset(
  uint32_t frame_count,
  uint32_t sample_rate_hz,
  uint32_t channel_count,
  const float *const *planes,
  daw_audio_asset_handle *out_asset) {
  if (!wasm_asset_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  const daw_audio_asset_descriptor descriptor{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .revision = 1,
    .byte_length = static_cast<uint64_t>(frame_count) * static_cast<uint64_t>(channel_count) * sizeof(float),
    .content_hash_prefix = 0,
    .frame_count = frame_count,
    .sample_rate_hz = sample_rate_hz,
    .channel_count = channel_count,
    .planes = planes,
  };
  return daw_audio_core_create_asset(to_handle(wasm_asset_core.get()), &descriptor, out_asset);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_release_asset(
  daw_audio_asset_handle asset) {
  if (!wasm_asset_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  return daw_audio_core_release_asset(to_handle(wasm_asset_core.get()), asset);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_initialize(
  uint32_t sample_rate_hz,
  uint32_t max_frames_per_block,
  uint32_t max_assets) {
  return daw_audio_core_wasm_graph_initialize_planar(
    sample_rate_hz, max_frames_per_block, kMaximumChannels, 2, max_assets);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_initialize_planar(
  uint32_t sample_rate_hz,
  uint32_t max_frames_per_block,
  uint32_t max_input_buses,
  uint32_t max_channels,
  uint32_t max_assets) {
  const daw_audio_core_config config{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .max_frames_per_block = max_frames_per_block,
    .max_channels = max_channels,
    .max_assets = max_assets,
    .sample_rate_hz = sample_rate_hz,
  };
  if (!valid_config(config) || max_input_buses == 0 || max_input_buses > kMaximumChannels) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  wasm_asset_core.reset();
  wasm_asset_core.reset(new (std::nothrow) Core{});
  if (wasm_asset_core == nullptr || !initialize_core_storage(*wasm_asset_core)) {
    wasm_asset_core.reset();
    wasm_graph_core = nullptr;
    return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
  wasm_graph_core = wasm_asset_core.get();
  wasm_graph_core->config = config;
  wasm_graph_max_input_buses = max_input_buses;
  wasm_asset_initialized = false;
  wasm_graph_initialized = true;
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_prepare(
  const uint8_t *graph_bytes,
  uint32_t graph_byte_count) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  std::array<daw_audio_graph_node_descriptor, kMaximumGraphNodes> nodes{};
  std::array<daw_audio_graph_edge_descriptor, kMaximumGraphEdges> edges{};
  std::array<daw_audio_processor_descriptor, kMaximumGraphProcessors> processors{};
  std::array<std::array<uint32_t, DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS>, kMaximumGraphProcessors> targets{};
  std::array<std::array<uint8_t, DAW_AUDIO_CORE_MAX_PROCESSOR_STATE_BYTES>, kMaximumGraphProcessors> states{};
  daw_audio_graph_prepare_request request{};
  if (!wasm_parse_graph(graph_bytes, graph_byte_count, &request, &nodes, &edges, &processors, &targets, &states)) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  return daw_audio_core_prepare_graph(to_handle(wasm_graph_core), &request);
}

extern "C" uint32_t daw_audio_core_wasm_graph_prepared_continuity() {
  return !wasm_graph_initialized || wasm_graph_core == nullptr
    ? 0U
    : daw_audio_core_prepared_graph_continuity(to_handle(wasm_graph_core));
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_publish(uint32_t expected_revision) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  return daw_audio_core_publish(to_handle(wasm_graph_core), expected_revision);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_cancel(uint32_t expected_revision) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  return daw_audio_core_cancel_prepared_graph(to_handle(wasm_graph_core), expected_revision);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_process(
  uint32_t frame_count,
  const float *left_input,
  const float *right_input,
  float *left_output,
  float *right_output,
  uint32_t graph_revision,
  const uint8_t *parameter_bytes,
  uint32_t parameter_byte_count,
  const uint8_t *event_bytes,
  uint32_t event_byte_count) {
  const float *inputs[2]{left_input, right_input == nullptr ? left_input : right_input};
  float *outputs[2]{left_output, right_output};
  return daw_audio_core_wasm_graph_process_planar(
    frame_count, 1, 2, inputs, outputs, graph_revision, parameter_bytes, parameter_byte_count,
    event_bytes, event_byte_count, nullptr, 0);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_process_planar(
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
  uint32_t instrument_event_byte_count) {
  if (!wasm_graph_initialized || outputs == nullptr) return DAW_AUDIO_CORE_NOT_PREPARED;
  if (wasm_graph_core == nullptr
    || frame_count == 0 || frame_count > wasm_graph_core->config.max_frames_per_block
    || input_bus_count > wasm_graph_max_input_buses || channel_count == 0
    || channel_count > wasm_graph_core->config.max_channels) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  if ((input_bus_count > 0 && inputs == nullptr) || outputs == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  std::array<daw_audio_processor_parameter_block, DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETER_BLOCKS> blocks{};
  std::array<daw_audio_processor_event, DAW_AUDIO_CORE_MAX_PROCESSOR_EVENTS> events{};
  std::array<daw_audio_instrument_event, DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS> instrument_events{};
  uint32_t block_count = 0;
  uint32_t event_count = 0;
  uint32_t offset = 0;
  if (parameter_byte_count == 0) {
    if (parameter_bytes != nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  } else {
    if (parameter_bytes == nullptr || !wasm_read_u32(parameter_bytes, parameter_byte_count, &offset, &block_count)
      || block_count > DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETER_BLOCKS) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    for (uint32_t index = 0; index < block_count; ++index) {
      uint64_t processor_id = 0;
      uint32_t values_frame_count = 0;
      uint32_t target_count = 0;
      if (!wasm_read_u64(parameter_bytes, parameter_byte_count, &offset, &processor_id)
        || !wasm_read_u32(parameter_bytes, parameter_byte_count, &offset, &values_frame_count)
        || !wasm_read_u32(parameter_bytes, parameter_byte_count, &offset, &target_count)
        || target_count == 0 || target_count > DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS
        || (values_frame_count != 1 && values_frame_count != frame_count)
        || offset > parameter_byte_count || parameter_byte_count - offset < target_count * 4u) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
      const uint32_t *targets = reinterpret_cast<const uint32_t *>(parameter_bytes + offset);
      offset += target_count * 4u;
      const uint64_t value_bytes = static_cast<uint64_t>(target_count) * static_cast<uint64_t>(values_frame_count) * sizeof(float);
      if (value_bytes > parameter_byte_count - offset) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
      const float *values = reinterpret_cast<const float *>(parameter_bytes + offset);
      offset += static_cast<uint32_t>(value_bytes);
      blocks[index] = {.processor_instance_id = processor_id, .frame_count = values_frame_count, .parameter_count = target_count, .parameter_targets = targets, .values = values};
    }
    if (offset != parameter_byte_count) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  offset = 0;
  if (event_byte_count == 0) {
    if (event_bytes != nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  } else {
    if (event_bytes == nullptr || !wasm_read_u32(event_bytes, event_byte_count, &offset, &event_count)
      || event_count > DAW_AUDIO_CORE_MAX_PROCESSOR_EVENTS) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    for (uint32_t index = 0; index < event_count; ++index) {
      uint64_t processor_id = 0;
      uint32_t target = 0;
      uint32_t frame_offset = 0;
      float value = 0.0F;
      if (!wasm_read_u64(event_bytes, event_byte_count, &offset, &processor_id)
        || !wasm_read_u32(event_bytes, event_byte_count, &offset, &target)
        || !wasm_read_u32(event_bytes, event_byte_count, &offset, &frame_offset)
        || !wasm_read_f32(event_bytes, event_byte_count, &offset, &value)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
      events[index] = {.processor_instance_id = processor_id, .parameter_target = target, .frame_offset = frame_offset, .value = value};
    }
    if (offset != event_byte_count) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  uint32_t instrument_event_count = 0;
  offset = 0;
  if (instrument_event_byte_count == 0) {
    if (instrument_event_bytes != nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  } else {
    if (instrument_event_bytes == nullptr
      || !wasm_read_u32(instrument_event_bytes, instrument_event_byte_count, &offset, &instrument_event_count)
      || instrument_event_count > DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    for (uint32_t index = 0; index < instrument_event_count; ++index) {
      daw_audio_instrument_event &event = instrument_events[index];
      if (!wasm_read_u64(instrument_event_bytes, instrument_event_byte_count, &offset, &event.node_id)
        || !wasm_read_u64(instrument_event_bytes, instrument_event_byte_count, &offset, &event.note_id)
        || !wasm_read_u64(instrument_event_bytes, instrument_event_byte_count, &offset, &event.sequence)
        || !wasm_read_u32(instrument_event_bytes, instrument_event_byte_count, &offset, &event.epoch)
        || !wasm_read_u32(instrument_event_bytes, instrument_event_byte_count, &offset, &event.frame_offset)
        || !wasm_read_u32(instrument_event_bytes, instrument_event_byte_count, &offset, &event.type)
        || !wasm_read_u32(instrument_event_bytes, instrument_event_byte_count, &offset, &event.channel)
        || !wasm_read_u32(instrument_event_bytes, instrument_event_byte_count, &offset, &event.note)
        || !wasm_read_f32(instrument_event_bytes, instrument_event_byte_count, &offset, &event.value)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
    if (offset != instrument_event_byte_count) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  const daw_audio_core_process_block block{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .frame_count = frame_count, .channel_count = channel_count, .input_bus_count = input_bus_count,
    .inputs = inputs, .outputs = outputs, .graph_revision = graph_revision, .parameter_block_count = block_count,
    .parameter_blocks = block_count == 0 ? nullptr : blocks.data(), .event_count = event_count,
    .events = event_count == 0 ? nullptr : events.data(), .transport_epoch = wasm_graph_core->transport.epoch,
    .instrument_event_count = instrument_event_count,
    .instrument_events = instrument_event_count == 0 ? nullptr : instrument_events.data(),
  };
  return daw_audio_core_process(to_handle(wasm_graph_core), &block);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_set_transport(
  uint32_t epoch,
  uint32_t running,
  int64_t frame) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  const daw_audio_transport_state state{
    .epoch = epoch,
    .running = running,
    .frame = frame,
    .tempo_bpm = 0.0,
    .time_signature_numerator = 0,
    .time_signature_denominator = 0,
    .cycle_active = 0,
    .cycle_start_frame = 0,
    .cycle_end_frame = 0,
  };
  return daw_audio_core_set_transport(to_handle(wasm_graph_core), &state);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_schedule_sample_source(
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
  float fade_out_curve_position) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  const daw_audio_sample_source_event event{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION,
    .epoch = epoch,
    .sequence = sequence,
    .source_node_id = source_node_id,
    .asset = asset,
    .start_frame = start_frame,
    .stop_frame = stop_frame,
    .source_offset_frame = source_offset_frame,
    .source_frame_count = source_frame_count,
    .gain = gain,
    .fade_in_start_frame = fade_in_start_frame,
    .fade_in_end_frame = fade_in_end_frame,
    .fade_out_start_frame = fade_out_start_frame,
    .fade_out_end_frame = fade_out_end_frame,
    .source_offset_fraction = source_offset_fraction,
    .fade_in_curve = fade_in_curve,
    .fade_in_curve_position = fade_in_curve_position,
    .fade_out_curve = fade_out_curve,
    .fade_out_curve_position = fade_out_curve_position,
  };
  return daw_audio_core_schedule_sample_source(to_handle(wasm_graph_core), &event);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_register_pcm_asset(
  uint32_t frame_count,
  uint32_t sample_rate_hz,
  uint32_t channel_count,
  const float *const *planes,
  daw_audio_asset_handle *out_asset) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  const daw_audio_asset_descriptor descriptor{
    .abi_version = DAW_AUDIO_CORE_ABI_VERSION, .revision = 1,
    .byte_length = static_cast<uint64_t>(frame_count) * static_cast<uint64_t>(channel_count) * sizeof(float),
    .content_hash_prefix = 0, .frame_count = frame_count, .sample_rate_hz = sample_rate_hz,
    .channel_count = channel_count, .planes = planes,
  };
  return daw_audio_core_create_asset(to_handle(wasm_graph_core), &descriptor, out_asset);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_release_asset(daw_audio_asset_handle asset) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  return daw_audio_core_release_asset(to_handle(wasm_graph_core), asset);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_configure_synth(
  uint64_t node_id,
  const daw_audio_synth_state *state) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  return daw_audio_core_configure_synth(to_handle(wasm_graph_core), node_id, state);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_configure_sampler(
  uint64_t node_id,
  const daw_audio_sampler_state *state,
  const daw_audio_sample_zone *zones) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  return daw_audio_core_configure_sampler(to_handle(wasm_graph_core), node_id, state, zones);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_configure_granular(
  uint64_t node_id,
  const daw_audio_granular_state *state) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  return daw_audio_core_configure_granular(to_handle(wasm_graph_core), node_id, state);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_recording_capture_initialize(
  const daw_audio_recording_capture_config *config) {
  if (wasm_recording_capture != 0) {
    daw_audio_recording_capture_destroy(wasm_recording_capture);
    wasm_recording_capture = 0;
  }
  return daw_audio_recording_capture_create(config, &wasm_recording_capture);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_recording_capture_process(
  const float *const *inputs,
  uint32_t input_channel_count,
  uint32_t frame_count,
  int64_t start_frame) {
  if (wasm_recording_capture == 0) return DAW_AUDIO_CORE_NOT_PREPARED;
  return daw_audio_recording_capture_process(
    wasm_recording_capture, inputs, input_channel_count, frame_count, start_frame);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_recording_capture_process_monitor(
  const float *const *inputs,
  uint32_t input_channel_count,
  float *const *monitor_outputs,
  uint32_t monitor_channel_count,
  uint32_t frame_count,
  int64_t start_frame) {
  if (wasm_recording_capture == 0) return DAW_AUDIO_CORE_NOT_PREPARED;
  return daw_audio_recording_capture_process_monitor(
    wasm_recording_capture, inputs, input_channel_count, monitor_outputs, monitor_channel_count, frame_count, start_frame);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_recording_capture_dequeue(
  float *const *outputs,
  daw_audio_recording_capture_block *out_block) {
  if (wasm_recording_capture == 0 || outputs == nullptr || out_block == nullptr) return DAW_AUDIO_CORE_NOT_PREPARED;
  daw_audio_recording_capture_block block{};
  const daw_audio_core_result result = daw_audio_recording_capture_dequeue(wasm_recording_capture, &block);
  if (result != DAW_AUDIO_CORE_OK) return result;
  for (uint32_t channel = 0; channel < block.channel_count; ++channel) {
    if (outputs[channel] == nullptr) {
      (void)daw_audio_recording_capture_release_block(wasm_recording_capture, block.block_id);
      return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
    for (uint32_t frame = 0; frame < block.frame_count; ++frame) {
      outputs[channel][frame] = block.planes[channel][frame];
    }
    block.planes[channel] = outputs[channel];
  }
  *out_block = block;
  return daw_audio_recording_capture_release_block(wasm_recording_capture, block.block_id);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_recording_capture_finalize(int64_t stop_frame) {
  if (wasm_recording_capture == 0) return DAW_AUDIO_CORE_NOT_PREPARED;
  return daw_audio_recording_capture_finalize(wasm_recording_capture, stop_frame);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_recording_capture_cancel(void) {
  if (wasm_recording_capture == 0) return DAW_AUDIO_CORE_NOT_PREPARED;
  return daw_audio_recording_capture_cancel(wasm_recording_capture);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_recording_capture_get_diagnostics(
  daw_audio_recording_capture_diagnostics *out_diagnostics) {
  if (wasm_recording_capture == 0) return DAW_AUDIO_CORE_NOT_PREPARED;
  return daw_audio_recording_capture_get_diagnostics(wasm_recording_capture, out_diagnostics);
}

extern "C" daw_audio_core_result daw_audio_core_create_asset(
  daw_audio_core_handle core_handle,
  const daw_audio_asset_descriptor *descriptor,
  daw_audio_asset_handle *out_asset) {
  if (descriptor == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  const daw_audio_mapped_asset_descriptor mapped_descriptor{
    .abi_version = descriptor->abi_version,
    .revision = descriptor->revision,
    .byte_length = descriptor->byte_length,
    .content_hash_prefix = descriptor->content_hash_prefix,
    .frame_count = descriptor->frame_count,
    .sample_rate_hz = descriptor->sample_rate_hz,
    .channel_count = descriptor->channel_count,
    .planes = descriptor->planes,
  };
  return daw_audio_core_create_mapped_asset(core_handle, &mapped_descriptor, out_asset);
}

extern "C" daw_audio_core_result daw_audio_core_create_mapped_asset(
  daw_audio_core_handle core_handle,
  const daw_audio_mapped_asset_descriptor *descriptor,
  daw_audio_asset_handle *out_asset) {
  Core *core = to_core(core_handle);
  if (core == nullptr || descriptor == nullptr || out_asset == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (!valid_abi(descriptor->abi_version)) return DAW_AUDIO_CORE_UNSUPPORTED_VERSION;
  if (!valid_asset_descriptor(*descriptor)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  for (uint32_t index = 0; index < core->config.max_assets; ++index) {
    AssetSlot &slot = core->assets[index];
    if (slot.occupied) continue;
    slot.occupied = true;
    slot.revision = descriptor->revision;
    slot.frame_count = descriptor->frame_count;
    slot.sample_rate_hz = descriptor->sample_rate_hz;
    slot.channel_count = descriptor->channel_count;
    slot.planes = descriptor->planes;
    *out_asset = make_asset_handle(index, slot.generation);
    return DAW_AUDIO_CORE_OK;
  }
  return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
}

extern "C" daw_audio_core_result daw_audio_core_get_asset_revision(
  daw_audio_core_handle core_handle,
  daw_audio_asset_handle asset,
  uint32_t *out_revision) {
  Core *core = to_core(core_handle);
  if (core == nullptr || out_revision == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  AssetSlot *slot = find_asset(core, asset);
  if (slot == nullptr) return DAW_AUDIO_CORE_INVALID_HANDLE;
  *out_revision = slot->revision;
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_release_asset(
  daw_audio_core_handle core_handle,
  daw_audio_asset_handle asset) {
  Core *core = to_core(core_handle);
  if (core == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  AssetSlot *slot = find_asset(core, asset);
  if (slot == nullptr) return DAW_AUDIO_CORE_INVALID_HANDLE;
  if (asset_is_active(*core, asset)) return DAW_AUDIO_CORE_ASSET_IN_USE;
  slot->occupied = false;
  slot->revision = 0;
  slot->frame_count = 0;
  slot->sample_rate_hz = 0;
  slot->channel_count = 0;
  slot->planes = nullptr;
  ++slot->generation;
  if (slot->generation == 0) ++slot->generation;
  return DAW_AUDIO_CORE_OK;
}
