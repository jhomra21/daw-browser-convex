#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <type_traits>

namespace daw::audio_host_macos {

enum class CallbackWait { kAcknowledged, kCancelled, kUnresolved };

// Control-thread only. Once claimed, ownership stays with the callback until
// acknowledgement. A timeout never authorizes destruction, a second request, or
// touching what the claimed request mutates.
template <typename Token, typename DeviceHalted>
CallbackWait WaitForCallbackRequest(
  std::condition_variable& wake, std::mutex& mutex,
  std::atomic<Token>& requested, const std::atomic<Token>& acknowledged,
  std::type_identity_t<Token> token, DeviceHalted device_halted
) {
  std::unique_lock lock(mutex);
  wake.wait_for(lock, std::chrono::seconds(1), [&] {
    return acknowledged.load(std::memory_order_acquire) == token || device_halted();
  });
  if (acknowledged.load(std::memory_order_acquire) == token) return CallbackWait::kAcknowledged;
  auto expected = token;
  return requested.compare_exchange_strong(expected, 0, std::memory_order_acq_rel)
    ? CallbackWait::kCancelled : CallbackWait::kUnresolved;
}

// A request the callback claimed and has not acknowledged yet. Control work that
// reads what the request mutates waits for the late acknowledgement instead of
// racing it. Only the control thread writes the token; Recorded() may be read from
// any thread, which is how the progress drainer learns which claim to report.
template <typename Token>
class ClaimedRequest {
 public:
  void Record(Token token) { token_.store(token, std::memory_order_release); }
  Token Recorded() const { return token_.load(std::memory_order_acquire); }
  bool Pending(const std::atomic<Token>& acknowledged) {
    const Token token = token_.load(std::memory_order_relaxed);
    if (token != 0 && acknowledged.load(std::memory_order_acquire) == token) {
      token_.store(0, std::memory_order_release);
      return false;
    }
    return token != 0;
  }

 private:
  std::atomic<Token> token_{0};
};

}  // namespace daw::audio_host_macos
