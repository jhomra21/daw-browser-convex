cmake_minimum_required(VERSION 3.20)
project(daw_audio_core LANGUAGES C CXX)
include(CTest)

option(DAW_AUDIO_CORE_BUILD_WASM "Build the optimized production Emscripten audio core." OFF)
option(DAW_AUDIO_CORE_BUILD_WASM_HARNESS "Build the Emscripten-compatible audio-core fixture harness." OFF)

set(DAW_AUDIO_CORE_SOURCES
  ${CMAKE_CURRENT_SOURCE_DIR}/src/audio_core.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/audio_core_assets.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/audio_core_graph_prepare.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/audio_core_graph_render.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/audio_core_instruments.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/audio_core_mixer.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/audio_core_native_hooks.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/audio_core_parameters.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/audio_core_prepare.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/audio_core_process.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/audio_core_publication.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/audio_core_recording.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/audio_core_slots.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/audio_core_sources.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/audio_core_validation.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/audio_core_wasm.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/processor_autofilter.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/processor_compressor.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/processor_delay.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/processor_eq.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/processor_gate.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/processor_limiter.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/processor_lofi.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/processor_modulation.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/processor_registry.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/processor_reverb.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/processor_saturator.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/processor_spectral.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/processor_utility.cpp
)
# The host test compiles the core with its own fault-injection definition instead of linking the library.
set(DAW_AUDIO_CORE_SOURCES ${DAW_AUDIO_CORE_SOURCES} PARENT_SCOPE)
add_library(daw-audio-core STATIC ${DAW_AUDIO_CORE_SOURCES})
target_compile_features(daw-audio-core PUBLIC cxx_std_20)
target_include_directories(daw-audio-core PUBLIC include generated)
if(NOT CMAKE_SYSTEM_NAME STREQUAL "Emscripten")
  target_compile_definitions(
    daw-audio-core
    PUBLIC
      DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS=1
      DAW_AUDIO_CORE_USE_PERSISTENT_VALIDATION_SCRATCH=1
  )
endif()

if(MSVC)
  target_compile_options(daw-audio-core PRIVATE /W4 /WX /EHs-c- /GR-)
else()
  target_compile_options(daw-audio-core PRIVATE -Wall -Wextra -Werror -fno-exceptions -fno-rtti)
endif()

