#pragma once
#include "daw/audio_core.h"
#include "processor_contract_generated.h"
#include "daw/audio_core.h"
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
#include "daw/audio_core_native.h"
#include <chrono>
#include <string_view>
#endif

#include "dsp/biquad.h"
#include "dsp/eq_band.h"
#include "dsp/parameter_smoother.h"
#include "dsp/polyphase_iir_half_band.h"

#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <atomic>
#include <limits>
#include <memory>
#include <new>
#include <span>
#include <type_traits>
#include <tuple>

#include "autofilter_kernel.h"
#include "compressor_kernel.h"
#include "gate_kernel.h"
#include "limiter_kernel.h"

#if defined(DAW_AUDIO_CORE_TEST_INSTRUMENT_REJECTION)
extern "C" bool daw_audio_core_test_reject_instrument_event(uint32_t index);
#endif


namespace daw::audio_core_internal {

namespace dsp = ::daw::audio_core::dsp;

constexpr uint32_t kMaximumFramesPerBlock = 8192;
constexpr uint32_t kMaximumChannels = 64;
constexpr uint32_t kMaximumAssets = 64;
constexpr uint32_t kMaximumSampleSources = 256;
// The upper half holds the sources a seam fades out beside the live ones.
constexpr uint32_t kSampleSourceSlots = kMaximumSampleSources * 2;
// Live limits are what a request may carry. Entries a plan deletes keep fading
// out in transition capacity of their own, so a full live plan can always
// replace any of its entries; only a genuine overflow of the transition capacity
// fails the prepare. A plan's arrays hold both.
constexpr uint32_t kMaximumLiveNodes = 64;
constexpr uint32_t kMaximumLiveEdges = 256;
constexpr uint32_t kMaximumLiveProcessors = 512;
constexpr uint32_t kMaximumGhostNodes = 64;
constexpr uint32_t kMaximumGhostEdges = 256;
constexpr uint32_t kMaximumGhostProcessors = 128;
constexpr uint32_t kMaximumGraphNodes = kMaximumLiveNodes + kMaximumGhostNodes;
constexpr uint32_t kMaximumGraphEdges = kMaximumLiveEdges + kMaximumGhostEdges;
// Transition nodes the core adds to carry a fade have ids no caller can name.
constexpr uint64_t kTransitionNodeId = 1ULL << 63;
constexpr uint32_t kMaximumGraphProcessors = kMaximumLiveProcessors + kMaximumGhostProcessors;
constexpr uint32_t kMaximumInstrumentVoices = DAW_AUDIO_CORE_MAX_INSTRUMENT_VOICES;
constexpr uint32_t kMaximumModulationDelayFrames = 4132;
constexpr uint32_t kMaximumDelayProcessors = DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE;
constexpr uint32_t kMaximumReverbProcessors = DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE;
constexpr uint32_t kMaximumLimiterProcessors = DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE;
constexpr uint32_t kMaximumGateProcessors = DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE;
constexpr uint32_t kMaximumCompressorProcessors = DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE;
// A published plan and the plan being prepared may each reference every node,
// so node runtime (instrument voices, fade progress) has two plans' worth of
// slots. Processor slots equal one plan's capacity, live and transition entries
// together. Exhaustion is a failure that never touches an active slot.
constexpr uint32_t kNodeRuntimeSlots = kMaximumLiveNodes * 2 + kMaximumGhostNodes;
// Fader values by DAW_AUDIO_MIXER_PARAMETER_* target: gain, pan, mute, solo.
constexpr uint32_t kMixerParameterCount = DAW_AUDIO_MIXER_PARAMETER_SOLO - DAW_AUDIO_MIXER_PARAMETER_GAIN + 1;
// Replaced instruments that may still be fading out beside a node's current one.
// Each replacement within one deletion fade of the last adds one; a prepare that
// would exceed it fails rather than cutting the oldest.
constexpr uint32_t kMaximumNodeBlends = 8;
// Live processors and fading ghosts together on one node.
constexpr uint32_t kMaximumNodeChain = DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE * 2u;
constexpr uint32_t kProcessorRuntimeSlots = kMaximumGraphProcessors;
constexpr uint32_t kMaximumSpectralProcessors = DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE;
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
constexpr uint32_t kMaximumNativeGraphStagesPerNode = DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE * 2u;
#endif
constexpr uint32_t kMaximumSpectralFftSize = 4096;
constexpr uint32_t kMaximumSpectralBins = kMaximumSpectralFftSize / 2 + 1;
constexpr uint32_t kSpectralHpssFrames = 31;
// HPSS at overlap two: N + 30*(N/2) fills the median, then N
// replaces every overlap-add contribution. Round up and leave reader slack.
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
constexpr uint32_t kSpectralInputFrames = 131072;
#else
// Portable callers cannot publish a live FFT-size change. Preserve their
// fixed 256 MiB memory contract instead of reserving native transition history.
constexpr uint32_t kSpectralInputFrames = 16384;
#endif
constexpr float kSampleTerminationFadeMilliseconds = 6.0F;
// One extra frame lets a 96 kHz processor read the full 3,000 ms contract maximum.
constexpr uint32_t kMaximumTimeEffectDelayFrames = 288001;
// Reverb uses this fixed ring for pre-delay and its early-reflection taps.
constexpr uint32_t kMaximumReverbDelayFrames = 24001;
// The late network is eight feedback lines and two input diffusion chains, sized for
// 192 kHz (100 ms of line plus modulation). A higher rate clamps its delays to the
// buffers instead of running past them.
constexpr uint32_t kReverbLineCount = 8;
constexpr uint32_t kReverbLineFrames = 20480;
constexpr uint32_t kReverbDiffusionStages = 3;
constexpr uint32_t kReverbDiffusionFrames = 2560;
static_assert(sizeof(uintptr_t) <= sizeof(daw_audio_core_handle));
static_assert(DAW_AUDIO_CORE_PROCESSOR_CONTRACT_VERSION == 1u);

enum class ContinuityPreparationResult : uint8_t {
  kAccepted,
  kIncompatible,
};

struct AssetSlot {
  uint32_t generation = 1;
  uint32_t revision = 0;
  uint64_t frame_count = 0;
  uint32_t sample_rate_hz = 0;
  uint32_t channel_count = 0;
  const float *const *planes = nullptr;
  bool paged = false;
  bool occupied = false;
};

struct PagedPageSlot {
  std::atomic<daw_audio_asset_handle> owner{0};
  uint64_t page_index = 0;
  uint32_t valid_frames = 0;
  std::atomic<uint32_t> pin_count{0};
  uint64_t access_sequence = 0;
  bool occupied = false;
};

struct PagedPreparation {
  daw_audio_asset_handle asset = 0;
  uint32_t generation = 1;
  uint64_t source_offset_frame = 0;
  uint64_t source_frame_count = 0;
  uint64_t first_page = 0;
  uint32_t page_count = 0;
  std::array<uint16_t, DAW_AUDIO_CORE_MAX_PAGED_PREPARATION_PAGES> page_slots{};
  bool occupied = false;
};

struct SampleSource {
  uint64_t source_node_id = 0;
  uint32_t node_runtime_slot = 0;
  uint32_t node_runtime_generation = 0;
  daw_audio_asset_handle asset = 0;
  int64_t start_frame = 0;
  int64_t stop_frame = 0;
  uint64_t source_offset_frame = 0;
  float source_offset_fraction = 0.0F;
  uint64_t source_frame_count = 0;
  double reconciled_read_end = 0.0;
  float gain = 0.0F;
  int64_t fade_in_start_frame = 0;
  int64_t fade_in_end_frame = 0;
  int64_t fade_out_start_frame = 0;
  int64_t fade_out_end_frame = 0;
  float fade_in_curve = 0.0F;
  float fade_in_curve_position = 0.5F;
  float fade_out_curve = 0.0F;
  float fade_out_curve_position = 0.5F;
  PagedPreparation *paged_preparation = nullptr;
  bool paged = false;
  bool active = false;
  int64_t termination_start = 0;
  int64_t termination_end = 0;
  int64_t termination_read_frame = 0;
  int64_t entry_start = 0;
  int64_t entry_end = 0;
};

// Reusable runtime (processor histories, instrument voices, fade progress)
// lives in slots that outlive any one plan. A slot only moves
//   free/initialized -> prepared -> active -> retired(epoch) -> free
// and its generation advances when it is released, so a plan that still holds an
// old (index, generation) pair is detectably stale.
enum RuntimeSlotState : uint32_t {
  kSlotFree = 0,
  kSlotInitialized,
  kSlotPrepared,
  kSlotActive,
  kSlotRetired,
};

struct RuntimeSlot {
  // Core storage starts value-initialized, which is the initialized state.
  std::atomic<uint32_t> state{kSlotInitialized};
  std::atomic<uint32_t> generation{1};
  std::atomic<uint64_t> retired_epoch{0};
  // Deletion-fade progress. Only the callback writes it.
  std::atomic<uint32_t> fade_elapsed{0};
};

struct GraphRevision {
  struct Range {
    uint16_t start = 0;
    uint16_t count = 0;
  };
  uint32_t revision = 0;
  // Counts of live entries, which every id lookup and validation sees. Ghosts
  // (deleted nodes, their edges and processors that are still fading out) are
  // appended after the live entries, are only rendered, and are never reported
  // as live graph members.
  uint32_t node_count = 0;
  uint32_t edge_count = 0;
  uint32_t ghost_node_count = 0;
  uint32_t ghost_edge_count = 0;
  uint32_t ghost_processor_count = 0;
  // Frames a ghost needs to fade to silence, fixed when the plan is prepared.
  uint32_t fade_frames = 0;
  uint32_t minimum_latency = 0;
  uint32_t latency_budget = 0;
  uint32_t latency_raise = 0;
  uint64_t latency_origin = 0;
  uint64_t latency_end = 0;
  struct ReadHead {
    uint32_t previous_delay = 0;
    uint32_t delay = 0;
    uint32_t stopped_delay = 0;
    uint64_t seam = 0;
    uint32_t crossfade_frames = 0;
  };
  std::array<ReadHead, kMaximumGraphEdges> read_heads{};
  uint32_t master_index = kMaximumGraphNodes;
  uint32_t total_node_count() const { return node_count + ghost_node_count; }
  uint32_t total_edge_count() const { return edge_count + ghost_edge_count; }
  // Each node (live or ghost) owns a node runtime slot holding its instrument
  // voices and deletion-fade progress. Plans refer to it by (slot, generation).
  std::array<uint16_t, kMaximumGraphNodes> node_slots{};
  std::array<uint32_t, kMaximumGraphNodes> node_generations{};
  std::array<std::array<uint16_t, 3>, kMaximumGraphNodes> tap_history_slots{};
  std::array<std::array<bool, 3>, kMaximumLiveNodes> reset_tap_histories{};
  std::array<std::array<bool, 3>, kMaximumGraphNodes> ghost_history_writers{};
  // Slots of the previous plan that this plan neither keeps nor fades out;
  // publish retires them.
  struct SlotRef {
    uint16_t index = 0;
    uint32_t generation = 0;
  };
  uint32_t released_node_count = 0;
  std::array<SlotRef, kMaximumGraphNodes> released_nodes{};
  uint32_t released_processor_count = 0;
  std::array<SlotRef, kMaximumGraphProcessors + kMaximumSpectralProcessors> released_processors{};
  std::array<daw_audio_graph_node_descriptor, kMaximumGraphNodes> nodes{};
  std::array<uint32_t, kMaximumGraphNodes> node_lookup{};
  std::array<daw_audio_graph_edge_descriptor, kMaximumGraphEdges> edges{};
  std::array<uint16_t, kMaximumGraphEdges> edge_source_indices{};
  std::array<uint16_t, kMaximumGraphEdges> edge_target_indices{};
  std::array<uint16_t, kMaximumGraphEdges> incoming_edge_indices{};
  std::array<Range, kMaximumGraphNodes> incoming_edge_ranges{};
  std::array<uint16_t, kMaximumGraphEdges> sidechain_edge_indices{};
  // Sidechain edges only: the plan processor whose detector the edge feeds. A
  // fading edge can feed a surviving processor or a fading one.
  std::array<uint16_t, kMaximumGraphEdges> edge_target_processors{};
  // Edges that replace a route through a deleted node: one plus the ghost node
  // whose fade-out the edge fades in against (0 for every other edge).
  std::array<uint16_t, kMaximumGraphEdges> edge_join_nodes{};
  // Edges that carry on one of the published plan: a route it already had, or the
  // ghost of one it drops. One plus that edge's index there (0 for every other
  // edge): publish moves the edge from the gain it applied to its own.
  std::array<uint16_t, kMaximumGraphEdges> edge_previous{};
  // Nodes whose chain runs its surviving stages in a different order than the one
  // they render now. Such a node dips: it keeps the old order while its output fades
  // to nothing, then runs this plan's order while the output returns. A stage cannot
  // render both orders at once, and at nothing the switch cannot be heard.
  std::array<bool, kMaximumGraphNodes> node_reordered{};
  // Where each processor of the published plan stands in this one (its own entry, or
  // the ghost that fades it out), -1 when it is gone. Publish carries the order a
  // dip keeps into this plan through it.
  std::array<int16_t, kMaximumGraphProcessors> processor_remap{};
  // A node that got a fresh slot while the published plan had one (a replaced
  // instrument) names that predecessor by its index in the published plan, plus one:
  // publish keeps the predecessor rendering beside it for the deletion fade.
  std::array<uint16_t, kMaximumGraphNodes> node_replaces{};
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
    uint32_t limiter_slot = kMaximumLimiterProcessors;
    uint32_t gate_slot = kMaximumGateProcessors;
    uint32_t compressor_slot = kMaximumCompressorProcessors;
    uint32_t spectral_slot = kMaximumSpectralProcessors;
    uint32_t generation = 0;
    // A ghost keeps rendering a deleted processor while it fades out. One on a
    // deleted node fades with that node; a detached one sits on a surviving
    // node and crossfades back to the unprocessed signal.
    bool ghost = false;
    bool detached = false;
    // Ghosts only: the plan processor that precedes this one in the chain it was
    // deleted from (-1 when it headed the chain), so it renders in its old place.
    int32_t chain_anchor = -1;
    // A processor that got a fresh slot while replacing one of the same identity:
    // the index of that predecessor in the plan being replaced (-1 when none). Publish
    // hands its bypass position over on the callback side.
    int32_t bypass_source = -1;
    // Replacement stages share input, never an upstream execution.
    int32_t spectral_predecessor = -1;
    // Compensation may live beside a replacement stage, before retained
    // downstream DSP, rather than solely in an outgoing edge read head.
    uint32_t spectral_compensation = 0;
  };
  uint32_t spectral_predecessor_count = 0;
  std::array<Processor, kMaximumSpectralProcessors> spectral_predecessors{};
  uint32_t processor_count = 0;
  uint32_t total_processor_count() const { return processor_count + ghost_processor_count; }
  std::array<Processor, kMaximumGraphProcessors> processors{};
  std::array<uint16_t, kMaximumGraphProcessors> processor_indices{};
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  // Control-prepared live-target indexes keep publication reconciliation
  // logarithmic per queued event, independently of the processor chain order.
  std::array<uint16_t, kMaximumLiveProcessors> scheduled_processor_lookup{};
  std::array<uint16_t, kMaximumLiveNodes> scheduled_mixer_lookup{};
#endif
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
  float bypass = 0.0F;
};

