cmake_minimum_required(VERSION 3.20)
project(daw_native LANGUAGES CXX)
if(APPLE)
  enable_language(OBJCXX)
endif()

option(DAW_BUILD_PLUGIN_HOST "Build the platform-specific VST3 host." OFF)
option(DAW_BUILD_AUDIO_HOST_MACOS "Build the macOS CoreAudio host." OFF)

include(CTest)

add_subdirectory(audio-core)

if(DAW_BUILD_PLUGIN_HOST)
  add_subdirectory(plugin-host)
endif()

if(DAW_BUILD_AUDIO_HOST_MACOS)
  add_subdirectory(audio-host-macos)
endif()