if(BUILD_TESTING)
  add_executable(daw-audio-core-test tests/audio_core_test.cpp tests/utility_fixture.cpp tests/graph_fixture.cpp)
  target_compile_features(daw-audio-core-test PRIVATE cxx_std_20)
  target_link_libraries(daw-audio-core-test PRIVATE daw-audio-core)
  add_test(NAME daw-audio-core-test COMMAND daw-audio-core-test)
  add_test(NAME daw-spectral-spectral-transfer-late COMMAND daw-audio-core-test --phase-4-contract spectral-transfer-late)
  foreach(contract IN ITEMS spectral-snapshot-mode spectral-frozen-tone spectral-transfer-flat
      spectral-transfer-pink spectral-transfer-narrow spectral-transfer-endpoints
      spectral-transfer-relearn spectral-recapture-bound
      spectral-freeze-gesture-0 spectral-freeze-gesture-1
      spectral-freeze-gesture-2 spectral-freeze-gesture-3
      spectral-freeze-toggle-0 spectral-freeze-toggle-1)
    add_test(NAME daw-spectral-${contract}
      COMMAND daw-audio-core-test --phase-4-contract ${contract})
  endforeach()
  add_test(NAME daw-phase6i-replacement-silences-the-voices-of-a-missing-zone
    COMMAND daw-audio-core-test --phase-6i-contract zones-gone-heard)
  # A voice that names a zone the instrument no longer has is cleared by the next render block, so no audio or public
  # status shows it. Only this variant, which includes the core sources, can read the carried voices.
  add_executable(daw-audio-core-voice-state-test tests/audio_core_test.cpp tests/utility_fixture.cpp tests/graph_fixture.cpp)
  target_compile_features(daw-audio-core-voice-state-test PRIVATE cxx_std_20)
  target_include_directories(daw-audio-core-voice-state-test PRIVATE include generated)
  target_compile_definitions(daw-audio-core-voice-state-test PRIVATE
    DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS=1 DAW_AUDIO_CORE_USE_PERSISTENT_VALIDATION_SCRATCH=1
    DAW_AUDIO_CORE_TEST_SPECTRAL_INTERNALS=1)
  add_test(NAME daw-phase6i-replacement-leaves-no-voice-on-a-missing-zone
    COMMAND daw-audio-core-voice-state-test --phase-6i-contract zones-gone)
  # Shared DSP blocks (src/dsp, header-only). One ctest per block group; the executable prints each measured value.
  add_executable(daw-dsp-blocks-test tests/dsp_blocks_test.cpp)
  target_compile_features(daw-dsp-blocks-test PRIVATE cxx_std_20)
  if(MSVC)
    target_compile_options(daw-dsp-blocks-test PRIVATE /W4 /WX /EHs-c- /GR-)
  else()
    target_compile_options(daw-dsp-blocks-test PRIVATE -Wall -Wextra -Werror -fno-exceptions -fno-rtti)
  endif()
  foreach(group IN ITEMS smoother safety latency delay oversampler adaa filters lfo)
    add_test(NAME daw-dsp-blocks-${group} COMMAND daw-dsp-blocks-test ${group})
  endforeach()
  # Auto Filter kernel (src/autofilter_kernel.h). One ctest per measurement group; the executable prints each value.
  add_executable(daw-autofilter-test tests/autofilter_test.cpp)
  target_compile_features(daw-autofilter-test PRIVATE cxx_std_20)
  if(MSVC)
    target_compile_options(daw-autofilter-test PRIVATE /W4 /WX /EHs-c- /GR-)
  else()
    target_compile_options(daw-autofilter-test PRIVATE -Wall -Wextra -Werror -fno-exceptions -fno-rtti)
  endif()
  foreach(group IN ITEMS clean alias latency resonance slope switch modulation safety)
    add_test(NAME daw-autofilter-${group} COMMAND daw-autofilter-test ${group})
  endforeach()
  # Chorus/Flanger, Ensemble and Phaser kernels. One ctest per measurement group; the executable prints each value.
  add_executable(daw-modulation-test tests/modulation_test.cpp)
  target_compile_features(daw-modulation-test PRIVATE cxx_std_20)
  if(MSVC)
    target_compile_options(daw-modulation-test PRIVATE /W4 /WX /EHs-c- /GR-)
  else()
    target_compile_options(daw-modulation-test PRIVATE -Wall -Wextra -Werror -fno-exceptions -fno-rtti)
  endif()
  foreach(group IN ITEMS loop level feedback latency safety stereo average pan sync click)
    add_test(NAME daw-modulation-${group} COMMAND daw-modulation-test ${group})
  endforeach()
  # Limiter kernel (src/limiter_kernel.h). One ctest per measurement group; the executable prints each value.
  add_executable(daw-limiter-test tests/limiter_test.cpp)
  target_compile_features(daw-limiter-test PRIVATE cxx_std_20)
  if(MSVC)
    target_compile_options(daw-limiter-test PRIVATE /W4 /WX /EHs-c- /GR-)
  else()
    target_compile_options(daw-limiter-test PRIVATE -Wall -Wextra -Werror -fno-exceptions -fno-rtti)
  endif()
  foreach(group IN ITEMS attack ceiling lowrate gain auto latency clean safety cpu)
    add_test(NAME daw-limiter-${group} COMMAND daw-limiter-test ${group})
  endforeach()
  # Compressor kernel (src/compressor_kernel.h). One ctest per measurement group; the executable prints each value.
  add_executable(daw-compressor-test tests/compressor_test.cpp)
  target_compile_features(daw-compressor-test PRIVATE cxx_std_20)
  if(MSVC)
    target_compile_options(daw-compressor-test PRIVATE /W4 /WX /EHs-c- /GR-)
  else()
    target_compile_options(daw-compressor-test PRIVATE -Wall -Wextra -Werror -fno-exceptions -fno-rtti)
  endif()
  foreach(group IN ITEMS detector safety smoothing sidechain latency release makeup expand cpu)
    add_test(NAME daw-compressor-${group} COMMAND daw-compressor-test ${group})
  endforeach()
  # Gate kernel (src/gate_kernel.h). One ctest per measurement group; the executable prints each value.
  add_executable(daw-gate-test tests/gate_test.cpp)
  target_compile_features(daw-gate-test PRIVATE cxx_std_20)
  if(MSVC)
    target_compile_options(daw-gate-test PRIVATE /W4 /WX /EHs-c- /GR-)
  else()
    target_compile_options(daw-gate-test PRIVATE -Wall -Wextra -Werror -fno-exceptions -fno-rtti)
  endif()
  foreach(group IN ITEMS detector timing hold expander controls sidechain safety latency cpu)
    add_test(NAME daw-gate-${group} COMMAND daw-gate-test ${group})
  endforeach()
  # EQ band designs (src/dsp/eq_band.h) against the analog prototypes.
  add_executable(daw-eq-design-test tests/eq_design_test.cpp)
  target_compile_features(daw-eq-design-test PRIVATE cxx_std_20)
  if(MSVC)
    target_compile_options(daw-eq-design-test PRIVATE /W4 /WX /EHs-c- /GR-)
  else()
    target_compile_options(daw-eq-design-test PRIVATE -Wall -Wextra -Werror -fno-exceptions -fno-rtti)
  endif()
  foreach(group IN ITEMS accuracy nearNyquistPoles poleTable slopes stability)
    add_test(NAME daw-eq-design-${group} COMMAND daw-eq-design-test ${group})
  endforeach()
  # Not tests: the generator writes the EQ pole tables, the bench prints the cost of every EQ band design.
  add_executable(daw-eq-pole-table-generator tools/eq_pole_table_generator.cpp)
  target_compile_features(daw-eq-pole-table-generator PRIVATE cxx_std_20)
  add_executable(daw-eq-design-bench tools/eq_design_bench.cpp)
  target_compile_features(daw-eq-design-bench PRIVATE cxx_std_20)
  add_executable(daw-audio-core-graph-fixture tests/graph_fixture_cli.cpp tests/graph_fixture.cpp)
  target_compile_features(daw-audio-core-graph-fixture PRIVATE cxx_std_20)
  target_link_libraries(daw-audio-core-graph-fixture PRIVATE daw-audio-core)
  # Reverb kernel (src/reverb_kernel.h). One ctest per measurement group; the executable prints each value.
  add_executable(daw-reverb-test tests/reverb_test.cpp)
  target_compile_features(daw-reverb-test PRIVATE cxx_std_20)
  if(MSVC)
    target_compile_options(daw-reverb-test PRIVATE /W4 /WX /EHs-c- /GR-)
  else()
    target_compile_options(daw-reverb-test PRIVATE -Wall -Wextra -Werror -fno-exceptions -fno-rtti)
  endif()
  foreach(group decay shelves freeze stereo guards rates)
    add_test(NAME daw-reverb-${group} COMMAND daw-reverb-test ${group})
  endforeach()

  # Delay kernel (src/delay_kernel.h). One ctest per measurement group; the executable prints each value.
  add_executable(daw-delay-test tests/delay_test.cpp)
  target_compile_features(daw-delay-test PRIVATE cxx_std_20)
  if(MSVC)
    target_compile_options(daw-delay-test PRIVATE /W4 /WX /EHs-c- /GR-)
  else()
    target_compile_options(daw-delay-test PRIVATE -Wall -Wextra -Werror -fno-exceptions -fno-rtti)
  endif()
  foreach(group position fractional click filter sync freeze safety)
    add_test(NAME daw-delay-${group} COMMAND daw-delay-test ${group})
  endforeach()

  # Saturator kernel (src/saturator_kernel.h). One ctest per measurement group; the executable prints each value.
  add_executable(daw-saturator-test tests/saturator_test.cpp)
  target_compile_features(daw-saturator-test PRIVATE cxx_std_20)
  if(MSVC)
    target_compile_options(daw-saturator-test PRIVATE /W4 /WX /EHs-c- /GR-)
  else()
    target_compile_options(daw-saturator-test PRIVATE -Wall -Wextra -Werror -fno-exceptions -fno-rtti)
  endif()
  foreach(group unity continuity alias color postclip step dry safety)
    add_test(NAME daw-saturator-${group} COMMAND daw-saturator-test ${group})
  endforeach()

  # Lo-Fi kernel (src/lofi_kernel.h). One ctest per measurement group; the executable prints each value.
  add_executable(daw-lofi-test tests/lofi_test.cpp)
  target_compile_features(daw-lofi-test PRIVATE cxx_std_20)
  if(MSVC)
    target_compile_options(daw-lofi-test PRIVATE /W4 /WX /EHs-c- /GR-)
  else()
    target_compile_options(daw-lofi-test PRIVATE -Wall -Wextra -Werror -fno-exceptions -fno-rtti)
  endif()
  foreach(group bits rate prefilter clip floor safety)
    add_test(NAME daw-lofi-${group} COMMAND daw-lofi-test ${group})
  endforeach()

  # Utility kernel (src/utility_kernel.h). One ctest per measurement group; the executable prints each value.
  add_executable(daw-utility-test tests/utility_test.cpp)
  target_compile_features(daw-utility-test PRIVATE cxx_std_20)
  if(MSVC)
    target_compile_options(daw-utility-test PRIVATE /W4 /WX /EHs-c- /GR-)
  else()
    target_compile_options(daw-utility-test PRIVATE -Wall -Wextra -Werror -fno-exceptions -fno-rtti)
  endif()
  foreach(group step dc bassmono balance channel width safety)
    add_test(NAME daw-utility-${group} COMMAND daw-utility-test ${group})
  endforeach()

  # Not a test: prints the cost of one Reverb per frame from graph fixtures (tools/reverb-bench-fixtures.ts).
  add_executable(daw-reverb-bench tools/reverb_bench.cpp tests/graph_fixture.cpp)
  target_compile_features(daw-reverb-bench PRIVATE cxx_std_20)
  target_link_libraries(daw-reverb-bench PRIVATE daw-audio-core)

  # Not a test: prints the cost of each modulation effect per frame from graph fixtures (tools/modulation-bench-fixtures.ts).
  add_executable(daw-modulation-bench tools/modulation_bench.cpp tests/graph_fixture.cpp)
  target_compile_features(daw-modulation-bench PRIVATE cxx_std_20)
  target_link_libraries(daw-modulation-bench PRIVATE daw-audio-core)
