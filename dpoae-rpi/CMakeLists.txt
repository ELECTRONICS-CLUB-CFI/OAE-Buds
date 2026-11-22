cmake_minimum_required(VERSION 3.20)
project(dpoae_rpi VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Optimization and warning flags
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    add_compile_options(-Wall -Wextra -Wpedantic -O3)
endif()

# Include directories
include_directories(
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/third_party
)

# Find FFTW3 if available
find_package(PkgConfig QUIET)
if(PKG_CONFIG_FOUND)
    pkg_check_modules(FFTW3 QUIET fftw3)
endif()

if(FFTW3_FOUND)
    message(STATUS "FFTW3 found via pkg-config: ${FFTW3_LIBRARIES}")
    add_compile_definitions(OAE_USE_FFTW3=1)
else()
    find_path(FFTW3_INCLUDE_DIR fftw3.h)
    find_library(FFTW3_LIBRARY NAMES fftw3)
    if(FFTW3_INCLUDE_DIR AND FFTW3_LIBRARY)
        message(STATUS "FFTW3 found: ${FFTW3_LIBRARY}")
        set(FFTW3_LIBRARIES ${FFTW3_LIBRARY})
        add_compile_definitions(OAE_USE_FFTW3=1)
    else()
        message(STATUS "FFTW3 not found. Using built-in high-performance FFT fallback.")
    endif()
endif()

# Find ALSA on Linux
if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    find_package(ALSA REQUIRED)
    message(STATUS "ALSA found: ${ALSA_LIBRARIES}")
endif()

# Core static library
add_library(oae_core STATIC
    src/oae_config.cpp
    src/signal_gen.cpp
    src/dsp_engine.cpp
    src/calibrator.cpp
    src/session_runner.cpp
)

if(FFTW3_LIBRARIES)
    target_link_libraries(oae_core PUBLIC ${FFTW3_LIBRARIES})
endif()

# Main executable
add_executable(dpoae-rpi
    src/main.cpp
    src/audio_engine_miniaudio.cpp
)

target_link_libraries(dpoae-rpi PRIVATE oae_core)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux" AND ALSA_FOUND)
    target_link_libraries(dpoae-rpi PRIVATE ${ALSA_LIBRARIES} pthread m)
endif()

# Testing
enable_testing()

set(TEST_TARGETS
    test_config_toml
    test_signal_gen
    test_dsp_engine
    test_calibrator
    test_session_mock
)

foreach(test_name ${TEST_TARGETS})
    add_executable(${test_name} tests/${test_name}.cpp)
    target_link_libraries(${test_name} PRIVATE oae_core)
    target_include_directories(${test_name} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests)
    if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
        target_link_libraries(${test_name} PRIVATE pthread m)
    endif()
    add_test(NAME ${test_name} COMMAND ${test_name})
endforeach()
