cmake_minimum_required(VERSION 3.20)
project(daw_loudness_reference LANGUAGES C CXX)

include(FetchContent)

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(ENABLE_TESTS OFF CACHE BOOL "" FORCE)
set(CMAKE_POLICY_VERSION_MINIMUM 3.5 CACHE STRING "" FORCE)

FetchContent_Declare(
  libebur128
  GIT_REPOSITORY https://github.com/jiixyj/libebur128.git
  GIT_TAG 67b33abe1558160ed76ada1322329b0e9e058b02
  GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(libebur128)

add_executable(daw-loudness-reference main.cpp)
target_compile_features(daw-loudness-reference PRIVATE cxx_std_20)
target_include_directories(daw-loudness-reference PRIVATE "${libebur128_SOURCE_DIR}/ebur128")
target_link_libraries(daw-loudness-reference PRIVATE ebur128)
