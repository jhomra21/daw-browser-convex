#include "daw/audio_core.h"
#include "processor_contract_generated.h"
#include "daw/audio_core.h"
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
#include "daw/audio_core_native.h"
#endif

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

#if defined(DAW_AUDIO_CORE_TEST_INSTRUMENT_REJECTION)
extern "C" bool daw_audio_core_test_reject_instrument_event(uint32_t index);
#endif

namespace {

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
constexpr uint32_t kMaximumDynamicsDelayFrames = 1024;
constexpr uint32_t kMaximumDelayProcessors = DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE;
constexpr uint32_t kMaximumReverbProcessors = DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE;
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
constexpr uint32_t kAutoFilterLatencyFrames = 6;
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

struct EqHistory {
  std::array<std::array<BiquadHistory, 2>, 8> bands{};
  float bypass = 0.0F;
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

bool initialize_native_graph_stages(NativeGraphHooks &hooks, const GraphRevision &graph) noexcept {
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

struct SpectralTransferMap {
  struct Band {
    uint32_t first = 0, last = 0;
    float first_weight = 0, last_weight = 0, inner_weight = 0;
  };
  std::array<Band, kMaximumSpectralBins> bands{};
  uint32_t before = 0, after = 0;
  float level = 1;
};

struct SpectralHistory {
  SpectralTransferMap transfer_map{};
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
  uint64_t warm_cursor = 0;
  uint64_t freeze_source_deadline = 0;
  uint32_t transition_elapsed = 0;
  bool transition_started = false;
  bool analysis_from_predecessor = false;
  bool freeze_source_latched = false;
  bool freeze_changed_after_latch = false;
  bool persistent_state_transferred = false;
  uint64_t state_serial = 0;
  uint32_t state_mode = UINT32_MAX;
  uint64_t prepared_state_serial = UINT64_MAX;
  uint32_t prepared_state_mode = UINT32_MAX;
  uint32_t prepared_state_fft_size = 0;
  uint32_t analysis_frames = 0;
};

uint32_t spectral_warm_frames(const daw_audio_spectral_state &state) {
  return state.fft_size * 2u + (state.mode == DAW_AUDIO_SPECTRAL_MODE_HPSS
    ? (kSpectralHpssFrames - 1u) * (state.fft_size / state.overlap) : 0u);
}

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
  std::array<DynamicsHistory, kMaximumGraphProcessors> dynamics_histories{};
  std::array<ModulationHistory, kMaximumGraphProcessors> modulation_histories{};
  std::array<DelayHistory, kMaximumDelayProcessors> delay_histories{};
  std::array<ReverbHistory, kMaximumReverbProcessors> reverb_histories{};
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
  // plus the delay/reverb/spectral history named by the owner tables below
  // (index + 1 of the owning processor slot, 0 when free; control-owned).
  std::array<RuntimeSlot, kProcessorRuntimeSlots> processor_slots{};
  std::array<uint32_t, kMaximumDelayProcessors> delay_slot_owners{};
  std::array<uint32_t, kMaximumReverbProcessors> reverb_slot_owners{};
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

bool initialize_core_storage(Core &core) {
  core.staged_processor_state_patches.reset(new (std::nothrow) Core::StagedProcessorStatePatch[2]);
  core.graph_prepare_scratch.reset(new (std::nothrow) GraphRevision[2]);
  return core.staged_processor_state_patches != nullptr && core.graph_prepare_scratch != nullptr;
}

bool initialize_paged_storage(Core &core, const daw_audio_paged_asset_config &config) {
  if (config.abi_version != DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION
    || config.page_frames == 0
    || config.slot_count == 0
    || config.slot_count > DAW_AUDIO_CORE_MAX_PAGED_PAGE_SLOTS
    || config.max_channels == 0
    || config.max_channels > DAW_AUDIO_CORE_WASM_PAGED_MAX_CHANNELS
    || config.max_channels > core.config.max_channels) return false;
  if (core.paged_config.slot_count != 0) return false;
  const uint64_t sample_count = static_cast<uint64_t>(config.slot_count)
    * static_cast<uint64_t>(config.max_channels) * static_cast<uint64_t>(config.page_frames);
  if (sample_count > std::numeric_limits<std::size_t>::max()) return false;
  const std::size_t samples = static_cast<std::size_t>(sample_count);
  auto slots = std::unique_ptr<PagedPageSlot[]>(new (std::nothrow) PagedPageSlot[config.slot_count]);
  auto storage = std::unique_ptr<float[]>(new (std::nothrow) float[samples]);
  auto preparations = std::unique_ptr<PagedPreparation[]>(
    new (std::nothrow) PagedPreparation[DAW_AUDIO_CORE_MAX_PAGED_PREPARATIONS]);
  if (slots == nullptr || storage == nullptr || preparations == nullptr) return false;
  core.paged_config = config;
  core.paged_slots = std::move(slots);
  core.paged_storage = std::move(storage);
  core.paged_preparations = std::move(preparations);
  core.paged_access_sequence = 0;
  return true;
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

uint64_t paged_page_count(const Core &core, uint64_t frame_count) {
  if (frame_count == 0) return 0;
  return (frame_count - 1u) / static_cast<uint64_t>(core.paged_config.page_frames) + 1u;
}

float *paged_storage_plane(Core &core, uint32_t slot, uint32_t channel) {
  const std::size_t offset = (static_cast<std::size_t>(slot) * core.paged_config.max_channels + channel)
    * core.paged_config.page_frames;
  return core.paged_storage.get() + offset;
}

const float *paged_storage_plane(const Core &core, uint32_t slot, uint32_t channel) {
  const std::size_t offset = (static_cast<std::size_t>(slot) * core.paged_config.max_channels + channel)
    * core.paged_config.page_frames;
  return core.paged_storage.get() + offset;
}

PagedPageSlot *find_paged_page(Core &core, daw_audio_asset_handle asset, uint64_t page_index) {
  if (core.paged_slots == nullptr) return nullptr;
  for (uint32_t slot = 0; slot < core.paged_config.slot_count; ++slot) {
    PagedPageSlot &page = core.paged_slots[slot];
    if (page.owner.load(std::memory_order_acquire) == asset && page.page_index == page_index) return &page;
  }
  return nullptr;
}

uint32_t select_paged_page_slot(Core &core, daw_audio_asset_handle asset, uint64_t page_index) {
  uint32_t free_slot = core.paged_config.slot_count;
  uint32_t lru_slot = core.paged_config.slot_count;
  uint64_t lru_sequence = UINT64_MAX;
  for (uint32_t slot = 0; slot < core.paged_config.slot_count; ++slot) {
    PagedPageSlot &page = core.paged_slots[slot];
    const uint64_t owner = page.owner.load(std::memory_order_acquire);
    if (owner == asset && page.page_index == page_index) return slot;
    if (owner == 0 && free_slot == core.paged_config.slot_count) {
      free_slot = slot;
      continue;
    }
    if (owner != 0 && page.pin_count.load(std::memory_order_acquire) == 0
      && page.access_sequence < lru_sequence) {
      lru_slot = slot;
      lru_sequence = page.access_sequence;
    }
  }
  return free_slot != core.paged_config.slot_count ? free_slot : lru_slot;
}

bool paged_preparation_handle_parts(
  daw_audio_paged_preparation_handle handle,
  uint32_t *index,
  uint32_t *generation) {
  const uint32_t encoded_index = static_cast<uint32_t>(handle);
  if (encoded_index == 0) return false;
  *index = encoded_index - 1u;
  *generation = static_cast<uint32_t>(handle >> 32u);
  return *generation != 0;
}

PagedPreparation *find_paged_preparation(Core &core, daw_audio_paged_preparation_handle handle) {
  uint32_t index = 0;
  uint32_t generation = 0;
  if (!paged_preparation_handle_parts(handle, &index, &generation)
    || core.paged_preparations == nullptr || index >= DAW_AUDIO_CORE_MAX_PAGED_PREPARATIONS) return nullptr;
  PagedPreparation &preparation = core.paged_preparations[index];
  return preparation.occupied && preparation.generation == generation ? &preparation : nullptr;
}

daw_audio_paged_preparation_handle make_paged_preparation_handle(uint32_t index, uint32_t generation) {
  return (static_cast<daw_audio_paged_preparation_handle>(generation) << 32u)
    | static_cast<daw_audio_paged_preparation_handle>(index + 1u);
}

bool paged_asset_is_referenced(const Core &core, daw_audio_asset_handle asset) {
  for (const SampleSource &source : *core.active_sample_sources) {
    if (source.active && source.asset == asset) return true;
  }
  if (core.paged_preparations != nullptr) {
    for (uint32_t index = 0; index < DAW_AUDIO_CORE_MAX_PAGED_PREPARATIONS; ++index) {
      const PagedPreparation &preparation = core.paged_preparations[index];
      if (preparation.occupied && preparation.asset == asset) return true;
    }
  }
  for (uint32_t slot = 0; slot < kNodeRuntimeSlots; ++slot) {
    const uint32_t state = core.node_slots[slot].state.load(std::memory_order_acquire);
    if (state != kSlotPrepared && state != kSlotActive) continue;
    const InstrumentNodeState &instrument = core.instrument_runtime[slot];
    for (uint32_t index = 0; index < instrument.sampler.zone_count; ++index) {
      if (instrument.zones[index].asset == asset) return true;
    }
    for (const SampleVoice &voice : instrument.sample_voices) {
      if (voice.active && voice.asset == asset) return true;
    }
    if (instrument.granular.asset == asset && (instrument.granular_note_count > 0
      || std::any_of(instrument.grains.begin(), instrument.grains.end(),
        [](const GranularGrain &grain) { return grain.active; }))) return true;
  }
  return false;
}

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
  const AssetSlot *asset = state.asset == 0 ? nullptr : find_asset(&core, state.asset);
  return state.version == 1 && (state.asset == 0 || (asset != nullptr && !asset->paged)) && state.seed != 0
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
  return asset != nullptr && !asset->paged && zone.key_low <= zone.key_high && zone.key_high <= 127
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

InstrumentNodeState &published_instrument(Core &core, uint32_t node_index) {
  return core.instrument_runtime[(*core.published_graph).node_slots[node_index]];
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

bool allocate_graph_stage_buffers(Core &core);

// Topological order over live and ghost nodes together, signal and sidechain
// edges alike: a key is always processed before the node it controls. False on a
// cycle.
bool order_graph_nodes(GraphRevision &graph) {
  std::array<uint32_t, kMaximumGraphNodes> remaining{};
  std::array<bool, kMaximumGraphNodes> ordered{};
  const uint32_t node_total = graph.total_node_count();
  const uint32_t edge_total = graph.total_edge_count();
  for (uint32_t edge_index = 0; edge_index < edge_total; ++edge_index) {
    ++remaining[graph.edge_target_indices[edge_index]];
  }
  for (uint32_t order_count = 0; order_count < node_total; ++order_count) {
    uint32_t next = kMaximumGraphNodes;
    for (uint32_t index = 0; index < node_total; ++index) {
      if (!ordered[index] && remaining[index] == 0) {
        next = index;
        break;
      }
    }
    if (next == kMaximumGraphNodes) return false;
    ordered[next] = true;
    graph.process_order[order_count] = next;
    for (uint32_t edge_index = 0; edge_index < edge_total; ++edge_index) {
      if (graph.edge_source_indices[edge_index] == next) --remaining[graph.edge_target_indices[edge_index]];
    }
  }
  return true;
}

// Edge and processor ranges in request order for live and ghost entries.
void build_graph_ranges(GraphRevision &graph) {
  const uint32_t node_total = graph.total_node_count();
  const uint32_t edge_total = graph.total_edge_count();
  const uint32_t processor_total = graph.total_processor_count();
  graph.incoming_edge_ranges = {};
  graph.processor_ranges = {};
  graph.sidechain_edge_ranges = {};
  for (uint32_t edge_index = 0; edge_index < edge_total; ++edge_index) {
    if (graph.edges[edge_index].sidechain == 0) ++graph.incoming_edge_ranges[graph.edge_target_indices[edge_index]].count;
  }
  for (uint32_t processor_index = 0; processor_index < processor_total; ++processor_index) {
    ++graph.processor_ranges[graph.processors[processor_index].node_index].count;
  }
  uint16_t incoming_start = 0;
  uint16_t processor_start = 0;
  for (uint32_t node_index = 0; node_index < node_total; ++node_index) {
    graph.incoming_edge_ranges[node_index].start = incoming_start;
    graph.processor_ranges[node_index].start = processor_start;
    incoming_start = static_cast<uint16_t>(incoming_start + graph.incoming_edge_ranges[node_index].count);
    processor_start = static_cast<uint16_t>(processor_start + graph.processor_ranges[node_index].count);
  }
  std::array<uint16_t, kMaximumGraphNodes> incoming_fill{};
  std::array<uint16_t, kMaximumGraphNodes> processor_fill{};
  for (uint32_t edge_index = 0; edge_index < edge_total; ++edge_index) {
    if (graph.edges[edge_index].sidechain != 0) continue;
    const uint32_t target = graph.edge_target_indices[edge_index];
    graph.incoming_edge_indices[graph.incoming_edge_ranges[target].start + incoming_fill[target]++] =
      static_cast<uint16_t>(edge_index);
  }
  for (uint32_t processor_index = 0; processor_index < graph.processor_count; ++processor_index) {
    const uint32_t node_index = graph.processors[processor_index].node_index;
    graph.processor_indices[graph.processor_ranges[node_index].start + processor_fill[node_index]++] =
      static_cast<uint16_t>(processor_index);
  }
  // A ghost goes back where it stood in its chain: straight after the processor
  // it followed, so every retained processor still runs once and in order.
  // Ghosts are stored in their old chain order, so a ghost's anchor is placed
  // before the ghost itself.
  for (uint32_t processor_index = graph.processor_count; processor_index < processor_total; ++processor_index) {
    const GraphRevision::Processor &ghost = graph.processors[processor_index];
    uint16_t *chain = &graph.processor_indices[graph.processor_ranges[ghost.node_index].start];
    uint32_t position = 0;
    if (ghost.chain_anchor >= 0) {
      while (chain[position] != ghost.chain_anchor) ++position;
      ++position;
    }
    for (uint32_t end = processor_fill[ghost.node_index]++; end > position; --end) chain[end] = chain[end - 1];
    chain[position] = static_cast<uint16_t>(processor_index);
  }
  uint16_t sidechain_edge_count = 0;
  for (uint32_t processor_index = 0; processor_index < processor_total; ++processor_index) {
    GraphRevision::Range &sidechain_range = graph.sidechain_edge_ranges[processor_index];
    sidechain_range.start = sidechain_edge_count;
    for (uint32_t edge_index = 0; edge_index < edge_total; ++edge_index) {
      if (graph.edges[edge_index].sidechain != 0 && graph.edge_target_processors[edge_index] == processor_index) {
        graph.sidechain_edge_indices[sidechain_edge_count++] = static_cast<uint16_t>(edge_index);
        ++sidechain_range.count;
      }
    }
  }
}

daw_audio_core_result prepare_graph_revision(
  Core &core,
  const daw_audio_graph_prepare_request &request,
  GraphRevision *out_graph) {
  core.graph_validation_diagnostic = {};
  if (!valid_abi(request.abi_version)) return DAW_AUDIO_CORE_UNSUPPORTED_VERSION;
  if (request.graph_revision == 0 || request.node_count == 0 || request.node_count > kMaximumLiveNodes
    || request.edge_count > kMaximumLiveEdges || request.nodes == nullptr
    || (request.edge_count > 0 && request.edges == nullptr)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (request.processor_count > kMaximumLiveProcessors) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  if (request.processor_count > 0 && request.processors == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  GraphRevision &graph = core.graph_prepare_scratch[1];
  // Reset directly in preallocated storage. `graph = {}` materializes a full
  // graph temporary in debug builds and overflows macOS control-thread stacks.
  // This is control-only placement construction, with no storage allocation.
  std::destroy_at(&graph);
  std::construct_at(&graph);
  graph.revision = request.graph_revision;
  graph.node_count = request.node_count;
  graph.edge_count = request.edge_count;
  for (uint32_t index = 0; index < graph.node_count; ++index) {
    const daw_audio_graph_node_descriptor node = request.nodes[index];
    if (node.id == 0 || !valid_graph_node_kind(node.kind) || !valid_graph_layout(node.input_layout)
      || !valid_graph_layout(node.output_layout) || !valid_instrument_descriptor(node) || !valid_mixer_state(node.mixer)
      || node.keep_latency > 1
      // A source's bus indexes the block's input buses, which process caps at kMaximumChannels.
      || (node.kind == DAW_AUDIO_GRAPH_NODE_SOURCE
        && node.input_bus != DAW_AUDIO_GRAPH_INPUT_BUS_DISCONNECTED
        && node.input_bus >= kMaximumChannels)) {
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
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  for (uint32_t index = 0; index < graph.processor_count; ++index) graph.scheduled_processor_lookup[index] = index;
  std::sort(graph.scheduled_processor_lookup.begin(), graph.scheduled_processor_lookup.begin() + graph.processor_count,
    [&graph](uint16_t left, uint16_t right) { return graph.processors[left].instance_id < graph.processors[right].instance_id; });
  for (uint32_t index = 0; index < graph.node_count; ++index) graph.scheduled_mixer_lookup[index] = index;
  std::sort(graph.scheduled_mixer_lookup.begin(), graph.scheduled_mixer_lookup.begin() + graph.node_count,
    [&graph](uint16_t left, uint16_t right) { return graph.nodes[left].mixer.instance_id < graph.nodes[right].mixer.instance_id; });
#endif
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
          graph.edge_target_processors[index] = static_cast<uint16_t>(processor_index);
          break;
        }
      }
      if (target == nullptr || target->node_id != edge.to_node_id
        || target->input_layout != graph.nodes[static_cast<uint32_t>(to_index)].input_layout) {
        return DAW_AUDIO_CORE_INVALID_ARGUMENT;
      }
    }
    if (edge.pdc_delay_frames > kMaximumGraphLatencyFrames) {
      core.graph_validation_diagnostic = {
        .code = DAW_AUDIO_CORE_GRAPH_VALIDATION_PDC_DELAY_EXCEEDS_RING_CAPACITY,
        .index = index,
        .actual = edge.pdc_delay_frames,
        .limit = kMaximumGraphLatencyFrames,
      };
      return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    }
    for (uint32_t existing = 0; existing < index; ++existing) {
      if (graph.edges[existing].id == edge.id) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
    graph.edges[index] = edge;
    graph.edge_source_indices[index] = static_cast<uint16_t>(from_index);
    graph.edge_target_indices[index] = static_cast<uint16_t>(to_index);
  }
  if (!order_graph_nodes(graph)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
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
    if (path_latency[node_index] > kMaximumGraphLatencyFrames) {
      core.graph_validation_diagnostic = {
        .code = DAW_AUDIO_CORE_GRAPH_VALIDATION_PATH_LATENCY_EXCEEDS_PRODUCT_MAXIMUM,
        .index = node_index,
        .actual = path_latency[node_index],
        .limit = kMaximumGraphLatencyFrames,
      };
      return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    }
    for (uint32_t edge_index = 0; edge_index < graph.edge_count; ++edge_index) {
      const daw_audio_graph_edge_descriptor &edge = graph.edges[edge_index];
      if (edge.sidechain != 0 || edge.to_node_id != graph.nodes[node_index].id) continue;
      const uint32_t source_index = graph.edge_source_indices[edge_index];
      uint32_t arrival = path_latency[source_index];
      if (edge.tap == DAW_AUDIO_GRAPH_EDGE_PRE_FX) arrival -= effective_node_latency(source_index);
      if (edge.pdc_delay_frames != upstream_latency - arrival) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
  }
  build_graph_ranges(graph);
  graph.minimum_latency = path_latency[graph.master_index];
  if (!core.graph_stage_buffers) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  *out_graph = graph;
  return DAW_AUDIO_CORE_OK;
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
    bool valid = core.override_parameter_valid[slot][index];
    float value = core.override_parameter_values[slot][index];
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
  core.override_parameter_valid[slot].fill(false);
  const Core::ProcessorOverrides &overrides = core.processor_overrides[processor.history_slot];
  for (uint32_t entry = 0; entry < overrides.count; ++entry) {
    const auto parameter_begin = processor.parameter_targets.begin();
    const auto parameter_end = parameter_begin + processor.parameter_count;
    const auto target = std::lower_bound(parameter_begin, parameter_end, overrides.targets[entry]);
    if (target == parameter_end || *target != overrides.targets[entry]) continue;
    const auto index = static_cast<size_t>(target - parameter_begin);
    core.override_parameter_values[slot][index] = overrides.values[entry];
    core.override_parameter_valid[slot][index] = true;
  }
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

// Callback. A plan's processor reaches its override table through the runtime
// slot it owns, so a retained processor keeps its values across republishes.
void latch_processor_parameter_values(Core &core) {
  const GraphRevision &graph = *core.published_graph;
  for (uint32_t processor_index = 0; processor_index < graph.processor_count; ++processor_index) {
    const GraphRevision::Processor &processor = graph.processors[processor_index];
    const uint32_t slot = processor.control_slot;
    if (!core.parameter_cache_prepared[slot]) continue;
    Core::ProcessorOverrides &overrides = core.processor_overrides[processor.history_slot];
    for (uint32_t index = 0; index < processor.parameter_count; ++index) {
      if (!core.resolved_parameter_valid[slot][index]) continue;
      const uint32_t target = processor.parameter_targets[index];
      uint32_t entry = 0;
      while (entry < overrides.count && overrides.targets[entry] != target) ++entry;
      if (entry == overrides.count) {
        if (entry < DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS) {
          ++overrides.count;
        } else {
          // Full of targets earlier plans declared: this plan declares at most
          // the table size and this target is missing from it, so one entry is stale.
          const auto declared_begin = processor.parameter_targets.begin();
          const auto declared_end = declared_begin + processor.parameter_count;
          entry = 0;
          while (std::binary_search(declared_begin, declared_end, overrides.targets[entry])) ++entry;
        }
        overrides.targets[entry] = target;
      }
      overrides.values[entry] = core.resolved_parameter_values[slot][index];
    }
  }
}

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

constexpr uint32_t mixer_value_index(uint32_t target) {
  return target - DAW_AUDIO_MIXER_PARAMETER_GAIN;
}

MixerBlock begin_mixer_block(const Core &core, const daw_audio_mixer_state &mixer, uint32_t slot) {
  MixerBlock block{.slot = slot, .active = mixer.instance_id != 0};
  if (!block.active) return block;
  block.values = {mixer.gain, mixer.pan, mixer.muted == 0 ? 0.0F : 1.0F, mixer.soloed == 0 ? 0.0F : 1.0F};
  const Core::MixerLatch &latch = core.mixer_latches[slot];
  for (uint32_t index = 0; index < kMixerParameterCount; ++index) {
    if ((latch.mask & (1u << index)) != 0) block.values[index] = latch.values[index];
  }
  const daw_audio_processor_event *events_end = core.active_events + core.active_event_count;
  block.next = std::lower_bound(core.active_events, events_end, mixer.instance_id,
    [](const daw_audio_processor_event &event, uint64_t id) { return event.processor_instance_id < id; });
  block.end = std::upper_bound(block.next, events_end, mixer.instance_id,
    [](uint64_t id, const daw_audio_processor_event &event) { return id < event.processor_instance_id; });
  return block;
}

void advance_mixer_block(MixerBlock &mixer, uint32_t frame) {
  for (; mixer.next != mixer.end && mixer.next->frame_offset <= frame; ++mixer.next) {
    const uint32_t index = mixer_value_index(mixer.next->parameter_target);
    if (index >= kMixerParameterCount) continue;
    mixer.values[index] = mixer.next->value;
    mixer.written = static_cast<uint8_t>(mixer.written | (1u << index));
  }
}

// Callback, after a node's block: what its events set holds for later blocks.
void latch_mixer_block(Core &core, const MixerBlock &mixer) {
  Core::MixerLatch &latch = core.mixer_latches[mixer.slot];
  for (uint32_t index = 0; index < kMixerParameterCount; ++index) {
    if ((mixer.written & (1u << index)) != 0) latch.values[index] = mixer.values[index];
  }
  latch.mask = static_cast<uint8_t>(latch.mask | mixer.written);
}

// Whether any live node's fader is soloed, per frame of the block, into
// mixer_solo_frames. False, writing nothing, when none is soloed in the block.
bool resolve_mixer_solo(Core &core, const GraphRevision &graph, uint32_t frame_count) {
  bool soloed = false;
  for (uint32_t node = 0; node < graph.node_count; ++node) {
    MixerBlock mixer = begin_mixer_block(core, graph.nodes[node].mixer, graph.node_slots[node]);
    for (uint32_t frame = 0; mixer.active && frame < frame_count;) {
      advance_mixer_block(mixer, frame);
      const uint32_t until = mixer.next == mixer.end ? frame_count : mixer.next->frame_offset;
      if (mixer.values[mixer_value_index(DAW_AUDIO_MIXER_PARAMETER_SOLO)] == 1.0F) {
        if (!soloed) std::fill_n(core.mixer_solo_frames.begin(), frame_count, uint8_t{0});
        soloed = true;
        std::fill(core.mixer_solo_frames.begin() + frame, core.mixer_solo_frames.begin() + until, uint8_t{1});
      }
      frame = until;
    }
  }
  return soloed;
}

// One frame of a fader. A publish that changed what a retained node applies moves
// its gains there over the plan's fade (begin_mixer_ramps); otherwise they follow
// the values at once.
void apply_mixer_frame(Core &core, MixerBlock &mixer, uint32_t frame, bool solo_active,
  float *left, float *right) {
  if (!mixer.active) return;
  advance_mixer_block(mixer, frame);
  const bool silent = mixer.values[mixer_value_index(DAW_AUDIO_MIXER_PARAMETER_MUTE)] == 1.0F
    || (solo_active && mixer.values[mixer_value_index(DAW_AUDIO_MIXER_PARAMETER_SOLO)] != 1.0F);
  std::array<float, 2> gains{};
  if (!silent) {
    const float gain = mixer.values[mixer_value_index(DAW_AUDIO_MIXER_PARAMETER_GAIN)];
    const float pan = mixer.values[mixer_value_index(DAW_AUDIO_MIXER_PARAMETER_PAN)];
    gains = {std::min(1.0F, 1.0F - pan) * gain, std::min(1.0F, 1.0F + pan) * gain};
  }
  Core::MixerRamp &ramp = core.mixer_ramps[mixer.slot];
  ramp.seen = true;
  if (ramp.elapsed < ramp.frames) {
    const float progress = static_cast<float>(++ramp.elapsed) / static_cast<float>(ramp.frames);
    for (uint32_t channel = 0; channel < 2; ++channel) {
      gains[channel] = ramp.from[channel] + (gains[channel] - ramp.from[channel]) * progress;
    }
  } else if (silent) {
    ramp.applied = gains;
    *left = 0.0F;
    *right = 0.0F;
    return;
  }
  ramp.applied = gains;
  *left *= gains[0];
  *right *= gains[1];
}

float clamp_bypass_step(float current, float target, float step) {
  if (target > current + step) return current + step;
  if (target < current - step) return current - step;
  return target;
}

// The one bypass transition every processor kind shares: a 10 ms linear move of
// `level` between the processed signal (0) and the dry one (1). The processor keeps
// running underneath, so un-bypassing continues its state rather than restarting it.
float advance_bypass(const Core &core, float &level, bool bypassed) {
  const uint32_t frames = (core.config.sample_rate_hz + 50u) / 100u;
  level = clamp_bypass_step(level, bypassed ? 1.0F : 0.0F, 1.0F / static_cast<float>(frames == 0 ? 1u : frames));
  return level;
}

float bypass_mix(float processed, float dry, float level) {
  if (level <= 0.0F) return processed;
  if (level >= 1.0F) return dry;
  return processed + (dry - processed) * level;
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

  advance_bypass(core, history.bypass, state.enabled == 0 || (processor != nullptr && processor->bypassed != 0));
  *left_output = bypass_mix(left, sanitized_dry_left, history.bypass);
  *right_output = bypass_mix(right, sanitized_dry_right, history.bypass);
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
  const float wet_left = render_saturator_channel(core, processor, frame, input_left, &history.previous_left, history.color_left);
  const float wet_right = render_saturator_channel(core, processor, frame, input_right, &history.previous_right, history.color_right);
  advance_bypass(core, history.bypass, processor.bypassed != 0 || processor.saturator.enabled == 0);
  *output_left = bypass_mix(wet_left, std::isfinite(input_left) ? input_left : 0.0F, history.bypass);
  *output_right = bypass_mix(wet_right, std::isfinite(input_right) ? input_right : 0.0F, history.bypass);
}

void render_eq_processor(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  float input_left, float input_right, float, float, float *output_left, float *output_right) {
  EqHistory &history = core.eq_histories[processor.history_slot];
  float left = std::isfinite(input_left) ? input_left : 0.0F;
  float right = std::isfinite(input_right) ? input_right : 0.0F;
  const float dry_left = left;
  const float dry_right = right;
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
  advance_bypass(core, history.bypass, processor.bypassed != 0 || processor.eq.enabled == 0);
  *output_left = bypass_mix(std::isfinite(left) ? left : 0.0F, dry_left, history.bypass);
  *output_right = bypass_mix(std::isfinite(right) ? right : 0.0F, dry_right, history.bypass);
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
  advance_bypass(core, history.bypass, processor.bypassed != 0 || processor.autofilter.enabled == 0);
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
  advance_bypass(core, history.bypass, processor.bypassed != 0 || state.enabled == 0);
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
  advance_bypass(core, history.bypass, !enabled || processor.bypassed != 0);
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
  advance_bypass(core, history.bypass, !enabled || processor.bypassed != 0);
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
  // Bypass crossfades to the input as delayed by the processor's fixed latency, so
  // it never shifts the signal in time.
  const float delayed_left = left;
  const float delayed_right = right;
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
      const float target = dynamics_db_to_gain(target_db);
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
    const float target_db = compressor_curve_db(dynamics_gain_to_db(level), state) - dynamics_gain_to_db(level);
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
  }
  history.write = (write + 1) % kMaximumDynamicsDelayFrames;
  if (gate) {
    left *= history.gain[0];
    right *= history.gain[1];
  } else if (!compressor) {
    left *= history.gain[0];
    right *= history.gain[1];
  }
  const bool enabled = gate ? processor.gate.enabled != 0 : compressor ? processor.compressor.enabled != 0 : processor.limiter.enabled != 0;
  advance_bypass(core, history.bypass, processor.bypassed != 0 || !enabled);
  *output_left = bypass_mix(std::isfinite(left) ? left : 0.0F, delayed_left, history.bypass);
  *output_right = bypass_mix(std::isfinite(right) ? right : 0.0F, delayed_right, history.bypass);
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
  const float freeze = history.freeze_source_latched
    ? (history.analysis_from_predecessor ? 1.0F : 0.0F)
    : spectral_transform_parameter(core, processor, 15, frame, state.freeze);
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
  imaginary[0] = 0.0F;
  imaginary[state.fft_size / 2u] = 0.0F;
  for (uint32_t bin = 1; bin < state.fft_size / 2; ++bin) {
    real[state.fft_size - bin] = real[bin]; imaginary[state.fft_size - bin] = -imaginary[bin];
  }
}

void process_spectral_frame(Core &core, GraphRevision::Processor &processor, SpectralHistory &history, uint32_t frame) {
  if (history.analysis_frames < UINT32_MAX) ++history.analysis_frames;
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

void render_spectral_sample(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  float input_left, float input_right, float sidechain_left, float sidechain_right, float *output_left, float *output_right,
  const std::array<float, 2> *analysis_input = nullptr) {
  SpectralHistory &history = core.spectral_histories[processor.spectral_slot];
  reset_spectral_history(history, processor.spectral);
  const uint32_t input_mask = kMaximumSpectralFftSize - 1;
  const uint32_t output_mask = kMaximumSpectralFftSize * 2 - 1;
  const std::array<float, 2> input{std::isfinite(input_left) ? input_left : 0.0F, std::isfinite(input_right) ? input_right : 0.0F};
  const std::array<float, 2> sidechain{std::isfinite(sidechain_left) ? sidechain_left : 0.0F, std::isfinite(sidechain_right) ? sidechain_right : 0.0F};
  advance_bypass(core, history.bypass, processor.bypassed != 0 || processor.spectral.enabled == 0);
  std::array<float, 2> output{};
  for (uint32_t channel = 0; channel < 2; ++channel) {
    history.input[channel][history.write_index & input_mask] = analysis_input ? (*analysis_input)[channel] : input[channel];
    history.sidechain[channel][history.write_index & input_mask] = sidechain[channel];
    history.dry[channel][(history.write_index + processor.spectral.fft_size) & output_mask] = input[channel];
    const float wet = history.output[channel][history.write_index];
    history.wet_sample[channel] = wet;
    const float dry = history.dry[channel][history.write_index];
    history.output[channel][history.write_index] = 0.0F;
    history.dry[channel][history.write_index] = 0.0F;
    const float mix = spectral_parameter(core, processor, 25, frame, processor.spectral.mix);
    const float processed = dry * (1.0F - mix) + wet * mix;
    output[channel] = processed + (dry - processed) * history.bypass;
  }
  history.write_index = (history.write_index + 1) & output_mask;
  if (--history.samples_until_frame == 0) {
    const auto captured = history.freeze_captured;
    process_spectral_frame(core, processor, history, frame);
    history.samples_until_frame = history.hop_size;
    const auto mode = processor.spectral.mode;
    if (history.state_serial == 0 || history.state_mode != mode || mode == DAW_AUDIO_SPECTRAL_MODE_GATE
      || (mode == DAW_AUDIO_SPECTRAL_MODE_FREEZE && captured != history.freeze_captured)
      || (mode == DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE
        && spectral_transform_parameter(core, processor, 24, frame, processor.spectral.profile_learn) > 0.0F)) {
      ++history.state_serial;
      history.state_mode = mode;
      core.spectral_inputs[processor.spectral_slot].publish(history, mode);
    }
  }
  *output_left = output[0];
  *output_right = output[1];
  for (uint32_t channel = 0; channel < 2; ++channel)
    history.rendered[channel][(history.write_index - 1u) & output_mask] = output[channel];
}

void render_spectral_processor(
  Core &core, GraphRevision::Processor &processor, uint32_t frame,
  float input_left, float input_right, float sidechain_left, float sidechain_right, float *output_left, float *output_right) {
  render_spectral_sample(core, processor, frame, input_left, input_right, sidechain_left, sidechain_right,
    output_left, output_right);
}

float spectral_delayed_output(const SpectralHistory &history, uint32_t channel, uint32_t delay) {
  return history.rendered[channel][(history.write_index - 1u - delay) & (kMaximumSpectralFftSize * 2u - 1u)];
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
  for (SampleSource &source : *core.active_sample_sources) source.active = false;
}

bool asset_is_active(const Core &core, daw_audio_asset_handle asset) {
  return paged_asset_is_referenced(core, asset);
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

float source_envelope_gain(const SampleSource &source, int64_t transport_frame, int64_t envelope_frame) {
  const float fade_in = curved_fade_gain(
    envelope_frame, source.fade_in_start_frame, source.fade_in_end_frame, 0.0F, 1.0F,
    source.fade_in_curve, source.fade_in_curve_position);
  const float fade_out = curved_fade_gain(
    envelope_frame, source.fade_out_start_frame, source.fade_out_end_frame, 1.0F, 0.0F,
    source.fade_out_curve, source.fade_out_curve_position);
  const float termination = source.termination_end == 0 ? 1.F
    : transport_frame >= source.termination_end ? 0.F
    : 1.F - static_cast<float>(transport_frame - source.termination_start)
      / static_cast<float>(source.termination_end - source.termination_start);
  const float entry = source.entry_end == 0 ? 1.F
    : std::min(1.F, static_cast<float>(transport_frame - source.entry_start)
      / static_cast<float>(source.entry_end - source.entry_start));
  return source.gain * fade_in * fade_out * termination * entry;
}

float paged_asset_frame_sample(
  const Core &core,
  const PagedPreparation &preparation,
  uint64_t frame,
  uint32_t channel) {
  const uint64_t page_index = frame / core.paged_config.page_frames;
  if (page_index < preparation.first_page
    || page_index - preparation.first_page >= preparation.page_count) return 0.0F;
  const uint32_t position = static_cast<uint32_t>(page_index - preparation.first_page);
  const uint32_t slot_index = preparation.page_slots[position];
  const PagedPageSlot &page = core.paged_slots[slot_index];
  if (page.owner.load(std::memory_order_acquire) != preparation.asset) return 0.0F;
  const uint32_t page_frame = static_cast<uint32_t>(frame % core.paged_config.page_frames);
  if (page_frame >= page.valid_frames) return 0.0F;
  return paged_storage_plane(core, slot_index, channel)[page_frame];
}

float asset_sample(
  const Core &core,
  const AssetSlot &asset,
  const PagedPreparation *preparation,
  double position,
  uint32_t channel) {
  const double bounded = std::fmax(0.0, std::fmin(position, static_cast<double>(asset.frame_count - 1)));
  const uint64_t frame = static_cast<uint64_t>(bounded);
  const uint64_t next = frame + 1 < asset.frame_count ? frame + 1 : frame;
  const float fraction = static_cast<float>(bounded - static_cast<double>(frame));
  const float first = preparation == nullptr
    ? asset.planes[channel][frame]
    : paged_asset_frame_sample(core, *preparation, frame, channel);
  if (fraction == 0.0F) return std::isfinite(first) ? first : 0.0F;
  const float second = preparation == nullptr
    ? asset.planes[channel][next]
    : paged_asset_frame_sample(core, *preparation, next, channel);
  const float value = first + (second - first) * fraction;
  return std::isfinite(value) ? value : 0.0F;
}

// DAW_REALTIME_CALLBACK_HELPER_BEGIN sample-source-node-ownership
void bind_sample_source_node(SampleSource &source, const GraphRevision &graph) {
  const auto node = graph_node_index(graph, source.source_node_id);
  if (node < 0) return; // Legacy root sources have no graph runtime owner.
  source.node_runtime_slot = graph.node_slots[static_cast<uint32_t>(node)];
  source.node_runtime_generation = graph.node_generations[static_cast<uint32_t>(node)];
}

bool sample_source_node_alive(const Core &core, const SampleSource &source) {
  if (source.node_runtime_generation == 0) return true;
  const auto &slot = core.node_slots[source.node_runtime_slot];
  return slot.state.load(std::memory_order_acquire) == kSlotActive
    && slot.generation.load(std::memory_order_relaxed) == source.node_runtime_generation;
}
// DAW_REALTIME_CALLBACK_HELPER_END sample-source-node-ownership

SampleSource make_sample_source(const daw_audio_sample_source_event &event) {
  return {
    .source_node_id = event.source_node_id,
    .asset = event.asset,
    .start_frame = event.start_frame,
    .stop_frame = event.stop_frame,
    .source_offset_frame = event.source_offset_frame,
    .source_offset_fraction = event.source_offset_fraction,
    .source_frame_count = event.source_frame_count,
    .gain = event.gain,
    .fade_in_start_frame = event.fade_in_start_frame,
    .fade_in_end_frame = event.fade_in_end_frame,
    .fade_out_start_frame = event.fade_out_start_frame,
    .fade_out_end_frame = event.fade_out_end_frame,
    .fade_in_curve = event.fade_in_curve,
    .fade_in_curve_position = event.fade_in_curve_position,
    .fade_out_curve = event.fade_out_curve,
    .fade_out_curve_position = event.fade_out_curve_position,
    .active = true,
  };
}

std::array<SampleSource, kSampleSourceSlots> &inactive_sample_source_table(Core &core) {
  return core.active_sample_sources == &core.sample_source_tables[0] ? core.sample_source_tables[1]
    : core.sample_source_tables[0];
}

// DAW_REALTIME_CALLBACK_HELPER_BEGIN native-source-seam
// Swaps the active table for `next` at `frame`. A source that matches one already sounding keeps its cursor. Every other
// sounding source fades out over kSampleTerminationFadeMilliseconds in the upper half of the table, and the sources
// that take its place on the same node fade in over that span. `next` is bound to the published graph and ordered by
// the caller. False leaves the table intact, so `apply = false` probes capacity.
bool reconcile_sample_sources(Core &core, std::span<const SampleSource> next, int64_t frame, bool apply) {
  const int64_t duration = std::max<int64_t>(1,
    static_cast<int64_t>(core.config.sample_rate_hz * kSampleTerminationFadeMilliseconds / 1000.F));
  if (frame < 0 || frame > INT64_MAX - duration || next.size() > kMaximumSampleSources) return false;
  std::array<int32_t, kMaximumSampleSources> matches{};
  std::array<bool, kMaximumSampleSources> retained{};
  const auto signature = [](const SampleSource &source) {
    // The running cursor retains its accepted wire origin. Projected f32
    // positions can collide for distinct origins, so never use them as identity.
    return std::make_tuple(source.source_node_id, source.node_runtime_slot, source.node_runtime_generation,
      source.asset, source.paged, source.start_frame, source.source_offset_frame,
      std::bit_cast<uint32_t>(source.source_offset_fraction), source.gain,
      source.fade_in_start_frame, source.fade_in_end_frame,
      source.fade_out_start_frame, source.fade_out_end_frame,
      source.fade_in_curve, source.fade_in_curve_position,
      source.fade_out_curve, source.fade_out_curve_position);
  };
  using Signature = decltype(signature(next[0]));
  using IndexedSignature = std::pair<Signature, uint32_t>;
  std::array<IndexedSignature, kMaximumSampleSources> old_sources{}, next_sources{};
  uint32_t old_count = 0, next_count = 0;
  // Fixed storage, O(n log n) multiset matching. Equal wire origins match
  // once each, including genuinely overlapping identical clips.
  for (uint32_t slot = 0; slot < kMaximumSampleSources; ++slot) {
    const auto &source = (*core.active_sample_sources)[slot];
    if (!source.active || !sample_source_node_alive(core, source)
      || source.start_frame > frame || source.stop_frame <= frame) continue;
    if (find_asset(&core, source.asset) == nullptr) continue;
    old_sources[old_count++] = {signature(source), slot};
  }
  for (uint32_t index = 0; index < next.size(); ++index) {
    matches[index] = -1;
    if (next[index].start_frame <= frame && next[index].stop_frame > frame) {
      next_sources[next_count++] = {signature(next[index]), index};
    }
  }
  std::sort(old_sources.begin(), old_sources.begin() + old_count);
  std::sort(next_sources.begin(), next_sources.begin() + next_count);
  uint32_t previous = 0, following = 0;
  while (previous < old_count && following < next_count) {
    if (old_sources[previous].first < next_sources[following].first) { ++previous; continue; }
    if (next_sources[following].first < old_sources[previous].first) { ++following; continue; }
    const auto slot = old_sources[previous++].second;
    matches[next_sources[following++].second] = static_cast<int32_t>(slot);
    retained[slot] = true;
  }
  uint32_t tails = 0, available = 0, fading_count = 0;
  using NodeOwner = std::pair<uint32_t, uint32_t>;
  std::array<NodeOwner, kSampleSourceSlots> fading_nodes{};
  for (uint32_t slot = 0; slot < kSampleSourceSlots; ++slot) {
    const auto &source = (*core.active_sample_sources)[slot];
    const bool audible = source.active && sample_source_node_alive(core, source) && source.start_frame <= frame
      && (source.termination_end == 0 ? source.stop_frame > frame : source.termination_end > frame);
    if (slot < kMaximumSampleSources) {
      if (audible && !retained[slot]) {
        ++tails;
        fading_nodes[fading_count++] = {source.node_runtime_slot, source.node_runtime_generation};
      }
    } else if (audible) fading_nodes[fading_count++] = {source.node_runtime_slot, source.node_runtime_generation};
    else ++available;
  }
  if (tails > available) return false;
  if (!apply) return true;
  std::sort(fading_nodes.begin(), fading_nodes.begin() + fading_count);
  uint32_t tail_slot = kMaximumSampleSources;
  for (uint32_t slot = 0; slot < kMaximumSampleSources; ++slot) {
    auto &source = (*core.active_sample_sources)[slot];
    if (retained[slot]) continue;
    if (source.active && sample_source_node_alive(core, source)
      && source.start_frame <= frame && source.stop_frame > frame) {
      while (tail_slot < kSampleSourceSlots) {
        const auto &tail = (*core.active_sample_sources)[tail_slot];
        if (!tail.active || !sample_source_node_alive(core, tail) || tail.termination_end <= frame) break;
        ++tail_slot;
      }
      auto &tail = (*core.active_sample_sources)[tail_slot++];
      tail = source;
      tail.termination_start = frame;
      tail.termination_end = frame + duration;
      tail.termination_read_frame = source.stop_frame - 1;
      const auto *asset = find_asset(&core, source.asset);
      if (asset != nullptr) {
        // Hold the last readable sample if the old region ends during the
        // declick. Compute once at the seam, never ceil/divide per tail sample.
        const double rate = static_cast<double>(asset->sample_rate_hz) / core.config.sample_rate_hz;
        const double read_count = source.reconciled_read_end == 0.0
          ? static_cast<double>(source.source_frame_count)
          : source.reconciled_read_end - (static_cast<double>(source.source_offset_frame)
            + static_cast<double>(source.source_offset_fraction));
        const double last = std::max(0.0, std::ceil(std::min(read_count,
          static_cast<double>(asset->frame_count - source.source_offset_frame)
            - source.source_offset_fraction) / rate) - 1.0);
        tail.termination_read_frame = source.start_frame + static_cast<int64_t>(std::min(last,
          static_cast<double>(source.stop_frame - source.start_frame - 1)));
      }
    }
    source.active = false;
  }
  uint32_t free_slot = 0;
  for (uint32_t index = 0; index < next.size(); ++index) {
    const auto &declared = next[index];
    if (declared.stop_frame <= frame) continue;
    if (matches[index] >= 0) {
      auto &source = (*core.active_sample_sources)[static_cast<uint32_t>(matches[index])];
      source.stop_frame = declared.stop_frame;
      source.paged_preparation = declared.paged_preparation;
      source.reconciled_read_end = (static_cast<double>(declared.source_offset_frame)
        + static_cast<double>(declared.source_offset_fraction)) + static_cast<double>(declared.source_frame_count);
      continue;
    }
    while ((*core.active_sample_sources)[free_slot].active) ++free_slot;
    auto &source = (*core.active_sample_sources)[free_slot];
    source = declared;
    if (declared.start_frame > frame) continue;
    source.entry_start = frame;
    source.entry_end = std::binary_search(fading_nodes.begin(), fading_nodes.begin() + fading_count,
      NodeOwner{source.node_runtime_slot, source.node_runtime_generation}) ? frame + duration : 0;
  }
  return true;
}
// DAW_REALTIME_CALLBACK_HELPER_END native-source-seam

void prepare_active_source_ranges(Core &core, const GraphRevision *graph) {
  // A deleted node's sources expire when its existing fade retires the slot.
  // This also drops owners removed without a ghost, before resource collection.
  for (auto &source : *core.active_sample_sources)
    if (source.active && !sample_source_node_alive(core, source)) source.active = false;
  core.active_source_ranges = {};
  core.root_source_range = {};
  uint16_t count = 0;
  if (graph != nullptr) {
    // A fading source keeps playing its scheduled clips until it reaches silence.
    for (uint32_t node_index = 0; node_index < graph->total_node_count(); ++node_index) {
      GraphRevision::Range &range = core.active_source_ranges[node_index];
      range.start = count;
      if (graph->nodes[node_index].kind != DAW_AUDIO_GRAPH_NODE_SOURCE) continue;
      for (uint32_t source_index = 0; source_index < core.active_sample_sources->size(); ++source_index) {
        const SampleSource &source = (*core.active_sample_sources)[source_index];
        if (source.active && source.source_node_id == graph->nodes[node_index].id
          && source.node_runtime_slot == graph->node_slots[node_index]
          && source.node_runtime_generation == graph->node_generations[node_index]) {
          core.active_source_indices[count++] = static_cast<uint16_t>(source_index);
          ++range.count;
        }
      }
    }
  }
  core.root_source_range.start = count;
  for (uint32_t source_index = 0; source_index < core.active_sample_sources->size(); ++source_index) {
    const SampleSource &source = (*core.active_sample_sources)[source_index];
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
    SampleSource &source = (*core.active_sample_sources)[core.active_source_indices[position]];
    if (!source.active) continue;
    if ((source.termination_end == 0 && transport_frame >= source.stop_frame)
      || (source.termination_end != 0 && transport_frame >= source.termination_end)) {
      source.active = false;
      continue;
    }
    if (transport_frame < source.start_frame) continue;
    AssetSlot *asset = find_asset(&core, source.asset);
    if (asset == nullptr) {
      source.active = false;
      continue;
    }
    const int64_t read_frame = source.termination_end == 0 ? transport_frame
      : std::min(transport_frame, source.termination_read_frame);
    const uint64_t elapsed_output_frames = static_cast<uint64_t>(read_frame - source.start_frame);
    const double source_position = static_cast<double>(source.source_offset_frame)
      + static_cast<double>(source.source_offset_fraction)
      + static_cast<double>(elapsed_output_frames) * static_cast<double>(asset->sample_rate_hz)
        / static_cast<double>(core.config.sample_rate_hz);
    const double source_end = source.reconciled_read_end != 0.0 ? source.reconciled_read_end
      : static_cast<double>(source.source_offset_frame)
      + static_cast<double>(source.source_offset_fraction)
      + static_cast<double>(source.source_frame_count);
    if (source_position >= source_end
      || source.source_offset_frame >= asset->frame_count
      || source_position < 0.0
      || source_position >= static_cast<double>(asset->frame_count)) {
      source.active = false;
      continue;
    }
    const float gain = source_envelope_gain(source, transport_frame, read_frame);
    const uint32_t right_channel = asset->channel_count > 1 ? 1 : 0;
    const float left = asset_sample(core, *asset, source.paged ? source.paged_preparation : nullptr, source_position, 0);
    const float right = asset_sample(core, *asset, source.paged ? source.paged_preparation : nullptr, source_position, right_channel);
    *left_output += left * gain;
    if (right_output != left_output) *right_output += right * gain;
  }
}

constexpr uint32_t kGraphPreFxStage = 0;
constexpr uint32_t kGraphPreFaderStage = 1;
constexpr uint32_t kGraphOutputStage = 2;
constexpr uint32_t kGraphStageCount = 3;

// Sized by the core config, so one allocation serves every revision and a
// prepare never frees storage the callback may still be reading.
bool allocate_graph_stage_buffers(Core &core) {
  if (core.graph_stage_buffers) return true;
  const std::size_t graph_stage_samples = static_cast<std::size_t>(kGraphStageCount) * kMaximumGraphNodes * 2u
    * core.config.max_frames_per_block;
  std::unique_ptr<float[]> buffers(new (std::nothrow) float[graph_stage_samples]());
  if (!buffers) return false;
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  if (!core.graph_tap_storage) {
    const std::size_t history_samples = static_cast<std::size_t>(Core::kTapHistorySlots) * 2u
      * kMaximumGraphLatencyFrames;
    core.graph_tap_storage.reset(new (std::nothrow) float[history_samples]());
    if (!core.graph_tap_storage) return false;
    // A zero-filled allocation may still be backed by shared zero pages.
    // Touch every 4 KiB off-thread, covering native and Wasm page sizes.
    volatile float *pages = core.graph_tap_storage.get();
    for (std::size_t sample = 0; sample < history_samples; sample += 1024u) pages[sample] = 0.0F;
    for (uint32_t slot = 0; slot < Core::kTapHistorySlots; ++slot) {
      core.graph_tap_histories[slot].offset = static_cast<std::size_t>(slot) * 2u * kMaximumGraphLatencyFrames;
      core.graph_tap_histories[slot].capacity = kMaximumGraphLatencyFrames;
    }
  }
#endif
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

float deletion_fade_gain(uint32_t elapsed, uint32_t fade_frames) {
  return elapsed >= fade_frames ? 0.0F : 1.0F - static_cast<float>(elapsed) / static_cast<float>(fade_frames);
}

// Level at which a signal leaves a source node that was deleted. A fading node
// feeding a node that was deleted no later than itself is faded once, where the
// signal leaves that node, so deleting a source with its group does not apply the
// ramp twice.
float ghost_edge_fade_gain(const Core &core, const GraphRevision &graph, uint32_t edge_index, uint32_t frame) {
  const uint32_t target_index = graph.edge_target_indices[edge_index];
  const uint32_t elapsed = core.node_fade_start[graph.edge_source_indices[edge_index]];
  if (target_index >= graph.node_count && core.node_fade_start[target_index] >= elapsed) return 1.0F;
  return deletion_fade_gain(elapsed + frame, graph.fade_frames);
}

// Level at which a route that replaced one through a deleted node enters: the
// complement of that node's fade-out.
float edge_join_gain(const Core &core, const GraphRevision &graph, uint32_t edge_index, uint32_t frame) {
  const uint32_t join = graph.edge_join_nodes[edge_index];
  if (join == 0) return 1.0F;
  return 1.0F - deletion_fade_gain(core.node_fade_start[join - 1] + frame, graph.fade_frames);
}

float graph_tap_sample(
  Core &core,
  const GraphRevision &graph,
  uint32_t edge_index,
  uint32_t channel,
  uint32_t frame,
  uint32_t delay) {
  const daw_audio_graph_edge_descriptor &edge = graph.edges[edge_index];
  const uint32_t source_index = graph.edge_source_indices[edge_index];
  const uint32_t stage = edge.tap == DAW_AUDIO_GRAPH_EDGE_PRE_FX ? kGraphPreFxStage
    : edge.tap == DAW_AUDIO_GRAPH_EDGE_PRE_FADER ? kGraphPreFaderStage : kGraphOutputStage;
  float source = 0.0F;
  if (delay <= frame) {
    source = *graph_stage_sample(core, stage, source_index, channel, frame - delay);
  } else if (core.graph_write_frame + frame >= delay) {
    const uint64_t read_frame = core.graph_write_frame + frame - delay;
    const uint32_t slot = graph.tap_history_slots[source_index][stage];
    const auto &history = core.graph_tap_histories[slot];
    if (read_frame >= history.first_frame && read_frame < history.end_frame
      && history.end_frame - read_frame <= history.capacity) {
      const std::size_t offset = history.offset + static_cast<std::size_t>(channel) * history.capacity
        + (read_frame & (history.capacity - 1u));
      source = core.graph_tap_storage[offset];
    }
  }
  return source;
}

// The gain an edge applies `at` frames into the move a publish started
// (begin_edge_ramps): from where it stood toward its own, then exactly its own.
float edge_ramp_gain(const Core::EdgeRamp &ramp, float gain, uint32_t at) {
  if (at >= ramp.frames) return gain;
  const float progress = static_cast<float>(at) / static_cast<float>(ramp.frames);
  return ramp.from + (gain - ramp.from) * progress;
}

void advance_edge_ramps(Core &core, const GraphRevision &graph, uint32_t frame_count) {
  for (uint32_t edge = 0; edge < graph.total_edge_count(); ++edge) {
    Core::EdgeRamp &ramp = core.edge_ramps[core.edge_ramp_bank][edge];
    ramp.seen = true;
    ramp.elapsed = std::min(ramp.frames, ramp.elapsed + frame_count);
  }
}

float graph_edge_sample(
  Core &core, const GraphRevision &graph, uint32_t edge_index,
  uint32_t channel, uint32_t frame) {
  const auto &edge = graph.edges[edge_index];
  const uint32_t source_index = graph.edge_source_indices[edge_index];
  float source = 0.0F;
  const auto &head = graph.read_heads[edge_index];
  const uint64_t absolute = core.graph_write_frame + frame;
  const uint64_t seam = head.seam + core.latency_publication_shift;
  if (core.transport.running == 0 || core.latency_shrunk_revision == graph.revision) {
    source = graph_tap_sample(core, graph, edge_index, channel, frame, head.stopped_delay);
  } else if (absolute < seam) {
    source = graph_tap_sample(core, graph, edge_index, channel, frame, head.previous_delay);
  } else if (head.crossfade_frames != 0 && absolute - seam < head.crossfade_frames) {
    const float mix = static_cast<float>(absolute - seam) / head.crossfade_frames;
    const float previous = graph_tap_sample(core, graph, edge_index, channel, frame, head.previous_delay);
    const float next = graph_tap_sample(core, graph, edge_index, channel, frame, head.delay);
    source = previous * (1.0F - mix) + next * mix;
  } else {
    source = graph_tap_sample(core, graph, edge_index, channel, frame, head.delay);
  }
  const Core::EdgeRamp &ramp = core.edge_ramps[core.edge_ramp_bank][edge_index];
  source *= edge_ramp_gain(ramp, edge.gain, ramp.elapsed + frame + 1u);
  if (source_index >= graph.node_count) source *= ghost_edge_fade_gain(core, graph, edge_index, frame);
  return source * edge_join_gain(core, graph, edge_index, frame);
}

void clear_instrument_state(InstrumentNodeState &instrument);
void release_instrument_state(InstrumentNodeState &instrument);

void release_instrument_voices(Core &core) {
  for (uint32_t slot = 0; slot < kNodeRuntimeSlots; ++slot) {
    if (core.node_slots[slot].state.load(std::memory_order_acquire) == kSlotActive) {
      release_instrument_state(core.instrument_runtime[slot]);
    }
  }
}

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
  instrument.grains = {};
  instrument.granular_note_ids = {};
  instrument.granular_note_ages = {};
  instrument.granular_note_count = 0;
  instrument.granular_next_note_age = 1;
  instrument.sustain = false;
}

void clear_instrument_state(InstrumentNodeState &instrument) {
  instrument.voices = {};
  instrument.sample_voices = {};
  instrument.grains = {};
  instrument.granular_note_ids = {};
  instrument.granular_note_ages = {};
  instrument.granular_note_count = 0;
  instrument.granular_next_note_age = 1;
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

// The continuous values of an instrument's configuration, the ones a knob drag
// moves; every other field (waveforms, modes, enables, capacity, zone set, asset) is
// discrete and replaces the instrument when it changes. `visit(to, from)` is called
// for each continuous float of `to` and its counterpart in `from`. An oscillator's
// octave and semitone fold into its detune (cents), so a transposition drags like
// any other value; `from` is read through that fold and `to` receives the sum.
float oscillator_cents(const daw_audio_synth_oscillator_state &oscillator) {
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

// A kept instrument's targets move at once; `applied` follows them. One pole per
// value, so a value reverses without overshoot, a burst of events ends where the
// last one says, and a value within 1e-4 of its target lands on it (nothing decays
// into subnormals). The time constant is the shortest the drag witnesses accept: at
// 2 ms a two-semitone step still changes a cycle's period by 3.5%, at 5 ms by less
// than 2.5%.
constexpr float kInstrumentSlewSeconds = 0.005F;

void advance_applied(const Core &core, InstrumentNodeState &instrument, uint32_t kind) {
  const float rate = 1.0F / std::fmax(1.0F, static_cast<float>(core.config.sample_rate_hz) * kInstrumentSlewSeconds);
  const auto slew = [rate](float &applied, float target) {
    const float delta = target - applied;
    applied = std::fabs(delta) <= 1e-4F * std::fmax(1.0F, std::fabs(target)) ? target : applied + delta * rate;
  };
  if (kind == DAW_AUDIO_INSTRUMENT_KIND_SYNTH) {
    visit_synth(instrument.applied.synth, instrument.synth, slew);
  } else if (kind == DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) {
    visit_granular(instrument.applied.granular, instrument.granular, slew);
  } else {
    visit_sampler(instrument.applied.sampler, instrument.sampler, slew);
    for (uint32_t index = 0; index < instrument.sampler.zone_count; ++index) {
      visit_zone(instrument.applied.zones[index], instrument.zones[index], slew);
    }
  }
}

// A configuration with its continuous values cleared: what two configurations must
// share for one instrument to serve both.
InstrumentConfiguration discrete_part(const InstrumentConfiguration &configuration) {
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

void set_instrument_targets(InstrumentNodeState &runtime, const InstrumentConfiguration &configuration) {
  runtime.synth = configuration.synth;
  runtime.sampler = configuration.sampler;
  runtime.zones = configuration.zones;
  runtime.granular = configuration.granular;
}

// An instrument that is set up (not edited) applies what it is set to from its first
// frame, so nothing slews in from zero.
void set_up_instrument(InstrumentNodeState &runtime, const InstrumentConfiguration &configuration) {
  set_instrument_targets(runtime, configuration);
  runtime.applied = configuration;
  for (daw_audio_synth_oscillator_state &oscillator : runtime.applied.synth.oscillators) {
    oscillator.detune_cents = oscillator_cents(oscillator);
    oscillator.octave = oscillator.semitone = 0;
  }
}

bool instrument_declares_target(const daw_audio_instrument_state_descriptor &descriptor, uint32_t target) {
  for (uint32_t index = 0; index < descriptor.parameter_count; ++index) {
    if (descriptor.parameter_targets[index] == target) return true;
  }
  return false;
}

bool set_synth_parameter(daw_audio_synth_state &synth, uint32_t target, float value) {
  if (!std::isfinite(value)) return false;
  if (target == DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_GAIN && value >= 0.0F && value <= 1.5F) synth.output_gain = value;
  else if (target == DAW_AUDIO_SYNTH_PARAMETER_OUTPUT_PAN && value >= -1.0F && value <= 1.0F) synth.output_pan = value;
  else if (target == DAW_AUDIO_SYNTH_PARAMETER_FILTER_CUTOFF_HZ && value >= 20.0F && value <= 20000.0F) synth.filter_cutoff_hz = value;
  else if (target == DAW_AUDIO_SYNTH_PARAMETER_FILTER_RESONANCE && value >= 0.0001F && value <= 30.0F) synth.filter_resonance = value;
  else if (target == DAW_AUDIO_SYNTH_PARAMETER_AMP_ATTACK_MS && value >= 0.0F && value <= 60000.0F) synth.amp_attack_ms = value;
  else if (target == DAW_AUDIO_SYNTH_PARAMETER_AMP_DECAY_MS && value >= 0.0F && value <= 60000.0F) synth.amp_decay_ms = value;
  else if (target == DAW_AUDIO_SYNTH_PARAMETER_AMP_SUSTAIN && value >= 0.0F && value <= 1.0F) synth.amp_sustain = value;
  else if (target == DAW_AUDIO_SYNTH_PARAMETER_AMP_RELEASE_MS && value >= 0.0F && value <= 60000.0F) synth.amp_release_ms = value;
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
  const daw_audio_synth_state &synth = instrument.applied.synth;
  const float amp_attack = 1.0F / std::fmax(1.0F, synth.amp_attack_ms * sample_rate_hz / 1000.0F);
  const float amp_decay = 1.0F / std::fmax(1.0F, synth.amp_decay_ms * sample_rate_hz / 1000.0F);
  const float amp_release = 1.0F / std::fmax(1.0F, synth.amp_release_ms * sample_rate_hz / 1000.0F);
  const float amp_sustain = synth.amp_sustain;
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
      const float semitones = (oscillator.detune_cents + lfo * synth.lfo_pitch_cents) / 100.0F;
      const float increment = base_frequency * std::pow(2.0F, semitones / 12.0F) / static_cast<float>(sample_rate_hz);
      voice.oscillator_phase[oscillator_index] += increment;
      voice.oscillator_phase[oscillator_index] -= std::floor(voice.oscillator_phase[oscillator_index]);
      sample += waveform(oscillator.waveform, voice.oscillator_phase[oscillator_index]) * oscillator.level;
    }
    float cutoff = synth.filter_cutoff_hz;
    cutoff *= std::pow(2.0F, (static_cast<float>(voice.note) - 60.0F) / 12.0F * synth.filter_key_tracking
      + voice.filter_level * synth.filter_envelope_amount_octaves + lfo * synth.lfo_filter_octaves);
    cutoff = std::fmax(20.0F, std::fmin(cutoff, static_cast<float>(sample_rate_hz) * 0.45F));
    const float resonance = synth.filter_resonance;
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

double sample_voice_increment(
  const Core &core, const AssetSlot &asset, uint32_t note, const daw_audio_sample_zone &zone) {
  const float cents = (static_cast<float>(note) - static_cast<float>(zone.root_note)) * 100.0F + zone.tune_cents;
  return std::pow(2.0, cents / 1200.0) * static_cast<double>(asset.sample_rate_hz) / core.config.sample_rate_hz;
}

// Re-derives what a voice took from its zone when the zone no longer says the same:
// a swapped asset or a tuning edit changes the step (the playhead stays where it
// is), and a start edit moves the playhead by the same distance as the start, so the
// note plays on from the same offset into the sample.
void follow_sample_zone(
  const Core &core, SampleVoice &voice, const daw_audio_sample_zone &zone, const AssetSlot &asset) {
  if (voice.asset != zone.asset || voice.root_note != zone.root_note || voice.tune_cents != zone.tune_cents) {
    voice.asset = zone.asset;
    voice.root_note = zone.root_note;
    voice.tune_cents = zone.tune_cents;
    voice.increment = sample_voice_increment(core, asset, voice.note, zone);
  }
  if (voice.start_frame != zone.start_frame) {
    voice.position += static_cast<double>(zone.start_frame) - static_cast<double>(voice.start_frame);
    voice.start_frame = zone.start_frame;
  }
}

void render_sample_instrument_frame(
  Core &core,
  InstrumentNodeState &instrument,
  const daw_audio_instrument_state_descriptor &descriptor,
  float *left_output,
  float *right_output) {
  float left = 0.0F;
  float right = 0.0F;
  const daw_audio_sampler_state &state = instrument.applied.sampler;
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
    const daw_audio_sample_zone &zone = instrument.applied.zones[voice.zone];
    AssetSlot *asset = find_asset(&core, zone.asset);
    if (asset == nullptr || (voice.amp_level <= 0.0F && voice.released)) {
      voice = {};
      continue;
    }
    follow_sample_zone(core, voice, zone, *asset);
    if (voice.position >= static_cast<double>(zone.end_frame)) {
      if (zone.playback_mode == DAW_AUDIO_SAMPLE_PLAYBACK_ONE_SHOT) {
        voice = {};
        continue;
      }
      const double loop_length = static_cast<double>(zone.loop_end_frame - zone.loop_start_frame);
      voice.position = static_cast<double>(zone.loop_start_frame) + std::fmod(
        voice.position - static_cast<double>(zone.loop_start_frame), loop_length);
    }
    const auto sample_at = [&core, asset](double position, uint32_t channel) {
      return asset_sample(core, *asset, nullptr, position, channel);
    };
    const uint32_t right_channel = asset->channel_count > 1 ? 1 : 0;
    float sample_left = sample_at(voice.position, 0);
    float sample_right = sample_at(voice.position, right_channel);
    if (zone.playback_mode == DAW_AUDIO_SAMPLE_PLAYBACK_CROSSFADE_LOOP
      && zone.crossfade_frame_count > 0
      && voice.position >= static_cast<double>(zone.loop_end_frame - zone.crossfade_frame_count)) {
      const double fade = (voice.position - static_cast<double>(zone.loop_end_frame - zone.crossfade_frame_count))
        / static_cast<double>(zone.crossfade_frame_count);
      const double loop_position = static_cast<double>(zone.loop_start_frame)
        + (voice.position - static_cast<double>(zone.loop_end_frame - zone.crossfade_frame_count));
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
    const float gain = zone.gain * voice.velocity * voice.amp_level * std::fmax(0.0F, 1.0F - lfo * state.lfo_amplitude);
    const float pan_angle = (std::fmax(-1.0F, std::fmin(1.0F, zone.pan + lfo * state.lfo_pan)) + 1.0F) * 0.7853981633974483096F;
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
  const daw_audio_granular_state &state = instrument.applied.granular;
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
    uint32_t oldest_index = 0;
    uint32_t empty_index = static_cast<uint32_t>(instrument.granular_note_ids.size());
    for (uint32_t index = 0; index < instrument.granular_note_ids.size(); ++index) {
      const uint64_t note_id = instrument.granular_note_ids[index];
      if (note_id == event.note_id) return true;
      if (note_id == 0) {
        empty_index = index;
        continue;
      }
      if (instrument.granular_note_ages[index] < instrument.granular_note_ages[oldest_index]) {
        oldest_index = index;
      }
    }
    if (instrument.granular_next_note_age == UINT64_MAX) {
      const auto previous_ages = instrument.granular_note_ages;
      for (uint32_t index = 0; index < instrument.granular_note_ids.size(); ++index) {
        if (instrument.granular_note_ids[index] == 0) continue;
        uint64_t rank = 1;
        for (uint32_t other = 0; other < instrument.granular_note_ids.size(); ++other) {
          if (instrument.granular_note_ids[other] != 0
            && previous_ages[other] < previous_ages[index]) ++rank;
        }
        instrument.granular_note_ages[index] = rank;
      }
      instrument.granular_next_note_age = static_cast<uint64_t>(instrument.granular_note_count) + 1;
    }
    const uint32_t target_index = empty_index < instrument.granular_note_ids.size() ? empty_index : oldest_index;
    instrument.granular_note_ids[target_index] = event.note_id;
    instrument.granular_note_ages[target_index] = instrument.granular_next_note_age++;
    if (empty_index < instrument.granular_note_ids.size()) ++instrument.granular_note_count;
    return true;
  }
  if (type == DAW_AUDIO_INSTRUMENT_EVENT_NOTE_OFF) {
    for (uint32_t index = 0; index < instrument.granular_note_ids.size(); ++index) {
      if (instrument.granular_note_ids[index] == event.note_id) {
        instrument.granular_note_ids[index] = 0;
        instrument.granular_note_ages[index] = 0;
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
  uint32_t *round_robin_cursor = nullptr;
  for (uint32_t index = 0; index < instrument.sampler.zone_count; ++index) {
    const daw_audio_sample_zone &zone = instrument.zones[index];
    if (event.note >= zone.key_low && event.note <= zone.key_high
      && event.value * 127.0F >= zone.velocity_low && event.value * 127.0F <= zone.velocity_high) {
      matching_group = zone.round_robin_group;
      if (matching_group == 0) {
        selected = &zone;
        break;
      }
      round_robin_cursor = &instrument.round_robin_cursors[matching_group % DAW_AUDIO_CORE_MAX_SAMPLE_ZONES];
      const uint32_t cursor = *round_robin_cursor;
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
  AssetSlot *asset = find_asset(&core, selected->asset);
  if (asset == nullptr) return false;
  if (round_robin_cursor != nullptr) ++*round_robin_cursor;
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
      if (voice.active && instrument.zones[voice.zone].choke_group == selected->choke_group) {
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
  *voice = {.note_id = event.note_id, .note = event.note, .zone = static_cast<uint32_t>(selected - instrument.zones.data()),
    .velocity = event.value, .asset = selected->asset, .start_frame = selected->start_frame, .root_note = selected->root_note,
    .tune_cents = selected->tune_cents, .position = static_cast<double>(selected->start_frame),
    .increment = sample_voice_increment(core, *asset, event.note, *selected), .age = instrument.next_age++, .active = true};
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
      && set_synth_parameter(instrument.synth, event.note, event.value);
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

// A plan entry renders only while its slot is active at the generation the plan
// recorded. A mismatch on an active slot means the slot was reused under a plan
// that still names it; that entry must never render.
bool runtime_slot_renderable(Core &core, const RuntimeSlot &slot, uint32_t generation) {
  if (slot.state.load(std::memory_order_acquire) != kSlotActive) return false;
  if (slot.generation.load(std::memory_order_relaxed) == generation) return true;
  core.stale_references.fetch_add(1, std::memory_order_relaxed);
  return false;
}

void retire_runtime_slot(Core &core, RuntimeSlot &slot) {
  // The process call in progress completes epoch render_epoch + 1.
  slot.retired_epoch.store(core.render_epoch.load(std::memory_order_relaxed) + 1, std::memory_order_relaxed);
  slot.state.store(kSlotRetired, std::memory_order_release);
}

// Moves every ghost's fade forward by one block and retires what finished. The
// slot then only awaits reclamation after this process call completes.
void advance_deletion_fades(Core &core, const GraphRevision &graph, uint32_t frame_count) {
  const auto advance = [&](RuntimeSlot &slot) {
    const uint32_t elapsed = slot.fade_elapsed.load(std::memory_order_relaxed);
    if (elapsed >= graph.fade_frames) return true;
    slot.fade_elapsed.store(std::min(graph.fade_frames, elapsed + frame_count), std::memory_order_relaxed);
    return elapsed + frame_count >= graph.fade_frames;
  };
  for (uint32_t node_index = graph.node_count; node_index < graph.total_node_count(); ++node_index) {
    RuntimeSlot &slot = core.node_slots[graph.node_slots[node_index]];
    if (slot.state.load(std::memory_order_relaxed) == kSlotActive && advance(slot)) retire_runtime_slot(core, slot);
  }
  for (uint32_t index = graph.processor_count; index < graph.total_processor_count(); ++index) {
    const GraphRevision::Processor &processor = graph.processors[index];
    RuntimeSlot &slot = core.processor_slots[processor.history_slot];
    if (slot.state.load(std::memory_order_relaxed) != kSlotActive) continue;
    const bool finished = processor.detached
      ? advance(slot)
      : core.node_slots[graph.node_slots[processor.node_index]].state.load(std::memory_order_relaxed) != kSlotActive;
    if (finished) {
      retire_runtime_slot(core, slot);
      if (processor.spectral_predecessor >= 0) {
        const auto &previous = graph.spectral_predecessors[processor.spectral_predecessor];
        auto &old_slot = core.processor_slots[previous.history_slot];
        if (old_slot.state.load(std::memory_order_relaxed) == kSlotActive
          && old_slot.generation.load(std::memory_order_relaxed) == previous.generation) retire_runtime_slot(core, old_slot);
      }
    }
  }
}

struct ChainItem {
  uint16_t processor_index = 0;
  ProcessorRenderer render = nullptr;
};
constexpr uint32_t kMaximumChainItems = kMaximumNodeChain;

SpectralTransferMap prepare_spectral_transfer(uint32_t before, uint32_t after) {
  SpectralTransferMap map{};
  map.before = before; map.after = after;
  map.level = static_cast<float>(after) / before;
  const double ratio = static_cast<double>(after) / before;
  const uint32_t last = before / 2u;
  for (uint32_t bin = 0; bin <= after / 2u; ++bin) {
    auto &band = map.bands[bin];
    const double at = bin / ratio;
    if (after >= before) {
      band.first = static_cast<uint32_t>(at);
      band.last = std::min(band.first + 1u, last);
      band.first_weight = 1.0 - (at - band.first);
      band.last_weight = at - band.first;
      if (band.first == band.last) { band.first_weight = 1; band.last_weight = 0; }
    } else {
      const double left = std::max(0.0, (bin - 0.5) / ratio);
      const double right = std::min(static_cast<double>(last), (bin + 0.5) / ratio);
      band.first = static_cast<uint32_t>(left + 0.5);
      band.last = std::min(last, static_cast<uint32_t>(right + 0.5));
      band.inner_weight = 1.0 / (right - left);
      band.first_weight = (std::min(right, band.first + 0.5) - left) / (right - left);
      band.last_weight = (right - std::max(left, band.last - 0.5)) / (right - left);
    }
  }
  return map;
}

void apply_spectral_transfer(const SpectralHistory &prior, const daw_audio_spectral_state &before,
  SpectralHistory &history, const daw_audio_spectral_state &after, const SpectralTransferMap &map) {
  if (before.mode != after.mode || map.before != before.fft_size || map.after != after.fft_size) return;
  if (before.fft_size == after.fft_size) {
    history.frozen_magnitude = prior.frozen_magnitude;
    history.frozen_phase = prior.frozen_phase;
    history.noise_profile = prior.noise_profile;
    history.gate_gain = prior.gate_gain;
    history.freeze_captured = prior.freeze_captured;
    return;
  }
  const bool gate = after.mode == DAW_AUDIO_SPECTRAL_MODE_GATE;
  if (!gate && after.mode != DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE) return;
  for (uint32_t channel = 0; channel < 2; ++channel) {
    const auto &source = gate ? prior.gate_gain[channel] : prior.noise_profile[channel];
    auto &destination = gate ? history.gate_gain[channel] : history.noise_profile[channel];
    const auto power = [&](uint32_t k) { return source[k] * source[k]; };
    for (uint32_t bin = 0; bin <= after.fft_size / 2u; ++bin) {
      const auto &band = map.bands[bin];
      float sum = power(band.first) * band.first_weight + power(band.last) * band.last_weight;
      // Disjoint, control-prepared bands touch each source bin at most twice.
      // Validated sizes <=4096 bound total work by 2*2049/channel.
      for (uint32_t k = band.first + 1u; k < band.last; ++k) sum += power(k) * band.inner_weight;
      destination[bin] = std::sqrt(sum * (gate ? 1.0F : map.level));
    }
  }
}

// Control-side only. The callback applies the immutable map once if the tagged
// state changed after prepare; it never constructs weights or calls trig/log.
void transfer_spectral_persistent(const SpectralHistory &prior, const daw_audio_spectral_state &before,
  SpectralHistory &history, const daw_audio_spectral_state &after) {
  history.transfer_map = prepare_spectral_transfer(before.fft_size, after.fft_size);
  apply_spectral_transfer(prior, before, history, after, history.transfer_map);
}
// One processor's sample. Its key is the signal routed to it, or its own input
// when nothing is. A key from a deleted source fades with that source, and the
// processor's own input takes over by the amount the keys have faded: once every
// key is gone the detector reads exactly what it would with no key routed, with
// no step on the way and no later publication needed.
void render_chain_frame(
  Core &core, GraphRevision &graph, const ChainItem &item, uint32_t frame, float &left, float &right) {
  GraphRevision::Processor &processor = graph.processors[item.processor_index];
  resolve_processor_parameter_frame(core, processor, frame);
  const float own_left = processor.kind == DAW_AUDIO_PROCESSOR_KIND_SPECTRAL ? 0.0F : left;
  const float own_right = processor.kind == DAW_AUDIO_PROCESSOR_KIND_SPECTRAL ? 0.0F : right;
  float sidechain_left = own_left;
  float sidechain_right = own_right;
  const GraphRevision::Range sidechain_range = graph.sidechain_edge_ranges[item.processor_index];
  if (sidechain_range.count > 0) {
    sidechain_left = 0.0F;
    sidechain_right = 0.0F;
    float key_level = 0.0F;
    const uint32_t sidechain_end = static_cast<uint32_t>(sidechain_range.start) + sidechain_range.count;
    for (uint32_t sidechain_position = sidechain_range.start; sidechain_position < sidechain_end; ++sidechain_position) {
      const uint32_t edge_index = graph.sidechain_edge_indices[sidechain_position];
      sidechain_left += graph_edge_sample(core, graph, edge_index, 0, frame);
      sidechain_right += graph_edge_sample(core, graph, edge_index, 1, frame);
      key_level += edge_join_gain(core, graph, edge_index, frame)
        * (graph.edge_source_indices[edge_index] < graph.node_count ? 1.0F : ghost_edge_fade_gain(core, graph, edge_index, frame));
    }
    key_level = std::min(1.0F, key_level);
    if (key_level < 1.0F) {
      sidechain_left += own_left * (1.0F - key_level);
      sidechain_right += own_right * (1.0F - key_level);
    }
  }
  float processed_left = 0.0F;
  float processed_right = 0.0F;
  const auto record_input = [&](uint32_t slot) {
    auto &input = core.spectral_inputs[slot];
    const uint64_t end = input.end.load(std::memory_order_relaxed);
    const uint32_t at = end & (kSpectralInputFrames - 1u);
    input.store(0, at, left);
    input.store(1, at, right);
    input.store(2, at, sidechain_left);
    input.store(3, at, sidechain_right);
    input.end.store(end + 1u, std::memory_order_release);
  };
  if (processor.kind == DAW_AUDIO_PROCESSOR_KIND_SPECTRAL) record_input(processor.spectral_slot);
  if (processor.spectral_predecessor >= 0) {
    auto &old = graph.spectral_predecessors[processor.spectral_predecessor];
    auto &slot = core.processor_slots[old.history_slot];
    auto &history = core.spectral_histories[processor.spectral_slot];
    if (runtime_slot_renderable(core, slot, old.generation)) {
      auto &input = core.spectral_inputs[old.spectral_slot];
      const uint64_t end = input.end.load(std::memory_order_relaxed);
      // The predecessor has no parameter-cache entry of its own. Freeze must
      // nevertheless follow the replacement's resolved live control so it is
      // the audible released reference while fresh live analysis fills.
      const float freeze = spectral_transform_parameter(core, processor, 15, frame, processor.spectral.freeze);
      const bool freeze_resize = old.spectral.mode == DAW_AUDIO_SPECTRAL_MODE_FREEZE
        && processor.spectral.mode == DAW_AUDIO_SPECTRAL_MODE_FREEZE
        && old.spectral.fft_size != processor.spectral.fft_size;
      const bool latch_now = freeze_resize && !history.freeze_source_latched
        && core.graph_write_frame + frame >= history.freeze_source_deadline;
      const bool recapture = freeze_resize
        && (history.freeze_source_latched ? history.analysis_from_predecessor : freeze > 0.0F);
      if (history.freeze_source_latched && (freeze > 0.0F) != history.analysis_from_predecessor)
        history.freeze_changed_after_latch = true;
      if (old.spectral.mode == DAW_AUDIO_SPECTRAL_MODE_FREEZE
        && processor.spectral.mode == DAW_AUDIO_SPECTRAL_MODE_FREEZE) old.spectral.freeze = freeze;
      if (!history.persistent_state_transferred) {
        history.persistent_state_transferred = true;
        const auto &prior = core.spectral_histories[old.spectral_slot];
        if ((history.prepared_state_serial != prior.state_serial
          || history.prepared_state_mode != old.spectral.mode
          || history.prepared_state_fft_size != old.spectral.fft_size)
          && prior.state_mode == old.spectral.mode && prior.fft_size == old.spectral.fft_size)
          apply_spectral_transfer(prior, old.spectral, history, processor.spectral, history.transfer_map);
        if (recapture) {
          // Only fresh predecessor wet samples may reach the existing capture
          // step. Old prepared live-input OLA drains while the predecessor stays
          // audible; no bulk reset or spectrum conversion runs on the callback.
          history.freeze_captured.fill(false);
          history.samples_until_frame = processor.spectral.fft_size;
          history.analysis_frames = 0;
          history.warm_cursor = end;
          history.analysis_from_predecessor = true;
        }
        const bool same_mode = old.spectral.mode == processor.spectral.mode;
        ++history.state_serial;
        history.state_mode = processor.spectral.mode;
        core.spectral_inputs[processor.spectral_slot].publish(history, processor.spectral.mode);
        if (same_mode && (processor.spectral.mode == DAW_AUDIO_SPECTRAL_MODE_GATE
          || processor.spectral.mode == DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE
          || (processor.spectral.mode == DAW_AUDIO_SPECTRAL_MODE_FREEZE && freeze > 0.0F))) {
          history.warm_cursor = end - std::min<uint64_t>(end, spectral_warm_frames(processor.spectral));
          // Current envelopes/profiles are not historical state. Replaying
          // past samples would apply release or profile learning twice.
          if (recapture || processor.spectral.mode == DAW_AUDIO_SPECTRAL_MODE_GATE
            || processor.spectral.mode == DAW_AUDIO_SPECTRAL_MODE_NOISE_REDUCE) history.warm_cursor = end;
          history.analysis_frames = 0;
        }
      }
      if (!history.transition_started) {
        history.warm_cursor = end - std::min<uint64_t>(end, spectral_warm_frames(processor.spectral));
        history.transition_started = true;
      }
      if (!history.freeze_source_latched && history.analysis_from_predecessor != recapture) {
        // Use the same resolved event/automation value as synthesis. A source
        // change needs N fresh samples and the ordinary N+C OLA fill before
        // fading; keep the released predecessor audible during that bounded
        // warm-up. Never replay pre-gesture input with post-gesture parameters.
        history.analysis_from_predecessor = recapture;
        history.freeze_captured.fill(false);
        history.samples_until_frame = processor.spectral.fft_size;
        history.analysis_frames = 0;
        history.warm_cursor = end;
      }
      // The publication-relative deadline never restarts. Freeze this final
      // analysis source and replacement Freeze until the ready fade
      // ends; further controls remain in the parameter cache for steady state.
      if (latch_now) history.freeze_source_latched = true;
      // A command delayed longer than its warm window restarts bounded
      // catch-up from the newest complete warm window. The old stage continues
      // at unity, and at least two FFTs replace any stale algorithm history
      // before this replacement can become audible.
      const uint32_t warm_frames = spectral_warm_frames(processor.spectral) + processor.spectral_compensation;
      if (end - history.warm_cursor > warm_frames) {
        history.warm_cursor = end - std::min<uint64_t>(end, warm_frames);
        history.analysis_frames = 0;
        history.transition_elapsed = 0;
      }
      record_input(old.spectral_slot);
      float old_left = 0.0F, old_right = 0.0F;
      render_spectral_processor(core, old, frame, left, right, sidechain_left, sidechain_right, &old_left, &old_right);
      if (recapture) {
        render_spectral_sample(core, processor, frame, left, right, sidechain_left, sidechain_right,
          &processed_left, &processed_right, &core.spectral_histories[old.spectral_slot].wet_sample);
        history.warm_cursor = end + 1u;
      }
      // At most two replacement samples per input sample: bounded catch-up
      // from retained stage input, without a publish-time FFT burst or upstream
      // rerender. Only these two stages run until the 10 ms linear seam ends.
      for (uint32_t work = 0; !recapture && work < 2 && history.warm_cursor < end + 1u; ++work) {
        const uint32_t at = history.warm_cursor++ & (kSpectralInputFrames - 1u);
        render_spectral_processor(core, processor, frame,
          input.sample(0, at), input.sample(1, at),
          input.sample(2, at), input.sample(3, at),
          &processed_left, &processed_right);
      }
      const uint32_t ola_frames = processor.spectral.overlap;
      bool ready = history.analysis_frames >= ola_frames + 1u;
      if (processor.spectral.mode == DAW_AUDIO_SPECTRAL_MODE_HPSS)
        ready = history.analysis_frames >= kSpectralHpssFrames + ola_frames;
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
      const uint64_t absolute = core.graph_write_frame + frame;
      const uint64_t raise_seam = graph.latency_origin + core.latency_publication_shift
        + (graph.latency_raise != 0 ? graph.fade_frames : 0u);
      const bool running = core.transport.running != 0 && core.latency_shrunk_revision != graph.revision
        && graph.nodes[processor.node_index].keep_latency == 0;
      const uint32_t common_latency = processor.spectral.fft_size + processor.spectral_compensation;
      const uint32_t old_delay = !running ? 0u : absolute < raise_seam ? old.spectral_compensation
        : common_latency - old.spectral.fft_size;
      old_left = spectral_delayed_output(core.spectral_histories[old.spectral_slot], 0, old_delay);
      old_right = spectral_delayed_output(core.spectral_histories[old.spectral_slot], 1, old_delay);
      const uint32_t new_delay = running ? processor.spectral_compensation : 0u;
      processed_left = spectral_delayed_output(history, 0, new_delay);
      processed_right = spectral_delayed_output(history, 1, new_delay);
      const uint32_t algorithm_frames = processor.spectral.mode == DAW_AUDIO_SPECTRAL_MODE_HPSS
        ? kSpectralHpssFrames + ola_frames : ola_frames + 1u;
      ready = ready && absolute >= raise_seam
        && history.analysis_frames >= algorithm_frames + (new_delay + history.hop_size - 1u) / history.hop_size;
#endif
      const bool advance_transition = ready && history.warm_cursor == end + 1u;
      // A gesture can arrive after fading has begun. Hold the last coefficient
      // during replacement-source fill instead of jumping back to predecessor-only.
      const uint32_t fade_at = advance_transition ? history.transition_elapsed++
        : history.transition_elapsed - std::min(history.transition_elapsed, 1u);
      const float mix = std::min(1.0F, static_cast<float>(fade_at) / (graph.fade_frames * 2u));
      processed_left = old_left * (1.0F - mix) + processed_left * mix;
      processed_right = old_right * (1.0F - mix) + processed_right * mix;
      if (mix == 1.0F) {
        if (history.analysis_from_predecessor && history.freeze_changed_after_latch) {
          // The existing dry delay retains exactly N live stage-input samples.
          // Restore that analysis window at the seam so a deferred engage
          // captures live input, not the predecessor's wet tail. This bounded
          // 2N copy leaves the capture spectrum, OLA and aligned output intact.
          const uint32_t size = processor.spectral.fft_size;
          for (uint32_t channel = 0; channel < 2; ++channel)
            for (uint32_t i = 0; i < size; ++i)
              history.input[channel][(history.write_index - size + i) & (kMaximumSpectralFftSize - 1u)]
                = history.dry[channel][(history.write_index + i) & (kMaximumSpectralFftSize * 2u - 1u)];
        }
        // Even release -> engage ending at the latched value needs a fresh
        // normal capture. Clear only capture ownership, never the OLA tail.
        if (history.freeze_changed_after_latch) {
          history.freeze_captured.fill(false);
          ++history.state_serial;
          core.spectral_inputs[processor.spectral_slot].publish(history, processor.spectral.mode);
        }
        history.freeze_source_latched = false;
        retire_runtime_slot(core, slot);
      }
    } else {
      item.render(core, processor, frame, left, right, sidechain_left, sidechain_right, &processed_left, &processed_right);
      if (processor.spectral_compensation != 0 && core.transport.running != 0
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
        && core.latency_shrunk_revision.load(std::memory_order_relaxed) != graph.revision
#endif
      ) {
        processed_left = spectral_delayed_output(history, 0, processor.spectral_compensation);
        processed_right = spectral_delayed_output(history, 1, processor.spectral_compensation);
      }
    }
  } else {
    item.render(core, processor, frame, left, right, sidechain_left, sidechain_right, &processed_left, &processed_right);
    if (processor.kind == DAW_AUDIO_PROCESSOR_KIND_SPECTRAL && processor.spectral_compensation != 0
      && core.transport.running != 0
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
      && core.latency_shrunk_revision.load(std::memory_order_relaxed) != graph.revision
#endif
    ) {
      const auto &history = core.spectral_histories[processor.spectral_slot];
      processed_left = spectral_delayed_output(history, 0, processor.spectral_compensation);
      processed_right = spectral_delayed_output(history, 1, processor.spectral_compensation);
    }
  }
  left = std::isfinite(processed_left) ? processed_left : 0.0F;
  right = std::isfinite(processed_right) ? processed_right : 0.0F;
}

// Renders consecutive built-in processors of one node over the block, in chain
// order. Removed processors that sit next to each other and started fading
// together leave as one stage: they run in sequence at full level and a single
// ramp crossfades from the signal that entered the first to the one that left the
// last. Crossfading each on its own would multiply the ramps. Runs frames
// [frame_begin, frame_end) of the block: a dipping node runs the two halves of a
// block in different orders, and each processor still sees its frames once, in
// sequence. Returns whether a live (not fading) processor ran.
bool render_chain_segment(
  Core &core, GraphRevision &graph, uint32_t node_index, uint32_t frame_begin, uint32_t frame_end,
  const ChainItem *items, uint32_t count) {
  bool live = false;
  const auto fade_clock = [&core](const GraphRevision::Processor &processor, uint32_t &elapsed) {
    const RuntimeSlot &slot = core.processor_slots[processor.history_slot];
    if (!runtime_slot_renderable(core, slot, processor.generation)) return false;
    elapsed = slot.fade_elapsed.load(std::memory_order_relaxed);
    return true;
  };
  std::array<ChainItem, kMaximumChainItems> run;
  for (uint32_t position = 0; position < count; ++position) {
    GraphRevision::Processor &first = graph.processors[items[position].processor_index];
    uint32_t fade_start = 0;
    if (first.detached && !fade_clock(first, fade_start)) continue;
    uint32_t run_count = 0;
    run[run_count++] = items[position];
    while (first.detached && position + 1 < count) {
      const GraphRevision::Processor &candidate = graph.processors[items[position + 1].processor_index];
      uint32_t elapsed = 0;
      if (!candidate.detached) break;
      if (!fade_clock(candidate, elapsed)) {
        ++position;
        continue;
      }
      if (elapsed != fade_start) break;
      run[run_count++] = items[++position];
    }
    live = live || !first.ghost;
    for (uint32_t index = 0; index < run_count; ++index) {
      prepare_processor_parameter_cache(core, graph.processors[run[index].processor_index]);
    }
    for (uint32_t frame = frame_begin; frame < frame_end; ++frame) {
      float &left = *graph_stage_sample(core, kGraphPreFaderStage, node_index, 0, frame);
      float &right = *graph_stage_sample(core, kGraphPreFaderStage, node_index, 1, frame);
      const float dry_left = left;
      const float dry_right = right;
      for (uint32_t index = 0; index < run_count; ++index) render_chain_frame(core, graph, run[index], frame, left, right);
      if (!first.detached) continue;
      const float wet = deletion_fade_gain(fade_start + frame, graph.fade_frames);
      left = dry_left + (left - dry_left) * wet;
      right = dry_right + (right - dry_right) * wet;
      if (!std::isfinite(left)) left = 0.0F;
      if (!std::isfinite(right)) right = 0.0F;
    }
  }
  return live;
}

// Ends the replaced instruments fading out beside a node's own, and the ones
// behind them: each retires its slot, which awaits reclamation after the process
// call completes. Callback, once a blend is over; or control thread, for a slot
// nothing renders any more.
void end_node_blend(Core &core, Core::NodeBlend &first) {
  Core::NodeBlend *blend = &first;
  for (uint32_t link = 0; blend->partner != 0 && link <= kMaximumNodeBlends; ++link) {
    const uint32_t partner = blend->partner - 1u;
    RuntimeSlot &slot = core.node_slots[partner];
    if (slot.state.load(std::memory_order_relaxed) == kSlotActive
      && slot.generation.load(std::memory_order_relaxed) == blend->partner_generation) retire_runtime_slot(core, slot);
    blend->partner = 0;
    blend->elapsed = 0;
    blend->depth.store(0, std::memory_order_release);
    blend = &core.node_blends[partner];
  }
}

// Moves every replaced instrument's fade forward by one block; one that finished
// retires itself and everything behind it, whose weight is nil by then.
void advance_node_blends(Core &core, const GraphRevision &graph, uint32_t frame_count) {
  for (uint32_t node_index = 0; node_index < graph.total_node_count(); ++node_index) {
    Core::NodeBlend &head = core.node_blends[graph.node_slots[node_index]];
    uint32_t depth = 0;
    Core::NodeBlend *blend = &head;
    while (blend->partner != 0 && depth < kMaximumNodeBlends) {
      blend->elapsed = std::min(graph.fade_frames, blend->elapsed + frame_count);
      if (blend->elapsed >= graph.fade_frames) {
        end_node_blend(core, *blend);
        break;
      }
      ++depth;
      blend = &core.node_blends[blend->partner - 1u];
    }
    head.depth.store(depth, std::memory_order_release);
  }
}

// A layout fold moves a linear step per frame toward the layout's target and folds
// by the position it stands at, so the first frame after a change is still the old
// layout and the last of the fade is the target layout.
float advance_fold(float &level, bool mono, float step) {
  const float applied = level;
  level = clamp_bypass_step(level, mono ? 1.0F : 0.0F, step);
  return applied;
}

void fold_channels(float level, float &left, float &right) {
  if (level <= 0.0F) return;
  const float mean = 0.5F * (left + right);
  if (level >= 1.0F) {
    left = right = mean;
    return;
  }
  left += (mean - left) * level;
  right += (mean - right) * level;
}

void render_instrument_state(
  Core &core, InstrumentNodeState &state, const daw_audio_instrument_state_descriptor &descriptor,
  float *left, float *right) {
  advance_applied(core, state, descriptor.kind);
  if (descriptor.kind == DAW_AUDIO_INSTRUMENT_KIND_SYNTH) {
    render_instrument_frame(state, descriptor, core.config.sample_rate_hz, left, right);
  } else if (descriptor.kind == DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) {
    render_granular_instrument_frame(core, state, left, right);
  } else {
    render_sample_instrument_frame(core, state, descriptor, left, right);
  }
}

// A reorder of a node's stages gets no splice: the stages are single instances that
// cannot render both orders, and any blend of the two outputs leaves a residue for a
// downstream resonant filter to ring on. The node dips instead. For half a deletion
// fade its output goes to nothing through the old order, which keeps running with
// its history; then, at nothing, the plan's order takes over and the output returns
// over another half. Each stage runs once per frame throughout and the order
// changes where the output is zero, so the dip is the only audible change.
uint32_t dip_half_frames(const GraphRevision &graph) { return std::max(1u, (graph.fade_frames + 1u) / 2u); }

// The leading frames of a block that still have output to fade, and so run the old
// order; the frame whose output is nothing already belongs to the plan's order. A
// node with an external stage cannot split a block (the stage renders all of it), so
// it keeps the old order for the whole block in which its output reaches nothing, and
// `dip_hold_frames` places the fade at the end of that block.
uint32_t dip_old_frames(const Core::NodeDip &dip, uint32_t frame_count, bool splittable) {
  if (dip.phase != Core::kDipFadingOut || dip.level == 0) return 0;
  return splittable ? std::min(frame_count, dip.level) : frame_count;
}

// The leading frames of a block in which a node that cannot split it keeps the old
// order at the level it stands at, so the fade ends on the block edge where the plan's
// order takes over instead of reaching nothing early and holding silence. A fade that
// does not fit in the block (shorter than it) runs from the first frame, and holds
// the level it has reached in the block that can finish it.
uint32_t dip_hold_frames(const Core::NodeDip &dip, uint32_t frame_count, bool splittable) {
  if (splittable || dip.phase != Core::kDipFadingOut || dip.level == 0 || frame_count < dip.level) return 0;
  return frame_count - dip.level;
}

// Multiplies a node's pre-fader output by its dip, one linear step per frame, and
// moves the dip along. The frame whose output is nothing, past the old order's last,
// starts the return. The first `hold_frames` frames keep the level they stand at.
void apply_node_dip(
  Core &core, const GraphRevision &graph, uint32_t node_index, uint32_t frame_count, uint32_t old_frames,
  uint32_t hold_frames) {
  Core::NodeDip &dip = core.node_dips[graph.node_slots[node_index]];
  const uint32_t half = dip_half_frames(graph);
  for (uint32_t frame = 0; frame < frame_count && dip.phase != Core::kDipNone; ++frame) {
    if (dip.phase == Core::kDipFadingOut && dip.level == 0 && frame >= old_frames) dip.phase = Core::kDipFadingIn;
    const float gain = static_cast<float>(dip.level) / static_cast<float>(half);
    if (dip.phase == Core::kDipFadingOut) {
      if (dip.level > 0 && frame >= hold_frames) --dip.level;
    } else if (++dip.level >= half) {
      dip = {};
    }
    *graph_stage_sample(core, kGraphPreFaderStage, node_index, 0, frame) *= gain;
    *graph_stage_sample(core, kGraphPreFaderStage, node_index, 1, frame) *= gain;
  }
}

// The chain a dipping node runs while its output fades out: the plan's chain with
// the stages the dip names (survivors, and the ghosts of stages the edit deleted)
// put back in the order they ran, in the places those stages hold. Stages the dip
// does not name (added by the edit) stay where the plan puts them, and so do the
// external stages around them.
void order_chain_for_dip(
  const GraphRevision &graph, const Core::NodeDip &dip, const ChainItem *items, uint32_t count, ChainItem *out) {
  const auto order_end = dip.order.begin() + dip.count;
  uint32_t taken = 0;
  for (uint32_t position = 0; position < count; ++position) {
    out[position] = items[position];
    if (std::find(dip.order.begin(), order_end, items[position].processor_index) == order_end) continue;
    const uint16_t index = dip.order[taken++];
    out[position] = {index, find_processor_renderer(graph.processors[index].kind)};
  }
}

// One block of a node's chain: the old order for the frames a dip still fades out,
// then the plan's order.
bool render_node_chain(
  Core &core, GraphRevision &graph, uint32_t node_index, uint32_t frame_count, uint32_t old_frames,
  const ChainItem *items, const ChainItem *old_items, uint32_t count) {
  bool live = false;
  if (old_frames > 0) live = render_chain_segment(core, graph, node_index, 0, old_frames, old_items, count);
  if (old_frames < frame_count) {
    live = render_chain_segment(core, graph, node_index, old_frames, frame_count, items, count) || live;
  }
  return live;
}

void process_graph(Core &core, const daw_audio_core_process_block &block) {
  GraphRevision &graph = (*core.published_graph);
  // Where each ghost's fade stands, known up front because a ghost consumer reads
  // its sources' progress. A faded-out ghost contributes nothing: consumers
  // multiply by the fade gain.
  for (uint32_t node_index = graph.node_count; node_index < graph.total_node_count(); ++node_index) {
    const RuntimeSlot &node_slot = core.node_slots[graph.node_slots[node_index]];
    core.node_fade_start[node_index] = runtime_slot_renderable(core, node_slot, graph.node_generations[node_index])
      ? node_slot.fade_elapsed.load(std::memory_order_relaxed) : graph.fade_frames;
  }
  const bool solo = resolve_mixer_solo(core, graph, block.frame_count);
  for (uint32_t ordered = 0; ordered < graph.total_node_count(); ++ordered) {
    const uint32_t node_index = graph.process_order[ordered];
    const daw_audio_graph_node_descriptor &node = graph.nodes[node_index];
    const bool ghost_node = node_index >= graph.node_count;
    if (ghost_node && core.node_fade_start[node_index] >= graph.fade_frames) continue;
    const uint32_t node_slot = graph.node_slots[node_index];
    InstrumentNodeState &instrument_state = core.instrument_runtime[node_slot];
    // The instrument and, while it fades out, the one it replaced and the ones
    // that one replaced in turn. `elapsed` is the clock of the fade-in that link
    // owns against the next one; the oldest link has none.
    struct InstrumentLink {
      InstrumentNodeState *state;
      const daw_audio_instrument_state_descriptor *descriptor;
      uint32_t elapsed;
    };
    std::array<InstrumentLink, kMaximumNodeBlends + 1> instrument_links;
    uint32_t instrument_link_count = 0;
    if (node.kind == DAW_AUDIO_GRAPH_NODE_INSTRUMENT) {
      instrument_links[instrument_link_count++] = {&instrument_state, &node.instrument, 0};
      const Core::NodeBlend *blend = &core.node_blends[node_slot];
      while (blend->partner != 0 && instrument_link_count <= kMaximumNodeBlends) {
        const uint32_t partner = blend->partner - 1u;
        if (!runtime_slot_renderable(core, core.node_slots[partner], blend->partner_generation)) break;
        instrument_links[instrument_link_count - 1].elapsed = blend->elapsed;
        instrument_links[instrument_link_count++] = {&core.instrument_runtime[partner], &blend->descriptor, 0};
        blend = &core.node_blends[partner];
      }
    }
    Core::NodeFold &fold = core.node_folds[node_slot];
    if (!fold.seen) {
      fold.level = {node.input_layout == DAW_AUDIO_GRAPH_LAYOUT_MONO ? 1.0F : 0.0F,
        node.output_layout == DAW_AUDIO_GRAPH_LAYOUT_MONO ? 1.0F : 0.0F};
      fold.seen = true;
    }
    const float fold_step = 1.0F / static_cast<float>(graph.fade_frames);
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
    const uint32_t hook_layout = node.output_layout;
    const uint32_t hook_channel_count = hook_layout == DAW_AUDIO_GRAPH_LAYOUT_MONO ? 1U : 2U;
#endif
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
            for (uint32_t link = 0; link < instrument_link_count; ++link) release_instrument_state(*instrument_links[link].state);
          } else if (is_native_all_sound_off(event.type)) {
            for (uint32_t link = 0; link < instrument_link_count; ++link) clear_instrument_state(*instrument_links[link].state);
          } else if (node.instrument.kind == DAW_AUDIO_INSTRUMENT_KIND_SYNTH) {
            (void)apply_instrument_event(instrument_state, node.instrument, event);
          } else if (node.instrument.kind == DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) {
            (void)apply_granular_instrument_event(instrument_state, event);
          } else {
            (void)apply_sample_instrument_event(core, instrument_state, node.instrument, event);
          }
        }
        if (instrument_link_count == 1) {
          render_instrument_state(core, instrument_state, node.instrument, &left, &right);
        } else {
          // Complementary weights: each link takes its share of what the newer
          // links left, so the waveforms sum to one whole at every frame.
          float remaining = 1.0F;
          for (uint32_t link = 0; link < instrument_link_count; ++link) {
            const InstrumentLink &voice = instrument_links[link];
            float voice_left = 0.0F;
            float voice_right = 0.0F;
            render_instrument_state(core, *voice.state, *voice.descriptor, &voice_left, &voice_right);
            const float entering = link + 1 == instrument_link_count ? 1.0F
              : std::min(1.0F, static_cast<float>(voice.elapsed + frame) / static_cast<float>(graph.fade_frames));
            left += remaining * entering * voice_left;
            right += remaining * entering * voice_right;
            remaining *= 1.0F - entering;
          }
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
      fold_channels(advance_fold(fold.level[0], node.input_layout == DAW_AUDIO_GRAPH_LAYOUT_MONO, fold_step), left, right);
      *graph_stage_sample(core, kGraphPreFxStage, node_index, 0, frame) = std::isfinite(left) ? left : 0.0F;
      *graph_stage_sample(core, kGraphPreFxStage, node_index, 1, frame) = std::isfinite(right) ? right : 0.0F;
      *graph_stage_sample(core, kGraphPreFaderStage, node_index, 0, frame) =
        *graph_stage_sample(core, kGraphPreFxStage, node_index, 0, frame);
      *graph_stage_sample(core, kGraphPreFaderStage, node_index, 1, frame) =
        *graph_stage_sample(core, kGraphPreFxStage, node_index, 1, frame);
    }
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
    const NativeGraphHooks &native_stages = *core.published_native_hooks;
#endif
    // A node that is dipping runs the old order of its stages for the frames its
    // output still has to fade. An external stage renders a whole block where it
    // stands, so a node with one keeps the old order for the whole block in which its
    // output reaches nothing; it holds the old order at its level first, so the fade
    // ends on that block's edge.
    bool splittable = true;
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
    for (std::uint32_t stage_index = 0; stage_index < native_stages.stage_counts[node_index]; ++stage_index) {
      if (native_stages.stages[node_index][stage_index].kind == NativeGraphStageKind::kExternal) splittable = false;
    }
#endif
    const Core::NodeDip &node_dip = core.node_dips[node_slot];
    const uint32_t old_frames = dip_old_frames(node_dip, block.frame_count, splittable);
    const uint32_t hold_frames = dip_hold_frames(node_dip, block.frame_count, splittable);
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
    std::array<ChainItem, kMaximumChainItems> plan_order;
    std::array<ChainItem, kMaximumChainItems> old_order;
    uint32_t built_in_count = 0;
    for (std::uint32_t stage_index = 0; stage_index < native_stages.stage_counts[node_index]; ++stage_index) {
      const NativeGraphStage &stage = native_stages.stages[node_index][stage_index];
      if (stage.kind != NativeGraphStageKind::kExternal) plan_order[built_in_count++] = {stage.processor_index, stage.renderer};
    }
    if (old_frames > 0) order_chain_for_dip(graph, node_dip, plan_order.data(), built_in_count, old_order.data());
    // Built-in stages are gathered until an external stage interrupts the chain.
    std::array<ChainItem, kMaximumChainItems> pending;
    std::array<ChainItem, kMaximumChainItems> old_pending;
    std::uint32_t pending_count = 0;
    std::uint32_t built_in_index = 0;
    const auto render_pending = [&] {
      const bool live = render_node_chain(
        core, graph, node_index, block.frame_count, old_frames, pending.data(), old_pending.data(), pending_count);
      pending_count = 0;
      return live;
    };
    for (std::uint32_t stage_index = 0; stage_index < native_stages.stage_counts[node_index]; ++stage_index) {
      const NativeGraphStage &stage = native_stages.stages[node_index][stage_index];
      if (stage.kind == NativeGraphStageKind::kExternal) {
        processed_chain = render_pending() || processed_chain;
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
      old_pending[pending_count] = old_frames > 0 ? old_order[built_in_index] : plan_order[built_in_index];
      pending[pending_count++] = plan_order[built_in_index++];
    }
    processed_chain = render_pending() || processed_chain;
#else
    const GraphRevision::Range processor_range = graph.processor_ranges[node_index];
    const uint32_t processor_end = static_cast<uint32_t>(processor_range.start) + processor_range.count;
    std::array<ChainItem, kMaximumChainItems> chain;
    uint32_t chain_count = 0;
    for (uint32_t position = processor_range.start; position < processor_end; ++position) {
      const uint32_t processor_index = graph.processor_indices[position];
      const ProcessorRenderer render = find_processor_renderer(graph.processors[processor_index].kind);
      if (render != nullptr) chain[chain_count++] = {static_cast<uint16_t>(processor_index), render};
    }
    std::array<ChainItem, kMaximumChainItems> old_chain;
    if (old_frames > 0) order_chain_for_dip(graph, node_dip, chain.data(), chain_count, old_chain.data());
    processed_chain = render_node_chain(
      core, graph, node_index, block.frame_count, old_frames, chain.data(), old_chain.data(), chain_count)
      || processed_chain;
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
    apply_node_dip(core, graph, node_index, block.frame_count, old_frames, hold_frames);
    MixerBlock mixer = begin_mixer_block(core, node.mixer, node_slot);
    for (uint32_t frame = 0; frame < block.frame_count; ++frame) {
      float left = *graph_stage_sample(core, kGraphPreFaderStage, node_index, 0, frame);
      float right = *graph_stage_sample(core, kGraphPreFaderStage, node_index, 1, frame);
      *graph_stage_sample(core, kGraphPreFaderStage, node_index, 0, frame) = std::isfinite(left) ? left : 0.0F;
      *graph_stage_sample(core, kGraphPreFaderStage, node_index, 1, frame) = std::isfinite(right) ? right : 0.0F;
      apply_mixer_frame(core, mixer, frame, solo && core.mixer_solo_frames[frame] != 0, &left, &right);
      fold_channels(advance_fold(fold.level[1], node.output_layout == DAW_AUDIO_GRAPH_LAYOUT_MONO, fold_step), left, right);
      *graph_stage_sample(core, kGraphOutputStage, node_index, 0, frame) = std::isfinite(left) ? left : 0.0F;
      *graph_stage_sample(core, kGraphOutputStage, node_index, 1, frame) = std::isfinite(right) ? right : 0.0F;
    }
    latch_mixer_block(core, mixer);
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
    if (!ghost_node && core.published_native_hooks->observer != nullptr) {
      const auto project_frame = project_time_frame(core);
      core.published_native_hooks->observer({
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
        .planes = {
          graph_stage_sample(core, kGraphOutputStage, node_index, 0, 0),
          graph_stage_sample(core, kGraphOutputStage, node_index, 1, 0),
        },
        .instrument_events = {},
        .attachment = core.published_native_hooks->observer_attachment,
      });
    }
#endif
  }
  // Commit each pre-gain tap once, after every reader consumed the preceding
  // block's history. This keeps a full-capacity delay valid even when a block
  // spans the ring wrap; writing a source block before its readers would erase
  // the oldest samples they still need.
  for (uint32_t node = 0; node < graph.total_node_count(); ++node) {
    for (uint32_t stage = 0; stage < kGraphStageCount; ++stage) {
      if (node >= graph.node_count && !graph.ghost_history_writers[node][stage]) continue;
      const uint32_t slot = graph.tap_history_slots[node][stage];
      auto &history = core.graph_tap_histories[slot];
      if (history.capacity == 0) continue;
      if (history.end_frame != core.graph_write_frame) history.first_frame = core.graph_write_frame;
      for (uint32_t channel = 0; channel < 2; ++channel) {
        const std::size_t base = history.offset + static_cast<std::size_t>(channel) * history.capacity;
        for (uint32_t frame = 0; frame < block.frame_count; ++frame) {
          core.graph_tap_storage[base + ((core.graph_write_frame + frame) & (history.capacity - 1u))]
            = *graph_stage_sample(core, stage, node, channel, frame);
        }
      }
      history.end_frame = core.graph_write_frame + block.frame_count;
      history.first_frame = std::max(history.first_frame,
        history.end_frame > history.capacity ? history.end_frame - history.capacity : 0);
    }
  }
  advance_deletion_fades(core, graph, block.frame_count);
  advance_node_blends(core, graph, block.frame_count);
  advance_edge_ramps(core, graph, block.frame_count);
  for (uint32_t channel = 0; channel < block.channel_count; ++channel) {
    const uint32_t graph_channel = channel == 0 ? 0 : 1;
    for (uint32_t frame = 0; frame < block.frame_count; ++frame) {
      float gain = 1.0F;
      if (graph.latency_raise != 0 && core.transport.running != 0 && core.latency_shrunk_revision != graph.revision) {
        const uint64_t absolute = core.graph_write_frame + frame;
        const uint64_t seam = graph.latency_origin + core.latency_publication_shift + graph.fade_frames;
        if (absolute < seam) gain = static_cast<float>(seam - absolute) / graph.fade_frames;
        else if (absolute < seam + graph.fade_frames) gain = static_cast<float>(absolute - seam) / graph.fade_frames;
      }
      block.outputs[channel][frame] = *graph_stage_sample(core, kGraphOutputStage, graph.master_index, graph_channel, frame) * gain;
    }
  }
  core.graph_write_frame += block.frame_count;
  core.completed_graph_frame.store(core.graph_write_frame, std::memory_order_release);
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

bool bind_process_transport(Core &core, const daw_audio_core_process_block &block, uint8_t *rejected_events) {
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
  // Validation applies events to a scratch copy of only the nodes they touch.
#if defined(DAW_AUDIO_CORE_USE_PERSISTENT_VALIDATION_SCRATCH)
  auto &proposed_instruments = core.proposed_instruments;
#else
  std::array<InstrumentNodeState, kMaximumLiveNodes> proposed_instruments;
#endif
  for (auto &indices : core.instrument_event_indices) indices.fill(0);
  core.instrument_event_counts.fill(0);
  uint32_t previous_instrument_offset = 0;
  uint64_t previous_instrument_sequence = 0;
  bool has_previous_instrument = false;
  for (uint32_t event_index = 0; event_index < block.instrument_event_count; ++event_index) {
    core.rejected_instrument_event_index = event_index;
    const daw_audio_instrument_event &event = block.instrument_events[event_index];
#if defined(DAW_AUDIO_CORE_TEST_INSTRUMENT_REJECTION)
    // Only the host test's private core is built with this fault-injection hook.
    if (daw_audio_core_test_reject_instrument_event(event_index)) {
      if (rejected_events == nullptr) return false;
      rejected_events[event_index] = 1;
      continue;
    }
#endif
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
        || event.sequence <= previous_instrument_sequence))) {
      if (rejected_events == nullptr) return false;
      rejected_events[event_index] = 1;
      continue;
    }
    const uint32_t index = static_cast<uint32_t>(node_index);
    if (core.instrument_event_counts[index] == 0) proposed_instruments[index] = published_instrument(core, index);
    bool accepted = true;
    if (is_native_transport_release(event.type)) {
      release_instrument_state(proposed_instruments[index]);
    } else if (is_native_all_sound_off(event.type)) {
      clear_instrument_state(proposed_instruments[index]);
    } else if ((*core.published_graph).nodes[index].instrument.kind == DAW_AUDIO_INSTRUMENT_KIND_SYNTH) {
      accepted = apply_instrument_event(proposed_instruments[index], (*core.published_graph).nodes[index].instrument, event);
    } else if ((*core.published_graph).nodes[index].instrument.kind == DAW_AUDIO_INSTRUMENT_KIND_GRANULAR) {
      accepted = apply_granular_instrument_event(proposed_instruments[index], event);
    } else {
      accepted = apply_sample_instrument_event(core, proposed_instruments[index], (*core.published_graph).nodes[index].instrument, event);
    }
    if (!accepted) {
      if (rejected_events == nullptr) return false;
      rejected_events[event_index] = 1;
      continue;
    }
    const uint16_t count = core.instrument_event_counts[index];
    if (count >= DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS) return false;
    core.instrument_event_indices[index][count] = static_cast<uint16_t>(event_index);
    core.instrument_event_counts[index] = static_cast<uint16_t>(count + 1);
    previous_instrument_offset = event.frame_offset;
    previous_instrument_sequence = event.sequence;
    has_previous_instrument = true;
  }
  core.rejected_instrument_event_index = UINT32_MAX;
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

bool wasm_read_i64(const uint8_t *bytes, uint32_t byte_count, uint32_t *offset, int64_t *out) {
  uint64_t value = 0;
  if (!wasm_read_u64(bytes, byte_count, offset, &value)) return false;
  __builtin_memcpy(out, &value, sizeof(value));
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
  std::array<daw_audio_graph_node_descriptor, kMaximumLiveNodes> *nodes,
  std::array<daw_audio_graph_edge_descriptor, kMaximumLiveEdges> *edges,
  std::array<daw_audio_processor_descriptor, kMaximumLiveProcessors> *processors,
  std::array<std::array<uint32_t, DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS>, kMaximumLiveProcessors> *targets,
  std::array<std::array<uint8_t, DAW_AUDIO_CORE_MAX_PROCESSOR_STATE_BYTES>, kMaximumLiveProcessors> *states) {
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
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
      && version != DAW_AUDIO_CORE_NATIVE_GRAPH_ENVELOPE_VERSION_KEEP_LATENCY
#endif
      && version != DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION_LEGACY_2
      && version != DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION_LEGACY) || reserved != 0
    || revision == 0 || node_count == 0 || node_count > kMaximumLiveNodes || edge_count > kMaximumLiveEdges
    || processor_count > kMaximumLiveProcessors) return false;
  for (uint32_t index = 0; index < node_count; ++index) {
    uint64_t id = 0;
    uint32_t kind = 0;
    uint32_t input_layout = 0;
    uint32_t output_layout = 0;
    uint32_t input_bus = 0;
    uint32_t latency = 0;
    uint32_t external_latency = 0;
    uint32_t keep_latency = 0;
    if (!wasm_read_u64(bytes, byte_count, &offset, &id) || !wasm_read_u32(bytes, byte_count, &offset, &kind)
      || !wasm_read_u32(bytes, byte_count, &offset, &input_layout) || !wasm_read_u32(bytes, byte_count, &offset, &output_layout)
      || !wasm_read_u32(bytes, byte_count, &offset, &input_bus) || !wasm_read_u32(bytes, byte_count, &offset, &latency)) return false;
    if (version >= DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION_EXTERNAL_LATENCY
      && !wasm_read_u32(bytes, byte_count, &offset, &external_latency)) return false;
    if (version == DAW_AUDIO_CORE_NATIVE_GRAPH_ENVELOPE_VERSION_KEEP_LATENCY
      && (!wasm_read_u32(bytes, byte_count, &offset, &keep_latency) || keep_latency > 1)) return false;
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
      || version >= DAW_AUDIO_CORE_WASM_GRAPH_ENVELOPE_VERSION_EXTERNAL_LATENCY) {
      if (!wasm_read_u64(bytes, byte_count, &offset, &mixer.instance_id)
        || !wasm_read_f32(bytes, byte_count, &offset, &mixer.gain)
        || !wasm_read_f32(bytes, byte_count, &offset, &mixer.pan)
        || !wasm_read_u32(bytes, byte_count, &offset, &mixer.muted)
        || !wasm_read_u32(bytes, byte_count, &offset, &mixer.soloed)) return false;
    }
    (*nodes)[index] = {
      .id = id, .kind = wasm_graph_kind(kind), .input_layout = input_layout, .output_layout = output_layout,
      .input_bus = input_bus, .latency_frames = latency, .external_latency_frames = external_latency,
      .instrument = instrument, .mixer = mixer, .keep_latency = keep_latency,
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
  uint64_t sequence = 0;
  uint32_t frame_count = 0;
  int64_t start_frame = 0;
};

struct RecordingCapture {
  daw_audio_recording_capture_config config{};
  std::array<RecordingCaptureBlock, DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS> blocks{};
  uint32_t current = DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS;
  uint32_t pending = DAW_AUDIO_RECORDING_CAPTURE_POOL_BLOCKS;
  uint64_t next_sequence = 0;
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
  uint64_t sequence = UINT64_MAX;
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
  if (!allocate_graph_stage_buffers(*core)) {
    delete core;
    return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
  *out_core = to_handle(core);
  return DAW_AUDIO_CORE_OK;
}

extern "C" void daw_audio_core_destroy(daw_audio_core_handle core) {
  delete to_core(core);
}

void reclaim_retired_slots(Core &core);
void release_prepared_runtime(Core &core);
daw_audio_core_result prepare_runtime_ownership(Core &core);
daw_audio_core_result refresh_prepared_node(Core &core, uint32_t index);
bool mark_replaced_node(const Core &core, const GraphRevision &current, GraphRevision &next, uint32_t node);

// Control-side reader ownership. Retained live identities and delayed ghosts
// reserve rings. A zero-delay ghost still needs no ring.
// Dropped owners finish their last read/write in the old plan's render epoch;
// publication at the next boundary transfers their rings. Preparation must
// never reset those callback-owned descriptors or write their storage.
bool prepare_tap_histories(Core &core, GraphRevision &next) {
  const auto &current = *core.published_graph;
  std::array<bool, Core::kTapHistorySlots> occupied{};
  std::array<uint16_t, kMaximumGraphNodes> by_id{};
  for (uint32_t node = 0; node < current.node_count; ++node) {
    by_id[node] = static_cast<uint16_t>(node);
  }
  const auto end = by_id.begin() + current.node_count;
  std::sort(by_id.begin(), end, [&](uint16_t left, uint16_t right) {
    return current.nodes[left].id < current.nodes[right].id;
  });
  // Reserve retained readers before assigning any new owner, irrespective of
  // node order. Runtime generation distinguishes replacement from retention.
  for (uint32_t node = 0; node < next.node_count; ++node) {
    const uint64_t id = next.nodes[node].id;
    const auto old = std::lower_bound(by_id.begin(), end, id, [&](uint16_t index, uint64_t key) {
      return current.nodes[index].id < key;
    });
    const bool retained = old != end && current.nodes[*old].id == id
      && current.node_slots[*old] == next.node_slots[node]
      && current.node_generations[*old] == next.node_generations[node];
    for (uint32_t tap = 0; tap < kGraphStageCount; ++tap) {
      next.reset_tap_histories[node][tap] = !retained;
      if (retained) {
        next.tap_history_slots[node][tap] = current.tap_history_slots[*old][tap];
        occupied[next.tap_history_slots[node][tap]] = true;
      }
    }
  }
  // A delayed ghost keeps the old owner, not a second history bank. Reserve its
  // readers before transferring any dropped owner's ring to a fresh live tap.
  // The ordinary 192-ring bound remains a genuine capacity limit.
  for (uint32_t edge = next.edge_count; edge < next.total_edge_count(); ++edge) {
    if (next.read_heads[edge].delay == 0) continue;
    const uint32_t source = next.edge_source_indices[edge];
    if (source < next.node_count) continue;
    const uint32_t stage = next.edges[edge].tap == DAW_AUDIO_GRAPH_EDGE_PRE_FX ? kGraphPreFxStage
      : next.edges[edge].tap == DAW_AUDIO_GRAPH_EDGE_PRE_FADER ? kGraphPreFaderStage : kGraphOutputStage;
    const uint32_t slot = next.tap_history_slots[source][stage];
    if (!next.ghost_history_writers[source][stage] && occupied[slot]) return false;
    next.ghost_history_writers[source][stage] = true;
    occupied[slot] = true;
  }
  uint32_t free_slot = 0;
  for (uint32_t node = 0; node < next.node_count; ++node) {
    for (uint32_t tap = 0; tap < kGraphStageCount; ++tap) {
      if (!next.reset_tap_histories[node][tap]) continue;
      while (free_slot < occupied.size() && occupied[free_slot]) ++free_slot;
      if (free_slot == occupied.size()) return false;
      next.tap_history_slots[node][tap] = static_cast<uint16_t>(free_slot);
      occupied[free_slot++] = true;
    }
  }
  return true;
}

#if !defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
// Native reserves kMaximumGraphLatencyFrames for every tap; that does not fit the
// fixed 256 MiB Wasm memory, so the rings here follow the readers. Every tap a node
// owns keeps this floor, so a delay raised later still has its history to read.
constexpr uint32_t kPortableTapHistoryFloorFrames = 4096;

// Control and render share one thread here, so a prepare may move the rings. They
// only grow: the published plan keeps reading them, and a grown ring carries its
// history over. A ring covers the longest delay any head of the plan reads.
bool configure_portable_tap_histories(Core &core, const GraphRevision &graph) {
  std::array<uint32_t, Core::kTapHistorySlots> capacities{};
  for (uint32_t slot = 0; slot < capacities.size(); ++slot) capacities[slot] = core.graph_tap_histories[slot].capacity;
  const auto grow = [&](uint32_t slot, uint32_t frames) {
    uint32_t capacity = 1;
    while (capacity < frames) capacity *= 2;
    capacities[slot] = std::max(capacities[slot], capacity);
  };
  for (uint32_t node = 0; node < graph.node_count; ++node) {
    for (uint32_t tap = 0; tap < kGraphStageCount; ++tap) grow(graph.tap_history_slots[node][tap], kPortableTapHistoryFloorFrames);
  }
  for (uint32_t edge = 0; edge < graph.total_edge_count(); ++edge) {
    const auto &reader = graph.edges[edge];
    const auto &head = graph.read_heads[edge];
    const uint32_t stage = reader.tap == DAW_AUDIO_GRAPH_EDGE_PRE_FX ? kGraphPreFxStage
      : reader.tap == DAW_AUDIO_GRAPH_EDGE_PRE_FADER ? kGraphPreFaderStage : kGraphOutputStage;
    grow(graph.tap_history_slots[graph.edge_source_indices[edge]][stage],
      std::max({head.delay, head.previous_delay, head.stopped_delay}));
  }
  std::array<std::size_t, Core::kTapHistorySlots> offsets{};
  std::size_t samples = 0;
  bool grown = false;
  for (uint32_t slot = 0; slot < capacities.size(); ++slot) {
    offsets[slot] = samples;
    samples += static_cast<std::size_t>(capacities[slot]) * 2u;
    grown = grown || capacities[slot] != core.graph_tap_histories[slot].capacity;
  }
  if (!grown) return true;
  std::unique_ptr<float[]> storage(new (std::nothrow) float[samples]());
  if (!storage) return false;
  volatile float *pages = storage.get();
  for (std::size_t sample = 0; sample < samples; sample += 1024u) pages[sample] = 0.0F;
  for (uint32_t slot = 0; slot < capacities.size(); ++slot) {
    const auto &old = core.graph_tap_histories[slot];
    const uint64_t first = std::max<uint64_t>(old.first_frame, old.end_frame - std::min(old.end_frame, uint64_t{old.capacity}));
    for (uint32_t channel = 0; channel < 2; ++channel) {
      for (uint64_t frame = first; frame < old.end_frame; ++frame) {
        storage[offsets[slot] + channel * capacities[slot] + (frame & (capacities[slot] - 1u))]
          = core.graph_tap_storage[old.offset + channel * old.capacity + (frame & (old.capacity - 1u))];
      }
    }
  }
  for (uint32_t slot = 0; slot < capacities.size(); ++slot) {
    core.graph_tap_histories[slot].offset = offsets[slot];
    core.graph_tap_histories[slot].capacity = capacities[slot];
  }
  core.graph_tap_storage = std::move(storage);
  return true;
}
#endif

// Control-side read-head preparation. Keep the compiler's validated minimum
// table for stopped playback; a running graph pins its master budget on lowers.
// Heads share the retained pre-gain tap, never another copy of the signal.
daw_audio_core_result prepare_latency_heads(Core &core, GraphRevision &next, bool stopped = false) {
  const auto &current = *core.published_graph;
  const bool running = !stopped && core.transport_running.load(std::memory_order_acquire);
  std::array<uint32_t, kMaximumGraphNodes> padding{};
  std::array<bool, kMaximumGraphNodes> spectral_raise{};
  if (running) for (uint32_t index = 0; index < next.processor_count; ++index) {
    const auto &processor = next.processors[index];
    padding[processor.node_index] += processor.spectral_compensation;
    if (processor.spectral_predecessor >= 0) {
      const auto &prior = next.spectral_predecessors[processor.spectral_predecessor];
      spectral_raise[processor.node_index] = spectral_raise[processor.node_index]
        || processor.spectral.fft_size + processor.spectral_compensation
          > prior.spectral.fft_size + prior.spectral_compensation;
    }
  }
  const uint32_t old_budget = core.latency_budget.load(std::memory_order_acquire);
  std::array<uint32_t, kMaximumGraphNodes> paths{};
  std::array<uint32_t, kMaximumGraphNodes> inputs{};
  std::array<bool, kMaximumGraphNodes> kept{};
  std::array<bool, kMaximumGraphNodes> normal{};
  for (uint32_t ordered = 0; ordered < next.node_count; ++ordered) {
    const uint32_t node = next.process_order[ordered];
    const auto range = next.incoming_edge_ranges[node];
    kept[node] = next.nodes[node].keep_latency != 0;
    normal[node] = range.count == 0 && !kept[node];
    for (uint32_t position = range.start; position < range.start + range.count; ++position) {
      const uint32_t edge = next.incoming_edge_indices[position];
      const uint32_t source = next.edge_source_indices[edge];
      if (source >= next.node_count) continue;
      kept[node] = kept[node] || kept[source];
      if (!normal[source]) continue;
      normal[node] = true;
      uint32_t arrival = paths[source];
      if (next.edges[edge].tap == DAW_AUDIO_GRAPH_EDGE_PRE_FX)
        arrival -= next.nodes[source].latency_frames + next.nodes[source].external_latency_frames + padding[source];
      inputs[node] = std::max(inputs[node], arrival);
    }
    if (next.nodes[node].keep_latency != 0) normal[node] = false;
    paths[node] = inputs[node] + next.nodes[node].latency_frames + next.nodes[node].external_latency_frames + padding[node];
  }
  next.minimum_latency = normal[next.master_index] ? paths[next.master_index] : 0u;
  next.latency_budget = running ? std::max(old_budget, next.minimum_latency) : next.minimum_latency;
  next.latency_raise = running && current.revision != 0 && next.latency_budget > old_budget
    ? next.latency_budget - old_budget : 0;
  next.latency_origin = core.completed_graph_frame.load(std::memory_order_acquire);
  next.latency_end = next.latency_origin;
  if (next.latency_raise != 0) next.latency_end += next.fade_frames * 2u;
  // Normal contributions enter a mixed bus already compensated to output
  // content time. The shared bus (and every downstream bus/return) then needs
  // no compensation, preserving the monitored contribution without DSP lanes.
  std::array<uint32_t, kMaximumGraphNodes> downstream{};
  std::array<uint32_t, kMaximumGraphNodes> shortest{};
  shortest.fill(UINT32_MAX);
  shortest[next.master_index] = downstream[next.master_index] = next.nodes[next.master_index].latency_frames
    + next.nodes[next.master_index].external_latency_frames + padding[next.master_index];
  for (uint32_t ordered = next.node_count; ordered-- > 0;) {
    const uint32_t target = next.process_order[ordered];
    const auto range = next.incoming_edge_ranges[target];
    for (uint32_t position = range.start; position < range.start + range.count; ++position) {
      const uint32_t edge = next.incoming_edge_indices[position];
      const uint32_t source = next.edge_source_indices[edge];
      if (source >= next.node_count) continue;
      if (shortest[target] == UINT32_MAX) continue;
      const uint32_t latency = next.edges[edge].tap == DAW_AUDIO_GRAPH_EDGE_PRE_FX ? 0u
        : next.nodes[source].latency_frames + next.nodes[source].external_latency_frames + padding[source];
      downstream[source] = std::max(downstream[source], downstream[target] + latency);
      shortest[source] = std::min(shortest[source], shortest[target] + latency);
    }
  }
  // One shared nonlinear bus cannot give its normal contribution two different
  // pre-merge delays without executing independent DSP lanes. Reject that
  // topology explicitly rather than delaying its monitored contribution.
  for (uint32_t node = 0; node < next.node_count; ++node)
    if (kept[node] && normal[node] && shortest[node] != UINT32_MAX && shortest[node] != downstream[node]) {
      core.graph_validation_diagnostic = {
        .code = DAW_AUDIO_CORE_GRAPH_VALIDATION_KEEP_LATENCY_DIVERGENT_MIXED_BUS,
        .index = node, .actual = downstream[node], .limit = shortest[node]};
      return DAW_AUDIO_CORE_GRAPH_COMPATIBILITY_REJECTED;
    }
  std::array<uint16_t, kMaximumGraphEdges> old_edges{};
  for (uint32_t edge = 0; edge < current.edge_count; ++edge) old_edges[edge] = static_cast<uint16_t>(edge);
  const auto old_end = old_edges.begin() + current.edge_count;
  std::sort(old_edges.begin(), old_end, [&](uint16_t left, uint16_t right) {
    return current.edges[left].id < current.edges[right].id;
  });
  for (uint32_t edge = 0; edge < next.edge_count; ++edge) {
    const uint32_t source = next.edge_source_indices[edge];
    const uint32_t target = next.edge_target_indices[edge];
    auto &head = next.read_heads[edge];
    uint32_t arrival = paths[source];
    if (next.edges[edge].tap == DAW_AUDIO_GRAPH_EDGE_PRE_FX)
      arrival -= next.nodes[source].latency_frames + next.nodes[source].external_latency_frames + padding[source];
    const bool skip = kept[source] || next.nodes[target].keep_latency != 0;
    head.stopped_delay = skip || inputs[target] <= arrival ? 0u : inputs[target] - arrival;
    head.delay = head.stopped_delay;
    if (!skip && kept[target]) {
      const uint32_t remaining = downstream[target];
      head.stopped_delay = next.minimum_latency > remaining + arrival ? next.minimum_latency - remaining - arrival : 0u;
      head.delay = next.latency_budget > remaining + arrival ? next.latency_budget - remaining - arrival : 0u;
    } else if (!skip && target == next.master_index) head.delay += next.latency_budget - next.minimum_latency;
    head.previous_delay = head.delay;
    const auto &after = next.edges[edge];
    const auto old = std::lower_bound(old_edges.begin(), old_end, after.id, [&](uint16_t index, uint64_t id) {
      return current.edges[index].id < id;
    });
    const bool retained = old != old_end && current.edges[*old].id == after.id
      && current.edges[*old].from_node_id == after.from_node_id
      && current.edges[*old].to_node_id == after.to_node_id && current.edges[*old].tap == after.tap
      && current.edges[*old].sidechain == after.sidechain
      && current.edges[*old].target_processor_id == after.target_processor_id;
    if (retained) {
      head.previous_delay = running && old_budget == current.latency_budget
        && core.latency_shrunk_revision.load(std::memory_order_acquire) != current.revision
        ? current.read_heads[*old].delay : current.read_heads[*old].stopped_delay;
    }
    head.seam = next.latency_origin;
    if (running && retained && head.previous_delay != head.delay) {
      if (next.latency_raise != 0) head.seam += next.fade_frames;
      else {
        head.seam += std::max(head.previous_delay, head.delay);
        head.crossfade_frames = next.fade_frames * 2u;
      }
      next.latency_end = std::max(next.latency_end, head.seam + head.crossfade_frames);
    }
    // A spectral raise already aligns the predecessor to the new stage at the
    // write seam. Read the new tap segment at that segment's arrival, instead
    // of mixing read heads with incompatible effective source latencies.
    if (running && retained && after.tap != DAW_AUDIO_GRAPH_EDGE_PRE_FX && spectral_raise[source]) {
      head.seam = next.latency_origin + (next.latency_raise != 0 ? next.fade_frames : 0u) + head.delay;
      head.crossfade_frames = 0;
      next.latency_end = std::max(next.latency_end, head.seam);
    }
  }
  if (running) {
    // Stopped playback removes stage-local compensation as well as the pinned
    // master budget. Prepare that independent raw-latency table off-thread.
    std::array<uint32_t, kMaximumGraphEdges> delays{};
    const auto budget = next.latency_budget, raise = next.latency_raise;
    const auto end = next.latency_end;
    const auto origin = next.latency_origin;
    const auto heads = next.read_heads;
    const auto result = prepare_latency_heads(core, next, true);
    if (result != DAW_AUDIO_CORE_OK) return result;
    for (uint32_t edge = 0; edge < next.edge_count; ++edge) delays[edge] = next.read_heads[edge].stopped_delay;
    const auto raw_minimum = next.minimum_latency;
    next.read_heads = heads;
    for (uint32_t edge = 0; edge < next.edge_count; ++edge) next.read_heads[edge].stopped_delay = delays[edge];
    next.latency_budget = budget;
    next.minimum_latency = raw_minimum;
    next.latency_raise = raise;
    next.latency_end = end;
    next.latency_origin = origin;
  }
  return DAW_AUDIO_CORE_OK;
}

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
  // Ghosts copy the published plan's processors, which applying a patch rewrites
  // in the callback: preparing beside an unresolved patch would read a torn plan.
  for (uint32_t index = 0; index < 2; ++index) {
    if (core->staged_processor_state_patches[index].state.load(std::memory_order_acquire) >= 2) {
      return DAW_AUDIO_CORE_PROCESSOR_PATCH_PENDING;
    }
  }
  GraphRevision *prepared = &core->graph_prepare_scratch[0];
  const daw_audio_core_result result = prepare_graph_revision(*core, *request, prepared);
  if (result != DAW_AUDIO_CORE_OK) return result;
  // A new prepare replaces any unpublished plan: its fresh slots go back first.
  release_prepared_runtime(*core);
  core->prepared_revision = 0;
  reclaim_retired_slots(*core);
  (*core->prepared_graph) = *prepared;
  const daw_audio_core_result ownership = prepare_runtime_ownership(*core);
  if (ownership != DAW_AUDIO_CORE_OK) {
    release_prepared_runtime(*core);
    return ownership;
  }
  const auto latency = prepare_latency_heads(*core, *core->prepared_graph);
  if (latency != DAW_AUDIO_CORE_OK) {
    release_prepared_runtime(*core);
    return latency;
  }
  if (!prepare_tap_histories(*core, *core->prepared_graph)) {
    release_prepared_runtime(*core);
    return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
#if !defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  if (!configure_portable_tap_histories(*core, *core->prepared_graph)) {
    release_prepared_runtime(*core);
    return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
#endif
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  std::destroy_at(core->prepared_native_hooks);
  std::construct_at(core->prepared_native_hooks);
  if (!initialize_native_graph_stages(*core->prepared_native_hooks, *core->prepared_graph)) {
    release_prepared_runtime(*core);
    return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
#endif
  core->prepared_revision = request->graph_revision;
  return DAW_AUDIO_CORE_OK;
}

#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
namespace {
bool configuration_instrument_matches(Core& core, const uint64_t node_id, const uint32_t kind) {
  const auto& graph = configuration_graph(core);
  const auto index = graph_node_index(graph, node_id);
  return index >= 0 && graph.nodes[index].kind == DAW_AUDIO_GRAPH_NODE_INSTRUMENT
    && graph.nodes[index].instrument.kind == kind;
}

bool retained_scheduled_node(const GraphRevision& previous, const GraphRevision& next, uint64_t id) {
  const auto old_index = graph_node_index(previous, id);
  const auto new_index = graph_node_index(next, id);
  return old_index >= 0 && new_index >= 0
    && previous.nodes[old_index].kind == next.nodes[new_index].kind
    && previous.node_slots[old_index] == next.node_slots[new_index]
    && previous.node_generations[old_index] == next.node_generations[new_index];
}

const GraphRevision::Processor* scheduled_processor(const GraphRevision& graph, uint64_t id) {
  const auto end = graph.scheduled_processor_lookup.begin() + graph.processor_count;
  const auto found = std::lower_bound(graph.scheduled_processor_lookup.begin(), end, id,
    [&graph](uint16_t index, uint64_t target) { return graph.processors[index].instance_id < target; });
  return found != end && graph.processors[*found].instance_id == id ? &graph.processors[*found] : nullptr;
}

const daw_audio_graph_node_descriptor* scheduled_mixer(const GraphRevision& graph, uint64_t id) {
  const auto end = graph.scheduled_mixer_lookup.begin() + graph.node_count;
  const auto found = std::lower_bound(graph.scheduled_mixer_lookup.begin(), end, id,
    [&graph](uint16_t index, uint64_t target) { return graph.nodes[index].mixer.instance_id < target; });
  return found != end && graph.nodes[*found].mixer.instance_id == id ? &graph.nodes[*found] : nullptr;
}
}

bool daw::audio_core::RetainsScheduledTarget(const daw_audio_core_handle handle,
  const uint32_t previous_revision, const daw_audio_sample_source_event& event) noexcept {
  const Core* core = to_core(handle);
  return core != nullptr && core->prepared_graph->revision == previous_revision
    && retained_scheduled_node(*core->prepared_graph, *core->published_graph, event.source_node_id);
}

bool daw::audio_core::RetainsScheduledTarget(const daw_audio_core_handle handle,
  const uint32_t previous_revision, const daw_audio_processor_event& event) noexcept {
  const Core* core = to_core(handle);
  if (core == nullptr || core->prepared_graph->revision != previous_revision) return false;
  const auto& previous = *core->prepared_graph;
  const auto& next = *core->published_graph;
  const auto* old_processor = scheduled_processor(previous, event.processor_instance_id);
  const auto* new_processor = scheduled_processor(next, event.processor_instance_id);
  if (old_processor != nullptr && new_processor != nullptr)
    return old_processor->node_id == new_processor->node_id && old_processor->kind == new_processor->kind
      && retained_scheduled_node(previous, next, new_processor->node_id)
      && processor_declares_target(*new_processor, event.parameter_target);
  const auto* old_mixer = scheduled_mixer(previous, event.processor_instance_id);
  const auto* new_mixer = scheduled_mixer(next, event.processor_instance_id);
  return old_processor == nullptr && new_processor == nullptr && old_mixer != nullptr && new_mixer != nullptr
    && old_mixer->id == new_mixer->id && retained_scheduled_node(previous, next, new_mixer->id)
    && valid_mixer_parameter_value(event.parameter_target, event.value);
}

daw::audio_core::NativeLatencyTransition daw::audio_core::InspectLatencyTransition(
  const daw_audio_core_handle handle) noexcept {
  const Core *core = to_core(handle);
  if (core == nullptr) return {};
  return {
    .budget = core->latency_budget.load(std::memory_order_acquire),
    .revision = core->latency_move_revision.load(std::memory_order_acquire),
    .completed_revision = core->latency_completed_revision.load(std::memory_order_acquire),
    .completed_frame = core->completed_graph_frame.load(std::memory_order_acquire),
  };
}

std::uint32_t daw::audio_core::PublishedGraphLatency(const daw_audio_core_handle handle) noexcept {
  const Core *core = to_core(handle);
  return core == nullptr ? 0u : core->published_graph->minimum_latency;
}

void daw::audio_core::StopLatencyTransition(const daw_audio_core_handle handle) noexcept {
  Core *core = to_core(handle);
  if (core == nullptr) return;
  core->latency_shrunk_revision = core->published_revision;
  core->latency_budget.store(core->published_graph->minimum_latency, std::memory_order_release);
  core->transport_running.store(false, std::memory_order_release);
  core->latency_completed_revision.store(core->published_revision, std::memory_order_release);
}

bool daw::audio_core::ValidateInstrumentState(
  const daw_audio_core_handle handle, const uint64_t node_id,
  const daw_audio_synth_state& state) noexcept {
  auto* core = to_core(handle);
  return core != nullptr && configuration_instrument_matches(*core, node_id, DAW_AUDIO_INSTRUMENT_KIND_SYNTH)
    && valid_synth_state(state);
}

bool daw::audio_core::ValidateInstrumentState(
  const daw_audio_core_handle handle, const uint64_t node_id, const uint32_t kind,
  const daw_audio_sampler_state& state, const std::span<const daw_audio_sample_zone> zones) noexcept {
  auto* core = to_core(handle);
  if (core == nullptr || (kind != DAW_AUDIO_INSTRUMENT_KIND_SAMPLER && kind != DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK)
    || !configuration_instrument_matches(*core, node_id, kind)
    || !valid_sampler_state(state) || zones.size() != state.zone_count) return false;
  for (const auto& zone : zones) {
    if (!valid_sample_zone(*core, zone)
      || (kind == DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK
        && (zone.key_low != zone.key_high || zone.round_robin_group != 0))) return false;
  }
  return true;
}

bool daw::audio_core::ValidateInstrumentState(
  const daw_audio_core_handle handle, const uint64_t node_id,
  const daw_audio_granular_state& state) noexcept {
  auto* core = to_core(handle);
  return core != nullptr && configuration_instrument_matches(*core, node_id, DAW_AUDIO_INSTRUMENT_KIND_GRANULAR)
    && valid_granular_state(*core, state);
}

daw_audio_core_result daw::audio_core::RegisterNativeGraphHook(
  const daw_audio_core_handle core_handle,
  const NativeGraphHookRegistration& registration
) noexcept {
  Core *core = to_core(core_handle);
  if (core == nullptr || registration.graph_revision == 0
    || (registration.hook == nullptr && (registration.observer == nullptr || !registration.bindings.empty()))
    || registration.bindings.size() > kMaximumLiveNodes
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
  std::array<std::array<NativeGraphHookBinding, DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE>, kMaximumLiveNodes> node_bindings{};
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
    // External stages are placed among the plan's own processors. Fading ghosts
    // are not part of that numbering; they are put back after their anchors below.
    std::array<NativeGraphStage, kMaximumNativeGraphStagesPerNode> ordinary_stages{};
    std::array<NativeGraphStage, kMaximumNativeGraphStagesPerNode> ghost_stages{};
    std::uint32_t ordinary_count = 0;
    std::uint32_t ghost_count = 0;
    for (std::uint32_t stage_index = 0; stage_index < next.stage_counts[node_index]; ++stage_index) {
      const NativeGraphStage &stage = next.stages[node_index][stage_index];
      if ((*core->prepared_graph).processors[stage.processor_index].ghost) ghost_stages[ghost_count++] = stage;
      else ordinary_stages[ordinary_count++] = stage;
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
    std::uint32_t total_count = final_count;
    for (std::uint32_t ghost_index = 0; ghost_index < ghost_count; ++ghost_index) {
      const int32_t anchor = (*core->prepared_graph).processors[ghost_stages[ghost_index].processor_index].chain_anchor;
      std::uint32_t position = 0;
      if (anchor >= 0) {
        while (position < total_count && !(rebuilt[position].kind == NativeGraphStageKind::kBuiltIn
          && rebuilt[position].processor_index == anchor)) ++position;
        if (position == total_count) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
        ++position;
      }
      if (total_count >= kMaximumNativeGraphStagesPerNode) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
      for (std::uint32_t end = total_count++; end > position; --end) rebuilt[end] = rebuilt[end - 1];
      rebuilt[position] = ghost_stages[ghost_index];
    }
    next.stages[node_index] = rebuilt;
    next.stage_counts[node_index] = total_count;
  }
  *core->prepared_native_hooks = next;
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
  std::array<daw_audio_graph_node_descriptor, kMaximumLiveNodes> nodes{};
  std::array<daw_audio_graph_edge_descriptor, kMaximumLiveEdges> edges{};
  std::array<daw_audio_processor_descriptor, kMaximumLiveProcessors> processors{};
  std::array<std::array<uint32_t, DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS>, kMaximumLiveProcessors> targets{};
  std::array<std::array<uint8_t, DAW_AUDIO_CORE_MAX_PROCESSOR_STATE_BYTES>, kMaximumLiveProcessors> states{};
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

// The synth and sampler states are packed 4-byte words, so a byte compare is a value compare. A sample zone and the granular
// state open with a 64-bit handle that sits on an 8-byte boundary: they carry padding that the caller leaves as its heap held
// it, so they compare by field.
static_assert(sizeof(daw_audio_synth_state) == 156 && sizeof(daw_audio_sampler_state) == 88);

bool same_zone(const daw_audio_sample_zone &left, const daw_audio_sample_zone &right) {
  return left.asset == right.asset && left.key_low == right.key_low && left.key_high == right.key_high
    && left.velocity_low == right.velocity_low && left.velocity_high == right.velocity_high
    && left.root_note == right.root_note && left.tune_cents == right.tune_cents && left.gain == right.gain
    && left.pan == right.pan && left.round_robin_group == right.round_robin_group
    && left.round_robin_index == right.round_robin_index && left.playback_mode == right.playback_mode
    && left.start_frame == right.start_frame && left.end_frame == right.end_frame
    && left.loop_start_frame == right.loop_start_frame && left.loop_end_frame == right.loop_end_frame
    && left.crossfade_frame_count == right.crossfade_frame_count && left.choke_group == right.choke_group;
}

bool same_granular(const daw_audio_granular_state &left, const daw_audio_granular_state &right) {
  return left.version == right.version && left.asset == right.asset && left.seed == right.seed
    && left.max_grains == right.max_grains && left.window_shape == right.window_shape && left.freeze == right.freeze
    && left.grain_size_ms == right.grain_size_ms && left.density_hz == right.density_hz && left.position == right.position
    && left.spray == right.spray && left.pitch_semitones == right.pitch_semitones
    && left.reverse_probability == right.reverse_probability && left.stereo_spread == right.stereo_spread;
}

bool same_zones(const InstrumentConfiguration &left, const InstrumentConfiguration &right) {
  return std::equal(left.zones.begin(), left.zones.end(), right.zones.begin(), same_zone);
}

bool same_instrument_configuration(
  const daw_audio_graph_node_descriptor &current_node,
  const daw_audio_graph_node_descriptor &next_node,
  const InstrumentConfiguration &current,
  const InstrumentConfiguration &next) {
  if (current_node.instrument.kind != next_node.instrument.kind
    || current_node.instrument.version != next_node.instrument.version
    || current_node.instrument.voice_capacity != next_node.instrument.voice_capacity
    || current_node.instrument.parameter_count != next_node.instrument.parameter_count) return false;
  for (uint32_t index = 0; index < DAW_AUDIO_CORE_MAX_INSTRUMENT_PARAMETERS; ++index) {
    if (current_node.instrument.parameter_targets[index] != next_node.instrument.parameter_targets[index]) return false;
  }
  const InstrumentConfiguration before = discrete_part(current);
  const InstrumentConfiguration after = discrete_part(next);
  switch (next_node.instrument.kind) {
    case DAW_AUDIO_INSTRUMENT_KIND_SYNTH:
      return std::memcmp(&before.synth, &after.synth, sizeof(before.synth)) == 0;
    case DAW_AUDIO_INSTRUMENT_KIND_SAMPLER:
    case DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK:
      return std::memcmp(&before.sampler, &after.sampler, sizeof(before.sampler)) == 0
        && same_zones(before, after);
    case DAW_AUDIO_INSTRUMENT_KIND_GRANULAR:
      return same_granular(before.granular, after.granular);
    default:
      return true;
  }
}

// Whether a processor's slot (history, tails, live overrides) can serve the next
// plan's processor. Bypass is a parameter, not a structure: it is applied by the
// renderer, which ramps it where the DSP defines a ramp, so toggling it never
// replaces the slot.
bool compatible_processor_history(
  const GraphRevision::Processor &current,
  const GraphRevision::Processor &next) {
  if (current.instance_id != next.instance_id
    || current.kind != next.kind
    || current.state_version != next.state_version
    || current.state_size != next.state_size
    || current.input_layout != next.input_layout
    || current.output_layout != next.output_layout) return false;
  switch (next.kind) {
    case DAW_AUDIO_PROCESSOR_KIND_UTILITY:
      return current.utility.dc_block == next.utility.dc_block
        && current.utility.input_mode == next.utility.input_mode
        && current.utility.matrix == next.utility.matrix
        && current.utility.swap == next.utility.swap;
    case DAW_AUDIO_PROCESSOR_KIND_SATURATOR:
      return current.saturator.curve == next.saturator.curve
        && current.saturator.color == next.saturator.color
        && same_float(current.saturator.color_frequency_hz, next.saturator.color_frequency_hz);
    case DAW_AUDIO_PROCESSOR_KIND_EQ:
      if (current.eq.mono != next.eq.mono) return false;
      for (uint32_t band = 0; band < 8; ++band) {
        if (current.eq.bands[band].enabled != next.eq.bands[band].enabled
          || current.eq.bands[band].type != next.eq.bands[band].type) return false;
      }
      return true;
    case DAW_AUDIO_PROCESSOR_KIND_GATE:
      return current.gate.mode == next.gate.mode
        && current.gate.detector == next.gate.detector
        && current.gate.sidechain_enabled == next.gate.sidechain_enabled
        && same_float(current.gate.lookahead_ms, next.gate.lookahead_ms)
        && same_float(current.gate.sidechain_frequency_hz, next.gate.sidechain_frequency_hz)
        && same_float(current.gate.sidechain_q, next.gate.sidechain_q);
    case DAW_AUDIO_PROCESSOR_KIND_COMPRESSOR:
      return current.compressor.auto_release == next.compressor.auto_release
        && current.compressor.detector_mode == next.compressor.detector_mode
        && current.compressor.dynamics_mode == next.compressor.dynamics_mode
        && current.compressor.envelope_curve == next.compressor.envelope_curve
        && current.compressor.sidechain_enabled == next.compressor.sidechain_enabled
        && current.compressor.sidechain_filter_type == next.compressor.sidechain_filter_type
        && same_float(current.compressor.lookahead_ms, next.compressor.lookahead_ms)
        && same_float(current.compressor.sidechain_frequency_hz, next.compressor.sidechain_frequency_hz)
        && same_float(current.compressor.sidechain_q, next.compressor.sidechain_q);
    case DAW_AUDIO_PROCESSOR_KIND_LIMITER:
      return current.limiter.detector_oversampling == next.limiter.detector_oversampling
        && same_float(current.limiter.lookahead_ms, next.limiter.lookahead_ms);
    case DAW_AUDIO_PROCESSOR_KIND_SPECTRAL:
      return current.spectral.fft_size == next.spectral.fft_size
        && current.spectral.overlap == next.spectral.overlap;
    case DAW_AUDIO_PROCESSOR_KIND_AUTOFILTER:
      return current.autofilter.mode == next.autofilter.mode
        && current.autofilter.quality == next.autofilter.quality;
    case DAW_AUDIO_PROCESSOR_KIND_LOFI:
      return current.lofi.bit_depth == next.lofi.bit_depth
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

struct ProcessorContinuityMap {
  std::array<int32_t, kMaximumLiveProcessors> previous{};
  std::array<int32_t, kMaximumLiveProcessors> next{};
};

// Preparation only: immutable instance IDs, no reads of callback-owned
// parameters or DSP histories. Fixed storage also bounds preparation memory.
// A portable core cannot bridge a live FFT-size change: the retained stage-input
// history that does it is native-sized (kSpectralInputFrames). The stage is replaced
// instead, as a removal plus an insertion: the old one fades out as a ghost and the
// new one starts fresh. Native keeps the spectral history across sizes.
bool replaced_by_spectral_size_change(
  const GraphRevision::Processor &current, const GraphRevision::Processor &next) {
#if !defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  return current.kind == DAW_AUDIO_PROCESSOR_KIND_SPECTRAL && next.kind == DAW_AUDIO_PROCESSOR_KIND_SPECTRAL
    && current.spectral.fft_size != next.spectral.fft_size;
#else
  (void)current;
  (void)next;
  return false;
#endif
}

ProcessorContinuityMap build_processor_continuity_map(
  const GraphRevision &current, const GraphRevision &next) {
  ProcessorContinuityMap map{};
  map.previous.fill(-1);
  map.next.fill(-1);
  std::array<uint16_t, kMaximumLiveProcessors> current_order{};
  std::array<uint16_t, kMaximumLiveProcessors> next_order{};
  for (uint32_t index = 0; index < current.processor_count; ++index)
    current_order[index] = static_cast<uint16_t>(index);
  for (uint32_t index = 0; index < next.processor_count; ++index)
    next_order[index] = static_cast<uint16_t>(index);
  std::sort(current_order.begin(), current_order.begin() + current.processor_count,
    [&](uint16_t left, uint16_t right) {
      return current.processors[left].instance_id < current.processors[right].instance_id;
    });
  std::sort(next_order.begin(), next_order.begin() + next.processor_count,
    [&](uint16_t left, uint16_t right) {
      return next.processors[left].instance_id < next.processors[right].instance_id;
    });
  uint32_t old_position = 0;
  uint32_t new_position = 0;
  while (old_position < current.processor_count && new_position < next.processor_count) {
    const auto old_index = current_order[old_position];
    const auto new_index = next_order[new_position];
    const uint64_t old_id = current.processors[old_index].instance_id;
    const uint64_t new_id = next.processors[new_index].instance_id;
    if (old_id < new_id) ++old_position;
    else if (new_id < old_id) ++new_position;
    else {
      if (!replaced_by_spectral_size_change(current.processors[old_index], next.processors[new_index])) {
        map.previous[new_index] = old_index;
        map.next[old_index] = new_index;
      }
      ++old_position;
      ++new_position;
    }
  }
  return map;
}

void initialize_processor_slot(Core &core, uint32_t slot) {
  core.utility_histories[slot] = {};
  core.saturator_histories[slot] = {};
  core.eq_histories[slot] = {};
  core.dynamics_histories[slot] = {};
  core.modulation_histories[slot] = {};
  core.autofilter_histories[slot] = {};
  core.lofi_histories[slot] = {};
  core.processor_overrides[slot].count = 0;
}

// Everything the callback writes into a node slot besides the instrument voices
// (which assign_prepared_node resets, along with the configuration, when it hands
// the slot out): the reorder dip, the layout folds, the fader's latched values and
// ramp, and the instruments that were fading out beside this node's. A slot that
// left a plan carries none of it into the next node that takes it.
void initialize_node_slot(Core &core, uint32_t slot) {
  end_node_blend(core, core.node_blends[slot]);
  Core::NodeBlend &blend = core.node_blends[slot];
  blend.partner_generation = 0;
  blend.descriptor = {};
  core.node_dips[slot] = {};
  core.node_folds[slot] = {};
  core.mixer_latches[slot] = {};
  core.mixer_ramps[slot] = {};
}

// Delay, reverb and spectral histories live in small pools that follow the
// lifecycle of the processor slot that owns them.
void free_processor_slot_histories(Core &core, uint32_t slot) {
  for (uint32_t &owner : core.delay_slot_owners) if (owner == slot + 1) owner = 0;
  for (uint32_t &owner : core.reverb_slot_owners) if (owner == slot + 1) owner = 0;
  for (uint32_t &owner : core.spectral_slot_owners) if (owner == slot + 1) owner = 0;
}

// Control thread only. A retired slot is reusable once the render epoch it
// retired in has completed; the generation moves on before anything can name it again.
void reclaim_retired_slots(Core &core) {
  const uint64_t completed = core.render_epoch.load(std::memory_order_acquire);
  const auto reclaimable = [completed](const RuntimeSlot &slot) {
    return slot.state.load(std::memory_order_acquire) == kSlotRetired
      && completed >= slot.retired_epoch.load(std::memory_order_relaxed);
  };
  const auto free_slot = [&core](RuntimeSlot &slot) {
    slot.generation.fetch_add(1, std::memory_order_relaxed);
    slot.state.store(kSlotFree, std::memory_order_relaxed);
    slot.fade_elapsed.store(0, std::memory_order_relaxed);
    ++core.reclaimed_slots;
  };
  for (uint32_t index = 0; index < kProcessorRuntimeSlots; ++index) {
    RuntimeSlot &slot = core.processor_slots[index];
    if (!reclaimable(slot)) continue;
    free_slot(slot);
    free_processor_slot_histories(core, index);
    initialize_processor_slot(core, index);
    slot.state.store(kSlotInitialized, std::memory_order_release);
  }
  for (uint32_t index = 0; index < kNodeRuntimeSlots; ++index) {
    RuntimeSlot &slot = core.node_slots[index];
    if (!reclaimable(slot)) continue;
    free_slot(slot);
    initialize_node_slot(core, index);
    slot.state.store(kSlotInitialized, std::memory_order_release);
  }
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

int32_t acquire_history_owner(std::array<uint32_t, DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE> &owners, uint32_t slot) {
  for (uint32_t index = 0; index < owners.size(); ++index) {
    if (owners[index] == 0) {
      owners[index] = slot + 1;
      return static_cast<int32_t>(index);
    }
  }
  return -1;
}

// Rollback of an unpublished plan: its fresh slots go back, untouched, to initialized.
// Slots the plan shares with the published plan (or ghosts) are active and stay put.
void release_prepared_runtime(Core &core) {
  if (!core.prepared_runtime_held) return;
  const GraphRevision &plan = *core.prepared_graph;
  for (uint32_t index = 0; index < plan.processor_count; ++index) {
    const auto &processor = plan.processors[index];
    RuntimeSlot &slot = core.processor_slots[processor.history_slot];
    if (slot.state.load(std::memory_order_relaxed) != kSlotPrepared
      || slot.generation.load(std::memory_order_relaxed) != processor.generation) continue;
    free_processor_slot_histories(core, processor.history_slot);
    slot.state.store(kSlotInitialized, std::memory_order_release);
  }
  for (uint32_t index = 0; index < plan.total_node_count(); ++index) {
    RuntimeSlot &slot = core.node_slots[plan.node_slots[index]];
    if (slot.state.load(std::memory_order_relaxed) == kSlotPrepared
      && slot.generation.load(std::memory_order_relaxed) == plan.node_generations[index]) {
      slot.state.store(kSlotInitialized, std::memory_order_release);
    }
  }
  core.prepared_runtime_held = false;
}

// The fixed number of frames a deleted entry needs to reach silence.
uint32_t deletion_fade_frames(uint32_t sample_rate_hz) {
  return std::max<uint32_t>(1, static_cast<uint32_t>((static_cast<uint64_t>(sample_rate_hz) * 5u + 500u) / 1000u));
}

// Entries the new plan drops are kept as ghosts so they can fade out instead of
// being cut. A deleted node only needs to survive if it still feeds something
// that remains. A ghost is built only from what the published plan fixed at
// prepare time; the callback-owned parameter overrides stay in the runtime slot
// the ghost shares. Running out of transition capacity, a deletion that has no dry
// path to fade to, and fading entries that would form a cycle are failed prepares
// (CAPACITY_EXCEEDED, GRAPH_COMPATIBILITY_REJECTED): none of them ever produces a
// plan that cuts a deletion or resets what the edit did not touch. A deletion that
// changes latency moves the read heads (prepare_latency_heads), as on every host.
daw_audio_core_result append_deletion_ghosts(
  Core &core, const GraphRevision &current, GraphRevision &next,
  const ProcessorContinuityMap &processors) {
  const uint32_t old_nodes = current.total_node_count();
  std::array<int32_t, kMaximumGraphNodes> node_to_next{};
  std::array<bool, kMaximumGraphNodes> absent{};
  std::array<bool, kMaximumGraphNodes> needed{};
  node_to_next.fill(-1);
  for (uint32_t index = 0; index < old_nodes; ++index) {
    if (index < current.node_count) {
      node_to_next[index] = graph_node_index(next, current.nodes[index].id);
      absent[index] = node_to_next[index] < 0;
    } else {
      // A same-ID live node is a different incarnation. Keep the old ghost's
      // slot/generation and its routes until its callback-owned fade completes.
      absent[index] = core.node_slots[current.node_slots[index]].state.load(std::memory_order_acquire) == kSlotActive;
    }
  }
  std::array<uint32_t, kMaximumGraphNodes> position{};
  for (uint32_t order = 0; order < old_nodes; ++order) position[current.process_order[order]] = order;
  std::array<uint16_t, kMaximumGraphEdges> by_source{};
  const uint32_t old_edges = current.total_edge_count();
  for (uint32_t index = 0; index < old_edges; ++index) by_source[index] = static_cast<uint16_t>(index);
  std::sort(by_source.begin(), by_source.begin() + old_edges, [&](uint16_t left, uint16_t right) {
    return position[current.edge_source_indices[left]] > position[current.edge_source_indices[right]];
  });
  // A fading processor still being controlled by a key keeps its source alive too;
  // a key whose processor already finished fading is not worth a transition node.
  const auto controlled_processor_alive = [&](uint32_t edge_index) {
    if (current.edges[edge_index].sidechain == 0) return true;
    const uint32_t target = current.edge_target_processors[edge_index];
    return target < current.processor_count
      || core.processor_slots[current.processors[target].history_slot].state.load(std::memory_order_acquire) == kSlotActive;
  };
  for (uint32_t order = 0; order < old_edges; ++order) {
    const uint32_t index = by_source[order];
    const uint32_t from = current.edge_source_indices[index];
    const uint32_t to = current.edge_target_indices[index];
    if (absent[from] && controlled_processor_alive(index)
      && (node_to_next[to] >= 0 || (absent[to] && needed[to]))) needed[from] = true;
  }
  const auto same_route = [](const daw_audio_graph_edge_descriptor &left, const daw_audio_graph_edge_descriptor &right) {
    return left.from_node_id == right.from_node_id && left.to_node_id == right.to_node_id
      && left.sidechain == right.sidechain
      && (left.sidechain != 0 ? left.target_processor_id == right.target_processor_id : left.tap == right.tap);
  };
  // A route that joined against a fading node is still joining when the next edit
  // arrives before that fade is over: the node outlives the edit, and the route (or
  // the fading copy of it) keeps the join it had.
  for (uint32_t edge = 0; edge < old_edges; ++edge) {
    const uint32_t join = current.edge_join_nodes[edge];
    if (join != 0 && absent[join - 1]) needed[join - 1] = true;
  }
  uint32_t ghost_nodes = 0;
  for (uint32_t index = 0; index < old_nodes; ++index) {
    if (!absent[index] || !needed[index]) continue;
    if (ghost_nodes >= kMaximumGhostNodes) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    const uint32_t ghost_index = next.node_count + ghost_nodes++;
    node_to_next[index] = static_cast<int32_t>(ghost_index);
    next.nodes[ghost_index] = current.nodes[index];
    next.node_slots[ghost_index] = current.node_slots[index];
    next.node_generations[ghost_index] = current.node_generations[index];
    next.tap_history_slots[ghost_index] = current.tap_history_slots[index];
  }
  const auto inherit_join = [&](uint32_t edge, uint32_t old) {
    const uint32_t join = current.edge_join_nodes[old];
    if (join != 0 && node_to_next[join - 1] >= static_cast<int32_t>(next.node_count)) {
      next.edge_join_nodes[edge] = static_cast<uint16_t>(node_to_next[join - 1] + 1);
    }
  };
  uint32_t ghost_edges = 0;
  const auto inherit_reader = [&](uint32_t edge, uint32_t old) {
    const uint32_t delay = core.latency_budget.load(std::memory_order_acquire) == current.latency_budget
      ? current.read_heads[old].delay : current.read_heads[old].stopped_delay;
    next.edges[edge].pdc_delay_frames = delay;
    next.read_heads[edge] = {.previous_delay = delay, .delay = delay, .stopped_delay = delay};
  };
  for (uint32_t order = 0; order < old_edges; ++order) {
    const uint32_t index = by_source[order];
    if (current.edges[index].sidechain != 0) continue;
    const int32_t from = node_to_next[current.edge_source_indices[index]];
    const int32_t to = node_to_next[current.edge_target_indices[index]];
    const bool from_ghost = from >= static_cast<int32_t>(next.node_count);
    const bool to_ghost = to >= static_cast<int32_t>(next.node_count);
    if (from < 0 || to < 0 || !(from_ghost || to_ghost)) continue;
    if (ghost_edges >= kMaximumGhostEdges) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    const uint32_t ghost_index = next.edge_count + ghost_edges++;
    next.edges[ghost_index] = current.edges[index];
    next.edge_previous[ghost_index] = static_cast<uint16_t>(index + 1u);
    inherit_reader(ghost_index, index);
    next.edge_source_indices[ghost_index] = static_cast<uint16_t>(from);
    next.edge_target_indices[ghost_index] = static_cast<uint16_t>(to);
    inherit_join(ghost_index, index);
  }
  std::array<uint32_t, kMaximumGraphNodes> chain_lengths{};
  for (uint32_t index = 0; index < next.processor_count; ++index) ++chain_lengths[next.processors[index].node_index];
  // Where each processor of the published plan stands in this one, -1 when it is gone.
  std::array<int32_t, kMaximumGraphProcessors> processor_to_next{};
  processor_to_next.fill(-1);
  uint32_t ghost_processors = 0;
  // Walk each old chain in order so a ghost can name the processor it followed.
  for (uint32_t old_node = 0; old_node < old_nodes; ++old_node) {
    const int32_t node = node_to_next[old_node];
    if (node < 0) continue;
    const GraphRevision::Range chain = current.processor_ranges[old_node];
    int32_t anchor = -1;
    for (uint32_t link = chain.start; link < static_cast<uint32_t>(chain.start) + chain.count; ++link) {
      const uint32_t index = current.processor_indices[link];
      const auto &old = current.processors[index];
      if (index < current.processor_count) {
        const int32_t kept = processors.next[index];
        if (kept >= 0 && next.processors[static_cast<uint32_t>(kept)].kind == old.kind) {
          processor_to_next[index] = kept;
          if (next.processors[static_cast<uint32_t>(kept)].node_index == node) anchor = kept;
          continue;
        }
      } else if (core.processor_slots[old.history_slot].state.load(std::memory_order_acquire) != kSlotActive) {
        continue;
      }
      // A survivor's crossfade back to the dry signal needs a stage that neither
      // delays nor changes layout; otherwise the deletion cannot be faded.
      if (node < static_cast<int32_t>(next.node_count)) {
        if (old.input_layout != old.output_layout
          || old.input_layout != next.nodes[static_cast<uint32_t>(node)].output_layout) {
          return DAW_AUDIO_CORE_GRAPH_COMPATIBILITY_REJECTED;
        }
      }
      if (ghost_processors >= kMaximumGhostProcessors
        || ++chain_lengths[static_cast<uint32_t>(node)] > DAW_AUDIO_CORE_MAX_PROCESSORS_PER_NODE * 2u) {
        return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
      }
      const int32_t ghost_index = static_cast<int32_t>(next.processor_count + ghost_processors++);
      auto &ghost = next.processors[static_cast<uint32_t>(ghost_index)];
      ghost = old;
      ghost.ghost = true;
      // A stage already fading on its own clock keeps it when its node is deleted
      // too; the node's envelope then multiplies the rest of that fade.
      ghost.detached = old.detached || node < static_cast<int32_t>(next.node_count);
      ghost.node_index = static_cast<uint16_t>(node);
      ghost.node_id = next.nodes[static_cast<uint32_t>(node)].id;
      ghost.control_slot = static_cast<uint32_t>(ghost_index);
      ghost.chain_anchor = anchor;
      processor_to_next[index] = ghost_index;
      anchor = ghost_index;
    }
  }
  for (uint32_t index = 0; index < current.total_processor_count(); ++index) {
    next.processor_remap[index] = static_cast<int16_t>(processor_to_next[index]);
  }
  // A key keeps feeding a processor that fades, and a key that fades keeps feeding
  // the processor it controlled; an edge between two surviving entries is the
  // request's own business.
  for (uint32_t index = 0; index < old_edges; ++index) {
    if (current.edges[index].sidechain == 0) continue;
    const int32_t from = node_to_next[current.edge_source_indices[index]];
    const int32_t to = node_to_next[current.edge_target_indices[index]];
    const int32_t target = processor_to_next[current.edge_target_processors[index]];
    if (from < 0 || to < 0 || target < 0) continue;
    if (from < static_cast<int32_t>(next.node_count) && target < static_cast<int32_t>(next.processor_count)) continue;
    if (ghost_edges >= kMaximumGhostEdges) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    const uint32_t ghost_index = next.edge_count + ghost_edges++;
    next.edges[ghost_index] = current.edges[index];
    next.edge_previous[ghost_index] = static_cast<uint16_t>(index + 1u);
    inherit_reader(ghost_index, index);
    next.edge_source_indices[ghost_index] = static_cast<uint16_t>(from);
    next.edge_target_indices[ghost_index] = static_cast<uint16_t>(to);
    next.edge_target_processors[ghost_index] = static_cast<uint16_t>(target);
    inherit_join(ghost_index, index);
  }
  // Routes between surviving nodes are not cut or started either. A deleted one
  // keeps carrying its signal through a transition node that fades out; a new one
  // from a source that already sounds enters against the fade-out of the deleted
  // node it replaces (ungrouping), or else against a fade-in clock. Either way the
  // routes involved never sum to more than one route's worth.
  const auto transition_node = [&](uint32_t layout) -> int32_t {
    if (ghost_nodes >= kMaximumGhostNodes) return -1;
    const int32_t slot = acquire_runtime_slot(core.node_slots);
    if (slot < 0) return -1;
    core.prepared_runtime_held = true;
    const uint32_t index = next.node_count + ghost_nodes++;
    next.ghost_node_count = ghost_nodes;
    next.nodes[index] = {};
    next.nodes[index].id = kTransitionNodeId | index;
    next.nodes[index].kind = DAW_AUDIO_GRAPH_NODE_MIXER;
    next.nodes[index].input_layout = layout;
    next.nodes[index].output_layout = layout;
    next.node_slots[index] = static_cast<uint16_t>(slot);
    next.node_generations[index] = core.node_slots[static_cast<uint32_t>(slot)].generation.load(std::memory_order_relaxed);
    return static_cast<int32_t>(index);
  };
  for (uint32_t index = 0; index < current.edge_count; ++index) {
    const daw_audio_graph_edge_descriptor &old = current.edges[index];
    const int32_t from = node_to_next[current.edge_source_indices[index]];
    const int32_t to = node_to_next[current.edge_target_indices[index]];
    if (from < 0 || to < 0 || from >= static_cast<int32_t>(next.node_count)
      || to >= static_cast<int32_t>(next.node_count)) continue;
    const int32_t target = old.sidechain != 0 ? processor_to_next[current.edge_target_processors[index]] : -1;
    if (old.sidechain != 0 && (target < 0 || target >= static_cast<int32_t>(next.processor_count))) continue;
    bool kept = false;
    for (uint32_t other = 0; other < next.edge_count && !kept; ++other) kept = same_route(old, next.edges[other]);
    if (kept) continue;
    const int32_t carrier = transition_node(next.nodes[static_cast<uint32_t>(from)].output_layout);
    if (carrier < 0 || ghost_edges + 2 > kMaximumGhostEdges) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    const uint64_t carrier_id = next.nodes[static_cast<uint32_t>(carrier)].id;
    const uint32_t entering = next.edge_count + ghost_edges++;
    next.edges[entering] = {};
    next.edges[entering].id = old.id;
    next.edges[entering].from_node_id = old.from_node_id;
    next.edges[entering].to_node_id = carrier_id;
    next.edges[entering].gain = old.gain;
    next.edges[entering].tap = old.tap;
    next.edge_previous[entering] = static_cast<uint16_t>(index + 1u);
    inherit_reader(entering, index);
    next.edge_source_indices[entering] = static_cast<uint16_t>(from);
    next.edge_target_indices[entering] = static_cast<uint16_t>(carrier);
    const uint32_t leaving = next.edge_count + ghost_edges++;
    next.edges[leaving] = {};
    next.edges[leaving].id = old.id;
    next.edges[leaving].from_node_id = carrier_id;
    next.edges[leaving].to_node_id = old.to_node_id;
    next.edges[leaving].target_processor_id = old.target_processor_id;
    next.edges[leaving].gain = 1.0F;
    next.edges[leaving].tap = DAW_AUDIO_GRAPH_EDGE_POST_FADER;
    next.edges[leaving].sidechain = old.sidechain;
    next.edge_source_indices[leaving] = static_cast<uint16_t>(carrier);
    next.edge_target_indices[leaving] = static_cast<uint16_t>(to);
    if (old.sidechain != 0) next.edge_target_processors[leaving] = static_cast<uint16_t>(target);
  }
  int32_t clock = -1;
  for (uint32_t edge = 0; edge < next.edge_count; ++edge) {
    const daw_audio_graph_edge_descriptor &added = next.edges[edge];
    int32_t existing = -1;
    for (uint32_t old = 0; old < current.edge_count && existing < 0; ++old) {
      if (same_route(current.edges[old], added)) existing = static_cast<int32_t>(old);
    }
    if (existing >= 0) next.edge_previous[edge] = static_cast<uint16_t>(existing + 1);
    const int32_t source = graph_node_index(current, added.from_node_id);
    if (added.pdc_delay_frames != 0 || source < 0) continue;
    if (existing >= 0) {
      inherit_join(edge, static_cast<uint32_t>(existing));
      continue;
    }
    std::array<bool, kMaximumGraphNodes> seen{};
    std::array<uint16_t, kMaximumGraphNodes> queue{};
    uint32_t head = 0;
    uint32_t tail = 0;
    queue[tail++] = static_cast<uint16_t>(source);
    for (; head < tail && added.sidechain == 0 && next.edge_join_nodes[edge] == 0; ++head) {
      for (uint32_t old = 0; old < old_edges && next.edge_join_nodes[edge] == 0; ++old) {
        const uint32_t target = current.edge_target_indices[old];
        if (current.edges[old].sidechain != 0 || current.edge_source_indices[old] != queue[head]
          || target >= current.node_count || !absent[target] || seen[target]) continue;
        seen[target] = true;
        if (node_to_next[target] >= static_cast<int32_t>(next.node_count)) {
          next.edge_join_nodes[edge] = static_cast<uint16_t>(node_to_next[target] + 1);
        } else {
          queue[tail++] = static_cast<uint16_t>(target);
        }
      }
    }
    if (next.edge_join_nodes[edge] != 0) continue;
    if (clock < 0) clock = transition_node(DAW_AUDIO_GRAPH_LAYOUT_STEREO);
    if (clock < 0) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    next.edge_join_nodes[edge] = static_cast<uint16_t>(clock + 1);
  }
  next.ghost_node_count = ghost_nodes;
  next.ghost_edge_count = ghost_edges;
  next.ghost_processor_count = ghost_processors;
  if (order_graph_nodes(next)) return DAW_AUDIO_CORE_OK;
  for (uint32_t index = next.node_count; index < next.total_node_count(); ++index) {
    RuntimeSlot &slot = core.node_slots[next.node_slots[index]];
    if (slot.state.load(std::memory_order_relaxed) == kSlotPrepared) slot.state.store(kSlotInitialized, std::memory_order_release);
  }
  next.ghost_node_count = 0;
  next.ghost_edge_count = 0;
  next.ghost_processor_count = 0;
  order_graph_nodes(next);
  return DAW_AUDIO_CORE_GRAPH_COMPATIBILITY_REJECTED;
}

// Plans name slots that the previous plan owned: those it neither keeps nor
// fades out are retired by publish. Computed here so publish stays an integer loop.
void collect_released_slots(Core &core) {
  const GraphRevision &current = *core.published_graph;
  GraphRevision &next = *core.prepared_graph;
  std::array<bool, kProcessorRuntimeSlots> processor_kept{};
  std::array<bool, kNodeRuntimeSlots> node_kept{};
  for (uint32_t index = 0; index < next.total_processor_count(); ++index) {
    processor_kept[next.processors[index].history_slot] = true;
  }
  for (uint32_t index = 0; index < next.spectral_predecessor_count; ++index)
    processor_kept[next.spectral_predecessors[index].history_slot] = true;
  for (uint32_t index = 0; index < next.total_node_count(); ++index) node_kept[next.node_slots[index]] = true;
  // A replaced instrument's slot stays active beside its replacement; the node
  // retires it itself once the fade has run.
  for (uint32_t index = 0; index < next.node_count; ++index) {
    if (next.node_replaces[index] != 0) node_kept[current.node_slots[next.node_replaces[index] - 1u]] = true;
  }
  next.released_processor_count = 0;
  next.released_node_count = 0;
  for (uint32_t index = 0; index < current.spectral_predecessor_count; ++index) {
    const auto &processor = current.spectral_predecessors[index];
    if (!processor_kept[processor.history_slot])
      next.released_processors[next.released_processor_count++] = {
        static_cast<uint16_t>(processor.history_slot), processor.generation};
  }
  for (uint32_t index = 0; index < current.total_processor_count(); ++index) {
    const auto &processor = current.processors[index];
    if (!processor_kept[processor.history_slot]) {
      next.released_processors[next.released_processor_count++] = {
        static_cast<uint16_t>(processor.history_slot), processor.generation};
    }
  }
  for (uint32_t index = 0; index < current.total_node_count(); ++index) {
    if (!node_kept[current.node_slots[index]]) {
      next.released_nodes[next.released_node_count++] = {current.node_slots[index], current.node_generations[index]};
    }
  }
}

// A node keeps its slot (and so its voices and live overrides) only when the
// latency verdict was accepted and, for instruments, the configuration is
// unchanged. A node whose own configuration changed gets a fresh slot initialized
// from the prepared configuration; no other node is touched.
// Returns false when no node slot is free.
bool assign_prepared_node(Core &core, uint32_t index) {
  GraphRevision &next = *core.prepared_graph;
  const GraphRevision &current = *core.published_graph;
  RuntimeSlot &previous_slot = core.node_slots[next.node_slots[index]];
  if (previous_slot.state.load(std::memory_order_relaxed) == kSlotPrepared
    && previous_slot.generation.load(std::memory_order_relaxed) == next.node_generations[index]) {
    previous_slot.state.store(kSlotInitialized, std::memory_order_release);
  }
  const auto &node = next.nodes[index];
  const int32_t previous = current.revision == 0 ? -1 : graph_node_index(current, node.id);
  const bool retained = core.prepared_continuity == ContinuityPreparationResult::kAccepted && previous >= 0
    && current.nodes[static_cast<uint32_t>(previous)].kind == node.kind
    && (node.kind != DAW_AUDIO_GRAPH_NODE_INSTRUMENT
      || (core.prepared_instrument_previous_nodes[index] == previous
        && same_instrument_configuration(
          current.nodes[static_cast<uint32_t>(previous)], node,
          (*core.published_instrument_configs)[static_cast<uint32_t>(previous)],
          (*core.prepared_instrument_configs)[index])));
  if (retained) {
    next.node_slots[index] = current.node_slots[static_cast<uint32_t>(previous)];
    next.node_generations[index] = current.node_generations[static_cast<uint32_t>(previous)];
    return true;
  }
  const int32_t slot_index = acquire_runtime_slot(core.node_slots);
  if (slot_index < 0) return false;
  core.prepared_runtime_held = true;
  next.node_slots[index] = static_cast<uint16_t>(slot_index);
  next.node_generations[index] = core.node_slots[slot_index].generation.load(std::memory_order_relaxed);
  InstrumentNodeState &runtime = core.instrument_runtime[slot_index];
  runtime = {};
  set_up_instrument(runtime, (*core.prepared_instrument_configs)[index]);
  return true;
}

// Instrument configuration changed on the prepared plan: the node may switch
// between keeping the published slot and getting a fresh one.
daw_audio_core_result refresh_prepared_node(Core &core, uint32_t index) {
  const bool assigned = assign_prepared_node(core, index);
  bool capacity = true;
  if (core.published_revision != 0 && core.prepared_continuity == ContinuityPreparationResult::kAccepted) {
    capacity = mark_replaced_node(core, *core.published_graph, *core.prepared_graph, index);
  }
  collect_released_slots(core);
  return assigned && capacity ? DAW_AUDIO_CORE_OK : DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
}

// Where a processor's bypass position lives, whichever kind it is.
float *bypass_level(Core &core, const GraphRevision::Processor &processor) {
  switch (processor.kind) {
    case DAW_AUDIO_PROCESSOR_KIND_UTILITY: return &core.utility_histories[processor.history_slot].bypass;
    case DAW_AUDIO_PROCESSOR_KIND_SATURATOR: return &core.saturator_histories[processor.history_slot].bypass;
    case DAW_AUDIO_PROCESSOR_KIND_EQ: return &core.eq_histories[processor.history_slot].bypass;
    case DAW_AUDIO_PROCESSOR_KIND_GATE:
    case DAW_AUDIO_PROCESSOR_KIND_COMPRESSOR:
    case DAW_AUDIO_PROCESSOR_KIND_LIMITER: return &core.dynamics_histories[processor.history_slot].bypass;
    case DAW_AUDIO_PROCESSOR_KIND_AUTOFILTER: return &core.autofilter_histories[processor.history_slot].bypass;
    case DAW_AUDIO_PROCESSOR_KIND_LOFI: return &core.lofi_histories[processor.history_slot].bypass;
    case DAW_AUDIO_PROCESSOR_KIND_CHORUS:
    case DAW_AUDIO_PROCESSOR_KIND_FLANGER:
    case DAW_AUDIO_PROCESSOR_KIND_ENSEMBLE:
    case DAW_AUDIO_PROCESSOR_KIND_PHASER:
    case DAW_AUDIO_PROCESSOR_KIND_TREMOLO:
    case DAW_AUDIO_PROCESSOR_KIND_AUTOPAN: return &core.modulation_histories[processor.history_slot].bypass;
    case DAW_AUDIO_PROCESSOR_KIND_DELAY: return &core.delay_histories[processor.delay_slot].bypass;
    case DAW_AUDIO_PROCESSOR_KIND_REVERB: return &core.reverb_histories[processor.reverb_slot].bypass;
    case DAW_AUDIO_PROCESSOR_KIND_SPECTRAL: return &core.spectral_histories[processor.spectral_slot].bypass;
    default: return nullptr;
  }
}

// Whether the plan entry asks for its dry signal: bypassed, or its own enabled flag off.
bool bypass_requested(const GraphRevision::Processor &processor) {
  if (processor.bypassed != 0) return true;
  switch (processor.kind) {
    case DAW_AUDIO_PROCESSOR_KIND_UTILITY: return processor.utility.enabled == 0;
    case DAW_AUDIO_PROCESSOR_KIND_SATURATOR: return processor.saturator.enabled == 0;
    case DAW_AUDIO_PROCESSOR_KIND_EQ: return processor.eq.enabled == 0;
    case DAW_AUDIO_PROCESSOR_KIND_GATE: return processor.gate.enabled == 0;
    case DAW_AUDIO_PROCESSOR_KIND_COMPRESSOR: return processor.compressor.enabled == 0;
    case DAW_AUDIO_PROCESSOR_KIND_LIMITER: return processor.limiter.enabled == 0;
    case DAW_AUDIO_PROCESSOR_KIND_AUTOFILTER: return processor.autofilter.enabled == 0;
    case DAW_AUDIO_PROCESSOR_KIND_LOFI: return processor.lofi.enabled == 0;
    case DAW_AUDIO_PROCESSOR_KIND_CHORUS:
    case DAW_AUDIO_PROCESSOR_KIND_FLANGER: return processor.delay_modulation.enabled == 0;
    case DAW_AUDIO_PROCESSOR_KIND_ENSEMBLE: return processor.ensemble.enabled == 0;
    case DAW_AUDIO_PROCESSOR_KIND_PHASER: return processor.phaser.enabled == 0;
    case DAW_AUDIO_PROCESSOR_KIND_TREMOLO:
    case DAW_AUDIO_PROCESSOR_KIND_AUTOPAN: return processor.amplitude_modulation.enabled == 0;
    case DAW_AUDIO_PROCESSOR_KIND_DELAY: return processor.delay.enabled == 0;
    case DAW_AUDIO_PROCESSOR_KIND_REVERB: return processor.reverb.enabled == 0;
    case DAW_AUDIO_PROCESSOR_KIND_SPECTRAL: return processor.spectral.enabled == 0;
    default: return false;
  }
}

// A processor that gets a fresh slot starts its bypass where it is asked to sit, so
// one that is built bypassed (a graph's first plan, a replacement or an addition)
// is dry from its first sample instead of flashing wet while a ramp climbs from
// zero. One that joins a node that is already sounding starts on its dry signal
// and ramps in (an effect appearing in a sounding chain is a transition, not a
// cut). One that replaces another of the same identity is overwritten by
// hand_off_bypass at publish. Preparation only, on a slot the callback has not
// seen yet.
void seed_bypass(Core &core, const GraphRevision::Processor &fresh, bool joining) {
  if (float *level = bypass_level(core, fresh)) {
    *level = joining || bypass_requested(fresh) ? 1.0F : 0.0F;
  }
}

// Callback side of publish, integers and floats it owns only: a processor that
// replaced another of the same identity continues the bypass ramp where the old
// one actually stands, whether or not it has settled. The old slot is still
// active here (publish retires it afterwards) and the generation proves it is the
// one the plan was prepared against.
void hand_off_bypass(Core &core, const GraphRevision &replaced, const GraphRevision &plan) {
  for (uint32_t index = 0; index < plan.processor_count; ++index) {
    const GraphRevision::Processor &fresh = plan.processors[index];
    if (fresh.bypass_source < 0 || static_cast<uint32_t>(fresh.bypass_source) >= replaced.processor_count) continue;
    const GraphRevision::Processor &old = replaced.processors[static_cast<uint32_t>(fresh.bypass_source)];
    const RuntimeSlot &slot = core.processor_slots[old.history_slot];
    if (old.instance_id != fresh.instance_id || old.kind != fresh.kind
      || slot.state.load(std::memory_order_acquire) != kSlotActive
      || slot.generation.load(std::memory_order_relaxed) != old.generation) continue;
    float *from = bypass_level(core, old);
    float *to = bypass_level(core, fresh);
    if (from != nullptr && to != nullptr) *to = *from;
  }
}

// A node that gets a fresh slot where the published plan had one keeps that
// predecessor rendering beside it while it fades out (a replaced instrument).
// Also re-run when an instrument's configuration is set on the prepared plan,
// which can swap the node between keeping its slot and getting a fresh one.
// False when the predecessor already carries as many unfinished replacements as a
// node may: the edit fails instead of cutting the oldest.
bool mark_replaced_node(const Core &core, const GraphRevision &current, GraphRevision &next, uint32_t node) {
  const int32_t previous = graph_node_index(current, next.nodes[node].id);
  const bool replaced = previous >= 0 && current.nodes[static_cast<uint32_t>(previous)].kind == next.nodes[node].kind
    && next.node_slots[node] != current.node_slots[static_cast<uint32_t>(previous)];
  next.node_replaces[node] = replaced ? static_cast<uint16_t>(previous + 1) : 0;
  return !replaced
    || core.node_blends[current.node_slots[static_cast<uint32_t>(previous)]].depth.load(std::memory_order_acquire)
      < kMaximumNodeBlends;
}

// Preparation only, once slots are assigned: the surviving nodes whose stages run
// in a different order than they do now and so dip at publish. (A layout change and a
// replaced instrument crossfade their waveforms instead.) False when a replacement
// exceeds the blend capacity.
bool mark_reordered_nodes(
  const Core &core, const GraphRevision &current, GraphRevision &next, const ProcessorContinuityMap &processors) {
  bool capacity = true;
  for (uint32_t node = 0; node < next.node_count; ++node) {
    capacity = mark_replaced_node(core, current, next, node) && capacity;
    const int32_t previous = graph_node_index(current, next.nodes[node].id);
    if (previous < 0 || current.nodes[static_cast<uint32_t>(previous)].kind != next.nodes[node].kind) continue;
    const GraphRevision::Range old_chain = current.processor_ranges[static_cast<uint32_t>(previous)];
    const GraphRevision::Range new_chain = next.processor_ranges[node];
    int32_t last_position = -1;
    for (uint32_t link = new_chain.start; link < static_cast<uint32_t>(new_chain.start) + new_chain.count; ++link) {
      const uint32_t index = next.processor_indices[link];
      const int32_t kept = index < next.processor_count ? processors.previous[index] : -1;
      if (kept < 0) continue;
      int32_t position = -1;
      for (uint32_t old = 0; old < old_chain.count; ++old) {
        if (current.processor_indices[old_chain.start + old] == static_cast<uint32_t>(kept)) position = static_cast<int32_t>(old);
      }
      if (position < 0) continue;
      if (position < last_position) next.node_reordered[node] = true;
      last_position = std::max(last_position, position);
    }
  }
  return capacity;
}

// Carries the dip of the node `node` of `plan`, which stood at `previous` in the plan
// being left, across the publish. A node whose stages now run in a different order
// than the one it renders starts to dip; one already dipping keeps fading out
// through the order it was keeping, named in the new plan, and from where its
// output stands. A dip that has nothing left to keep returns from where it stands.
void carry_node_dip(
  Core &core, const GraphRevision &replaced, GraphRevision &plan, uint32_t node, uint32_t previous, bool reordered) {
  Core::NodeDip &dip = core.node_dips[plan.node_slots[node]];
  const bool keeping_order = dip.phase == Core::kDipFadingOut;
  if (!reordered && !keeping_order) return;
  // The order the node renders now: the published chain, with the stages a dip is
  // keeping back in the order they ran.
  const GraphRevision::Range published = replaced.processor_ranges[previous];
  const auto kept_end = dip.order.begin() + dip.count;
  std::array<uint16_t, kMaximumNodeChain> order{};
  uint32_t order_count = 0;
  uint32_t taken = 0;
  for (uint32_t link = published.start; link < static_cast<uint32_t>(published.start) + published.count; ++link) {
    uint32_t index = replaced.processor_indices[link];
    if (index >= replaced.total_processor_count()) continue;
    if (keeping_order && std::find(dip.order.begin(), kept_end, index) != kept_end) index = dip.order[taken++];
    const int32_t survivor = plan.processor_remap[index];
    if (survivor >= 0 && plan.processors[static_cast<uint32_t>(survivor)].node_index == node
      && find_processor_renderer(plan.processors[static_cast<uint32_t>(survivor)].kind) != nullptr) {
      order[order_count++] = static_cast<uint16_t>(survivor);
    }
  }
  // It differs when the plan's chain would run those stages another way round.
  bool differs = false;
  const GraphRevision::Range chain = plan.processor_ranges[node];
  const auto order_end = order.begin() + order_count;
  uint32_t position = 0;
  for (uint32_t link = chain.start; link < static_cast<uint32_t>(chain.start) + chain.count; ++link) {
    const uint32_t index = plan.processor_indices[link];
    if (index >= plan.total_processor_count() || std::find(order.begin(), order_end, index) == order_end) continue;
    differs = differs || order[position] != index;
    ++position;
  }
  if (differs) {
    dip.order = order;
    dip.count = order_count;
    if (!keeping_order) {
      if (dip.phase == Core::kDipNone) dip.level = dip_half_frames(plan);
      dip.phase = Core::kDipFadingOut;
    }
  } else if (keeping_order) {
    dip.phase = Core::kDipFadingIn;
    dip.count = 0;
  }
}

// The voices a full instrument of `capacity` would keep out of `voices`, best first
// by `outranks`; the rest are the ones it would give way.
template <typename Voice, typename Outranks>
std::array<bool, kMaximumInstrumentVoices> surviving_voices(
  const std::array<Voice, kMaximumInstrumentVoices> &voices, uint32_t capacity, Outranks outranks) {
  std::array<bool, kMaximumInstrumentVoices> keep{};
  for (uint32_t kept = 0; kept < capacity; ++kept) {
    int32_t best = -1;
    for (uint32_t index = 0; index < voices.size(); ++index) {
      if (voices[index].active && !keep[index] && (best < 0 || outranks(voices[index], voices[static_cast<uint32_t>(best)]))) {
        best = static_cast<int32_t>(index);
      }
    }
    if (best < 0) break;
    keep[static_cast<uint32_t>(best)] = true;
  }
  return keep;
}

template <typename Voice>
void carry_voices(
  const std::array<Voice, kMaximumInstrumentVoices> &voices, const std::array<bool, kMaximumInstrumentVoices> &keep,
  std::array<Voice, kMaximumInstrumentVoices> &into) {
  uint32_t carried = 0;
  for (uint32_t index = 0; index < voices.size(); ++index) {
    if (keep[index]) into[carried++] = voices[index];
  }
}

// Whether two zones are the same zone of a sampler, edited or not: a zone is named
// by what it answers to (its keys, velocities and round-robin place), never by its
// asset, tuning, gain, pan or ranges, which are what an edit changes.
bool same_sample_zone(const daw_audio_sample_zone &left, const daw_audio_sample_zone &right) {
  return left.key_low == right.key_low && left.key_high == right.key_high
    && left.velocity_low == right.velocity_low && left.velocity_high == right.velocity_high
    && left.round_robin_group == right.round_robin_group && left.round_robin_index == right.round_robin_index;
}

// Seeds the instrument that replaces another at publish: the replacement keeps its
// own configuration and takes over what the old one was playing, so a held note goes
// on at the phase it had and the edit applies to it at once (render reads every
// configured value per frame). It also takes over the continuous values the old one
// had applied (a zone's only while it is the same zone), so a drag already under way
// goes on from where it was and the edited targets slew from there. Callback side of publish, floats and integers only,
// into a slot nothing has rendered yet. Both slots then render the same voices
// across the 5 ms crossfade, whose weights sum to one, so the seam has no level bump.
//
// What carries, and why:
//
//  Synth (voices[], sustain, expression, next_age)
//   voices        carried whole: note, note_id, velocity, references, held and released,
//                 envelope levels and stages, oscillator, LFO and noise phase, filter
//                 history. All of it is signal state; every setting (waveform, filter
//                 mode, envelope times, level, pan) is read from the replacement's configuration
//                 each frame, so none is stored in a voice.
//   sustain       carried: the pedal is a held controller, not a setting. A note-off
//                 after the edit finds its voice by note_id and releases it.
//   expression    carried (controller state). next_age carried so ages stay ordered.
//   synth (live)  NOT carried: the replacement's configuration is the authority, as it is for a
//                 slot with no predecessor.
//   polyphony     lowered: the voices a full instrument would keep (not released
//                 first, then newest) carry into slots 0..capacity-1 and the rest stay
//                 in the old slot, fading with its crossfade. Raised: every voice carries.
//
//  Sampler and Drum Rack (sample_voices[], round_robin_cursors, next_age; no pedal)
//   voices        carried with their zone re-resolved in the replacement's zones by what the
//                 zone answers to (same index first). A voice whose zone is gone is not
//                 carried, nor is one a one-shot (or a swapped asset) left past the new
//                 zone's end: it stays in the old slot and ends on the crossfade.
//   zone values   end, loop, mode, crossfade, gain, pan and choke are read through the
//                 zone each frame; asset, tuning and start are re-derived by
//                 `follow_sample_zone` on the first frame, keeping the playhead (a start
//                 edit moves it by the same distance).
//   position, amp/filter/LFO state, forced release, velocity, note, note_id, age:
//                 carried (signal state and identity).
//   round_robin_cursors, next_age: carried (place in a rotation, age order).
//   sampler       NOT carried: configuration.
//
//  Granular (grains[], note ids and ages, count, next age, random state, next grain
//  frame, frozen position)
//   grains        carried (index below the replacement's max_grains): cursor, step, age, length and pan are
//                 what a grain was spawned with; window shape and the rest of the state
//                 are read from the configuration each frame. Grains past a lowered
//                 max_grains stay in the old slot and fade with it.
//   note state    carried: the held notes (ids, ages, count, next age) keep sounding and
//                 a note-off after the edit ends the right one.
//   random state, next grain frame: carried, so spawning goes on where it was.
//   frozen position: carried only while freeze is on before and after; otherwise the
//                 replacement captures it afresh.
void seed_instrument_runtime(
  const daw_audio_graph_node_descriptor &plan_node, const InstrumentNodeState &from, InstrumentNodeState &to) {
  const uint32_t capacity = plan_node.instrument.voice_capacity;
  const auto carry = [](float &applied, float before) { applied = before; };
  switch (plan_node.instrument.kind) {
    case DAW_AUDIO_INSTRUMENT_KIND_SYNTH:
      visit_synth(to.applied.synth, from.applied.synth, carry);
      to.sustain = from.sustain;
      to.expression = from.expression;
      to.next_age = from.next_age;
      carry_voices(from.voices, surviving_voices(from.voices, capacity, [](const InstrumentVoice &a, const InstrumentVoice &b) {
        return a.released != b.released ? !a.released : a.age > b.age;
      }), to.voices);
      break;
    case DAW_AUDIO_INSTRUMENT_KIND_SAMPLER:
    case DAW_AUDIO_INSTRUMENT_KIND_DRUM_RACK: {
      visit_sampler(to.applied.sampler, from.applied.sampler, carry);
      for (uint32_t zone = 0; zone < std::min(to.sampler.zone_count, from.sampler.zone_count); ++zone) {
        if (same_sample_zone(from.zones[zone], to.zones[zone])) visit_zone(to.applied.zones[zone], from.applied.zones[zone], carry);
      }
      to.round_robin_cursors = from.round_robin_cursors;
      to.next_age = from.next_age;
      std::array<SampleVoice, kMaximumInstrumentVoices> voices = from.sample_voices;
      for (SampleVoice &voice : voices) {
        if (!voice.active) continue;
        const daw_audio_sample_zone &before = from.zones[voice.zone];
        uint32_t zone = voice.zone;
        if (zone >= to.sampler.zone_count || !same_sample_zone(before, to.zones[zone])) {
          for (zone = 0; zone < to.sampler.zone_count && !same_sample_zone(before, to.zones[zone]); ++zone) {}
        }
        const bool found = zone < to.sampler.zone_count;
        const daw_audio_sample_zone &after = found ? to.zones[zone] : before;
        const double shifted = voice.position + static_cast<double>(after.start_frame) - static_cast<double>(voice.start_frame);
        const bool past_end = shifted >= static_cast<double>(after.end_frame)
          && (after.playback_mode == DAW_AUDIO_SAMPLE_PLAYBACK_ONE_SHOT || after.asset != voice.asset);
        voice.zone = zone;
        voice.active = found && !past_end;
      }
      carry_voices(voices, surviving_voices(voices, capacity, [](const SampleVoice &a, const SampleVoice &b) {
        return a.age > b.age;
      }), to.sample_voices);
      break;
    }
    case DAW_AUDIO_INSTRUMENT_KIND_GRANULAR: {
      visit_granular(to.applied.granular, from.applied.granular, carry);
      for (uint32_t index = 0; index < to.granular.max_grains; ++index) to.grains[index] = from.grains[index];
      to.granular_note_ids = from.granular_note_ids;
      to.granular_note_ages = from.granular_note_ages;
      to.granular_note_count = from.granular_note_count;
      to.granular_next_note_age = from.granular_next_note_age;
      to.granular_random_state = from.granular_random_state;
      to.granular_next_frame = from.granular_next_frame;
      if (from.granular.freeze != 0 && to.granular.freeze != 0) to.granular_frozen_position = from.granular_frozen_position;
      break;
    }
    default:
      break;
  }
}

// Callback side of publish, floats and integers it owns only. Every node starts or
// carries its dip (a deleted node's ghost too: its stages are ghosts now, and it
// keeps the order its output was fading through). A replaced instrument's
// predecessor stays active beside it (publish does not retire it): the node starts
// its fade-in against it, and takes over the predecessor's layout folds and dip so
// neither starts from nothing. `replaced` is the plan being left, whose slots are
// still active here and whose generation proves each is the one the plan was
// prepared against.
void begin_node_dips(Core &core, const GraphRevision &replaced, GraphRevision &plan) {
  for (uint32_t node = 0; node < plan.node_count; ++node) {
    const uint32_t slot = plan.node_slots[node];
    if (plan.node_replaces[node] != 0 && plan.node_replaces[node] <= replaced.node_count) {
      const uint32_t old_index = plan.node_replaces[node] - 1u;
      const uint32_t old_slot = replaced.node_slots[old_index];
      if (runtime_slot_renderable(core, core.node_slots[old_slot], replaced.node_generations[old_index])) {
        core.node_dips[slot] = core.node_dips[old_slot];
        core.node_folds[slot] = core.node_folds[old_slot];
        Core::NodeBlend &blend = core.node_blends[slot];
        blend.partner = static_cast<uint16_t>(old_slot + 1u);
        blend.partner_generation = replaced.node_generations[old_index];
        blend.elapsed = 0;
        blend.descriptor = replaced.nodes[old_index].instrument;
        blend.depth.store(core.node_blends[old_slot].depth.load(std::memory_order_acquire) + 1u, std::memory_order_release);
        if (replaced.nodes[old_index].instrument.kind == plan.nodes[node].instrument.kind) {
          seed_instrument_runtime(plan.nodes[node], core.instrument_runtime[old_slot], core.instrument_runtime[slot]);
        }
      }
    }
    const int32_t previous = graph_node_index(replaced, plan.nodes[node].id);
    if (previous >= 0) carry_node_dip(core, replaced, plan, node, static_cast<uint32_t>(previous), plan.node_reordered[node]);
  }
  for (uint32_t ghost = plan.node_count; ghost < plan.total_node_count(); ++ghost) {
    for (uint32_t old = 0; old < replaced.total_node_count(); ++old) {
      if (replaced.node_slots[old] == plan.node_slots[ghost]) carry_node_dip(core, replaced, plan, ghost, old, false);
    }
  }
}

// Callback side of publish. A kept instrument whose configuration changed (only in
// its continuous values, or it would have been replaced) takes the edited one as its
// targets: its voices go on and the values it applies slew there. An unchanged one
// keeps what a live event set.
void begin_instrument_edits(Core &core, const GraphRevision &replaced, const GraphRevision &plan) {
  for (uint32_t node = 0; node < plan.node_count; ++node) {
    if (plan.nodes[node].kind != DAW_AUDIO_GRAPH_NODE_INSTRUMENT) continue;
    const int32_t previous = graph_node_index(replaced, plan.nodes[node].id);
    if (previous < 0 || replaced.node_slots[static_cast<uint32_t>(previous)] != plan.node_slots[node]) continue;
    const InstrumentConfiguration &before = (*core.published_instrument_configs)[static_cast<uint32_t>(previous)];
    const InstrumentConfiguration &after = (*core.prepared_instrument_configs)[node];
    const bool same = std::memcmp(&before.synth, &after.synth, sizeof(after.synth)) == 0
      && std::memcmp(&before.sampler, &after.sampler, sizeof(after.sampler)) == 0
      && same_zones(before, after) && same_granular(before.granular, after.granular);
    if (!same) set_instrument_targets(core.instrument_runtime[plan.node_slots[node]], after);
  }
}

// Callback side of publish, beside the dips. Every retained node drops what it
// latched: the committed descriptor wins until the schedule sets a value again.
// When that or the descriptor changes what the node applies, its gains move there
// from the ones it applied last over the plan's fade, as its layout folds do.
void begin_mixer_ramps(Core &core, const GraphRevision &replaced, const GraphRevision &plan) {
  for (uint32_t node = 0; node < plan.node_count; ++node) {
    const int32_t previous = graph_node_index(replaced, plan.nodes[node].id);
    const uint32_t slot = plan.node_slots[node];
    if (previous < 0 || replaced.node_slots[static_cast<uint32_t>(previous)] != slot) continue;
    const daw_audio_mixer_state &before = replaced.nodes[static_cast<uint32_t>(previous)].mixer;
    const daw_audio_mixer_state &after = plan.nodes[node].mixer;
    Core::MixerLatch &latch = core.mixer_latches[slot];
    Core::MixerRamp &ramp = core.mixer_ramps[slot];
    const bool changed = latch.mask != 0 || before.instance_id != after.instance_id || before.gain != after.gain
      || before.pan != after.pan || before.muted != after.muted || before.soloed != after.soloed;
    if (ramp.seen && changed) {
      ramp.from = ramp.applied;
      ramp.elapsed = 0;
      ramp.frames = plan.fade_frames;
    }
    latch.mask = 0;
  }
}

// Callback side of publish, beside the fader ramps. An edge that carries on one of
// the plan being left keeps its move; once that edge has sounded, a gain the plan
// changes is reached from the one it applied last over the plan's fade, as a kept
// fader's is. A route the plan adds still enters against its join, and a dropped
// one still fades out as its ghost.
void begin_edge_ramps(Core &core, const GraphRevision &replaced, const GraphRevision &plan) {
  const auto &applied = core.edge_ramps[core.edge_ramp_bank];
  auto &ramps = core.edge_ramps[core.edge_ramp_bank ^ 1u];
  for (uint32_t edge = 0; edge < plan.total_edge_count(); ++edge) {
    ramps[edge] = {};
    if (plan.edge_previous[edge] == 0) continue;
    const uint32_t previous = plan.edge_previous[edge] - 1u;
    const Core::EdgeRamp &before = applied[previous];
    const float gain = replaced.edges[previous].gain;
    ramps[edge] = before;
    if (before.seen && gain != plan.edges[edge].gain) {
      ramps[edge] = {.from = edge_ramp_gain(before, gain, before.elapsed), .frames = plan.fade_frames, .seen = true};
    }
  }
  core.edge_ramp_bank ^= 1u;
}

// Prepares the runtime of the plan just copied into the prepared slot: instrument
// configuration, the topology verdict, deletion ghosts, and slot ownership. All of
// it happens off the callback; on failure nothing the callback uses has changed.
daw_audio_core_result prepare_runtime_ownership(Core &core) {
  GraphRevision &next = *core.prepared_graph;
  const GraphRevision &current = *core.published_graph;
  const bool has_current = current.revision != 0 && core.published_revision != 0;
  core.prepared_instrument_previous_nodes.fill(-1);
  for (uint32_t index = 0; index < next.node_count; ++index) {
    auto &configuration = (*core.prepared_instrument_configs)[index];
    configuration = {};
    const int32_t previous = has_current ? graph_node_index(current, next.nodes[index].id) : -1;
    if (previous >= 0) {
      const auto &current_node = current.nodes[static_cast<uint32_t>(previous)];
      if (current_node.kind == next.nodes[index].kind
        && current_node.instrument.kind == next.nodes[index].instrument.kind) {
        core.prepared_instrument_previous_nodes[index] = previous;
        configuration = (*core.published_instrument_configs)[static_cast<uint32_t>(previous)];
      }
    }
    if (next.nodes[index].kind == DAW_AUDIO_GRAPH_NODE_INSTRUMENT
      && next.nodes[index].instrument.kind == DAW_AUDIO_INSTRUMENT_KIND_SYNTH
      && configuration.synth.version == 0) configuration.synth = default_synth_state();
  }
  next.fade_frames = deletion_fade_frames(core.config.sample_rate_hz);
  const auto processors = has_current ? build_processor_continuity_map(current, next) : ProcessorContinuityMap{};
  core.prepared_continuity = ContinuityPreparationResult::kAccepted;
  next.node_reordered.fill(false);
  next.processor_remap.fill(-1);
  next.node_replaces.fill(0);
  next.edge_previous.fill(0);
  if (has_current) {
    const daw_audio_core_result ghosts = append_deletion_ghosts(core, current, next, processors);
    if (ghosts != DAW_AUDIO_CORE_OK) return ghosts;
  }
  build_graph_ranges(next);
  for (uint32_t index = 0; index < next.processor_count; ++index) {
    auto &processor = next.processors[index];
    // Each processor keeps its slot unless its own structure changed; a latency
    // change starts every processor from fresh slots. Fresh slots are initialized
    // here rather than reset by publish.
    const int32_t previous = has_current && core.prepared_continuity == ContinuityPreparationResult::kAccepted
      ? processors.previous[index] : -1;
    if (previous >= 0 && compatible_processor_history(current.processors[static_cast<uint32_t>(previous)], processor)) {
      const auto &kept = current.processors[static_cast<uint32_t>(previous)];
      processor.history_slot = kept.history_slot;
      processor.delay_slot = kept.delay_slot;
      processor.reverb_slot = kept.reverb_slot;
      processor.spectral_slot = kept.spectral_slot;
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
      processor.spectral_compensation = core.transport_running.load(std::memory_order_acquire)
        && core.latency_shrunk_revision.load(std::memory_order_acquire) != current.revision
          ? kept.spectral_compensation : 0u;
#endif
      processor.generation = kept.generation;
      if (kept.spectral_predecessor >= 0
        && core.processor_slots[current.spectral_predecessors[kept.spectral_predecessor].history_slot].state.load(std::memory_order_acquire) == kSlotActive
        && core.processor_slots[current.spectral_predecessors[kept.spectral_predecessor].history_slot].generation.load(std::memory_order_relaxed)
          == current.spectral_predecessors[kept.spectral_predecessor].generation) {
        if (next.spectral_predecessor_count == kMaximumSpectralProcessors) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
        processor.spectral_predecessor = static_cast<int32_t>(next.spectral_predecessor_count++);
        next.spectral_predecessors[processor.spectral_predecessor] = current.spectral_predecessors[kept.spectral_predecessor];
      }
      continue;
    }
    const int32_t slot = acquire_runtime_slot(core.processor_slots);
    if (slot < 0) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    core.prepared_runtime_held = true;
    processor.history_slot = static_cast<uint32_t>(slot);
    processor.generation = core.processor_slots[slot].generation.load(std::memory_order_relaxed);
    if (processor.kind == DAW_AUDIO_PROCESSOR_KIND_DELAY) {
      const int32_t owned = acquire_history_owner(core.delay_slot_owners, processor.history_slot);
      if (owned < 0) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
      processor.delay_slot = static_cast<uint32_t>(owned);
      std::destroy_at(&core.delay_histories[owned]);
      std::construct_at(&core.delay_histories[owned]);
    } else if (processor.kind == DAW_AUDIO_PROCESSOR_KIND_REVERB) {
      const int32_t owned = acquire_history_owner(core.reverb_slot_owners, processor.history_slot);
      if (owned < 0) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
      processor.reverb_slot = static_cast<uint32_t>(owned);
      std::destroy_at(&core.reverb_histories[owned]);
      std::construct_at(&core.reverb_histories[owned]);
    } else if (processor.kind == DAW_AUDIO_PROCESSOR_KIND_SPECTRAL) {
      const int32_t owned = acquire_history_owner(core.spectral_slot_owners, processor.history_slot);
      if (owned < 0) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
      processor.spectral_slot = static_cast<uint32_t>(owned);
      std::destroy_at(&core.spectral_histories[owned]);
      std::construct_at(&core.spectral_histories[owned]);
      reset_spectral_history(core.spectral_histories[owned], processor.spectral);
      std::destroy_at(&core.spectral_inputs[owned]);
      std::construct_at(&core.spectral_inputs[owned]);
      core.spectral_inputs[owned].initialize_samples();
      if (previous >= 0 && current.processors[previous].kind == DAW_AUDIO_PROCESSOR_KIND_SPECTRAL) {
        if (next.spectral_predecessor_count == kMaximumSpectralProcessors) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
        processor.spectral_predecessor = static_cast<int32_t>(next.spectral_predecessor_count++);
        next.spectral_predecessors[processor.spectral_predecessor] = current.processors[previous];
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
        const auto &prior = current.processors[previous];
        if (core.transport_running.load(std::memory_order_acquire)
          && next.nodes[processor.node_index].keep_latency == 0) {
          const uint32_t padding = core.latency_shrunk_revision.load(std::memory_order_acquire) == current.revision
            ? 0u : prior.spectral_compensation;
          processor.spectral_compensation = std::max(prior.spectral.fft_size + padding,
            processor.spectral.fft_size) - processor.spectral.fft_size;
        }
#endif
        next.spectral_predecessors[processor.spectral_predecessor].spectral_predecessor = -1;
        // The old stage has no cache entry. render_chain_frame forwards the
        // effective Freeze control; other controls retain this configuration.
        next.spectral_predecessors[processor.spectral_predecessor].parameter_count = 0;
        // Prepare the new algorithm from an atomic, retained stage-input
        // window. This is control-side only; it never reads mutable FFT state
        // or executes an upstream processor. Publication catches up only the
        // samples that arrived while this immutable revision was in flight.
        auto &input = core.spectral_inputs[current.processors[previous].spectral_slot];
        auto &history = core.spectral_histories[owned];
        const bool valid_snapshot = input.read(core.spectral_state_snapshot, current.processors[previous].spectral);
        const uint64_t end = input.end.load(std::memory_order_acquire);
        const uint64_t begin = end - std::min<uint64_t>(end,
          spectral_warm_frames(processor.spectral) + processor.spectral_compensation);
        const uint32_t parameters = processor.parameter_count;
        processor.parameter_count = 0;
        for (uint64_t cursor = begin; cursor < end; ++cursor) {
          const uint32_t at = cursor & (kSpectralInputFrames - 1u);
          float left = 0.0F, right = 0.0F;
          render_spectral_processor(core, processor, 0,
            input.sample(0, at), input.sample(1, at),
            input.sample(2, at), input.sample(3, at),
            &left, &right);
        }
        processor.parameter_count = parameters;
        if (valid_snapshot)
          transfer_spectral_persistent(core.spectral_state_snapshot, current.processors[previous].spectral,
            history, processor.spectral);
        else history.transfer_map = prepare_spectral_transfer(current.processors[previous].spectral.fft_size,
          processor.spectral.fft_size);
        // Serial zero means no analysis frame has been published yet. In
        // particular, an unobserved Gate starts at unity, not snapshot zeros.
        history.prepared_state_serial = core.spectral_state_snapshot.state_serial == 0
          ? UINT64_MAX : core.spectral_state_snapshot.state_serial;
        history.prepared_state_mode = valid_snapshot ? current.processors[previous].spectral.mode : UINT32_MAX;
        history.prepared_state_fft_size = valid_snapshot ? current.processors[previous].spectral.fft_size : 0;
        // A preempted preparation may have lost its oldest samples. Do not
        // expose that partial warmup or race an overwritten window: this is
        // genuine bounded-history exhaustion, not a published transition.
        const uint64_t completed = input.end.load(std::memory_order_acquire);
        if (completed - begin >= kSpectralInputFrames) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
        history.warm_cursor = end;
        history.transition_started = true;
      }
    }
    seed_bypass(core, processor, has_current && previous < 0 && graph_node_index(current, processor.node_id) >= 0);
    if (previous >= 0 && current.processors[static_cast<uint32_t>(previous)].kind == processor.kind) {
      processor.bypass_source = previous;
    }
  }
  for (uint32_t index = next.processor_count; index < next.total_processor_count(); ++index) {
    auto &ghost = next.processors[index];
    if (ghost.spectral_predecessor < 0) continue;
    const auto &predecessor = current.spectral_predecessors[ghost.spectral_predecessor];
    if (next.spectral_predecessor_count == kMaximumSpectralProcessors) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    ghost.spectral_predecessor = static_cast<int32_t>(next.spectral_predecessor_count++);
    next.spectral_predecessors[ghost.spectral_predecessor] = predecessor;
  }
  for (uint32_t index = 0; index < next.node_count; ++index) {
    if (!assign_prepared_node(core, index)) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
  if (has_current && core.prepared_continuity == ContinuityPreparationResult::kAccepted
    && !mark_reordered_nodes(core, current, next, processors)) {
    return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
  collect_released_slots(core);
  return DAW_AUDIO_CORE_OK;
}

// Callback side of publish, integers only: every slot the plan names must still be
// prepared or active at the generation the plan recorded.
bool prepared_runtime_current(const Core &core, const GraphRevision &plan) {
  const auto current = [](const RuntimeSlot &slot, uint32_t generation) {
    const uint32_t state = slot.state.load(std::memory_order_acquire);
    return (state == kSlotPrepared || state == kSlotActive)
      && slot.generation.load(std::memory_order_relaxed) == generation;
  };
  // Ghosts are exempt: one may finish fading between prepare and publish, and
  // then simply does not render.
  for (uint32_t index = 0; index < plan.processor_count; ++index) {
    if (!current(core.processor_slots[plan.processors[index].history_slot], plan.processors[index].generation)) return false;
  }
  for (uint32_t index = 0; index < plan.node_count; ++index) {
    if (!current(core.node_slots[plan.node_slots[index]], plan.node_generations[index])) return false;
  }
  return true;
}

void activate_prepared_runtime(Core &core, const GraphRevision &plan) {
  const auto activate = [](RuntimeSlot &slot) {
    uint32_t expected = kSlotPrepared;
    slot.state.compare_exchange_strong(expected, kSlotActive, std::memory_order_release, std::memory_order_relaxed);
  };
  for (uint32_t index = 0; index < plan.processor_count; ++index) activate(core.processor_slots[plan.processors[index].history_slot]);
  for (uint32_t index = 0; index < plan.total_node_count(); ++index) activate(core.node_slots[plan.node_slots[index]]);
  const auto retire = [&core](RuntimeSlot &slot, uint32_t generation) {
    if (slot.state.load(std::memory_order_relaxed) == kSlotActive
      && slot.generation.load(std::memory_order_relaxed) == generation) retire_runtime_slot(core, slot);
  };
  for (uint32_t index = 0; index < plan.released_processor_count; ++index) {
    retire(core.processor_slots[plan.released_processors[index].index], plan.released_processors[index].generation);
  }
  for (uint32_t index = 0; index < plan.released_node_count; ++index) {
    retire(core.node_slots[plan.released_nodes[index].index], plan.released_nodes[index].generation);
  }
}

extern "C" daw_audio_core_result daw_audio_core_publish(
  daw_audio_core_handle core_handle,
  uint32_t expected_revision) {
  Core *core = to_core(core_handle);
  if (core == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (expected_revision == 0) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (core->prepared_revision != expected_revision) return DAW_AUDIO_CORE_STALE_REVISION;
  if (core->latency_move_revision.load(std::memory_order_acquire)
    > core->latency_completed_revision.load(std::memory_order_acquire))
    return DAW_AUDIO_CORE_LATENCY_MOVE_PENDING;
  if ((*core->prepared_graph).revision == expected_revision) {
    if (!prepared_runtime_current(*core, *core->prepared_graph)) {
      core->stale_references.fetch_add(1, std::memory_order_relaxed);
      return DAW_AUDIO_CORE_STALE_REVISION;
    }
    hand_off_bypass(*core, *core->published_graph, *core->prepared_graph);
    begin_node_dips(*core, *core->published_graph, *core->prepared_graph);
    begin_instrument_edits(*core, *core->published_graph, *core->prepared_graph);
    begin_mixer_ramps(*core, *core->published_graph, *core->prepared_graph);
    begin_edge_ramps(*core, *core->published_graph, *core->prepared_graph);
    activate_prepared_runtime(*core, *core->prepared_graph);
    for (uint32_t index = 0; index < core->prepared_graph->processor_count; ++index) {
      const auto &processor = core->prepared_graph->processors[index];
      if (processor.spectral_predecessor < 0) continue;
      auto &history = core->spectral_histories[processor.spectral_slot];
      history.freeze_source_deadline = core->graph_write_frame + 2u * processor.spectral.fft_size
        + processor.spectral_compensation + 2u * core->prepared_graph->fade_frames
        + core->config.max_frames_per_block;
      history.freeze_source_latched = false;
      history.freeze_changed_after_latch = false;
    }
    // This is the same block-boundary/reader-epoch handoff as runtime slots.
    // Delayed ghosts keep their reserved histories; only fresh live owners reset.
    for (uint32_t node = 0; node < core->prepared_graph->node_count; ++node) {
      for (uint32_t tap = 0; tap < kGraphStageCount; ++tap) {
        if (!core->prepared_graph->reset_tap_histories[node][tap]) continue;
        auto &history = core->graph_tap_histories[core->prepared_graph->tap_history_slots[node][tap]];
        history.first_frame = core->graph_write_frame;
        history.end_frame = core->graph_write_frame;
      }
    }
    core->prepared_runtime_held = false;
    core->latency_publication_shift = core->graph_write_frame - core->prepared_graph->latency_origin;
    const bool running = core->transport_running.load(std::memory_order_acquire);
    core->latency_shrunk_revision = running ? 0u : expected_revision;
    core->latency_budget.store(running ? core->prepared_graph->latency_budget
      : core->prepared_graph->minimum_latency, std::memory_order_release);
    core->latency_move_revision.store(expected_revision, std::memory_order_release);
    if (!running || (core->prepared_graph->latency_end == core->prepared_graph->latency_origin
      && core->prepared_graph->spectral_predecessor_count == 0))
      core->latency_completed_revision.store(expected_revision, std::memory_order_release);
    std::swap(core->published_graph, core->prepared_graph);
    std::swap(core->published_instrument_configs, core->prepared_instrument_configs);
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
  release_prepared_runtime(*core);
  core->prepared_revision = 0;
  core->prepared_continuity = ContinuityPreparationResult::kAccepted;
  return DAW_AUDIO_CORE_OK;
}

extern "C" uint32_t daw_audio_core_prepared_graph_continuity(
  daw_audio_core_handle core_handle) {
  Core *core = to_core(core_handle);
  return core != nullptr && core->prepared_continuity == ContinuityPreparationResult::kAccepted ? 1U : 0U;
}

extern "C" uint32_t daw_audio_core_reclaim_retired_runtime(daw_audio_core_handle core_handle) {
  Core *core = to_core(core_handle);
  if (core == nullptr) return 0;
  const uint32_t before = core->reclaimed_slots;
  reclaim_retired_slots(*core);
  return core->reclaimed_slots - before;
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
      core->processor_overrides[current.history_slot].count = 0;
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
  // The reader may still be inside the plan being retired: its slots only
  // become reusable once that render epoch has completed.
  for (RuntimeSlot &slot : core->processor_slots) {
    if (slot.state.load(std::memory_order_relaxed) == kSlotActive) retire_runtime_slot(*core, slot);
  }
  for (RuntimeSlot &slot : core->node_slots) {
    if (slot.state.load(std::memory_order_relaxed) == kSlotActive) retire_runtime_slot(*core, slot);
  }
  core->published_revision = 0;
  GraphRevision &published = *core->published_graph;
  published.revision = 0;
  published.node_count = 0;
  published.edge_count = 0;
  published.processor_count = 0;
  published.ghost_node_count = 0;
  published.ghost_edge_count = 0;
  published.ghost_processor_count = 0;
  published.master_index = kMaximumGraphNodes;
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
  *core->published_native_hooks = {};
#endif
  reclaim_retired_slots(*core);
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

extern "C" daw_audio_core_result daw_audio_core_validate_instrument_target(
  daw_audio_core_handle core_handle,
  const daw_audio_instrument_event *event) {
  const Core *core = to_core(core_handle);
  if (core == nullptr || event == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  const auto &graph = *core->published_graph;
  const int32_t index = graph_node_index(graph, event->node_id);
  if (index < 0 || graph.nodes[static_cast<uint32_t>(index)].kind != DAW_AUDIO_GRAPH_NODE_INSTRUMENT) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  if (event->type != DAW_AUDIO_INSTRUMENT_EVENT_PARAMETER) return DAW_AUDIO_CORE_OK;
  const auto &descriptor = graph.nodes[static_cast<uint32_t>(index)].instrument;
  // Use the same setter as render validation, on local scalar configuration,
  // never read/copy the concurrently changing instrument runtime.
  daw_audio_synth_state candidate{};
  return descriptor.kind == DAW_AUDIO_INSTRUMENT_KIND_SYNTH
    && instrument_declares_target(descriptor, event->note)
    && set_synth_parameter(candidate, event->note, event->value)
      ? DAW_AUDIO_CORE_OK : DAW_AUDIO_CORE_INVALID_ARGUMENT;
}

extern "C" uint32_t daw_audio_core_rejected_instrument_event_index(
  daw_audio_core_handle core_handle) {
  const Core *core = to_core(core_handle);
  return core == nullptr ? UINT32_MAX : core->rejected_instrument_event_index;
}

static daw_audio_core_result process_block(
  daw_audio_core_handle core_handle,
  const daw_audio_core_process_block *block,
  uint8_t *rejected_events) {
  Core *core = to_core(core_handle);
  if (core == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  core->rejected_instrument_event_index = UINT32_MAX;
  if (rejected_events != nullptr) std::fill_n(rejected_events, DAW_AUDIO_CORE_MAX_INSTRUMENT_EVENTS, uint8_t{0});
  if (block == nullptr || block->outputs == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  // Every call counts as one render epoch once it returns, whatever it rendered.
  const struct EpochGuard {
    Core &core;
    ~EpochGuard() {
      core.render_epoch.fetch_add(1, std::memory_order_release);
      // Publish completion after the reader epoch, not from inside graph render.
      // Control may reclaim a descriptor as soon as it acquires this snapshot.
      const auto &graph = *core.published_graph;
      bool stages_complete = true;
      for (uint32_t index = 0; index < graph.spectral_predecessor_count; ++index) {
        const auto &processor = graph.spectral_predecessors[index];
        const auto &slot = core.processor_slots[processor.history_slot];
        if (slot.state.load(std::memory_order_relaxed) == kSlotActive
          && slot.generation.load(std::memory_order_relaxed) == processor.generation) stages_complete = false;
      }
      if (stages_complete && core.graph_write_frame >= graph.latency_end + core.latency_publication_shift)
        core.latency_completed_revision.store(graph.revision, std::memory_order_release);
    }
  } epoch{*core};
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
  if (!bind_process_transport(*core, *block, rejected_events)) {
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

extern "C" daw_audio_core_result daw_audio_core_process(
  daw_audio_core_handle core_handle,
  const daw_audio_core_process_block *block) {
  return process_block(core_handle, block, nullptr);
}

extern "C" daw_audio_core_result daw_audio_core_process_valid_instrument_events(
  daw_audio_core_handle core_handle,
  const daw_audio_core_process_block *block,
  uint8_t *rejected_events) {
  if (rejected_events == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  return process_block(core_handle, block, rejected_events);
}

extern "C" daw_audio_core_result daw_audio_core_set_transport(
  daw_audio_core_handle core_handle,
  const daw_audio_transport_state *state) {
  Core *core = to_core(core_handle);
  if (core == nullptr || state == nullptr || !valid_transport_state(*state)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (state->epoch < core->transport.epoch) return DAW_AUDIO_CORE_STALE_REVISION;
  if (state->epoch != core->transport.epoch) {
#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
    if (core->transport.running == 0 && state->running == 0 && state->frame != core->transport.frame) {
      // A stopped seek starts a fresh input timeline, not a continuation of the
      // previous DC estimate. A running locate primes with running=0 too:
      // require the previous transport to be stopped, preserving its estimate.
      // Keep musical tails and bypass ramps intact.
      const auto clear_dc = [](UtilityHistory &history) {
        history.dc_x1_left = history.dc_x1_right = 0.0F;
        history.dc_y1_left = history.dc_y1_right = 0.0F;
      };
      clear_dc(core->utility_history);
      for (auto &history : core->utility_histories) clear_dc(history);
    }
#endif
    clear_sample_sources(*core);
    release_instrument_voices(*core);
    core->last_event_sequence = 0;
    for (Core::MixerLatch &latch : core->mixer_latches) latch.mask = 0;
  }
  core->transport = *state;
  core->transport_running.store(state->running != 0, std::memory_order_release);
  if (state->running == 0) {
    core->latency_shrunk_revision = core->published_revision;
    core->latency_budget.store(core->published_graph->minimum_latency, std::memory_order_release);
    core->latency_completed_revision.store(core->published_revision, std::memory_order_release);
  }
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
  const auto index = static_cast<uint32_t>(node_index);
  if (core->prepared_revision != 0) {
    (*core->prepared_instrument_configs)[index].synth = *state;
    return refresh_prepared_node(*core, index);
  }
  (*core->published_instrument_configs)[index].synth = *state;
  set_up_instrument(published_instrument(*core, index), (*core->published_instrument_configs)[index]);
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
  const auto node_slot = static_cast<uint32_t>(node_index);
  auto &configuration = core->prepared_revision != 0
    ? (*core->prepared_instrument_configs)[node_slot] : (*core->published_instrument_configs)[node_slot];
  configuration.sampler = *state;
  for (uint32_t index = 0; index < state->zone_count; ++index) configuration.zones[index] = zones[index];
  for (uint32_t index = state->zone_count; index < configuration.zones.size(); ++index) configuration.zones[index] = {};
  if (core->prepared_revision != 0) return refresh_prepared_node(*core, node_slot);
  InstrumentNodeState &instrument = published_instrument(*core, node_slot);
  set_up_instrument(instrument, configuration);
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
  const auto index = static_cast<uint32_t>(node_index);
  if (core->prepared_revision != 0) {
    (*core->prepared_instrument_configs)[index].granular = *state;
    return refresh_prepared_node(*core, index);
  }
  (*core->published_instrument_configs)[index].granular = *state;
  set_up_instrument(published_instrument(*core, index), (*core->published_instrument_configs)[index]);
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
  for (uint32_t index = 0; index < kMaximumSampleSources; ++index) {
    auto &source = (*core->active_sample_sources)[index];
    if (!source.active) {
      target = &source;
      break;
    }
  }
  if (target == nullptr) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  *target = make_sample_source(*event);
  bind_sample_source_node(*target, *core->published_graph);
  core->last_event_sequence = event->sequence;
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_replace_sample_sources(
  daw_audio_core_handle core_handle,
  uint32_t revision,
  uint32_t epoch,
  const daw_audio_sample_source_replacement_event *events,
  uint32_t event_count) {
  Core *core = to_core(core_handle);
  if (core == nullptr || revision == 0 || epoch == 0
    || revision != core->published_revision || epoch != core->transport.epoch
    || event_count > kMaximumSampleSources || (event_count != 0 && events == nullptr)) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  auto *staged = &inactive_sample_source_table(*core);
  for (SampleSource &source : *staged) source.active = false;
  uint64_t previous_sequence = 0;
  for (uint32_t index = 0; index < event_count; ++index) {
    const daw_audio_sample_source_replacement_event &event = events[index];
    if (event.abi_version != DAW_AUDIO_CORE_ABI_VERSION
      || event.epoch != epoch || event.sequence == 0 || event.sequence <= previous_sequence
      || event.kind > 1) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    if (event.kind == 0) {
      const daw_audio_sample_source_event ordinary{
        .abi_version = event.abi_version,
        .epoch = event.epoch,
        .sequence = event.sequence,
        .source_node_id = event.source_node_id,
        .asset = event.asset,
        .start_frame = event.start_frame,
        .stop_frame = event.stop_frame,
        .source_offset_frame = event.source_offset_frame,
        .source_frame_count = event.source_frame_count,
        .gain = event.gain,
        .fade_in_start_frame = event.fade_in_start_frame,
        .fade_in_end_frame = event.fade_in_end_frame,
        .fade_out_start_frame = event.fade_out_start_frame,
        .fade_out_end_frame = event.fade_out_end_frame,
        .source_offset_fraction = event.source_offset_fraction,
        .fade_in_curve = event.fade_in_curve,
        .fade_in_curve_position = event.fade_in_curve_position,
        .fade_out_curve = event.fade_out_curve,
        .fade_out_curve_position = event.fade_out_curve_position,
      };
      if (!valid_sample_source_event(ordinary)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
      AssetSlot *asset = find_asset(core, ordinary.asset);
      if (asset == nullptr
        || ordinary.source_offset_frame >= asset->frame_count
        || ordinary.source_frame_count > asset->frame_count - ordinary.source_offset_frame) {
        return DAW_AUDIO_CORE_INVALID_HANDLE;
      }
    } else {
      PagedPreparation *preparation = find_paged_preparation(*core, event.preparation);
      if (preparation == nullptr
        || event.stop_frame <= event.start_frame
        || event.source_frame_count == 0
        || !std::isfinite(event.gain)
        || !std::isfinite(event.source_offset_fraction)
        || event.source_offset_fraction < 0.0F || event.source_offset_fraction >= 1.0F
        || event.source_offset_frame < preparation->source_offset_frame
        || event.source_offset_frame > preparation->source_offset_frame + preparation->source_frame_count
        || event.source_frame_count > preparation->source_offset_frame + preparation->source_frame_count
          - event.source_offset_frame
        || event.fade_in_start_frame > event.fade_in_end_frame
        || event.fade_out_start_frame > event.fade_out_end_frame
        || !std::isfinite(event.fade_in_curve) || event.fade_in_curve < -1.0F || event.fade_in_curve > 1.0F
        || !std::isfinite(event.fade_in_curve_position)
        || event.fade_in_curve_position < 0.0F || event.fade_in_curve_position > 1.0F
        || !std::isfinite(event.fade_out_curve) || event.fade_out_curve < -1.0F || event.fade_out_curve > 1.0F
        || !std::isfinite(event.fade_out_curve_position)
        || event.fade_out_curve_position < 0.0F || event.fade_out_curve_position > 1.0F) {
        return preparation == nullptr ? DAW_AUDIO_CORE_INVALID_HANDLE : DAW_AUDIO_CORE_INVALID_ARGUMENT;
      }
    }
    if ((*core->published_graph).revision == core->published_revision) {
      const int32_t node_index = graph_node_index((*core->published_graph), event.source_node_id);
      if (node_index < 0
        || (*core->published_graph).nodes[static_cast<uint32_t>(node_index)].kind != DAW_AUDIO_GRAPH_NODE_SOURCE) {
        return DAW_AUDIO_CORE_INVALID_ARGUMENT;
      }
    } else if (event.source_node_id != 0) {
      return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
    PagedPreparation *preparation = event.kind == 1
      ? find_paged_preparation(*core, event.preparation) : nullptr;
    (*staged)[index] = {
      .source_node_id = event.source_node_id,
      .asset = event.kind == 0 ? event.asset : preparation->asset,
      .start_frame = event.start_frame,
      .stop_frame = event.stop_frame,
      .source_offset_frame = event.source_offset_frame,
      .source_offset_fraction = event.source_offset_fraction,
      .source_frame_count = event.source_frame_count,
      .gain = event.gain,
      .fade_in_start_frame = event.fade_in_start_frame,
      .fade_in_end_frame = event.fade_in_end_frame,
      .fade_out_start_frame = event.fade_out_start_frame,
      .fade_out_end_frame = event.fade_out_end_frame,
      .fade_in_curve = event.fade_in_curve,
      .fade_in_curve_position = event.fade_in_curve_position,
      .fade_out_curve = event.fade_out_curve,
      .fade_out_curve_position = event.fade_out_curve_position,
      .paged_preparation = preparation,
      .paged = event.kind == 1,
      .active = true,
    };
    bind_sample_source_node((*staged)[index], *core->published_graph);
    previous_sequence = event.sequence;
  }
  if (core->transport.running != 0) {
    // A running transport swaps at its own frame: sources that match keep their cursor and the rest fade over 6 ms
    // instead of cutting. A stopped one has nothing sounding, so the table is simply replaced.
    if (!reconcile_sample_sources(*core, {staged->data(), event_count}, core->transport.frame, true)) {
      return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
    }
  } else {
    core->active_sample_sources = staged;
  }
  core->last_event_sequence = event_count == 0 ? 0 : previous_sequence;
  return DAW_AUDIO_CORE_OK;
}

extern "C" uint32_t daw_audio_core_get_paged_sub_abi_version(void) {
  return DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION;
}

extern "C" daw_audio_core_result daw_audio_core_configure_paged_assets(
  daw_audio_core_handle core_handle,
  const daw_audio_paged_asset_config *config) {
  Core *core = to_core(core_handle);
  if (core == nullptr || config == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  return initialize_paged_storage(*core, *config)
    ? DAW_AUDIO_CORE_OK
    : DAW_AUDIO_CORE_INVALID_ARGUMENT;
}

extern "C" daw_audio_core_result daw_audio_core_create_paged_asset(
  daw_audio_core_handle core_handle,
  const daw_audio_paged_asset_descriptor *descriptor,
  daw_audio_asset_handle *out_asset) {
  Core *core = to_core(core_handle);
  if (core == nullptr || descriptor == nullptr || out_asset == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (descriptor->abi_version != DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION
    || descriptor->revision == 0 || descriptor->frame_count == 0
    || descriptor->sample_rate_hz == 0 || descriptor->channel_count == 0
    || descriptor->channel_count > core->paged_config.max_channels
    || core->paged_config.slot_count == 0) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (descriptor->frame_count > UINT64_MAX / descriptor->channel_count / sizeof(float)
    || descriptor->byte_length != descriptor->frame_count * descriptor->channel_count * sizeof(float)) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  for (uint32_t index = 0; index < core->config.max_assets; ++index) {
    AssetSlot &slot = core->assets[index];
    if (slot.occupied) continue;
    slot.occupied = true;
    slot.paged = true;
    slot.revision = descriptor->revision;
    slot.frame_count = descriptor->frame_count;
    slot.sample_rate_hz = descriptor->sample_rate_hz;
    slot.channel_count = descriptor->channel_count;
    slot.planes = nullptr;
    *out_asset = make_asset_handle(index, slot.generation);
    return DAW_AUDIO_CORE_OK;
  }
  return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
}

extern "C" daw_audio_core_result daw_audio_core_write_paged_asset_page(
  daw_audio_core_handle core_handle,
  const daw_audio_paged_asset_page_write *write) {
  Core *core = to_core(core_handle);
  if (core == nullptr || write == nullptr || write->planes == nullptr
    || write->abi_version != DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  AssetSlot *asset = find_asset(core, write->asset);
  if (asset == nullptr || !asset->paged) return DAW_AUDIO_CORE_INVALID_HANDLE;
  if (write->channel_count != asset->channel_count
    || write->channel_count > core->paged_config.max_channels
    || write->page_index >= paged_page_count(*core, asset->frame_count)) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  const uint64_t page_start = write->page_index
    * static_cast<uint64_t>(core->paged_config.page_frames);
  const uint32_t expected_frames = static_cast<uint32_t>(
    std::min<uint64_t>(core->paged_config.page_frames, asset->frame_count - page_start));
  if (write->valid_frames != expected_frames) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  for (uint32_t channel = 0; channel < write->channel_count; ++channel) {
    if (write->planes[channel] == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  PagedPageSlot *existing = find_paged_page(*core, write->asset, write->page_index);
  if (existing != nullptr) {
    bool duplicate = true;
    for (uint32_t channel = 0; channel < write->channel_count && duplicate; ++channel) {
      const float *destination = paged_storage_plane(*core,
        static_cast<uint32_t>(existing - core->paged_slots.get()), channel);
      for (uint32_t frame = 0; frame < expected_frames; ++frame) {
        if (destination[frame] != write->planes[channel][frame]) {
          duplicate = false;
          break;
        }
      }
    }
    if (duplicate) return DAW_AUDIO_CORE_OK;
    if (existing->pin_count.load(std::memory_order_acquire) != 0) return DAW_AUDIO_CORE_ASSET_IN_USE;
  }
  const uint32_t selected = existing == nullptr
    ? select_paged_page_slot(*core, write->asset, write->page_index)
    : static_cast<uint32_t>(existing - core->paged_slots.get());
  if (selected >= core->paged_config.slot_count) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  PagedPageSlot &page = core->paged_slots[selected];
  if (page.pin_count.load(std::memory_order_acquire) != 0) return DAW_AUDIO_CORE_ASSET_IN_USE;
  page.owner.store(0, std::memory_order_release);
  for (uint32_t channel = 0; channel < core->paged_config.max_channels; ++channel) {
    float *destination = paged_storage_plane(*core, selected, channel);
    if (channel < write->channel_count) {
      for (uint32_t frame = 0; frame < expected_frames; ++frame) destination[frame] = write->planes[channel][frame];
    }
    for (uint32_t frame = expected_frames; frame < core->paged_config.page_frames; ++frame) destination[frame] = 0.0F;
  }
  page.page_index = write->page_index;
  page.valid_frames = expected_frames;
  page.access_sequence = ++core->paged_access_sequence;
  page.owner.store(write->asset, std::memory_order_release);
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_prepare_paged_asset(
  daw_audio_core_handle core_handle,
  const daw_audio_paged_asset_prepare_request *request,
  daw_audio_paged_preparation_handle *out_preparation,
  uint64_t *out_first_missing_page) {
  Core *core = to_core(core_handle);
  if (out_preparation != nullptr) *out_preparation = 0;
  if (out_first_missing_page != nullptr) *out_first_missing_page = 0;
  if (core == nullptr || request == nullptr || out_preparation == nullptr
    || out_first_missing_page == nullptr
    || request->abi_version != DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION
    || request->source_frame_count == 0) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  AssetSlot *asset = find_asset(core, request->asset);
  if (asset == nullptr || !asset->paged) return DAW_AUDIO_CORE_INVALID_HANDLE;
  if (request->source_offset_frame >= asset->frame_count
    || request->source_frame_count > asset->frame_count - request->source_offset_frame
    || request->interpolation_guard_frames > 1) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (request->source_frame_count > UINT64_MAX - request->source_offset_frame
    || request->interpolation_guard_frames > UINT64_MAX
      - request->source_offset_frame - request->source_frame_count) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  const uint64_t source_end = request->source_offset_frame + request->source_frame_count;
  const uint64_t guarded_end = source_end > UINT64_MAX - request->interpolation_guard_frames
    ? UINT64_MAX
    : source_end + request->interpolation_guard_frames;
  const uint64_t end = std::min(asset->frame_count, guarded_end);
  const uint64_t first_page = request->source_offset_frame
    / static_cast<uint64_t>(core->paged_config.page_frames);
  const uint64_t last_page = (end - 1u)
    / static_cast<uint64_t>(core->paged_config.page_frames);
  const uint64_t page_count64 = last_page - first_page + 1u;
  if (page_count64 > core->paged_config.slot_count
    || page_count64 > DAW_AUDIO_CORE_MAX_PAGED_PREPARATION_PAGES) {
    return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
  for (uint64_t index = 0; index < page_count64; ++index) {
    const uint64_t page_index = first_page + index;
    if (find_paged_page(*core, request->asset, page_index) == nullptr) {
      *out_first_missing_page = page_index;
      return DAW_AUDIO_CORE_NO_DATA;
    }
  }
  uint32_t preparation_index = DAW_AUDIO_CORE_MAX_PAGED_PREPARATIONS;
  for (uint32_t index = 0; index < DAW_AUDIO_CORE_MAX_PAGED_PREPARATIONS; ++index) {
    if (!core->paged_preparations[index].occupied) {
      preparation_index = index;
      break;
    }
  }
  if (preparation_index == DAW_AUDIO_CORE_MAX_PAGED_PREPARATIONS) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  PagedPreparation &preparation = core->paged_preparations[preparation_index];
  preparation.asset = request->asset;
  preparation.source_offset_frame = request->source_offset_frame;
  preparation.source_frame_count = request->source_frame_count;
  preparation.first_page = first_page;
  preparation.page_count = static_cast<uint32_t>(page_count64);
  for (uint32_t index = 0; index < preparation.page_count; ++index) {
    PagedPageSlot *page = find_paged_page(*core, request->asset, first_page + index);
    preparation.page_slots[index] = static_cast<uint16_t>(page - core->paged_slots.get());
    page->pin_count.fetch_add(1, std::memory_order_acq_rel);
    page->access_sequence = ++core->paged_access_sequence;
  }
  preparation.occupied = true;
  *out_preparation = make_paged_preparation_handle(preparation_index, preparation.generation);
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_schedule_prepared_sample_source(
  daw_audio_core_handle core_handle,
  const daw_audio_paged_sample_source_event *event) {
  Core *core = to_core(core_handle);
  if (core == nullptr || event == nullptr
    || event->abi_version != DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION
    || event->preparation == 0 || event->epoch == 0 || event->sequence == 0
    || event->stop_frame <= event->start_frame || event->source_frame_count == 0
    || !std::isfinite(event->gain) || !std::isfinite(event->source_offset_fraction)
    || event->source_offset_fraction < 0.0F || event->source_offset_fraction >= 1.0F
    || event->epoch != core->transport.epoch || event->sequence <= core->last_event_sequence) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  PagedPreparation *preparation = find_paged_preparation(*core, event->preparation);
  if (preparation == nullptr) return DAW_AUDIO_CORE_INVALID_HANDLE;
  if (event->source_offset_frame < preparation->source_offset_frame
    || event->source_offset_frame > preparation->source_offset_frame + preparation->source_frame_count
    || event->source_frame_count > preparation->source_offset_frame + preparation->source_frame_count
      - event->source_offset_frame) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if ((*core->published_graph).revision == core->published_revision) {
    const int32_t node_index = graph_node_index((*core->published_graph), event->source_node_id);
    if (node_index < 0 || (*core->published_graph).nodes[static_cast<uint32_t>(node_index)].kind
      != DAW_AUDIO_GRAPH_NODE_SOURCE) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  } else if (event->source_node_id != 0) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  SampleSource *target = nullptr;
  for (uint32_t index = 0; index < kMaximumSampleSources; ++index) {
    auto &source = (*core->active_sample_sources)[index];
    if (!source.active) {
      target = &source;
      break;
    }
  }
  if (target == nullptr) return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  *target = {
    .source_node_id = event->source_node_id, .asset = preparation->asset,
    .start_frame = event->start_frame, .stop_frame = event->stop_frame,
    .source_offset_frame = event->source_offset_frame,
    .source_offset_fraction = event->source_offset_fraction,
    .source_frame_count = event->source_frame_count, .gain = event->gain,
    .fade_in_start_frame = event->fade_in_start_frame, .fade_in_end_frame = event->fade_in_end_frame,
    .fade_out_start_frame = event->fade_out_start_frame, .fade_out_end_frame = event->fade_out_end_frame,
    .fade_in_curve = event->fade_in_curve, .fade_in_curve_position = event->fade_in_curve_position,
    .fade_out_curve = event->fade_out_curve, .fade_out_curve_position = event->fade_out_curve_position,
    .paged_preparation = preparation, .paged = true, .active = true,
  };
  bind_sample_source_node(*target, *core->published_graph);
  core->last_event_sequence = event->sequence;
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_release_paged_preparation(
  daw_audio_core_handle core_handle,
  daw_audio_paged_preparation_handle handle) {
  Core *core = to_core(core_handle);
  if (core == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  PagedPreparation *preparation = find_paged_preparation(*core, handle);
  if (preparation == nullptr) return DAW_AUDIO_CORE_INVALID_HANDLE;
  for (const SampleSource &source : *core->active_sample_sources) {
    if (source.active && source.paged_preparation == preparation) return DAW_AUDIO_CORE_ASSET_IN_USE;
  }
  for (uint32_t index = 0; index < preparation->page_count; ++index) {
    PagedPageSlot &page = core->paged_slots[preparation->page_slots[index]];
    uint32_t pin_count = page.pin_count.load(std::memory_order_acquire);
    while (pin_count != 0
      && !page.pin_count.compare_exchange_weak(
        pin_count, pin_count - 1, std::memory_order_acq_rel, std::memory_order_acquire)) {
    }
  }
  preparation->occupied = false;
  preparation->asset = 0;
  preparation->page_count = 0;
  ++preparation->generation;
  if (preparation->generation == 0) ++preparation->generation;
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_trim_paged_asset(
  daw_audio_core_handle core_handle,
  daw_audio_asset_handle asset_handle,
  uint64_t first_page,
  uint32_t page_count) {
  Core *core = to_core(core_handle);
  if (core == nullptr || page_count == 0) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  if (first_page > UINT64_MAX - page_count) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  AssetSlot *asset = find_asset(core, asset_handle);
  if (asset == nullptr || !asset->paged) return DAW_AUDIO_CORE_INVALID_HANDLE;
  const uint64_t last_page = first_page + page_count;
  for (uint32_t index = 0; index < DAW_AUDIO_CORE_MAX_PAGED_PREPARATIONS; ++index) {
    const PagedPreparation &preparation = core->paged_preparations[index];
    if (!preparation.occupied || preparation.asset != asset_handle) continue;
    const uint64_t preparation_last_page = preparation.first_page
      > UINT64_MAX - preparation.page_count
      ? UINT64_MAX
      : preparation.first_page + preparation.page_count;
    if (preparation.first_page < last_page
      && preparation_last_page > first_page) return DAW_AUDIO_CORE_ASSET_IN_USE;
  }
  for (uint32_t slot = 0; slot < core->paged_config.slot_count; ++slot) {
    PagedPageSlot &page = core->paged_slots[slot];
    if (page.owner.load(std::memory_order_acquire) == asset_handle
      && page.page_index >= first_page && page.page_index < last_page) {
      if (page.pin_count.load(std::memory_order_acquire) != 0) return DAW_AUDIO_CORE_ASSET_IN_USE;
    }
  }
  for (uint32_t slot = 0; slot < core->paged_config.slot_count; ++slot) {
    PagedPageSlot &page = core->paged_slots[slot];
    if (page.owner.load(std::memory_order_acquire) == asset_handle
      && page.page_index >= first_page && page.page_index < last_page) page.owner.store(0, std::memory_order_release);
  }
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
  // Reconfigure is stopped, with no concurrent reader. Portable rings are sized
  // from the first graph's actual readers, rather than native transition capacity.
  wasm_asset_core.reset();
  wasm_asset_core.reset(new (std::nothrow) Core{});
  if (wasm_asset_core == nullptr || !initialize_core_storage(*wasm_asset_core)) {
    wasm_asset_core.reset();
    wasm_graph_core = nullptr;
    return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
  wasm_graph_core = wasm_asset_core.get();
  wasm_graph_core->config = config;
  if (!allocate_graph_stage_buffers(*wasm_graph_core)) {
    wasm_asset_core.reset();
    wasm_graph_core = nullptr;
    return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
  const daw_audio_paged_asset_config paged_config{
    .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
    .page_frames = DAW_AUDIO_CORE_WASM_PAGED_PAGE_FRAMES,
    .slot_count = DAW_AUDIO_CORE_WASM_PAGED_PAGE_SLOTS,
    .max_channels = std::min(max_channels, DAW_AUDIO_CORE_WASM_PAGED_MAX_CHANNELS),
  };
  if (!initialize_paged_storage(*wasm_graph_core, paged_config)) {
    wasm_asset_core.reset();
    wasm_graph_core = nullptr;
    return DAW_AUDIO_CORE_CAPACITY_EXCEEDED;
  }
  wasm_graph_max_input_buses = max_input_buses;
  wasm_asset_initialized = false;
  wasm_graph_initialized = true;
  return DAW_AUDIO_CORE_OK;
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_prepare(
  const uint8_t *graph_bytes,
  uint32_t graph_byte_count) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  std::array<daw_audio_graph_node_descriptor, kMaximumLiveNodes> nodes{};
  std::array<daw_audio_graph_edge_descriptor, kMaximumLiveEdges> edges{};
  std::array<daw_audio_processor_descriptor, kMaximumLiveProcessors> processors{};
  std::array<std::array<uint32_t, DAW_AUDIO_CORE_MAX_PROCESSOR_PARAMETERS>, kMaximumLiveProcessors> targets{};
  std::array<std::array<uint8_t, DAW_AUDIO_CORE_MAX_PROCESSOR_STATE_BYTES>, kMaximumLiveProcessors> states{};
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

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_replace_sample_sources(
  uint32_t revision,
  uint32_t epoch,
  const uint8_t *event_bytes,
  uint32_t event_byte_count) {
  if (!wasm_graph_initialized || wasm_graph_core == nullptr
    || revision == 0 || epoch == 0 || event_bytes == nullptr || event_byte_count < 4) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  uint32_t offset = 0;
  uint32_t event_count = 0;
  if (!wasm_read_u32(event_bytes, event_byte_count, &offset, &event_count)
    || event_count > kMaximumSampleSources
    || event_count > UINT32_MAX / 120u
    || event_byte_count - offset != event_count * 120u) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  std::array<daw_audio_sample_source_replacement_event, kMaximumSampleSources> events{};
  for (uint32_t index = 0; index < event_count; ++index) {
    auto &event = events[index];
    if (!wasm_read_u32(event_bytes, event_byte_count, &offset, &event.kind)
      || !wasm_read_u32(event_bytes, event_byte_count, &offset, &event.reserved)
      || !wasm_read_u64(event_bytes, event_byte_count, &offset, &event.sequence)
      || !wasm_read_u64(event_bytes, event_byte_count, &offset, &event.source_node_id)
      || !wasm_read_u64(event_bytes, event_byte_count, &offset,
        event.kind == 0 ? &event.asset : &event.preparation)
      || !wasm_read_i64(event_bytes, event_byte_count, &offset, &event.start_frame)
      || !wasm_read_i64(event_bytes, event_byte_count, &offset, &event.stop_frame)
      || !wasm_read_u64(event_bytes, event_byte_count, &offset, &event.source_offset_frame)
      || !wasm_read_u64(event_bytes, event_byte_count, &offset, &event.source_frame_count)
      || !wasm_read_f32(event_bytes, event_byte_count, &offset, &event.gain)
      || !wasm_read_i64(event_bytes, event_byte_count, &offset, &event.fade_in_start_frame)
      || !wasm_read_i64(event_bytes, event_byte_count, &offset, &event.fade_in_end_frame)
      || !wasm_read_i64(event_bytes, event_byte_count, &offset, &event.fade_out_start_frame)
      || !wasm_read_i64(event_bytes, event_byte_count, &offset, &event.fade_out_end_frame)
      || !wasm_read_f32(event_bytes, event_byte_count, &offset, &event.source_offset_fraction)
      || !wasm_read_f32(event_bytes, event_byte_count, &offset, &event.fade_in_curve)
      || !wasm_read_f32(event_bytes, event_byte_count, &offset, &event.fade_in_curve_position)
      || !wasm_read_f32(event_bytes, event_byte_count, &offset, &event.fade_out_curve)
      || !wasm_read_f32(event_bytes, event_byte_count, &offset, &event.fade_out_curve_position)) {
      return DAW_AUDIO_CORE_INVALID_ARGUMENT;
    }
    event.abi_version = DAW_AUDIO_CORE_ABI_VERSION;
    event.epoch = epoch;
  }
  return daw_audio_core_replace_sample_sources(
    to_handle(wasm_graph_core), revision, epoch, events.data(), event_count);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_reset_sample_sources(
  uint32_t revision,
  uint32_t epoch) {
  if (!wasm_graph_initialized || wasm_graph_core == nullptr
    || revision == 0 || epoch == 0
    || wasm_graph_core->published_revision != revision
    || wasm_graph_core->transport.epoch != epoch) {
    return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  }
  clear_sample_sources(*wasm_graph_core);
  wasm_graph_core->last_event_sequence = 0;
  return DAW_AUDIO_CORE_OK;
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

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_create_paged_asset(
  uint64_t frame_count,
  uint32_t sample_rate_hz,
  uint32_t channel_count,
  daw_audio_asset_handle *out_asset) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  const daw_audio_paged_asset_descriptor descriptor{
    .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
    .revision = 1,
    .byte_length = frame_count * static_cast<uint64_t>(channel_count) * sizeof(float),
    .content_hash_prefix = 0,
    .frame_count = frame_count,
    .sample_rate_hz = sample_rate_hz,
    .channel_count = channel_count,
  };
  return daw_audio_core_create_paged_asset(to_handle(wasm_graph_core), &descriptor, out_asset);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_write_paged_asset_page(
  daw_audio_asset_handle asset,
  uint64_t page_index,
  uint32_t valid_frames,
  uint32_t channel_count,
  const float *const *planes) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  const daw_audio_paged_asset_page_write write{
    .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
    .asset = asset,
    .page_index = page_index,
    .valid_frames = valid_frames,
    .channel_count = channel_count,
    .planes = planes,
  };
  return daw_audio_core_write_paged_asset_page(to_handle(wasm_graph_core), &write);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_prepare_paged_asset(
  daw_audio_asset_handle asset,
  uint64_t source_offset_frame,
  uint64_t source_frame_count,
  uint32_t interpolation_guard_frames,
  daw_audio_paged_preparation_handle *out_preparation,
  uint64_t *out_first_missing_page) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  const daw_audio_paged_asset_prepare_request request{
    .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
    .asset = asset,
    .source_offset_frame = source_offset_frame,
    .source_frame_count = source_frame_count,
    .interpolation_guard_frames = interpolation_guard_frames,
    .reserved = 0,
  };
  return daw_audio_core_prepare_paged_asset(
    to_handle(wasm_graph_core), &request, out_preparation, out_first_missing_page);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_schedule_prepared_sample_source(
  uint32_t epoch,
  uint64_t sequence,
  uint64_t source_node_id,
  daw_audio_paged_preparation_handle preparation,
  int64_t start_frame,
  int64_t stop_frame,
  uint64_t source_offset_frame,
  uint64_t source_frame_count,
  float source_offset_fraction,
  float gain,
  int64_t fade_in_start_frame,
  int64_t fade_in_end_frame,
  int64_t fade_out_start_frame,
  int64_t fade_out_end_frame,
  float fade_in_curve,
  float fade_in_curve_position,
  float fade_out_curve,
  float fade_out_curve_position) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  const daw_audio_paged_sample_source_event event{
    .abi_version = DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION,
    .epoch = epoch,
    .sequence = sequence,
    .source_node_id = source_node_id,
    .preparation = preparation,
    .start_frame = start_frame,
    .stop_frame = stop_frame,
    .source_offset_frame = source_offset_frame,
    .source_frame_count = source_frame_count,
    .source_offset_fraction = source_offset_fraction,
    .gain = gain,
    .fade_in_start_frame = fade_in_start_frame,
    .fade_in_end_frame = fade_in_end_frame,
    .fade_out_start_frame = fade_out_start_frame,
    .fade_out_end_frame = fade_out_end_frame,
    .fade_in_curve = fade_in_curve,
    .fade_in_curve_position = fade_in_curve_position,
    .fade_out_curve = fade_out_curve,
    .fade_out_curve_position = fade_out_curve_position,
  };
  return daw_audio_core_schedule_prepared_sample_source(to_handle(wasm_graph_core), &event);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_release_paged_preparation(
  daw_audio_paged_preparation_handle preparation) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  return daw_audio_core_release_paged_preparation(to_handle(wasm_graph_core), preparation);
}

extern "C" daw_audio_core_result daw_audio_core_wasm_graph_trim_paged_asset(
  daw_audio_asset_handle asset,
  uint64_t first_page,
  uint32_t page_count) {
  if (!wasm_graph_initialized) return DAW_AUDIO_CORE_NOT_PREPARED;
  return daw_audio_core_trim_paged_asset(to_handle(wasm_graph_core), asset, first_page, page_count);
}

extern "C" uint32_t daw_audio_core_wasm_graph_paged_sub_abi_version(void) {
  return DAW_AUDIO_CORE_PAGED_ASSET_ABI_VERSION;
}

extern "C" uint32_t daw_audio_core_wasm_graph_paged_page_frames(void) {
  return DAW_AUDIO_CORE_WASM_PAGED_PAGE_FRAMES;
}

extern "C" uint32_t daw_audio_core_wasm_graph_paged_slot_count(void) {
  return DAW_AUDIO_CORE_WASM_PAGED_PAGE_SLOTS;
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
    slot.paged = false;
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

void release_asset_storage(Core *core, AssetSlot *slot, daw_audio_asset_handle asset) {
  slot->occupied = false;
  slot->revision = 0;
  slot->frame_count = 0;
  slot->sample_rate_hz = 0;
  slot->channel_count = 0;
  slot->planes = nullptr;
  slot->paged = false;
  if (core->paged_slots != nullptr) {
    for (uint32_t index = 0; index < core->paged_config.slot_count; ++index) {
      PagedPageSlot &page = core->paged_slots[index];
      if (page.owner.load(std::memory_order_acquire) == asset) page.owner.store(0, std::memory_order_release);
    }
  }
  ++slot->generation;
  if (slot->generation == 0) ++slot->generation;
}

extern "C" daw_audio_core_result daw_audio_core_release_asset(
  daw_audio_core_handle core_handle,
  daw_audio_asset_handle asset) {
  Core *core = to_core(core_handle);
  if (core == nullptr) return DAW_AUDIO_CORE_INVALID_ARGUMENT;
  AssetSlot *slot = find_asset(core, asset);
  if (slot == nullptr) return DAW_AUDIO_CORE_INVALID_HANDLE;
  if (asset_is_active(*core, asset)) return DAW_AUDIO_CORE_ASSET_IN_USE;
  release_asset_storage(core, slot, asset);
  return DAW_AUDIO_CORE_OK;
}

#if defined(DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS)
// DAW_REALTIME_CALLBACK_HELPER_BEGIN native-source-seam-declarations
bool daw::audio_core::ReconcileSampleSources(daw_audio_core_handle handle,
  std::span<const daw_audio_sample_source_event> events, int64_t frame, bool apply) noexcept {
  Core *core = to_core(handle);
  if (core == nullptr || events.size() > kMaximumSampleSources) return false;
  uint64_t floor = core->last_event_sequence;
  const auto &graph = configuration_graph(*core);
  // Only a hard replace stages in the inactive table, and the host never calls it, so the callback may borrow it.
  auto &declared = inactive_sample_source_table(*core);
  for (uint32_t index = 0; index < events.size(); ++index) {
    const auto &event = events[index];
    if (!valid_sample_source_event(event) || event.start_frame > frame || event.stop_frame <= frame
      || event.epoch != core->transport.epoch || event.sequence <= floor) return false;
    floor = event.sequence;
    const auto *asset = find_asset(core, event.asset);
    if (asset == nullptr || event.source_offset_frame >= asset->frame_count
      || event.source_frame_count > asset->frame_count - event.source_offset_frame) return false;
    const auto node = graph_node_index(graph, event.source_node_id);
    if (node < 0 || graph.nodes[static_cast<uint32_t>(node)].kind != DAW_AUDIO_GRAPH_NODE_SOURCE) return false;
    declared[index] = make_sample_source(event);
    bind_sample_source_node(declared[index], graph);
  }
  if (!reconcile_sample_sources(*core, {declared.data(), events.size()}, frame, apply)) return false;
  if (apply) core->last_event_sequence = floor;
  return true;
}
// DAW_REALTIME_CALLBACK_HELPER_END native-source-seam-declarations

void daw::audio_core::RequestAssetRetirement(daw_audio_core_handle handle, daw_audio_asset_handle asset) noexcept {
  Core *core = to_core(handle);
  uint32_t index = 0, generation = 0;
  if (core == nullptr || !decode_asset_handle(asset, &index, &generation)
    || index >= core->config.max_assets || find_asset(core, asset) == nullptr) return;
  auto& retirement = core->asset_retirements[index];
  auto open = retirement.load(std::memory_order_acquire);
  if ((open & 3U) == 0) retirement.compare_exchange_strong(open, open + 1, std::memory_order_release);
}

void daw::audio_core::CancelAssetRetirement(daw_audio_core_handle handle, daw_audio_asset_handle asset) noexcept {
  Core *core = to_core(handle);
  uint32_t index = 0, generation = 0;
  if (core == nullptr || !decode_asset_handle(asset, &index, &generation)
    || index >= core->config.max_assets || find_asset(core, asset) == nullptr) return;
  auto& retirement = core->asset_retirements[index];
  // Advance the ticket even when the callback is scanning this request. An old
  // scan cannot acknowledge a later request after renewed ownership (ABA).
  auto previous = retirement.load(std::memory_order_acquire);
  while (!retirement.compare_exchange_weak(previous, (previous & ~uint64_t{3}) + 4,
    std::memory_order_acq_rel)) {}
}

// DAW_REALTIME_CALLBACK_HELPER_BEGIN native-asset-reader-completion
bool daw::audio_core::CompleteAssetReaders(daw_audio_core_handle handle, uint64_t completing_epoch) noexcept {
  Core *core = to_core(handle);
  if (core == nullptr) return false;
  bool pending = false;
  for (uint32_t index = 0; index < core->config.max_assets; ++index)
    pending = pending || (core->asset_retirements[index].load(std::memory_order_acquire) & 3U) == 1;
  if (!pending) return false;
  bool ready = false;
  std::array<bool, kMaximumAssets> referenced{};
  const auto retain = [&](daw_audio_asset_handle asset) {
    uint32_t index = 0, generation = 0;
    if (decode_asset_handle(asset, &index, &generation) && index < core->config.max_assets) referenced[index] = true;
  };
  for (const auto &source : *core->active_sample_sources)
    if (source.active) retain(source.asset);
  for (uint32_t node = 0; node < kNodeRuntimeSlots; ++node) {
    // Prepared configuration belongs to the control thread and is protected
    // by its host lease. Only active/fading runtimes are callback readers.
    if (core->node_slots[node].state.load(std::memory_order_acquire) != kSlotActive) continue;
    const auto &instrument = core->instrument_runtime[node];
    for (uint32_t zone = 0; zone < instrument.sampler.zone_count; ++zone) retain(instrument.zones[zone].asset);
    for (const auto &voice : instrument.sample_voices) if (voice.active) retain(voice.asset);
    retain(instrument.granular.asset);
  }
  for (uint32_t index = 0; index < core->config.max_assets; ++index) {
    auto &retirement = core->asset_retirements[index];
    auto requested = retirement.load(std::memory_order_acquire);
    if ((requested & 3U) != 1) continue;
    // This host extension owns resident/mapped assets only. Portable paged
    // cache preparations keep their separate pin-count/release contract.
    if (!referenced[index] && !core->assets[index].paged) {
      core->asset_retirement_epochs[index].store(completing_epoch, std::memory_order_relaxed);
      ready = retirement.compare_exchange_strong(requested, requested + 1, std::memory_order_release) || ready;
    }
  }
  return ready;
}
// DAW_REALTIME_CALLBACK_HELPER_END native-asset-reader-completion

bool daw::audio_core::ReclaimAsset(daw_audio_core_handle handle, daw_audio_asset_handle asset,
  bool device_stopped, uint64_t completed_epoch) noexcept {
  Core *core = to_core(handle);
  if (core == nullptr) return false;
  uint32_t index = 0, generation = 0;
  if (!decode_asset_handle(asset, &index, &generation) || index >= core->config.max_assets) return false;
  auto &retirement = core->asset_retirements[index];
  if (device_stopped) {
    if (asset_is_active(*core, asset)) return false;
  } else if ((retirement.load(std::memory_order_acquire) & 3U) != 2
    || completed_epoch < core->asset_retirement_epochs[index].load(std::memory_order_relaxed)) return false;
  AssetSlot *slot = find_asset(core, asset);
  if (slot == nullptr) return false;
  // The callback never touches ready metadata. The host waits for the completed
  // render epoch before entering here and forbids new references meanwhile.
  release_asset_storage(core, slot, asset);
  const auto previous = retirement.load(std::memory_order_relaxed);
  retirement.store((previous & ~uint64_t{3}) + 4, std::memory_order_release);
  return true;
}
#endif