endif()

if(DAW_AUDIO_CORE_BUILD_WASM OR DAW_AUDIO_CORE_BUILD_WASM_HARNESS)
  if(NOT CMAKE_SYSTEM_NAME STREQUAL "Emscripten")
    message(FATAL_ERROR "Wasm audio-core targets require Emscripten. Configure with emcmake cmake.")
  endif()
  set(DAW_AUDIO_CORE_WASM_EXPORTS
    _malloc
    _free
    _daw_audio_core_get_abi_version
    _daw_audio_core_wasm_utility_initialize
    _daw_audio_core_wasm_utility_process
    _daw_audio_core_wasm_asset_initialize
    _daw_audio_core_wasm_register_pcm_asset
    _daw_audio_core_wasm_release_asset
    _daw_audio_core_wasm_graph_initialize
    _daw_audio_core_wasm_graph_initialize_planar
    _daw_audio_core_wasm_graph_prepare
    _daw_audio_core_wasm_graph_prepared_continuity
    _daw_audio_core_wasm_graph_publish
    _daw_audio_core_wasm_graph_cancel
    _daw_audio_core_wasm_graph_process
    _daw_audio_core_wasm_graph_process_planar
    _daw_audio_core_wasm_graph_set_transport
    _daw_audio_core_wasm_graph_schedule_sample_source
    _daw_audio_core_wasm_graph_replace_sample_sources
    _daw_audio_core_wasm_graph_reset_sample_sources
    _daw_audio_core_wasm_graph_register_pcm_asset
    _daw_audio_core_wasm_graph_release_asset
    _daw_audio_core_wasm_graph_configure_synth
    _daw_audio_core_wasm_graph_configure_sampler
    _daw_audio_core_wasm_graph_configure_granular
    _daw_audio_core_wasm_graph_create_paged_asset
    _daw_audio_core_wasm_graph_write_paged_asset_page
    _daw_audio_core_wasm_graph_prepare_paged_asset
    _daw_audio_core_wasm_graph_schedule_prepared_sample_source
    _daw_audio_core_wasm_graph_release_paged_preparation
    _daw_audio_core_wasm_graph_trim_paged_asset
    _daw_audio_core_wasm_graph_paged_sub_abi_version
    _daw_audio_core_wasm_graph_paged_page_frames
    _daw_audio_core_wasm_graph_paged_slot_count
    _daw_audio_core_wasm_recording_capture_initialize
    _daw_audio_core_wasm_recording_capture_process
    _daw_audio_core_wasm_recording_capture_process_monitor
    _daw_audio_core_wasm_recording_capture_dequeue
    _daw_audio_core_wasm_recording_capture_finalize
    _daw_audio_core_wasm_recording_capture_cancel
    _daw_audio_core_wasm_recording_capture_get_diagnostics
  )

  function(configure_audio_core_wasm_target target exports)
    list(JOIN exports "," exports_csv)
    target_compile_features(${target} PRIVATE cxx_std_20)
    target_compile_options(${target} PRIVATE -O3 -flto -fno-exceptions -fno-rtti)
    target_link_libraries(${target} PRIVATE daw-audio-core)
    target_link_options(${target} PRIVATE
      -O3
      -flto
      -sSTANDALONE_WASM
      --no-entry
      -sINITIAL_MEMORY=268435456
      -sALLOW_MEMORY_GROWTH=0
      -sSTACK_SIZE=8388608
      "-sEXPORTED_FUNCTIONS=${exports_csv}"
      -sWASM_BIGINT
    )
    set_target_properties(${target} PROPERTIES SUFFIX ".wasm")
  endfunction()
