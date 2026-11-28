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

include(CheckCXXCompilerFlag)
check_cxx_compiler_flag(
  "-Wno-unnecessary-virtual-specifier"
  DAW_HAS_WNO_UNNECESSARY_VIRTUAL_SPECIFIER
)
set(DAW_VST3_CPP_SUPPRESSIONS "-Wno-deprecated-declarations")
if(DAW_HAS_WNO_UNNECESSARY_VIRTUAL_SPECIFIER)
  string(APPEND DAW_VST3_CPP_SUPPRESSIONS " -Wno-unnecessary-virtual-specifier")
endif()

add_library(daw-vst3-worker-runtime STATIC
  src/worker-supervisor.cpp
  src/worker-transport.cpp
  src/worker-runtime.cpp
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
  PROPERTIES COMPILE_FLAGS "${DAW_VST3_CPP_SUPPRESSIONS}"
)
if(DAW_HAS_WNO_UNNECESSARY_VIRTUAL_SPECIFIER)
  set_source_files_properties(
    "${VST3_SDK_PATH}/public.sdk/source/vst/hosting/hostclasses.cpp"
    PROPERTIES COMPILE_FLAGS "-Wno-unnecessary-virtual-specifier"
  )
endif()
# -framework, not a find_library path: a cached path adds -F for that SDK, which makes its headers non-system and
# -Werror then fails on the SDK's own deprecations (a build directory outlives the Xcode it was configured with).
target_link_libraries(daw-vst3-sdk-hosting PUBLIC "-framework Cocoa" "-framework Security")

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

# A failure-injection plug-in for host tests. It is not part of the production plug-in set:
# nothing installs, signs, packages or catalogs it.
option(DAW_BUILD_AE08_TEST_PLUGIN "Build the AE-08 failure-injection test VST3 (never packaged)." OFF)
if(DAW_BUILD_AE08_TEST_PLUGIN)
  set(AE08_SDK "${VST3_SDK_PATH}")
  add_library(ae08-test-effect MODULE
    test-plugin/ae08-test-effect.cpp
    test-plugin/ae08-test-editor.mm
    "${AE08_SDK}/public.sdk/source/main/pluginfactory.cpp"
    "${AE08_SDK}/public.sdk/source/main/macmain.cpp"
    "${AE08_SDK}/public.sdk/source/main/moduleinit.cpp"
    "${AE08_SDK}/public.sdk/source/vst/vstsinglecomponenteffect.cpp"
    "${AE08_SDK}/public.sdk/source/vst/vstaudioeffect.cpp"
    "${AE08_SDK}/public.sdk/source/vst/vstcomponent.cpp"
    "${AE08_SDK}/public.sdk/source/vst/vstcomponentbase.cpp"
    "${AE08_SDK}/public.sdk/source/vst/vstbus.cpp"
    "${AE08_SDK}/public.sdk/source/vst/vstparameters.cpp"
    "${AE08_SDK}/public.sdk/source/vst/vstinitiids.cpp"
    "${AE08_SDK}/base/source/baseiids.cpp"
    "${AE08_SDK}/base/source/fbuffer.cpp"
    "${AE08_SDK}/base/source/fdebug.cpp"
    "${AE08_SDK}/base/source/fobject.cpp"
    "${AE08_SDK}/base/source/fstreamer.cpp"
    "${AE08_SDK}/base/source/fstring.cpp"
    "${AE08_SDK}/base/source/updatehandler.cpp"
    "${AE08_SDK}/base/thread/source/fcondition.cpp"
    "${AE08_SDK}/base/thread/source/flock.cpp"
    "${AE08_SDK}/pluginterfaces/base/conststringtable.cpp"
    "${AE08_SDK}/pluginterfaces/base/coreiids.cpp"
    "${AE08_SDK}/pluginterfaces/base/funknown.cpp"
    "${AE08_SDK}/pluginterfaces/base/ustring.cpp"
    "${AE08_SDK}/public.sdk/source/common/pluginview.cpp"
    "${AE08_SDK}/public.sdk/source/common/commoniids.cpp"
  )
  target_include_directories(ae08-test-effect PRIVATE "${AE08_SDK}")
  target_compile_definitions(ae08-test-effect PRIVATE RELEASE=1)
  target_compile_options(ae08-test-effect PRIVATE -Wno-deprecated-declarations -Wno-unnecessary-virtual-specifier)
  set_target_properties(ae08-test-effect PROPERTIES
    BUNDLE TRUE
    BUNDLE_EXTENSION vst3
    PREFIX ""
    SUFFIX ""
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/test-plugin/Info.plist.in"
  )
  set_source_files_properties(test-plugin/ae08-test-editor.mm PROPERTIES COMPILE_FLAGS "-fobjc-arc")
  target_link_libraries(ae08-test-effect PRIVATE "-framework CoreFoundation" "-framework AppKit")
endif()

if(BUILD_TESTING)
  add_executable(daw-plugin-host-worker-test
    tests/worker_supervisor_test.cpp
  )
  target_link_libraries(daw-plugin-host-worker-test PRIVATE daw-vst3-worker-runtime daw-vst3-sdk-hosting)
  target_compile_options(daw-plugin-host-worker-test PRIVATE -Wall -Wextra -Werror)
  add_dependencies(daw-plugin-host-worker-test daw-vst3-worker)
  add_test(NAME daw-plugin-host-worker-test COMMAND daw-plugin-host-worker-test "$<TARGET_FILE:daw-vst3-worker>")
endif()
