#include "control-frame.h"

#include <cstdlib>
#include <iostream>

namespace {

enum class HostState {
  kCreated,
  kReady,
  kEditorOpen,
  kFaulted,
  kTerminated,
};

bool CanTransition(HostState from, HostState to) {
  if (from == HostState::kCreated) return to == HostState::kReady || to == HostState::kTerminated;
  if (from == HostState::kReady) return to == HostState::kEditorOpen || to == HostState::kFaulted || to == HostState::kTerminated;
  if (from == HostState::kEditorOpen) return to == HostState::kReady || to == HostState::kFaulted || to == HostState::kTerminated;
  if (from == HostState::kFaulted) return to == HostState::kTerminated;
  return false;
}

}  // namespace

int main() {
  HostState state = HostState::kCreated;
  if (!CanTransition(state, HostState::kReady)) return EXIT_FAILURE;
  state = HostState::kReady;
  std::cerr << "daw-vst3-host control skeleton: no audio bridge is active\n";
  return state == HostState::kReady ? EXIT_SUCCESS : EXIT_FAILURE;
}
