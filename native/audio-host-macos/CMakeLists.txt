if(NOT APPLE)
  return()
endif()

add_library(daw-audio-host-macos-runtime STATIC
  src/audio-host.cpp
  src/coreaudio-hal.mm
  src/native-schedule-state.cpp
  src/recording-spool.cpp
)
target_compile_features(daw-audio-host-macos-runtime PUBLIC cxx_std_20)
target_include_directories(daw-audio-host-macos-runtime PUBLIC include)
find_library(COREAUDIO_FRAMEWORK CoreAudio REQUIRED)
find_library(COREFOUNDATION_FRAMEWORK CoreFoundation REQUIRED)
if(DAW_BUILD_PLUGIN_HOST)
  target_link_libraries(daw-audio-host-macos-runtime PUBLIC daw-vst3-worker-runtime daw-vst3-sdk-hosting)
  add_dependencies(daw-audio-host-macos-runtime daw-vst3-worker)
else()
  message(FATAL_ERROR "DAW_BUILD_AUDIO_HOST_MACOS requires DAW_BUILD_PLUGIN_HOST for native VST attachments.")
endif()
target_link_libraries(daw-audio-host-macos-runtime PUBLIC daw-audio-core "${COREAUDIO_FRAMEWORK}" "${COREFOUNDATION_FRAMEWORK}")
target_compile_options(daw-audio-host-macos-runtime PRIVATE -Wall -Wextra -Werror)

add_executable(daw-audio-host-macos src/main.cpp)
target_link_libraries(daw-audio-host-macos PRIVATE daw-audio-host-macos-runtime)
target_compile_options(daw-audio-host-macos PRIVATE -Wall -Wextra -Werror)

if(BUILD_TESTING)
  find_program(BUN_EXECUTABLE bun REQUIRED)
  add_executable(daw-recording-spool-test tests/recording_spool_test.cpp src/recording-spool.cpp)
  target_compile_features(daw-recording-spool-test PRIVATE cxx_std_20)
  target_link_libraries(daw-recording-spool-test PRIVATE daw-audio-core)
  target_compile_options(daw-recording-spool-test PRIVATE -Wall -Wextra -Werror)
  target_compile_definitions(daw-recording-spool-test PRIVATE
    DAW_RECORDING_SPOOL_TEST_DEQUEUE=1
    daw_audio_recording_capture_dequeue=daw_recording_spool_test_dequeue)
  add_test(NAME daw-recording-spool-test COMMAND daw-recording-spool-test)
  add_executable(daw-host-recording-spool-test tests/audio_host_recording_spool_test.cpp)
  target_link_libraries(daw-host-recording-spool-test PRIVATE daw-audio-host-macos-runtime)
  target_compile_options(daw-host-recording-spool-test PRIVATE -Wall -Wextra -Werror)
  add_test(NAME daw-host-recording-spool-test COMMAND daw-host-recording-spool-test)
  # A private core copy supplies indexed post-admission failures. The production
  # core/runtime (including BUILD_TESTING builds) never contains the hook.
  add_executable(daw-audio-host-macos-test tests/audio_host_test.cpp ../audio-core/src/audio_core.cpp src/audio-host.cpp)
  target_compile_definitions(daw-audio-host-macos-test PRIVATE
    DAW_AUDIO_CORE_TEST_INSTRUMENT_REJECTION=1 DAW_AUDIO_HOST_TEST_MEMORY_LOCK=1
    DAW_AUDIO_HOST_TEST_PATCH_CLAIM=1)
  target_link_libraries(daw-audio-host-macos-test PRIVATE daw-audio-host-macos-runtime)
  target_compile_options(daw-audio-host-macos-test PRIVATE -Wall -Wextra -Werror)
  add_test(NAME daw-audio-host-macos-test COMMAND daw-audio-host-macos-test)
  # The patch-claim seam holds a callback-taken patch so a claimed reply can be produced.
  # It exists only in this private copy of the host and never in the runtime library, the
  # product executable, or any other target.
  add_executable(daw-audio-host-macos-acceptance src/main.cpp src/audio-host.cpp)
  target_compile_definitions(daw-audio-host-macos-acceptance PRIVATE DAW_AUDIO_HOST_TEST_PATCH_CLAIM=2)
  target_link_libraries(daw-audio-host-macos-acceptance PRIVATE daw-audio-host-macos-runtime)
  target_compile_options(daw-audio-host-macos-acceptance PRIVATE -Wall -Wextra -Werror)
  add_executable(daw-audio-host-macos-graph-integration-test tests/native_graph_integration_test.cpp)
  target_link_libraries(daw-audio-host-macos-graph-integration-test PRIVATE daw-audio-host-macos-runtime)
  target_compile_options(daw-audio-host-macos-graph-integration-test PRIVATE -Wall -Wextra -Werror)
  add_test(NAME daw-audio-host-macos-graph-integration-test COMMAND daw-audio-host-macos-graph-integration-test)
  add_executable(daw-audio-host-macos-transaction-test tests/audio_host_transaction_test.cpp)
  target_link_libraries(daw-audio-host-macos-transaction-test PRIVATE daw-audio-host-macos-runtime)
  target_compile_options(daw-audio-host-macos-transaction-test PRIVATE -Wall -Wextra -Werror)
  add_test(NAME daw-audio-host-macos-transaction-test COMMAND daw-audio-host-macos-transaction-test $<TARGET_FILE:daw-audio-host-macos>)
  add_test(
    NAME daw-realtime-callback-static-guard
    COMMAND ${BUN_EXECUTABLE} test ${CMAKE_CURRENT_SOURCE_DIR}/tests/realtime_callback_guard.test.ts
  )
endif()
