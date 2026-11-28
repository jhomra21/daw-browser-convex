#pragma once

#include "audio-host-vst-attachment.h"

#include <condition_variable>
#include <deque>
#include <memory>
#include <mutex>
#include <thread>

namespace daw::audio_host_macos {

// Destroys retired attachments off the command thread: a worker's Stop() waits up to about
// 500 ms for its child to exit. Event driven; the thread sleeps on the queue.
class RetiredAttachmentReaper {
 public:
  RetiredAttachmentReaper() : thread_([this] { Run(); }) {}
  ~RetiredAttachmentReaper() {
    {
      const std::lock_guard lock(mutex_);
      stopping_ = true;
    }
    wake_.notify_one();
    thread_.join();
  }
  RetiredAttachmentReaper(const RetiredAttachmentReaper&) = delete;
  RetiredAttachmentReaper& operator=(const RetiredAttachmentReaper&) = delete;
  void Reap(std::unique_ptr<NativeVstWorkerAttachment> attachment) {
    {
      const std::lock_guard lock(mutex_);
      queue_.push_back(std::move(attachment));
    }
    wake_.notify_one();
  }

 private:
  void Run() {
    std::unique_lock lock(mutex_);
    for (;;) {
      wake_.wait(lock, [this] { return stopping_ || !queue_.empty(); });
      if (queue_.empty()) return;
      auto attachment = std::move(queue_.front());
      queue_.pop_front();
      lock.unlock();
      attachment.reset();  // stops its worker
      lock.lock();
    }
  }
  std::mutex mutex_;
  std::condition_variable wake_;
  std::deque<std::unique_ptr<NativeVstWorkerAttachment>> queue_;
  bool stopping_ = false;
  std::thread thread_;
};

}  // namespace daw::audio_host_macos
