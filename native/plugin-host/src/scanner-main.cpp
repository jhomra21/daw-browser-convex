#include "control-frame.h"

#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/moduleinfo/moduleinfoparser.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"

#include <array>
#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <optional>
#include <sstream>
#include <string>
#include <sys/resource.h>
#include <vector>

namespace {

constexpr std::size_t kMaximumRequestBytes = daw::plugin_host::kMaximumControlFrameBytes;
constexpr std::size_t kMaximumClasses = 1'024;
constexpr std::size_t kMaximumTextBytes = 256;
constexpr std::string_view kScannerVersion = "1";
constexpr std::string_view kSdkVersion = "3.8.0";

struct Request {
  std::string requestId;
  std::string bundlePath;
};

struct ClassResult {
  std::string classId;
  std::string vendor;
  std::string name;
  std::string version;
  std::string role;
  std::string source;
  std::optional<std::string> sdkVersion;
};

std::string EscapeJson(std::string_view value) {
  std::string result;
  result.reserve(value.size() + 8);
  for (const auto character : value) {
    switch (character) {
      case '"': result += "\\\""; break;
      case '\\': result += "\\\\"; break;
      case '\b': result += "\\b"; break;
      case '\f': result += "\\f"; break;
      case '\n': result += "\\n"; break;
      case '\r': result += "\\r"; break;
      case '\t': result += "\\t"; break;
      default:
        if (static_cast<unsigned char>(character) < 0x20U) {
          constexpr std::string_view digits{"0123456789abcdef"};
          result += "\\u00";
          result += digits[(static_cast<unsigned char>(character) >> 4U) & 0x0FU];
          result += digits[static_cast<unsigned char>(character) & 0x0FU];
        } else {
          result += character;
        }
    }
  }
  return result;
}

std::optional<std::string> ReadFrame() {
  std::array<std::uint8_t, 4> header {};
  std::cin.read(reinterpret_cast<char*>(header.data()), static_cast<std::streamsize>(header.size()));
  if (std::cin.gcount() != static_cast<std::streamsize>(header.size())) return std::nullopt;
  const auto length = daw::plugin_host::ReadFrameLength(header);
  if (!length || *length > kMaximumRequestBytes) return std::nullopt;
  std::string body(*length, '\0');
  std::cin.read(body.data(), static_cast<std::streamsize>(body.size()));
  if (std::cin.gcount() != static_cast<std::streamsize>(body.size())) return std::nullopt;
  return body;
}

void WriteFrame(std::string_view body) {
  if (body.empty() || body.size() > kMaximumRequestBytes) return;
  const auto size = static_cast<std::uint32_t>(body.size());
  const std::array<std::uint8_t, 4> header {
    static_cast<std::uint8_t>((size >> 24U) & 0xFFU),
    static_cast<std::uint8_t>((size >> 16U) & 0xFFU),
    static_cast<std::uint8_t>((size >> 8U) & 0xFFU),
    static_cast<std::uint8_t>(size & 0xFFU),
  };
  std::cout.write(reinterpret_cast<const char*>(header.data()), static_cast<std::streamsize>(header.size()));
  std::cout.write(body.data(), static_cast<std::streamsize>(body.size()));
  std::cout.flush();
}

std::optional<std::string> JsonString(const std::string& value, std::string_view key) {
  const std::string needle = "\"" + std::string(key) + "\"";
  const auto keyPosition = value.find(needle);
  if (keyPosition == std::string::npos) return std::nullopt;
  auto position = value.find(':', keyPosition + needle.size());
  if (position == std::string::npos) return std::nullopt;
  ++position;
  while (position < value.size() && std::isspace(static_cast<unsigned char>(value[position]))) ++position;
  if (position >= value.size() || value[position] != '"') return std::nullopt;
  ++position;
  std::string parsed;
  while (position < value.size()) {
    const auto character = value[position++];
    if (character == '"') return parsed;
    if (character == '\\') {
      if (position >= value.size()) return std::nullopt;
      const auto escaped = value[position++];
      if (escaped == '"' || escaped == '\\' || escaped == '/') parsed += escaped;
      else if (escaped == 'b') parsed += '\b';
      else if (escaped == 'f') parsed += '\f';
      else if (escaped == 'n') parsed += '\n';
      else if (escaped == 'r') parsed += '\r';
      else if (escaped == 't') parsed += '\t';
      else return std::nullopt;
    } else if (static_cast<unsigned char>(character) < 0x20U) {
      return std::nullopt;
    } else {
      parsed += character;
    }
  }
  return std::nullopt;
}

bool ValidRequestId(const std::string& value) {
  if (value.empty() || value.size() > 96) return false;
  for (const auto character : value) {
    if (!std::isalnum(static_cast<unsigned char>(character)) && character != '.' && character != '_' && character != '-') return false;
  }
  return true;
}

std::optional<Request> ParseRequest(const std::string& raw) {
  const auto version = raw.find("\"version\":2") != std::string::npos;
  const auto type = JsonString(raw, "type");
  const auto requestId = JsonString(raw, "requestId");
  const auto bundlePath = JsonString(raw, "bundlePath");
  if (!version || !type || *type != "scan" || !requestId || !bundlePath
    || !ValidRequestId(*requestId) || bundlePath->empty() || bundlePath->size() > 4096) return std::nullopt;
  return Request{*requestId, *bundlePath};
}

bool IsInstrument(const std::vector<std::string>& subCategories) {
  for (const auto& category : subCategories) {
    if (category == "Instrument") return true;
  }
  return false;
}

bool ValidText(const std::string& value) {
  return !value.empty() && value.size() <= kMaximumTextBytes;
}

std::optional<ClassResult> CreateResult(
  const std::string& classId,
  const std::string& vendor,
  const std::string& name,
  const std::string& version,
  const std::vector<std::string>& subCategories,
  std::string_view source,
  const std::string& sdkVersion
) {
  if (!ValidText(classId) || !ValidText(vendor) || !ValidText(name) || !ValidText(version)) return std::nullopt;
  return ClassResult{
    .classId = classId,
    .vendor = vendor,
    .name = name,
    .version = version,
    .role = IsInstrument(subCategories) ? "instrument" : "effect",
    .source = std::string(source),
    .sdkVersion = sdkVersion.empty() ? std::nullopt : std::optional<std::string>(sdkVersion.substr(0, kMaximumTextBytes)),
  };
}

std::vector<ClassResult> ParseModuleInfo(const std::string& bundlePath) {
  const auto infoPath = VST3::Hosting::Module::getModuleInfoPath(bundlePath);
  if (!infoPath) return {};
  std::ifstream file(*infoPath, std::ios::binary);
  std::stringstream contents;
  contents << file.rdbuf();
  const auto info = Steinberg::ModuleInfoLib::parseJson(contents.str(), nullptr);
  if (!info) return {};
  std::vector<ClassResult> results;
  for (const auto& classInfo : info->classes) {
    if (classInfo.category != kVstAudioEffectClass || results.size() >= kMaximumClasses) continue;
    const auto result = CreateResult(
      classInfo.cid,
      classInfo.vendor.empty() ? info->factoryInfo.vendor : classInfo.vendor,
      classInfo.name,
      classInfo.version.empty() ? info->version : classInfo.version,
      classInfo.subCategories,
      "moduleinfo",
      classInfo.sdkVersion
    );
    if (result) results.push_back(*result);
  }
  return results;
}

std::vector<ClassResult> InspectFactory(const std::string& bundlePath) {
  std::string error;
  const auto module = VST3::Hosting::Module::create(bundlePath, error);
  if (!module) return {};
  const auto factory = module->getFactory();
  const auto factoryVendor = factory.info().vendor();
  std::vector<ClassResult> results;
  for (const auto& classInfo : factory.classInfos()) {
    if (classInfo.category() != kVstAudioEffectClass || results.size() >= kMaximumClasses) continue;
    const auto result = CreateResult(
      classInfo.ID().toString(),
      classInfo.vendor().empty() ? factoryVendor : classInfo.vendor(),
      classInfo.name(),
      classInfo.version().empty() ? "unknown" : classInfo.version(),
      classInfo.subCategories(),
      "factory",
      classInfo.sdkVersion()
    );
    if (result) results.push_back(*result);
  }
  return results;
}

std::string ErrorResponse(const Request& request, std::string_view code, std::string_view message) {
  return "{\"version\":2,\"compatibility\":{\"minimum\":1,\"maximum\":2},\"requestId\":\""
    + EscapeJson(request.requestId) + "\",\"type\":\"error\",\"code\":\"" + std::string(code)
    + "\",\"message\":\"" + EscapeJson(message) + "\"}";
}

std::string ResultResponse(const Request& request, const std::string& bundlePath, const std::vector<ClassResult>& classes) {
  std::string result = "{\"version\":2,\"compatibility\":{\"minimum\":1,\"maximum\":2},\"requestId\":\""
    + EscapeJson(request.requestId) + "\",\"type\":\"result\",\"bundlePath\":\"" + EscapeJson(bundlePath)
    + "\",\"scannerVersion\":\"" + std::string(kScannerVersion) + "\",\"sdkVersion\":\""
    + std::string(kSdkVersion) + "\",\"classes\":[";
  for (std::size_t index = 0; index < classes.size(); ++index) {
    const auto& entry = classes[index];
    if (index > 0) result += ',';
    result += "{\"classId\":\"" + EscapeJson(entry.classId) + "\",\"vendor\":\"" + EscapeJson(entry.vendor)
      + "\",\"name\":\"" + EscapeJson(entry.name) + "\",\"version\":\"" + EscapeJson(entry.version)
      + "\",\"role\":\"" + entry.role + "\",\"source\":\"" + entry.source + "\"";
    if (entry.sdkVersion) result += ",\"sdkVersion\":\"" + EscapeJson(*entry.sdkVersion) + "\"";
    result += '}';
  }
  return result + "]}";
}

}  // namespace

int main() {
  const rlimit coreLimit{.rlim_cur = 0, .rlim_max = 0};
  if (setrlimit(RLIMIT_CORE, &coreLimit) != 0) return EXIT_FAILURE;
  const auto raw = ReadFrame();
  if (!raw) return EXIT_FAILURE;
  const auto request = ParseRequest(*raw);
  if (!request) {
    WriteFrame("{\"version\":2,\"compatibility\":{\"minimum\":1,\"maximum\":2},\"requestId\":\"invalid-request\",\"type\":\"error\",\"code\":\"invalid-request\",\"message\":\"The scanner request is invalid.\"}");
    return EXIT_FAILURE;
  }
  std::error_code error;
  const auto canonical = std::filesystem::canonical(request->bundlePath, error);
  if (error || canonical.extension() != ".vst3" || !std::filesystem::is_directory(canonical, error) || error) {
    WriteFrame(ErrorResponse(*request, "invalid-request", "The VST3 bundle path is invalid."));
    return EXIT_FAILURE;
  }
  auto classes = ParseModuleInfo(canonical.string());
  if (classes.empty()) classes = InspectFactory(canonical.string());
  WriteFrame(ResultResponse(*request, canonical.string(), classes));
  return EXIT_SUCCESS;
}
