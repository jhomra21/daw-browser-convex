cmake_minimum_required(VERSION 3.20)
project(daw_audio_core LANGUAGES C CXX)
include(CTest)

option(DAW_AUDIO_CORE_BUILD_WASM "Build the optimized production Emscripten audio core." OFF)
option(DAW_AUDIO_CORE_BUILD_WASM_HARNESS "Build the Emscripten-compatible audio-core fixture harness." OFF)

add_library(daw-audio-core STATIC src/audio_core.cpp)
target_compile_features(daw-audio-core PUBLIC cxx_std_20)
target_include_directories(daw-audio-core PUBLIC include generated)
if(NOT CMAKE_SYSTEM_NAME STREQUAL "Emscripten")
  target_compile_definitions(daw-audio-core PUBLIC DAW_AUDIO_CORE_ENABLE_NATIVE_GRAPH_HOOKS=1)
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
  add_executable(daw-audio-core-graph-fixture tests/graph_fixture_cli.cpp tests/graph_fixture.cpp)
  target_compile_features(daw-audio-core-graph-fixture PRIVATE cxx_std_20)
  target_link_libraries(daw-audio-core-graph-fixture PRIVATE daw-audio-core)
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
    _daw_audio_core_wasm_graph_publish
    _daw_audio_core_wasm_graph_process
    _daw_audio_core_wasm_graph_process_planar
    _daw_audio_core_wasm_graph_set_transport
    _daw_audio_core_wasm_graph_schedule_sample_source
    _daw_audio_core_wasm_graph_register_pcm_asset
    _daw_audio_core_wasm_graph_release_asset
    _daw_audio_core_wasm_graph_configure_synth
    _daw_audio_core_wasm_graph_configure_sampler
    _daw_audio_core_wasm_graph_configure_granular
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
      -sINITIAL_MEMORY=184549376
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
    _daw_audio_core_wasm_fixture_protocol_version
    _daw_audio_core_graph_fixture_protocol_version
    _daw_audio_core_run_utility_fixture
    _daw_audio_core_run_graph_fixture
  )
  configure_audio_core_wasm_target(daw-audio-core-wasm-harness "${DAW_AUDIO_CORE_WASM_HARNESS_EXPORTS}")
endif()