endif()

if(DAW_AUDIO_CORE_BUILD_WASM)
  add_executable(daw-audio-core-wasm src/wasm_entry.cpp)
  configure_audio_core_wasm_target(daw-audio-core-wasm "${DAW_AUDIO_CORE_WASM_EXPORTS}")
  set_property(TARGET daw-audio-core daw-audio-core-wasm PROPERTY INTERPROCEDURAL_OPTIMIZATION TRUE)
endif()

if(DAW_AUDIO_CORE_BUILD_WASM_HARNESS)
  add_executable(daw-audio-core-wasm-harness tests/wasm_harness.cpp tests/utility_fixture.cpp tests/graph_fixture.cpp)
  set(DAW_AUDIO_CORE_WASM_HARNESS_EXPORTS
    ${DAW_AUDIO_CORE_WASM_EXPORTS}
    _daw_audio_core_wasm_harness_abi_version
    _daw_audio_core_wasm_harness_struct_layout
    _daw_audio_core_wasm_fixture_protocol_version
    _daw_audio_core_graph_fixture_protocol_version
    _daw_audio_core_run_utility_fixture
    _daw_audio_core_run_graph_fixture
  )
  configure_audio_core_wasm_target(daw-audio-core-wasm-harness "${DAW_AUDIO_CORE_WASM_HARNESS_EXPORTS}")
endif()
