#pragma once

#include <algorithm>
#include <compare>
#include <cstdint>
#include <unordered_set>
#include <vector>

namespace daw::audio_host_macos {

// An edge as routing sees it. Gain and delay compensation are not routing: a level change or a latency
// recompute must never read as a reroute.
struct RouteEdge {
  std::uint64_t from = 0;
  std::uint64_t to = 0;
  std::uint64_t processor = 0;
  std::uint32_t tap = 0;
  std::uint32_t sidechain = 0;
  auto operator<=>(const RouteEdge&) const = default;
};

struct PlanRouting {
  std::vector<std::uint64_t> nodes;
  std::vector<RouteEdge> edges;
};

// Every edge on a path leaving `target`, sorted: its output, through any group or send, to the master.
inline std::vector<RouteEdge> DownstreamRoute(const PlanRouting& plan, const std::uint64_t target) {
  std::vector<RouteEdge> route;
  std::vector<std::uint64_t> frontier{target};
  std::unordered_set<std::uint64_t> seen{target};
  while (!frontier.empty()) {
    const auto node = frontier.back();
    frontier.pop_back();
    for (const auto& edge : plan.edges) {
      if (edge.from != node) continue;
      route.push_back(edge);
      if (seen.insert(edge.to).second) frontier.push_back(edge.to);
    }
  }
  std::sort(route.begin(), route.end());
  return route;
}

inline bool PlanContainsNode(const PlanRouting& plan, const std::uint64_t node) {
  return std::find(plan.nodes.begin(), plan.nodes.end(), node) != plan.nodes.end();
}

inline bool CaptureTargetKept(const PlanRouting& published, const PlanRouting& proposed, const std::uint64_t target) {
  return PlanContainsNode(proposed, target) && DownstreamRoute(published, target) == DownstreamRoute(proposed, target);
}

}  // namespace daw::audio_host_macos
