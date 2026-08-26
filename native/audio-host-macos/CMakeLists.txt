if(NOT APPLE)
  return()
endif()

add_library(daw-audio-host-macos-runtime STATIC
  src/audio-host.cpp
  src/coreaudio-hal.mm
  src/native-schedule-state.cpp
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
  add_executable(daw-audio-host-macos-test tests/audio_host_test.cpp)
  target_link_libraries(daw-audio-host-macos-test PRIVATE daw-audio-host-macos-runtime)
  target_compile_options(daw-audio-host-macos-test PRIVATE -Wall -Wextra -Werror)
  add_test(NAME daw-audio-host-macos-test COMMAND daw-audio-host-macos-test)
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
