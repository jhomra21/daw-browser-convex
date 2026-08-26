cmake_minimum_required(VERSION 3.20)
project(daw_plugin_host LANGUAGES CXX)

set(VST3_SDK_PATH "" CACHE PATH "Absolute path to an existing VST3 SDK 3.8.x checkout")
if(NOT VST3_SDK_PATH)
  message(FATAL_ERROR "VST3_SDK_PATH is required. No VST3 SDK is downloaded or vendored by this project.")
endif()

if(NOT EXISTS "${VST3_SDK_PATH}/pluginterfaces/vst/ivstcomponent.h")
  message(FATAL_ERROR "VST3_SDK_PATH does not contain the VST3 SDK headers.")
endif()

if(NOT CMAKE_OSX_ARCHITECTURES)
  set(CMAKE_OSX_ARCHITECTURES arm64)
endif()
if(NOT CMAKE_OSX_ARCHITECTURES STREQUAL "arm64")
  message(FATAL_ERROR "The initial plugin host supports macOS arm64 only.")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(daw-vst3-worker-runtime STATIC
  src/worker-supervisor.cpp
  src/worker-control-protocol.cpp
  src/worker-control-service.cpp
)
target_compile_features(daw-vst3-worker-runtime PUBLIC cxx_std_20)
target_include_directories(daw-vst3-worker-runtime PUBLIC src)
target_compile_options(daw-vst3-worker-runtime PRIVATE -Wall -Wextra -Werror)

add_library(daw-vst3-sdk-hosting STATIC
  src/vst3-worker.cpp
  src/vst3-editor-window.mm
  "${VST3_SDK_PATH}/public.sdk/source/vst/hosting/module.cpp"
  "${VST3_SDK_PATH}/public.sdk/source/vst/hosting/module_mac.mm"
  "${VST3_SDK_PATH}/public.sdk/source/vst/hosting/hostclasses.cpp"
  "${VST3_SDK_PATH}/public.sdk/source/vst/hosting/pluginterfacesupport.cpp"
  "${VST3_SDK_PATH}/public.sdk/source/vst/hosting/eventlist.cpp"
  "${VST3_SDK_PATH}/public.sdk/source/vst/hosting/parameterchanges.cpp"
  "${VST3_SDK_PATH}/public.sdk/source/vst/utility/stringconvert.cpp"
  "${VST3_SDK_PATH}/public.sdk/source/common/commonstringconvert.cpp"
  "${VST3_SDK_PATH}/public.sdk/source/vst/vstinitiids.cpp"
  "${VST3_SDK_PATH}/pluginterfaces/base/funknown.cpp"
  "${VST3_SDK_PATH}/pluginterfaces/base/coreiids.cpp"
)
target_include_directories(daw-vst3-sdk-hosting PUBLIC src "${VST3_SDK_PATH}")
target_compile_options(daw-vst3-sdk-hosting PRIVATE -Wall -Wextra -Werror)
set_source_files_properties(
  "${VST3_SDK_PATH}/public.sdk/source/vst/hosting/module_mac.mm"
  PROPERTIES COMPILE_FLAGS "-fobjc-arc -Wno-unused-parameter"
)
set_source_files_properties(
  src/vst3-worker.cpp
  "${VST3_SDK_PATH}/public.sdk/source/vst/utility/stringconvert.cpp"
  "${VST3_SDK_PATH}/public.sdk/source/common/commonstringconvert.cpp"
  PROPERTIES COMPILE_FLAGS "-Wno-deprecated-declarations -Wno-unnecessary-virtual-specifier"
)
set_source_files_properties(
  "${VST3_SDK_PATH}/public.sdk/source/vst/hosting/hostclasses.cpp"
  PROPERTIES COMPILE_FLAGS "-Wno-unnecessary-virtual-specifier"
)
find_library(COCOA_FRAMEWORK Cocoa REQUIRED)
find_library(SECURITY_FRAMEWORK Security REQUIRED)
target_link_libraries(daw-vst3-sdk-hosting PUBLIC "${COCOA_FRAMEWORK}" "${SECURITY_FRAMEWORK}")

add_executable(daw-vst3-worker src/worker-main.cpp)
target_link_libraries(daw-vst3-worker PRIVATE daw-vst3-worker-runtime daw-vst3-sdk-hosting)
target_compile_options(daw-vst3-worker PRIVATE -Wall -Wextra -Werror)

add_executable(daw-vst3-scanner
  src/scanner-main.cpp
  src/control-frame.cpp
  "${VST3_SDK_PATH}/public.sdk/source/vst/moduleinfo/moduleinfoparser.cpp"
)
target_include_directories(daw-vst3-scanner PRIVATE "${VST3_SDK_PATH}")
target_compile_options(daw-vst3-scanner PRIVATE -Wall -Wextra -Werror)
target_link_libraries(daw-vst3-scanner PRIVATE daw-vst3-sdk-hosting)

if(BUILD_TESTING)
  add_executable(daw-plugin-host-worker-test
    tests/worker_supervisor_test.cpp
  )
  target_link_libraries(daw-plugin-host-worker-test PRIVATE daw-vst3-worker-runtime daw-vst3-sdk-hosting)
  target_compile_options(daw-plugin-host-worker-test PRIVATE -Wall -Wextra -Werror)
  add_dependencies(daw-plugin-host-worker-test daw-vst3-worker)
  add_test(NAME daw-plugin-host-worker-test COMMAND daw-plugin-host-worker-test "$<TARGET_FILE:daw-vst3-worker>")
endif()
