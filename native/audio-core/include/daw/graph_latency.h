#pragma once

#include <stdint.h>

/* Shared by the graph and plug-in manifest validators. */
#ifdef __cplusplus
inline constexpr uint32_t kMaximumGraphLatencyFrames = 65'536;
#else
#define kMaximumGraphLatencyFrames 65536u
#endif
