cmake_minimum_required(VERSION 3.20)
project(synth16_cpu_benchmark LANGUAGES C CXX)

set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(DAW_AUDIO_CORE_BUILD_WASM OFF CACHE BOOL "" FORCE)
add_subdirectory(../../native/audio-core audio-core)

add_executable(synth16-cpu synth16-cpu.cpp)
target_compile_features(synth16-cpu PRIVATE cxx_std_20)
target_compile_options(synth16-cpu PRIVATE -O3 -DNDEBUG -Wall -Wextra -Werror)
target_link_libraries(synth16-cpu PRIVATE daw-audio-core)