// Everything the EQ carries between samples. The smoothers and the designed sections cover both curves (16 bands);
// the filter state is per channel and per band of the curve the channel runs.
struct EqHistory {
  static constexpr uint32_t kDryDelay = DAW_AUDIO_CORE_EQ_HIGH_QUALITY_LATENCY_FRAMES;

  bool initialized = false;
  std::array<dsp::ParameterSmoother<dsp::SmoothDomain::Log>, DAW_AUDIO_CORE_EQ_BAND_COUNT> frequency{};
  std::array<dsp::ParameterSmoother<>, DAW_AUDIO_CORE_EQ_BAND_COUNT> gain_db{};
  std::array<dsp::ParameterSmoother<>, DAW_AUDIO_CORE_EQ_BAND_COUNT> q{};
  dsp::ParameterSmoother<> scale{};
  dsp::ParameterSmoother<> output_db{};
  std::array<dsp::EqBandSections, DAW_AUDIO_CORE_EQ_BAND_COUNT> sections{};
  // The (frequency, gain, Q) the sections were designed from, so settled bands cost nothing.
  std::array<std::array<float, 3>, DAW_AUDIO_CORE_EQ_BAND_COUNT> designed{};
  // Counts processed samples so each band redesigns on its own slot of the control interval.
  uint32_t design_phase = 0;
  float output_gain = 1.0F;
  float output_gain_db = 0.0F;
  std::array<std::array<std::array<dsp::Biquad<double>, dsp::kEqMaxSections>, DAW_AUDIO_CORE_EQ_BANDS_PER_CURVE>, 2> filters{};
  std::array<dsp::PolyphaseIirHalfBand2x, 2> oversamplers{};
  // Dry signal delayed by the Hi-Quality latency so bypass crossfades between aligned paths.
  std::array<std::array<float, kDryDelay>, 2> dry{};
  uint32_t dry_index = 0;
  float bypass = 0.0F;
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

inline bool initialize_native_graph_stages(NativeGraphHooks &hooks, const GraphRevision &graph) noexcept {
  hooks.revision = graph.revision;
  hooks.stage_counts.fill(0);
  hooks.has_instrument_sources.fill(false);
  for (uint32_t node_index = 0; node_index < graph.total_node_count(); ++node_index) {
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

// A voice names its zone (an index into its own instrument's zones) and reads the
// zone's end, loop, gain, pan and choke each frame. What it derives from the zone
// once (the asset, the tuning increment, the start the playhead is offset from) is
// kept beside the values it was derived from, so `follow_sample_zone` re-derives it
// when they change.
struct SampleVoice {
  uint64_t note_id = 0;
  uint32_t note = 0;
  uint32_t zone = 0;
  float velocity = 0.0F;
  daw_audio_asset_handle asset = 0;
  uint32_t start_frame = 0;
  uint32_t root_note = 0;
  float tune_cents = 0.0F;
  double position = 0.0;
  double increment = 1.0;
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

// Control-owned snapshots contain configuration only. Live parameter overrides
// and all voice/grain/cursor state belong exclusively to InstrumentNodeState.
struct InstrumentConfiguration {
  daw_audio_synth_state synth{};
  daw_audio_sampler_state sampler{};
  std::array<daw_audio_sample_zone, DAW_AUDIO_CORE_MAX_SAMPLE_ZONES> zones{};
  daw_audio_granular_state granular{};
};

// `synth`, `sampler`, `zones` and `granular` are what the instrument is set to (its
// targets: a live event or a publish writes them). Render reads `applied`, which
// moves toward them a little every frame, so a drag has no steps.
struct InstrumentNodeState {
  InstrumentConfiguration applied{};
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
  std::array<uint64_t, kMaximumInstrumentVoices> granular_note_ages{};
  uint32_t granular_note_count = 0;
  uint64_t granular_next_note_age = 1;
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
  double phase = 0.0;
  float bypass = 0.0F;
};

// The reverb's late tail. The line lengths and gains depend only on decay, size and rate,
// so they are derived again only when one of those moves.
struct ReverbNetwork {
  std::array<std::array<float, kReverbLineFrames>, kReverbLineCount> lines{};
  std::array<std::array<float, kReverbDiffusionFrames>, 2 * kReverbDiffusionStages> diffusion{};
  uint32_t line_write = 0;
  uint32_t diffusion_write = 0;
  std::array<float, kReverbLineCount> low{};
  std::array<float, kReverbLineCount> high_input{};
  std::array<float, kReverbLineCount> high{};
  std::array<float, kReverbLineCount> line_frames{};
  std::array<float, kReverbLineCount> line_gain{};
  float decay_key = -1.0F;
  float size_key = -1.0F;
  uint32_t rate_key = 0;
};

struct ReverbHistory : TimeEffectHistory<kMaximumReverbDelayFrames> {
  ReverbNetwork network;
};

using DelayHistory = TimeEffectHistory<kMaximumTimeEffectDelayFrames>;

struct SpectralTransferMap {
  struct Band {
    uint32_t first = 0, last = 0;
    float first_weight = 0, last_weight = 0, inner_weight = 0;
  };
  std::array<Band, kMaximumSpectralBins> bands{};
  uint32_t before = 0, after = 0;
  float level = 1;
};

// State of a spectral stage that replaces a predecessor of another FFT size or
// mode. Prepared on the control side by prepare_spectral_replacement and advanced
// once per sample by render_spectral_replacement_step.
struct SpectralReplacement {
  SpectralTransferMap transfer_map{};
  uint64_t warm_cursor = 0;
  uint64_t freeze_source_deadline = 0;
  uint32_t transition_elapsed = 0;
  bool transition_started = false;
  bool analysis_from_predecessor = false;
  bool freeze_source_latched = false;
  bool freeze_changed_after_latch = false;
  bool persistent_state_transferred = false;
  uint64_t prepared_state_serial = UINT64_MAX;
  uint32_t prepared_state_mode = UINT32_MAX;
  uint32_t prepared_state_fft_size = 0;
};

struct SpectralHistory {
  SpectralReplacement replacement{};
  std::array<std::array<float, kMaximumSpectralFftSize * 2>, 2> rendered{};
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
  std::array<float, 2> wet_sample{};
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
  uint64_t state_serial = 0;
  uint32_t state_mode = UINT32_MAX;
  uint32_t analysis_frames = 0;
};

struct GateHistory {
  daw::audio_core::GateKernel kernel;
  uint32_t prepared_rate_hz = 0;
  float filter_frequency_hz = 0.0F;
  float filter_q = 0.0F;
  uint32_t filter_type = 0;
  float bypass = 0.0F;
  // A key from another track is routed to the gate; Gain and Dry/Wet act on it.
  bool external_key = false;
};

struct CompressorHistory {
  daw::audio_core::CompressorKernel kernel;
  uint32_t prepared_rate_hz = 0;
  float filter_frequency_hz = 0.0F;
  float filter_q = 0.0F;
  float bypass = 0.0F;
  // A key from another track drives the detector; Auto Makeup is off then, as it only means something for the own signal.
  bool external_key = false;
};

struct LimiterHistory {
  daw::audio_core::LimiterKernel kernel;
  uint32_t prepared_rate_hz = 0;
  float bypass = 0.0F;
};

struct AutoFilterHistory {
  daw::audio_core::AutoFilterKernel kernel;
  uint32_t prepared_rate_hz = 0;
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
  uint32_t rejected_instrument_event_index = UINT32_MAX;
  ContinuityPreparationResult prepared_continuity = ContinuityPreparationResult::kAccepted;
  std::array<int32_t, kMaximumLiveNodes> prepared_instrument_previous_nodes{};
  daw_audio_utility_state utility{};
  UtilityHistory utility_history{};
  bool utility_configured = false;
  std::array<AssetSlot, kMaximumAssets> assets{};
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  // 0 open, 1 awaiting final callback readers, 2 quiescent. Fixed capacity,
  // disjoint from asset metadata so acknowledgement never races slot reuse.
  std::array<std::atomic<uint64_t>, kMaximumAssets> asset_retirements{};
  std::array<std::atomic<uint64_t>, kMaximumAssets> asset_retirement_epochs{};
#endif
  daw_audio_paged_asset_config paged_config{
    .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
    .page_frames = DAW_AUDIO_CORE_WASM_PAGED_PAGE_FRAMES,
    .slot_count = 0,
    .max_channels = DAW_AUDIO_CORE_WASM_PAGED_MAX_CHANNELS,
  };
  std::unique_ptr<PagedPageSlot[]> paged_slots{};
  std::unique_ptr<float[]> paged_storage{};
  std::unique_ptr<PagedPreparation[]> paged_preparations{};
  uint64_t paged_access_sequence = 0;
  daw_audio_transport_state transport{};
  uint64_t last_event_sequence = 0;
  std::array<std::array<SampleSource, kSampleSourceSlots>, 2> sample_source_tables{};
  std::array<SampleSource, kSampleSourceSlots> *active_sample_sources = &sample_source_tables[0];
  std::array<GraphRevision, 2> graph_slots{};
  GraphRevision *prepared_graph = &graph_slots[0];
  GraphRevision *published_graph = &graph_slots[1];
  std::unique_ptr<StagedProcessorStatePatch[]> staged_processor_state_patches{};
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  std::array<NativeGraphHooks, 2> native_hook_banks{};
  NativeGraphHooks *prepared_native_hooks = &native_hook_banks[0];
  NativeGraphHooks *published_native_hooks = &native_hook_banks[1];
  bool prepare_profiling = false;
  std::array<daw::audio_core::PrepareStepTime, daw::audio_core::kMaximumPrepareSteps> prepare_steps{};
  std::size_t prepare_step_count = 0;
#endif
  std::unique_ptr<float[]> graph_stage_buffers{};
  // A history is shared by every edge reading the same pre-gain source tap.
  // Zero-delay ghosts consume current-block stages. Delayed ghosts reserve
  // only their actual readers, until the deletion fade and reader epoch finish.
  static constexpr uint32_t kTapHistorySlots = kMaximumLiveNodes * 3u;
  struct TapHistory {
    uint64_t first_frame = 0;
    uint64_t end_frame = 0;
    std::size_t offset = 0;
    uint32_t capacity = 0;
  };
  std::unique_ptr<float[]> graph_tap_storage{};
  std::array<TapHistory, kTapHistorySlots> graph_tap_histories{};
  uint64_t graph_write_frame = 0;
  // Callback writes; control observes only these release/acquire snapshots.
  std::atomic<uint64_t> completed_graph_frame{0};
  std::atomic<uint32_t> latency_budget{0};
  std::atomic<bool> transport_running{false};
  std::atomic<uint32_t> latency_move_revision{0};
  std::atomic<uint32_t> latency_completed_revision{0};
  // Callback-owned translation keeps absolute prepared seams intact when the
  // publication command reaches a later boundary than the prepare snapshot.
  uint64_t latency_publication_shift = 0;
  std::atomic<uint32_t> latency_shrunk_revision{0};
  std::unique_ptr<GraphRevision[]> graph_prepare_scratch{};
  std::array<ProcessorHistorySlot, kMaximumGraphProcessors> processor_history_slots{};
  std::array<UtilityHistory, kMaximumGraphProcessors> utility_histories{};
  std::array<SaturatorHistory, kMaximumGraphProcessors> saturator_histories{};
  std::array<EqHistory, kMaximumGraphProcessors> eq_histories{};
  std::array<ModulationHistory, kMaximumGraphProcessors> modulation_histories{};
  std::array<DelayHistory, kMaximumDelayProcessors> delay_histories{};
  std::array<ReverbHistory, kMaximumReverbProcessors> reverb_histories{};
  std::array<LimiterHistory, kMaximumLimiterProcessors> limiter_histories{};
  std::array<GateHistory, kMaximumGateProcessors> gate_histories{};
  std::array<CompressorHistory, kMaximumCompressorProcessors> compressor_histories{};
  std::array<SpectralHistory, kMaximumSpectralProcessors> spectral_histories{};
  SpectralHistory spectral_state_snapshot{};
  // Callback-owned stage-input histories, including detector input. Separate
  // from algorithm storage, so preparing/resetting a spare never touches a
  // running stage. The longest finite mode window is HPSS: 69,632 frames
  // at N=4096/overlap=2. 131,072 frames retain this plus reader slack.
  struct SpectralInputHistory {
    // Reserve address space at creation, but initialize/prefault the sample
    // pages only when a spectral slot is admitted on control. A user-provided
    // constructor intentionally leaves this float array uninitialized.
    // Every concurrent access uses lock-free atomic_ref, including wraparound.
    std::array<std::array<float, kSpectralInputFrames>, 4> samples;
    SpectralInputHistory() noexcept {}
    void initialize_samples() {
      for (auto &plane : samples) plane.fill(0.0F);
    }
    float sample(uint32_t plane, uint32_t frame) {
      return std::atomic_ref<float>(samples[plane][frame]).load(std::memory_order_relaxed);
    }
    void store(uint32_t plane, uint32_t frame, float value) {
      std::atomic_ref<float>(samples[plane][frame]).store(value, std::memory_order_relaxed);
    }
    std::atomic<uint64_t> end{0};
    struct PublishedState {
      std::array<std::array<float, kMaximumSpectralBins>, 2> magnitude{}, phase{};
      std::array<bool, 2> captured{};
      uint64_t serial = 0;
      uint32_t mode = UINT32_MAX;
      uint32_t fft_size = 0;
    };
    // Three fixed banks: callback owns writer, control owns reader, and an
    // atomic exchange hands over the latest complete snapshot. Neither waits.
    std::array<PublishedState, 3> states{};
    std::atomic<uint32_t> middle{1};
    uint32_t writer = 0;
    uint32_t reader = 2;
    void publish(const SpectralHistory &history, uint32_t mode) {
      auto &state = states[writer];
      if (mode == DAW_AUDIO_SPECTRAL_MODE_FREEZE) {
        state.magnitude = history.frozen_magnitude;
        state.phase = history.frozen_phase;
      } else if (mode == DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE) state.magnitude = history.noise_profile;
      else if (mode == DAW_AUDIO_SPECTRAL_MODE_GATE) state.magnitude = history.gate_gain;
      state.captured = history.freeze_captured;
      state.serial = history.state_serial;
      state.mode = mode;
      state.fft_size = history.fft_size;
      writer = middle.exchange(writer | 4u, std::memory_order_acq_rel) & 3u;
    }
    bool read(SpectralHistory &history, const daw_audio_spectral_state &config) {
      if ((middle.load(std::memory_order_acquire) & 4u) != 0)
        reader = middle.exchange(reader, std::memory_order_acq_rel) & 3u;
      const auto &state = states[reader];
      history.state_serial = 0;
      if (state.serial == 0 || state.mode != config.mode || state.fft_size != config.fft_size) return false;
      const auto mode = config.mode;
      if (mode == DAW_AUDIO_SPECTRAL_MODE_FREEZE) {
        history.frozen_magnitude = state.magnitude;
        history.frozen_phase = state.phase;
      } else if (mode == DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE) history.noise_profile = state.magnitude;
      else if (mode == DAW_AUDIO_SPECTRAL_MODE_GATE) history.gate_gain = state.magnitude;
      history.freeze_captured = state.captured;
      history.state_serial = state.serial;
      history.state_mode = state.mode;
      history.fft_size = state.fft_size;
      return true;
    }
  };
  static_assert(std::atomic_ref<float>::is_always_lock_free);
  static_assert(alignof(float) >= std::atomic_ref<float>::required_alignment);
  static_assert(std::atomic<uint64_t>::is_always_lock_free);
  std::array<SpectralInputHistory, kMaximumSpectralProcessors> spectral_inputs{};
  std::array<AutoFilterHistory, kMaximumGraphProcessors> autofilter_histories{};
  std::array<LoFiHistory, kMaximumGraphProcessors> lofi_histories{};
  // Ownership ledgers. Processor slot i guards every history array at index i
  // plus the delay/reverb/limiter/gate/compressor/spectral history named by the owner tables below
  // (index + 1 of the owning processor slot, 0 when free; control-owned).
  std::array<RuntimeSlot, kProcessorRuntimeSlots> processor_slots{};
  std::array<uint32_t, kMaximumDelayProcessors> delay_slot_owners{};
  std::array<uint32_t, kMaximumReverbProcessors> reverb_slot_owners{};
  std::array<uint32_t, kMaximumLimiterProcessors> limiter_slot_owners{};
  std::array<uint32_t, kMaximumGateProcessors> gate_slot_owners{};
  std::array<uint32_t, kMaximumCompressorProcessors> compressor_slot_owners{};
  std::array<uint32_t, kMaximumSpectralProcessors> spectral_slot_owners{};
  std::array<RuntimeSlot, kNodeRuntimeSlots> node_slots{};
  // Manual parameter values the callback latched from events and parameter
  // blocks, one table per processor slot. A table belongs to the slot, not to a
  // plan: it outlives republishes and follows the processor into a ghost, and
  // only reclaiming the slot (control thread, after its epoch) clears it.
  struct ProcessorOverrides {
    uint32_t count = 0;
    std::array<uint32_t, DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS> targets{};
    std::array<float, DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS> values{};
  };
  std::array<ProcessorOverrides, kProcessorRuntimeSlots> processor_overrides{};
  // Process calls that finished. A retired slot is reusable only after the
  // epoch it retired in has completed.
  std::atomic<uint64_t> render_epoch{0};
  std::atomic<uint32_t> stale_references{0};
  uint32_t reclaimed_slots = 0;
  // The prepared plan holds slots in the prepared state that rollback must return.
  bool prepared_runtime_held = false;
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
  // The processor's override table, laid out by parameter index for this block.
  std::array<std::array<float, DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS>, kMaximumGraphProcessors>
    override_parameter_values{};
  std::array<std::array<bool, DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS>, kMaximumGraphProcessors>
    override_parameter_valid{};
  const daw_audio_processor_event *active_events = nullptr;
  uint32_t active_event_count = 0;
  const daw_audio_instrument_event *active_instrument_events = nullptr;
  uint32_t active_instrument_event_count = 0;
  std::array<std::array<uint16_t, DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS>, kMaximumLiveNodes> instrument_event_indices{};
  std::array<uint16_t, kMaximumGraphNodes> instrument_event_counts{};
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  std::array<std::array<daw_audio_instrument_event, DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS>, kMaximumLiveNodes>
    native_instrument_events{};
#endif
  std::array<uint16_t, kSampleSourceSlots> active_source_indices{};
  std::array<GraphRevision::Range, kMaximumGraphNodes> active_source_ranges{};
  GraphRevision::Range root_source_range{};
  // Per block, where each ghost node's deletion fade starts (fade_frames once done).
  std::array<uint32_t, kMaximumGraphNodes> node_fade_start{};
  // Indexed by node runtime slot like the instrument runtime: where a node stands in
  // the dip that carries it across a reorder of its stages. The output is `level`
  // of the dip's half length (half a deletion fade). Fading out, the node renders
  // `order` (processors of the published plan, in the order they ran before the
  // edit) and `level` counts down to nothing; fading in, it renders the plan's own
  // order and `level` counts up to the whole.
  enum DipPhase : uint32_t { kDipNone = 0, kDipFadingOut, kDipFadingIn };
  struct NodeDip {
    uint32_t phase = kDipNone;
    uint32_t level = 0;
    uint32_t count = 0;
    std::array<uint16_t, kMaximumNodeChain> order{};
  };
  std::array<NodeDip, kNodeRuntimeSlots> node_dips{};
  // Where each layout fold of a node stands: 0 leaves the channels alone, 1 folds
  // them to mono, and a change of layout moves it linearly over the deletion fade.
  // [0] is the fold before the node's chain, [1] the fold after its fader.
  struct NodeFold {
    std::array<float, 2> level{};
    bool seen = false;
  };
  std::array<NodeFold, kNodeRuntimeSlots> node_folds{};
  // A replaced instrument keeps rendering its own voices in its old slot while the
  // node's new one fades in. `partner` is that slot plus one (0 for none); the
  // partner's own record chains the instrument it replaced in turn. `depth` is the
  // length of the chain, which the control thread reads to refuse one too long.
  struct NodeBlend {
    uint16_t partner = 0;
    uint32_t partner_generation = 0;
    uint32_t elapsed = 0;
    daw_audio_instrument_state_descriptor descriptor{};
    std::atomic<uint32_t> depth{0};
  };
  std::array<NodeBlend, kNodeRuntimeSlots> node_blends{};
  // Per node slot, the fader values a mixer event set, held until a later event,
  // a publish of the node or an epoch change drops them (`mask` bit per target).
  struct MixerLatch {
    std::array<float, kMixerParameterCount> values{};
    uint8_t mask = 0;
  };
  std::array<MixerLatch, kNodeRuntimeSlots> mixer_latches{};
  // Per node slot, the per-channel gains the fader applied last, and the move a
  // publish starts from them toward the plan's values.
  struct MixerRamp {
    std::array<float, 2> applied{};
    std::array<float, 2> from{};
    uint32_t elapsed = 0;
    uint32_t frames = 0;
    bool seen = false;
  };
  std::array<MixerRamp, kNodeRuntimeSlots> mixer_ramps{};
  // Per edge of the published plan, by its index there: the gain a publish moved
  // the edge from and how far it has come toward the plan's gain. Publish writes
  // the other bank for the plan it publishes and flips `edge_ramp_bank`.
  struct EdgeRamp {
    float from = 0.0F;
    uint32_t elapsed = 0;
    uint32_t frames = 0;
    bool seen = false;
  };
  std::array<std::array<EdgeRamp, kMaximumGraphEdges>, 2> edge_ramps{};
  uint32_t edge_ramp_bank = 0;
  // Per block, whether any fader is soloed at each frame (resolve_mixer_solo).
  std::array<uint8_t, kMaximumFramesPerBlock> mixer_solo_frames{};
  // Instrument runtime is indexed by node runtime slot, never by node position.
  std::array<InstrumentNodeState, kNodeRuntimeSlots> instrument_runtime{};
  std::array<std::array<InstrumentConfiguration, kMaximumLiveNodes>, 2> instrument_config_slots{};
  std::array<InstrumentConfiguration, kMaximumLiveNodes> *prepared_instrument_configs = &instrument_config_slots[0];
  std::array<InstrumentConfiguration, kMaximumLiveNodes> *published_instrument_configs = &instrument_config_slots[1];
#if defined(DAW_AUDIO_CORE_USE_PERSISTENT_VALIDATION_SCRATCH)
  std::array<InstrumentNodeState, kMaximumLiveNodes> proposed_instruments{};
#endif
};

struct ProcessorContract {
  uint32_t kind;
  uint32_t schema_version;
  uint32_t state_bytes;
  bool implemented;
};

inline constexpr std::array<ProcessorContract, DAW_AUDIO_CORE_PROCESSOR_REGISTRY_COUNT> kProcessorContracts{{
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

// One node's fader across one block. Events are sorted by instance, then offset
// (bind_process_transport), so a fader's events are one run that the block walks
// once, from what the slot latched (else the descriptor). Every event at or before
// a frame applies to it, equal offsets last-wins.
struct MixerBlock {
  uint32_t slot = 0;
  bool active = false;
  uint8_t written = 0;
  std::array<float, kMixerParameterCount> values{};
  const daw_audio_processor_event *next = nullptr;
  const daw_audio_processor_event *end = nullptr;
};

struct BiquadCoefficients {
  float b0;
  float b1;
  float b2;
  float a1;
  float a2;
};

// DAW_REALTIME_CALLBACK_HELPER_BEGIN native-source-seam
// Swaps the active table for `next` at `frame`. A source that matches one already sounding keeps its cursor. Every other
// sounding source fades out over kSampleTerminationFadeMilliseconds in the upper half of the table, and the sources
// that take its place on the same node fade in over that span. `next` is bound to the published graph and ordered by
// the caller. Planning reads the table and reports whether the swap fits; applying the plan cannot fail.
struct SourceReconciliationPlan {
  int64_t duration = 0;
  std::array<int32_t, kMaximumSampleSources> matches{};
  std::array<bool, kMaximumSampleSources> retained{};
  using NodeOwner = std::pair<uint32_t, uint32_t>;
  std::array<NodeOwner, kSampleSourceSlots> fading_nodes{};
  uint32_t fading_count = 0;
};

inline constexpr uint32_t kGraphPreFxStage = 0;
inline constexpr uint32_t kGraphPreFaderStage = 1;
inline constexpr uint32_t kGraphOutputStage = 2;
inline constexpr uint32_t kGraphStageCount = 3;

struct ProcessorContinuityMap {
  std::array<int32_t, kMaximumLiveProcessors> previous{};
  std::array<int32_t, kMaximumLiveProcessors> next{};
};

bool initialize_paged_storage(Core &core, const daw_audio_paged_asset_config &config);
bool paged_asset_is_referenced(const Core &core, daw_audio_asset_handle asset);
bool valid_synth_state(const daw_audio_synth_state &state);
bool valid_sampler_state(const daw_audio_sampler_state &state);
bool valid_granular_state(Core &core, const daw_audio_granular_state &state);
bool valid_sample_zone(Core &core, const daw_audio_sample_zone &zone);
bool valid_instrument_descriptor(const daw_audio_graph_node_descriptor &node);
int32_t graph_node_index(const GraphRevision &graph, uint64_t id);
bool order_graph_nodes(GraphRevision &graph);
void build_graph_ranges(GraphRevision &graph);
daw_audio_core_result prepare_graph_revision(
  Core &core,
  const daw_audio_graph_prepare_request &request,
  GraphRevision *out_graph);
bool valid_utility_state(const daw_audio_utility_state &state);
bool decode_processor_state(
  const daw_audio_processor_descriptor &descriptor,
  GraphRevision::Processor *out_processor);
float processor_parameter_value(
  const Core &core,
  const GraphRevision::Processor &processor,
  uint32_t target,
  uint32_t frame,
  float fallback);
void resolve_processor_parameter_frame(
  Core &core,
  GraphRevision::Processor &processor,
  uint32_t frame);
void prepare_processor_parameter_cache(
  Core &core,
  GraphRevision::Processor &processor);
void latch_processor_parameter_values(Core &core);
MixerBlock begin_mixer_block(const Core &core, const daw_audio_mixer_state &mixer, uint32_t slot);
bool resolve_mixer_solo(Core &core, const GraphRevision &graph, uint32_t frame_count);
void apply_mixer_frame(Core &core, MixerBlock &mixer, uint32_t frame, bool solo_active,
  float *left, float *right);
void process_utility_frame(
  Core &core,
  const GraphRevision::Processor *processor,
  UtilityHistory &history,
  uint32_t frame,
  float dry_left,
  float dry_right,
  float *left_output,
  float *right_output);
void render_utility_processor(
  Core &core,
  GraphRevision::Processor &processor,
  uint32_t frame,
  float input_left,
  float input_right,
  float,
  float,
  float *output_left,
  float *output_right);
BiquadCoefficients rbj_coefficients(uint32_t type, float frequency_hz, float q, float gain_db, uint32_t sample_rate_hz);
// The detector filter type a Gate or Compressor state stores (0 high-pass, 1 low-pass, 2 band-pass) as the RBJ designer names it.
inline uint32_t sidechain_band_type(uint32_t filter_type) {
  return filter_type == 1 ? DAW_AUDIO_EQ_BAND_LOWPASS : filter_type == 2 ? DAW_AUDIO_EQ_BAND_BANDPASS : DAW_AUDIO_EQ_BAND_HIGHPASS;
}
void render_saturator_processor(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  float input_left, float input_right, float, float, float *output_left, float *output_right);
void render_eq_processor(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  float input_left, float input_right, float, float, float *output_left, float *output_right);
void render_compressor_processor(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  float input_left, float input_right, float sidechain_left, float sidechain_right, float *output_left, float *output_right);
void render_limiter_processor(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  float input_left, float input_right, float, float, float *output_left, float *output_right);
void render_autofilter_processor(
  Core &core,
  GraphRevision::Processor &processor,
  uint32_t frame,
  float input_left,
  float input_right,
  float,
  float,
  float *output_left,
  float *output_right);
void render_lofi_processor(
  Core &core,
  GraphRevision::Processor &processor,
  uint32_t frame,
  float input_left,
  float input_right,
  float,
  float,
  float *output_left,
  float *output_right);
void render_modulation_processor(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  float input_left, float input_right, float, float, float *output_left, float *output_right);
bool render_reverb_sample(
  Core &core, GraphRevision::Processor &processor, uint32_t frame, ReverbHistory &history,
  float dry_left, float dry_right, float *left, float *right);
void render_time_effect_processor(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  float input_left, float input_right, float sidechain_left, float sidechain_right,
  float *output_left, float *output_right);
void render_gate_processor(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  float input_left, float input_right, float sidechain_left, float sidechain_right, float *output_left, float *output_right);
void render_spectral_processor(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  float input_left, float input_right, float sidechain_left, float sidechain_right, float *output_left, float *output_right);
ProcessorRenderer find_processor_renderer(uint32_t kind);
bool valid_sample_source_event(const daw_audio_sample_source_event &event);
float asset_sample(
  const Core &core,
  const AssetSlot &asset,
  const PagedPreparation *preparation,
  double position,
  uint32_t channel);
SampleSource make_sample_source(const daw_audio_sample_source_event &event);
bool plan_sample_source_reconciliation(Core &core, std::span<const SampleSource> next, int64_t frame,
  SourceReconciliationPlan &plan);
void apply_sample_source_reconciliation(Core &core, std::span<const SampleSource> next, int64_t frame,
  SourceReconciliationPlan &plan);
void prepare_active_source_ranges(Core &core, const GraphRevision *graph);
void render_sample_source_range(
  Core &core,
  GraphRevision::Range range,
  int64_t transport_frame,
  float *left_output,
  float *right_output);
bool allocate_graph_stage_buffers(Core &core);
void release_instrument_state(InstrumentNodeState &instrument);
void clear_instrument_state(InstrumentNodeState &instrument);
void advance_applied(const Core &core, InstrumentNodeState &instrument, uint32_t kind);
bool set_synth_parameter(daw_audio_synth_state &synth, uint32_t target, float value);
void render_instrument_frame(
  InstrumentNodeState &instrument,
  const daw_audio_instrument_state_descriptor &descriptor,
  uint32_t sample_rate_hz,
  float *left_output,
  float *right_output);
void render_sample_instrument_frame(
  Core &core,
  InstrumentNodeState &instrument,
  const daw_audio_instrument_state_descriptor &descriptor,
  float *left_output,
  float *right_output);
void render_granular_instrument_frame(
  Core &core,
  InstrumentNodeState &instrument,
  float *left_output,
  float *right_output);
bool apply_granular_instrument_event(
  InstrumentNodeState &instrument,
  const daw_audio_instrument_event &event);
bool apply_sample_instrument_event(
  Core &core,
  InstrumentNodeState &instrument,
  const daw_audio_instrument_state_descriptor &descriptor,
  const daw_audio_instrument_event &event);
bool apply_instrument_event(
  InstrumentNodeState &instrument,
  const daw_audio_instrument_state_descriptor &descriptor,
  const daw_audio_instrument_event &event);
void render_spectral_replacement_step(Core &core, GraphRevision &graph, GraphRevision::Processor &processor,
  GraphRevision::Processor &old, RuntimeSlot &slot, uint32_t frame, float left, float right,
  float sidechain_left, float sidechain_right, float &processed_left, float &processed_right);
void end_node_blend(Core &core, Core::NodeBlend &first);
void process_graph(Core &core, const daw_audio_core_process_block &block);
bool valid_processor_parameter_target(uint32_t kind, uint32_t target);
bool valid_processor_parameter_targets(const daw_audio_processor_descriptor &descriptor);
bool valid_processor_parameter_value(uint32_t target, float value);
bool wasm_parse_graph(
  const uint8_t *bytes,
  uint32_t byte_count,
  daw_audio_graph_prepare_request *out_request,
  std::array<daw_audio_graph_node_descriptor, kMaximumLiveNodes> *nodes,
  std::array<daw_audio_graph_edge_descriptor, kMaximumLiveEdges> *edges,
  std::array<daw_audio_processor_descriptor, kMaximumLiveProcessors> *processors,
  std::array<std::array<uint32_t, DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS>, kMaximumLiveProcessors> *targets,
  std::array<std::array<uint8_t, DAW_AUDIO_CORE_MAX_PROCESSOR_STATE_BYTES>, kMaximumLiveProcessors> *states);
bool same_instrument_configuration(
  const daw_audio_graph_node_descriptor &current_node,
  const daw_audio_graph_node_descriptor &next_node,
  const InstrumentConfiguration &current,
  const InstrumentConfiguration &next);
bool compatible_processor_history(
  const GraphRevision::Processor &current,
  const GraphRevision::Processor &next);
ProcessorContinuityMap build_processor_continuity_map(
  const GraphRevision &current, const GraphRevision &next);
void reclaim_retired_slots(Core &core);
void release_prepared_runtime(Core &core);
daw_audio_core_result append_deletion_ghosts(
  Core &core, const GraphRevision &current, GraphRevision &next,
  const ProcessorContinuityMap &processors);
void collect_released_slots(Core &core);
bool assign_prepared_node(Core &core, uint32_t index);
daw_audio_core_result prepare_spectral_replacement(Core &core, const GraphRevision &current, GraphRevision &next,
  GraphRevision::Processor &processor, uint32_t previous, uint32_t owned);
daw_audio_core_result prepare_runtime_ownership(Core &core);
void release_asset_storage(Core *core, AssetSlot *slot, daw_audio_asset_handle asset);
AssetSlot *find_asset(Core *core, daw_audio_asset_handle handle);
daw_audio_core_result refresh_prepared_node(Core &core, uint32_t index);
bool mark_replaced_node(const Core &core, const GraphRevision &current, GraphRevision &next, uint32_t node);

inline bool initialize_core_storage(Core &core) {
  core.staged_processor_state_patches.reset(new (std::nothrow) Core::StagedProcessorStatePatch[2]);
  core.graph_prepare_scratch.reset(new (std::nothrow) GraphRevision[2]);
  return core.staged_processor_state_patches != nullptr && core.graph_prepare_scratch != nullptr;
}

inline Core *to_core(daw_audio_core_handle handle) {
  return reinterpret_cast<Core *>(static_cast<uintptr_t>(handle));
}

inline daw_audio_core_handle to_handle(Core *core) {
  return static_cast<daw_audio_core_handle>(reinterpret_cast<uintptr_t>(core));
}

inline bool valid_abi(uint32_t version) {
  return version == DAW_AUDIO_CORE_ABI_VERSION;
}

inline bool valid_config(const daw_audio_core_config &config) {
  return valid_abi(config.abi_version)
    && config.max_frames_per_block > 0
    && config.max_frames_per_block <= kMaximumFramesPerBlock
    && config.max_channels > 0
    && config.max_channels <= kMaximumChannels
    && config.max_assets > 0
    && config.max_assets <= kMaximumAssets
    && config.sample_rate_hz > 0;
}

inline bool valid_graph_layout(uint32_t layout) {
  return layout == DAW_AUDIO_GRAPH_LAYOUT_MONO || layout == DAW_AUDIO_GRAPH_LAYOUT_STEREO;
}

inline bool valid_graph_node_kind(uint32_t kind) {
  return kind == DAW_AUDIO_GRAPH_NODE_SOURCE
    || kind == DAW_AUDIO_GRAPH_NODE_UTILITY
    || kind == DAW_AUDIO_GRAPH_NODE_MIXER
    || kind == DAW_AUDIO_GRAPH_NODE_MASTER
    || kind == DAW_AUDIO_GRAPH_NODE_INSTRUMENT;
}

inline float *paged_storage_plane(Core &core, uint32_t slot, uint32_t channel) {
  const std::size_t offset = (static_cast<std::size_t>(slot) * core.paged_config.max_channels + channel)
    * core.paged_config.page_frames;
  return core.paged_storage.get() + offset;
}

inline const float *paged_storage_plane(const Core &core, uint32_t slot, uint32_t channel) {
  const std::size_t offset = (static_cast<std::size_t>(slot) * core.paged_config.max_channels + channel)
    * core.paged_config.page_frames;
  return core.paged_storage.get() + offset;
}

inline bool paged_preparation_handle_parts(
  daw_audio_paged_preparation_handle handle,
  uint32_t *index,
  uint32_t *generation) {
  const uint32_t encoded_index = static_cast<uint32_t>(handle);
  if (encoded_index == 0) return false;
  *index = encoded_index - 1u;
  *generation = static_cast<uint32_t>(handle >> 32u);
  return *generation != 0;
}

inline PagedPreparation *find_paged_preparation(Core &core, daw_audio_paged_preparation_handle handle) {
  uint32_t index = 0;
  uint32_t generation = 0;
  if (!paged_preparation_handle_parts(handle, &index, &generation)
    || core.paged_preparations == nullptr || index >= DAW_AUDIO_CORE_MAX_PAGED_PREPARATIONS) return nullptr;
  PagedPreparation &preparation = core.paged_preparations[index];
  return preparation.occupied && preparation.generation == generation ? &preparation : nullptr;
}

inline constexpr daw_audio_synth_state default_synth_state() {
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

inline GraphRevision &configuration_graph(Core &core) {
  return core.prepared_revision != 0 ? (*core.prepared_graph) : (*core.published_graph);
}

inline InstrumentNodeState &published_instrument(Core &core, uint32_t node_index) {
  return core.instrument_runtime[(*core.published_graph).node_slots[node_index]];
}

inline bool valid_mixer_state(const daw_audio_mixer_state &mixer) {
  if (mixer.instance_id == 0) {
    return mixer.gain == 0.0F && mixer.pan == 0.0F && mixer.muted == 0 && mixer.soloed == 0;
  }
  return mixer.instance_id != 0 && std::isfinite(mixer.gain) && mixer.gain >= 0.0F && mixer.gain <= 4.0F
    && std::isfinite(mixer.pan) && mixer.pan >= -1.0F && mixer.pan <= 1.0F
    && mixer.muted <= 1 && mixer.soloed <= 1;
}

inline bool valid_graph_tap(uint32_t tap) {
  return tap == DAW_AUDIO_GRAPH_EDGE_PRE_FX
    || tap == DAW_AUDIO_GRAPH_EDGE_PRE_FADER
    || tap == DAW_AUDIO_GRAPH_EDGE_POST_FADER;
}

inline const ProcessorContract *find_processor_contract(uint32_t kind) {
  for (const ProcessorContract &contract : kProcessorContracts) {
    if (contract.kind == kind) return &contract;
  }
  return nullptr;
}

inline uint32_t read_u32_le(const uint8_t *input) {
  return static_cast<uint32_t>(input[0])
    | (static_cast<uint32_t>(input[1]) << 8u)
    | (static_cast<uint32_t>(input[2]) << 16u)
    | (static_cast<uint32_t>(input[3]) << 24u);
}

inline daw_audio_core_result validate_graph_path_latency(
  Core &core, uint32_t node_index, uint64_t path_latency) {
  if (path_latency <= kMaximumGraphLatencyFrames) return DAW_AUDIO_CORE_OK;
  core.graph_validation_diagnostic = {
    .code = DAW_AUDIO_CORE_GRAPH_VALIDATION_PATH_LATENCY_EXCEEDS_PRODUCT_MAXIMUM,
    .index = node_index,
    .actual = static_cast<uint32_t>(std::min<uint64_t>(path_latency, UINT32_MAX)),
    .limit = kMaximumGraphLatencyFrames,
  };
  return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
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

inline float summed_input(const daw_audio_core_process_block &block, uint32_t channel, uint32_t frame) {
  float value = 0.0F;
  if (block.inputs == nullptr) return value;
  for (uint32_t bus = 0; bus < block.input_bus_count; ++bus) {
    const float *input = block.inputs[bus * block.channel_count + channel];
    if (input != nullptr) value += input[frame];
  }
  return value;
}

inline void latch_mixer_block(Core &core, const MixerBlock &mixer) {
  Core::MixerLatch &latch = core.mixer_latches[mixer.slot];
  for (uint32_t index = 0; index < kMixerParameterCount; ++index) {
    if ((mixer.written & (1u << index)) != 0) latch.values[index] = mixer.values[index];
  }
  latch.mask = static_cast<uint8_t>(latch.mask | mixer.written);
}

inline float clamp_bypass_step(float current, float target, float step) {
  if (target > current + step) return current + step;
  if (target < current - step) return current - step;
  return target;
}

// The one bypass transition every processor kind shares: a 10 ms linear move of
// `level` between the processed signal (0) and the dry one (1). The processor keeps
// running underneath, so un-bypassing continues its state rather than restarting it.
inline float advance_bypass(const Core &core, float &level, bool bypassed) {
  const uint32_t frames = (core.config.sample_rate_hz + 50u) / 100u;
  level = clamp_bypass_step(level, bypassed ? 1.0F : 0.0F, 1.0F / static_cast<float>(frames == 0 ? 1u : frames));
  return level;
}

inline float bypass_mix(float processed, float dry, float level) {
  if (level <= 0.0F) return processed;
  if (level >= 1.0F) return dry;
  return processed + (dry - processed) * level;
}

inline float process_biquad(float input, const BiquadCoefficients &coefficients, BiquadHistory &history) {
  const float output = coefficients.b0 * input + coefficients.b1 * history.x1 + coefficients.b2 * history.x2
    - coefficients.a1 * history.y1 - coefficients.a2 * history.y2;
  history.x2 = history.x1; history.x1 = input; history.y2 = history.y1; history.y1 = output;
  return output;
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

inline void reset_spectral_history(SpectralHistory &history, const daw_audio_spectral_state &state) {
  if (history.fft_size == state.fft_size && history.overlap == state.overlap) return;
  history = SpectralHistory{};
  history.fft_size = state.fft_size;
  history.overlap = state.overlap;
  history.hop_size = state.fft_size / state.overlap;
  history.samples_until_frame = state.fft_size;
  for (auto &gain : history.gate_gain) gain.fill(1.0F);
}

inline float spectral_delayed_output(const SpectralHistory &history, uint32_t channel, uint32_t delay) {
  return history.rendered[channel][(history.write_index - 1u - delay) & (kMaximumSpectralFftSize * 2u - 1u)];
}

inline daw_audio_asset_handle make_asset_handle(uint32_t index, uint32_t generation) {
  return (static_cast<daw_audio_asset_handle>(generation) << 32u) | static_cast<daw_audio_asset_handle>(index + 1u);
}

inline bool decode_asset_handle(daw_audio_asset_handle handle, uint32_t *index, uint32_t *generation) {
  const uint32_t encoded_index = static_cast<uint32_t>(handle);
  if (encoded_index == 0) return false;
  *index = encoded_index - 1u;
  *generation = static_cast<uint32_t>(handle >> 32u);
  return true;
}

inline AssetSlot *find_asset(Core *core, daw_audio_asset_handle handle) {
  uint32_t index = 0;
  uint32_t generation = 0;
  if (!decode_asset_handle(handle, &index, &generation) || index >= core->config.max_assets) return nullptr;
  AssetSlot &slot = core->assets[index];
  if (!slot.occupied || slot.generation != generation) return nullptr;
  return &slot;
}

inline bool valid_transport_state(const daw_audio_transport_state &state) {
  return (state.running == 0 || state.running == 1)
    && state.epoch != 0
    && (state.tempo_bpm == 0.0 || (std::isfinite(state.tempo_bpm) && state.tempo_bpm > 0.0))
    && (state.time_signature_numerator == 0 || state.time_signature_numerator <= 32)
    && (state.time_signature_denominator == 0 || state.time_signature_denominator <= 32)
    && (state.cycle_active == 0 || state.cycle_active == 1)
    && (state.cycle_active == 0
      || (state.cycle_start_frame >= 0 && state.cycle_end_frame > state.cycle_start_frame));
}

[[maybe_unused]] inline std::int64_t project_time_frame(const Core &core) {
  if (core.transport.cycle_active == 0
    || core.transport.frame < core.transport.cycle_end_frame) return core.transport.frame;
  const auto length = core.transport.cycle_end_frame - core.transport.cycle_start_frame;
  if (length <= 0) return core.transport.frame;
  return core.transport.cycle_start_frame
    + (core.transport.frame - core.transport.cycle_start_frame) % length;
}

[[maybe_unused]] inline double project_time_music(const Core &core, const std::int64_t frame) {
  if (core.transport.tempo_bpm <= 0.0 || core.config.sample_rate_hz == 0) return 0.0;
  return static_cast<double>(frame) * core.transport.tempo_bpm
    / (60.0 * static_cast<double>(core.config.sample_rate_hz));
}

inline void clear_sample_sources(Core &core) {
  for (SampleSource &source : *core.active_sample_sources) source.active = false;
}

inline bool asset_is_active(const Core &core, daw_audio_asset_handle asset) {
  return paged_asset_is_referenced(core, asset);
}

// DAW_REALTIME_CALLBACK_HELPER_BEGIN sample-source-node-ownership
inline void bind_sample_source_node(SampleSource &source, const GraphRevision &graph) {
  const auto node = graph_node_index(graph, source.source_node_id);
  if (node < 0) return; // Legacy root sources have no graph runtime owner.
  source.node_runtime_slot = graph.node_slots[static_cast<uint32_t>(node)];
  source.node_runtime_generation = graph.node_generations[static_cast<uint32_t>(node)];
}

inline std::array<SampleSource, kSampleSourceSlots> &inactive_sample_source_table(Core &core) {
  return core.active_sample_sources == &core.sample_source_tables[0] ? core.sample_source_tables[1]
    : core.sample_source_tables[0];
}

inline float edge_ramp_gain(const Core::EdgeRamp &ramp, float gain, uint32_t at) {
  if (at >= ramp.frames) return gain;
  const float progress = static_cast<float>(at) / static_cast<float>(ramp.frames);
  return ramp.from + (gain - ramp.from) * progress;
}

inline void release_instrument_voices(Core &core) {
  for (uint32_t slot = 0; slot < kNodeRuntimeSlots; ++slot) {
    if (core.node_slots[slot].state.load(std::memory_order_acquire) == kSlotActive) {
      release_instrument_state(core.instrument_runtime[slot]);
    }
  }
}

inline bool is_native_instrument_event(const std::uint32_t type) {
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  return type >= static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOn)
    && type <= static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kAllSoundOff);
#else
  static_cast<void>(type);
  return false;
#endif
}

inline bool is_native_transport_release(const std::uint32_t type) {
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  return type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kTransportRelease);
#else
  static_cast<void>(type);
  return false;
#endif
}

inline bool is_native_all_sound_off(const std::uint32_t type) {
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  return type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kAllSoundOff);
#else
  static_cast<void>(type);
  return false;
#endif
}

inline bool is_native_live_note_on(const std::uint32_t type) {
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  return type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOn);
#else
  static_cast<void>(type);
  return false;
#endif
}

inline bool is_native_live_note_off(const std::uint32_t type) {
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  return type == static_cast<std::uint32_t>(daw::audio_core::NativeInstrumentEventType::kLiveNoteOff);
#else
  static_cast<void>(type);
  return false;
#endif
}

inline std::uint32_t portable_instrument_event_type(const std::uint32_t type) {
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

inline float waveform(uint32_t shape, float phase) {
  if (shape == DAW_AUDIO_SYNTH_WAVEFORM_SQUARE) return phase < 0.5F ? 1.0F : -1.0F;
  if (shape == DAW_AUDIO_SYNTH_WAVEFORM_SAWTOOTH) return 2.0F * phase - 1.0F;
  if (shape == DAW_AUDIO_SYNTH_WAVEFORM_TRIANGLE) return 1.0F - 4.0F * std::fabs(phase - 0.5F);
  return std::sin(6.2831853071795864769F * phase);
}

// The continuous values of an instrument's configuration, the ones a knob drag
// moves; every other field (waveforms, modes, enables, capacity, zone set, asset) is
// discrete and replaces the instrument when it changes. `visit(to, from)` is called
// for each continuous float of `to` and its counterpart in `from`. An oscillator's
// octave and semitone fold into its detune (cents), so a transposition drags like
// any other value; `from` is read through that fold and `to` receives the sum.
inline float oscillator_cents(const daw_audio_synth_oscillator_state &oscillator) {
  return static_cast<float>(oscillator.octave * 1200 + oscillator.semitone * 100) + oscillator.detune_cents;
}

template <typename State, size_t Count, typename Visit>
void visit_fields(State &to, const State &from, const std::array<float State::*, Count> &fields, Visit &&visit) {
  for (float State::*field : fields) visit(to.*field, from.*field);
}

template <typename Visit>
void visit_synth(daw_audio_synth_state &to, const daw_audio_synth_state &from, Visit &&visit) {
  visit_fields(to, from, std::array{
    &daw_audio_synth_state::noise_level, &daw_audio_synth_state::filter_cutoff_hz, &daw_audio_synth_state::filter_resonance,
    &daw_audio_synth_state::filter_key_tracking, &daw_audio_synth_state::filter_envelope_amount_octaves,
    &daw_audio_synth_state::filter_attack_ms, &daw_audio_synth_state::filter_decay_ms, &daw_audio_synth_state::filter_sustain,
    &daw_audio_synth_state::filter_release_ms, &daw_audio_synth_state::amp_attack_ms, &daw_audio_synth_state::amp_decay_ms,
    &daw_audio_synth_state::amp_sustain, &daw_audio_synth_state::amp_release_ms, &daw_audio_synth_state::lfo_rate_hz,
    &daw_audio_synth_state::lfo_pitch_cents, &daw_audio_synth_state::lfo_filter_octaves, &daw_audio_synth_state::lfo_amplitude,
    &daw_audio_synth_state::lfo_pan, &daw_audio_synth_state::output_gain, &daw_audio_synth_state::output_pan}, visit);
  for (uint32_t index = 0; index < 2; ++index) {
    visit(to.oscillators[index].level, from.oscillators[index].level);
    visit(to.oscillators[index].detune_cents, oscillator_cents(from.oscillators[index]));
  }
}

template <typename Visit>
void visit_sampler(daw_audio_sampler_state &to, const daw_audio_sampler_state &from, Visit &&visit) {
  visit_fields(to, from, std::array{
    &daw_audio_sampler_state::amp_attack_ms, &daw_audio_sampler_state::amp_decay_ms, &daw_audio_sampler_state::amp_sustain,
    &daw_audio_sampler_state::amp_release_ms, &daw_audio_sampler_state::filter_cutoff_hz,
    &daw_audio_sampler_state::filter_resonance, &daw_audio_sampler_state::filter_envelope_amount,
    &daw_audio_sampler_state::filter_attack_ms, &daw_audio_sampler_state::filter_decay_ms,
    &daw_audio_sampler_state::filter_sustain, &daw_audio_sampler_state::filter_release_ms,
    &daw_audio_sampler_state::lfo_rate_hz, &daw_audio_sampler_state::lfo_pitch_cents, &daw_audio_sampler_state::lfo_filter_hz,
    &daw_audio_sampler_state::lfo_amplitude, &daw_audio_sampler_state::lfo_pan}, visit);
}

template <typename Visit>
void visit_zone(daw_audio_sample_zone &to, const daw_audio_sample_zone &from, Visit &&visit) {
  visit_fields(to, from, std::array{
    &daw_audio_sample_zone::tune_cents, &daw_audio_sample_zone::gain, &daw_audio_sample_zone::pan}, visit);
}

template <typename Visit>
void visit_granular(daw_audio_granular_state &to, const daw_audio_granular_state &from, Visit &&visit) {
  visit_fields(to, from, std::array{
    &daw_audio_granular_state::grain_size_ms, &daw_audio_granular_state::density_hz, &daw_audio_granular_state::position,
    &daw_audio_granular_state::spray, &daw_audio_granular_state::pitch_semitones,
    &daw_audio_granular_state::reverse_probability, &daw_audio_granular_state::stereo_spread}, visit);
}

// A configuration with its continuous values cleared: what two configurations must
// share for one instrument to serve both.
inline InstrumentConfiguration discrete_part(const InstrumentConfiguration &configuration) {
  InstrumentConfiguration discrete = configuration;
  const InstrumentConfiguration none{};
  const auto clear = [](float &to, float) { to = 0.0F; };
  visit_synth(discrete.synth, none.synth, clear);
  visit_sampler(discrete.sampler, none.sampler, clear);
  visit_granular(discrete.granular, none.granular, clear);
  for (uint32_t index = 0; index < discrete.sampler.zone_count; ++index) visit_zone(discrete.zones[index], none.zones[index], clear);
  for (daw_audio_synth_oscillator_state &oscillator : discrete.synth.oscillators) oscillator.octave = oscillator.semitone = 0;
  return discrete;
}

inline void set_instrument_targets(InstrumentNodeState &runtime, const InstrumentConfiguration &configuration) {
  runtime.synth = configuration.synth;
  runtime.sampler = configuration.sampler;
  runtime.zones = configuration.zones;
  runtime.granular = configuration.granular;
}

// An instrument that is set up (not edited) applies what it is set to from its first
// frame, so nothing slews in from zero.
inline void set_up_instrument(InstrumentNodeState &runtime, const InstrumentConfiguration &configuration) {
  set_instrument_targets(runtime, configuration);
  runtime.applied = configuration;
  for (daw_audio_synth_oscillator_state &oscillator : runtime.applied.synth.oscillators) {
    oscillator.detune_cents = oscillator_cents(oscillator);
    oscillator.octave = oscillator.semitone = 0;
  }
}

inline bool instrument_declares_target(const daw_audio_instrument_state_descriptor &descriptor, uint32_t target) {
  for (uint32_t index = 0; index < descriptor.parameter_count; ++index) {
    if (descriptor.parameter_targets[index] == target) return true;
  }
  return false;
}

// A plan entry renders only while its slot is active at the generation the plan
// recorded. A mismatch on an active slot means the slot was reused under a plan
// that still names it; that entry must never render.
inline bool runtime_slot_renderable(Core &core, const RuntimeSlot &slot, uint32_t generation) {
  if (slot.state.load(std::memory_order_acquire) != kSlotActive) return false;
  if (slot.generation.load(std::memory_order_relaxed) == generation) return true;
  core.stale_references.fetch_add(1, std::memory_order_relaxed);
  return false;
}

inline void retire_runtime_slot(Core &core, RuntimeSlot &slot) {
  // The process call in progress completes epoch render_epoch + 1.
  slot.retired_epoch.store(core.render_epoch.load(std::memory_order_relaxed) + 1, std::memory_order_relaxed);
  slot.state.store(kSlotRetired, std::memory_order_release);
}

inline void record_spectral_input(Core &core, uint32_t slot, float left, float right, float sidechain_left, float sidechain_right) {
  auto &input = core.spectral_inputs[slot];
  const uint64_t end = input.end.load(std::memory_order_relaxed);
  const uint32_t at = end & (kSpectralInputFrames - 1u);
  input.store(0, at, left);
  input.store(1, at, right);
  input.store(2, at, sidechain_left);
  input.store(3, at, sidechain_right);
  input.end.store(end + 1u, std::memory_order_release);
}

// A reorder of a node's stages gets no splice: the stages are single instances that
// cannot render both orders, and any blend of the two outputs leaves a residue for a
// downstream resonant filter to ring on. The node dips instead. For half a deletion
// fade its output goes to nothing through the old order, which keeps running with
// its history; then, at nothing, the plan's order takes over and the output returns
// over another half. Each stage runs once per frame throughout and the order
// changes where the output is zero, so the dip is the only audible change.
inline uint32_t dip_half_frames(const GraphRevision &graph) { return std::max(1u, (graph.fade_frames + 1u) / 2u); }

inline const GraphRevision::Processor *find_processor(
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

inline bool processor_declares_target(const GraphRevision::Processor &processor, uint32_t target) {
  const auto begin = processor.parameter_targets.begin();
  const auto end = begin + processor.parameter_count;
  const auto parameter = std::lower_bound(begin, end, target);
  return parameter != end && *parameter == target;
}

inline const daw_audio_graph_node_descriptor *find_mixer_node(
  const GraphRevision &graph,
  uint64_t instance_id) {
  for (uint32_t index = 0; index < graph.node_count; ++index) {
    if (graph.nodes[index].mixer.instance_id == instance_id) return &graph.nodes[index];
  }
  return nullptr;
}

inline bool valid_mixer_parameter_value(uint32_t target, float value) {
  if (!std::isfinite(value)) return false;
  if (target == DAW_AUDIO_MIXER_PARAMETER_GAIN) return value >= 0.0F && value <= 4.0F;
  if (target == DAW_AUDIO_MIXER_PARAMETER_PAN) return value >= -1.0F && value <= 1.0F;
  return (target == DAW_AUDIO_MIXER_PARAMETER_MUTE || target == DAW_AUDIO_MIXER_PARAMETER_SOLO)
    && (value == 0.0F || value == 1.0F);
}

inline bool wasm_read_u32(const uint8_t *bytes, uint32_t byte_count, uint32_t *offset, uint32_t *out) {
  if (*offset > byte_count || byte_count - *offset < 4) return false;
  *out = read_u32_le(bytes + *offset);
  *offset += 4;
  return true;
}

#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
class PrepareScope {
 public:
  PrepareScope(Core &core, const char *step) : core_(core.prepare_profiling ? &core : nullptr), step_(step) {
    if (core_ != nullptr) started_ = std::chrono::steady_clock::now();
  }
  PrepareScope(const PrepareScope &) = delete;
  PrepareScope &operator=(const PrepareScope &) = delete;
  ~PrepareScope() { Finish(); }
  void Finish() {
    if (core_ == nullptr) return;
    const auto elapsed = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
      std::chrono::steady_clock::now() - started_).count());
    auto &steps = core_->prepare_steps;
    const auto end = steps.begin() + static_cast<std::ptrdiff_t>(core_->prepare_step_count);
    const auto found = std::find_if(steps.begin(), end, [this](const auto &entry) {
      return std::string_view(entry.step) == step_;
    });
    if (found != end) found->nanoseconds += elapsed;
    else if (core_->prepare_step_count < steps.size()) steps[core_->prepare_step_count++] = {step_, elapsed};
    core_ = nullptr;
  }
 private:
  Core *core_;
  const char *step_;
  std::chrono::steady_clock::time_point started_{};
};
#else
struct PrepareScope {
  PrepareScope(Core &, const char *) {}
  void Finish() {}
};
#endif

inline bool same_zone(const daw_audio_sample_zone &left, const daw_audio_sample_zone &right) {
  return left.asset == right.asset && left.key_low == right.key_low && left.key_high == right.key_high
    && left.velocity_low == right.velocity_low && left.velocity_high == right.velocity_high
    && left.root_note == right.root_note && left.tune_cents == right.tune_cents && left.gain == right.gain
    && left.pan == right.pan && left.round_robin_group == right.round_robin_group
    && left.round_robin_index == right.round_robin_index && left.playback_mode == right.playback_mode
    && left.start_frame == right.start_frame && left.end_frame == right.end_frame
    && left.loop_start_frame == right.loop_start_frame && left.loop_end_frame == right.loop_end_frame
    && left.crossfade_frame_count == right.crossfade_frame_count && left.choke_group == right.choke_group;
}

inline bool same_granular(const daw_audio_granular_state &left, const daw_audio_granular_state &right) {
  return left.version == right.version && left.asset == right.asset && left.seed == right.seed
    && left.max_grains == right.max_grains && left.window_shape == right.window_shape && left.freeze == right.freeze
    && left.grain_size_ms == right.grain_size_ms && left.density_hz == right.density_hz && left.position == right.position
    && left.spray == right.spray && left.pitch_semitones == right.pitch_semitones
    && left.reverse_probability == right.reverse_probability && left.stereo_spread == right.stereo_spread;
}

inline bool same_zones(const InstrumentConfiguration &left, const InstrumentConfiguration &right) {
  return std::equal(left.zones.begin(), left.zones.end(), right.zones.begin(), same_zone);
}

template <std::size_t Count>
int32_t acquire_runtime_slot(std::array<RuntimeSlot, Count> &slots) {
  for (uint32_t index = 0; index < Count; ++index) {
    if (slots[index].state.load(std::memory_order_relaxed) == kSlotInitialized) {
      slots[index].state.store(kSlotPrepared, std::memory_order_release);
      return static_cast<int32_t>(index);
    }
  }
  return -1;
}

inline int32_t acquire_history_owner(std::array<uint32_t, DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE> &owners, uint32_t slot) {
  for (uint32_t index = 0; index < owners.size(); ++index) {
    if (owners[index] == 0) {
      owners[index] = slot + 1;
      return static_cast<int32_t>(index);
    }
  }
  return -1;
}

// The fixed number of frames a deleted entry needs to reach silence.
inline uint32_t deletion_fade_frames(uint32_t sample_rate_hz) {
  return std::max<uint32_t>(1, static_cast<uint32_t>((static_cast<uint64_t>(sample_rate_hz) * 5u + 500u) / 1000u));
}

// Instrument configuration changed on the prepared plan: the node may switch
// between keeping the published slot and getting a fresh one.
inline daw_audio_core_result refresh_prepared_node(Core &core, uint32_t index) {
  const bool assigned = assign_prepared_node(core, index);
  bool capacity = true;
  if (core.published_revision != 0 && core.prepared_continuity == ContinuityPreparationResult::kAccepted) {
    capacity = mark_replaced_node(core, *core.published_graph, *core.prepared_graph, index);
  }
  collect_released_slots(core);
  return assigned && capacity ? DAW_AUDIO_CORE_OK : DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
}

// A node that gets a fresh slot where the published plan had one keeps that
// predecessor rendering beside it while it fades out (a replaced instrument).
// Also re-run when an instrument's configuration is set on the prepared plan,
// which can swap the node between keeping its slot and getting a fresh one.
// False when the predecessor already carries as many unfinished replacements as a
// node may: the edit fails instead of cutting the oldest.
inline bool mark_replaced_node(const Core &core, const GraphRevision &current, GraphRevision &next, uint32_t node) {
  const int32_t previous = graph_node_index(current, next.nodes[node].id);
  const bool replaced = previous >= 0 && current.nodes[static_cast<uint32_t>(previous)].kind == next.nodes[node].kind
    && next.node_slots[node] != current.node_slots[static_cast<uint32_t>(previous)];
  next.node_replaces[node] = replaced ? static_cast<uint16_t>(previous + 1) : 0;
  return !replaced
    || core.node_blends[current.node_slots[static_cast<uint32_t>(previous)]].depth.load(std::memory_order_acquire)
      < kMaximumNodeBlends;
}
}  // namespace daw::audio_core_internal

using namespace daw::audio_core_internal;
