#include <Windows.h>
#include <ShlObj.h>
#include <Softpub.h>
#include <Wincrypt.h>
#include <Wintrust.h>

#include <array>
#include <charconv>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <cwctype>
#include <deque>
#include <iostream>
#include <limits>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

namespace {

constexpr int kProtocolVersion = 1;
constexpr std::size_t kMaximumLineLength = 512;
constexpr std::size_t kMaximumControlQueue = 16;
constexpr std::size_t kMaximumApplicationNameLength = 96;
constexpr std::size_t kMaximumTokenLength = 96;
constexpr int kLogitechSpeakerDeviceType = 0x0e;
constexpr wchar_t kLogitechRuntimeFileName[] = L"sdk_legacy_led_x64.dll";
constexpr wchar_t kLogitechRuntimeRegistryKey[] =
    L"SOFTWARE\\Classes\\CLSID\\{a6519e67-7632-4375-afdf-caa889744403}\\ServerBinary";

// JavaScript emits LF, LR, RF, RR. Logitech's G560 IDs are LF=0, RF=1,
// LR=2, RR=3, so the native bridge is the only place that translates them.
constexpr std::array<int, 4> kSdkZoneForCanonicalIndex{0, 2, 1, 3};

struct Frame {
    std::uint64_t sequence = 0;
    std::array<std::array<int, 3>, 4> zones{};
};

enum class CommandType {
    Acquire,
    Frame,
    Release,
    Ping,
    Quit
};

struct Command {
    CommandType type = CommandType::Ping;
    std::string argument;
    Frame frame;
};

struct ParseResult {
    std::optional<Command> command;
    std::string error;
};

struct SubmitResult {
    bool accepted = false;
    std::optional<std::uint64_t> droppedFrame;
    std::string error;
};

std::mutex outputMutex;

using LogiLedInitWithNameFunction = bool (*)(const char*);
using LogiLedGetSdkVersionFunction = bool (*)(int*, int*, int*);
using LogiLedSetLightingForTargetZoneFunction = bool (*)(int, int, int, int, int);
using LogiLedShutdownFunction = void (*)();

void WriteResponse(const std::string& response) {
    std::lock_guard lock(outputMutex);
    std::cout << response << '\n' << std::flush;
}

std::vector<std::string_view> SplitTokens(std::string_view input) {
    std::vector<std::string_view> tokens;
    std::size_t cursor = 0;
    while (cursor < input.size()) {
        while (cursor < input.size() && (input[cursor] == ' ' || input[cursor] == '\t')) {
            ++cursor;
        }
        if (cursor >= input.size()) {
            break;
        }
        const std::size_t start = cursor;
        while (cursor < input.size() && input[cursor] != ' ' && input[cursor] != '\t') {
            ++cursor;
        }
        tokens.emplace_back(input.substr(start, cursor - start));
    }
    return tokens;
}

template <typename Integer>
bool ParseInteger(std::string_view token, Integer& value) {
    if (token.empty()) {
        return false;
    }
    Integer parsed{};
    const char* begin = token.data();
    const char* end = token.data() + token.size();
    const auto result = std::from_chars(begin, end, parsed);
    if (result.ec != std::errc{} || result.ptr != end) {
        return false;
    }
    value = parsed;
    return true;
}

bool IsSafeText(std::string_view value, std::size_t maximumLength) {
    if (value.empty() || value.size() > maximumLength) {
        return false;
    }
    for (const unsigned char character : value) {
        if (character < 0x20 || character > 0x7e || character == '\r' || character == '\n') {
            return false;
        }
    }
    return true;
}

std::string_view RemainderAfterCommand(std::string_view line) {
    const std::size_t separator = line.find_first_of(" \t");
    if (separator == std::string_view::npos) {
        return {};
    }
    std::size_t start = separator;
    while (start < line.size() && (line[start] == ' ' || line[start] == '\t')) {
        ++start;
    }
    return line.substr(start);
}

ParseResult ParseCommand(std::string_view line) {
    const auto tokens = SplitTokens(line);
    if (tokens.empty()) {
        return {std::nullopt, "empty_command"};
    }

    if (tokens[0] == "ACQUIRE") {
        const auto name = RemainderAfterCommand(line);
        if (!IsSafeText(name, kMaximumApplicationNameLength)) {
            return {std::nullopt, "invalid_application_name"};
        }
        Command command;
        command.type = CommandType::Acquire;
        command.argument.assign(name);
        return {std::move(command), {}};
    }

    if (tokens[0] == "FRAME") {
        if (tokens.size() != 14) {
            return {std::nullopt, "invalid_frame_field_count"};
        }
        Command command;
        command.type = CommandType::Frame;
        if (!ParseInteger(tokens[1], command.frame.sequence)) {
            return {std::nullopt, "invalid_frame_sequence"};
        }
        for (std::size_t zone = 0; zone < command.frame.zones.size(); ++zone) {
            for (std::size_t channel = 0; channel < command.frame.zones[zone].size(); ++channel) {
                int percentage = -1;
                const std::size_t tokenIndex = 2 + zone * 3 + channel;
                if (!ParseInteger(tokens[tokenIndex], percentage) || percentage < 0 || percentage > 100) {
                    return {std::nullopt, "invalid_frame_percentage"};
                }
                command.frame.zones[zone][channel] = percentage;
            }
        }
        return {std::move(command), {}};
    }

    if (tokens[0] == "RELEASE") {
        const auto reason = RemainderAfterCommand(line);
        if (!reason.empty() && !IsSafeText(reason, kMaximumTokenLength)) {
            return {std::nullopt, "invalid_release_reason"};
        }
        Command command;
        command.type = CommandType::Release;
        command.argument.assign(reason);
        return {std::move(command), {}};
    }

    if (tokens[0] == "PING") {
        const auto token = RemainderAfterCommand(line);
        if (!token.empty() && !IsSafeText(token, kMaximumTokenLength)) {
            return {std::nullopt, "invalid_ping_token"};
        }
        Command command;
        command.type = CommandType::Ping;
        command.argument.assign(token);
        return {std::move(command), {}};
    }

    if (tokens[0] == "QUIT" && tokens.size() == 1) {
        Command command;
        command.type = CommandType::Quit;
        return {std::move(command), {}};
    }

    return {std::nullopt, "unknown_command"};
}

bool ReadBoundedLine(std::istream& input, std::string& line, bool& tooLong) {
    line.clear();
    tooLong = false;
    bool readAny = false;
    char character = 0;
    while (input.get(character)) {
        readAny = true;
        if (character == '\n') {
            break;
        }
        if (line.size() < kMaximumLineLength) {
            line.push_back(character);
        } else {
            tooLong = true;
        }
    }
    if (!readAny) {
        return false;
    }
    if (!line.empty() && line.back() == '\r') {
        line.pop_back();
    }
    return true;
}

class WorkQueue {
public:
    SubmitResult Submit(Command command) {
        std::lock_guard lock(mutex_);
        if (closed_ || quitting_) {
            return {false, std::nullopt, "bridge_closing"};
        }

        SubmitResult result{true, std::nullopt, {}};
        if (command.type == CommandType::Frame) {
            if (latestFrame_) {
                result.droppedFrame = latestFrame_->sequence;
            }
            latestFrame_ = std::move(command.frame);
        } else if (command.type == CommandType::Quit) {
            if (latestFrame_) {
                result.droppedFrame = latestFrame_->sequence;
            }
            latestFrame_.reset();
            controls_.clear();
            controls_.push_back(std::move(command));
            quitting_ = true;
        } else {
            if (controls_.size() >= kMaximumControlQueue) {
                return {false, std::nullopt, "control_queue_full"};
            }
            if (command.type == CommandType::Release && latestFrame_) {
                result.droppedFrame = latestFrame_->sequence;
                latestFrame_.reset();
            }
            controls_.push_back(std::move(command));
        }
        condition_.notify_one();
        return result;
    }

    std::optional<Command> Take() {
        std::unique_lock lock(mutex_);
        condition_.wait(lock, [this] {
            return closed_ || !controls_.empty() || latestFrame_.has_value();
        });
        if (!controls_.empty()) {
            Command command = std::move(controls_.front());
            controls_.pop_front();
            return command;
        }
        if (latestFrame_) {
            Command command;
            command.type = CommandType::Frame;
            command.frame = std::move(*latestFrame_);
            latestFrame_.reset();
            return command;
        }
        return std::nullopt;
    }

    void CloseInput() {
        std::lock_guard lock(mutex_);
        closed_ = true;
        latestFrame_.reset();
        controls_.clear();
        condition_.notify_one();
    }

private:
    std::mutex mutex_;
    std::condition_variable condition_;
    std::deque<Command> controls_;
    std::optional<Frame> latestFrame_;
    bool closed_ = false;
    bool quitting_ = false;
};

std::wstring NormalizeSignerOrganization(std::wstring value) {
    while (!value.empty() && std::iswspace(value.front())) {
        value.erase(value.begin());
    }
    while (!value.empty() && std::iswspace(value.back())) {
        value.pop_back();
    }
    for (wchar_t& character : value) {
        character = static_cast<wchar_t>(std::towlower(character));
    }
    return value;
}

bool IsLogitechSignerOrganization(const std::wstring& organization) {
    const std::wstring normalized = NormalizeSignerOrganization(organization);
    return normalized == L"logitech inc" ||
        normalized == L"logitech europe s.a." ||
        normalized == L"logitech europe sa" ||
        normalized == L"logitech international s.a." ||
        normalized == L"logitech international sa";
}

bool HasExpectedRuntimeFileName(const std::wstring& path) {
    const std::size_t separator = path.find_last_of(L"\\/");
    const wchar_t* fileName = separator == std::wstring::npos
        ? path.c_str()
        : path.c_str() + separator + 1;
    return _wcsicmp(fileName, kLogitechRuntimeFileName) == 0;
}

std::optional<std::wstring> ExpandRegistryString(const std::wstring& value, DWORD type) {
    if (type != REG_EXPAND_SZ) {
        return value;
    }
    const DWORD required = ExpandEnvironmentStringsW(value.c_str(), nullptr, 0);
    if (required == 0) {
        return std::nullopt;
    }
    std::vector<wchar_t> expanded(required);
    if (ExpandEnvironmentStringsW(value.c_str(), expanded.data(), required) != required) {
        return std::nullopt;
    }
    return std::wstring(expanded.data());
}

std::optional<std::wstring> ReadRegisteredRuntimePath() {
    DWORD type = 0;
    DWORD bytes = 0;
    constexpr DWORD flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ |
        RRF_SUBKEY_WOW6464KEY | RRF_ZEROONFAILURE;
    LONG status = RegGetValueW(
        HKEY_LOCAL_MACHINE,
        kLogitechRuntimeRegistryKey,
        nullptr,
        flags,
        &type,
        nullptr,
        &bytes);
    if (status != ERROR_SUCCESS || bytes < sizeof(wchar_t)) {
        return std::nullopt;
    }
    std::vector<wchar_t> buffer(bytes / sizeof(wchar_t) + 1, L'\0');
    status = RegGetValueW(
        HKEY_LOCAL_MACHINE,
        kLogitechRuntimeRegistryKey,
        nullptr,
        flags,
        &type,
        buffer.data(),
        &bytes);
    if (status != ERROR_SUCCESS || buffer.front() == L'\0') {
        return std::nullopt;
    }
    return ExpandRegistryString(std::wstring(buffer.data()), type);
}

std::optional<std::wstring> DefaultRuntimePath() {
    PWSTR programFiles = nullptr;
    if (FAILED(SHGetKnownFolderPath(FOLDERID_ProgramFiles, KF_FLAG_DEFAULT, nullptr, &programFiles))) {
        return std::nullopt;
    }
    std::wstring path(programFiles);
    CoTaskMemFree(programFiles);
    path += L"\\LGHUB\\sdks\\";
    path += kLogitechRuntimeFileName;
    return path;
}

std::optional<std::wstring> CanonicalExistingFilePath(const std::wstring& candidate) {
    if (candidate.empty() || !HasExpectedRuntimeFileName(candidate)) {
        return std::nullopt;
    }
    const DWORD required = GetFullPathNameW(candidate.c_str(), 0, nullptr, nullptr);
    if (required == 0) {
        return std::nullopt;
    }
    std::vector<wchar_t> fullPath(required);
    if (GetFullPathNameW(candidate.c_str(), required, fullPath.data(), nullptr) == 0) {
        return std::nullopt;
    }
    const DWORD attributes = GetFileAttributesW(fullPath.data());
    if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
        return std::nullopt;
    }
    return std::wstring(fullPath.data());
}

std::optional<std::wstring> ReadEmbeddedSignerOrganization(const std::wstring& path) {
    HCERTSTORE certificateStore = nullptr;
    HCRYPTMSG cryptographicMessage = nullptr;
    DWORD encoding = 0;
    DWORD contentType = 0;
    DWORD formatType = 0;
    if (!CryptQueryObject(
            CERT_QUERY_OBJECT_FILE,
            path.c_str(),
            CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED,
            CERT_QUERY_FORMAT_FLAG_BINARY,
            0,
            &encoding,
            &contentType,
            &formatType,
            &certificateStore,
            &cryptographicMessage,
            nullptr)) {
        return std::nullopt;
    }

    std::optional<std::wstring> organization;
    DWORD signerInfoBytes = 0;
    if (CryptMsgGetParam(
            cryptographicMessage,
            CMSG_SIGNER_INFO_PARAM,
            0,
            nullptr,
            &signerInfoBytes) && signerInfoBytes >= sizeof(CMSG_SIGNER_INFO)) {
        std::vector<std::uint8_t> signerInfoBuffer(signerInfoBytes);
        if (CryptMsgGetParam(
                cryptographicMessage,
                CMSG_SIGNER_INFO_PARAM,
                0,
                signerInfoBuffer.data(),
                &signerInfoBytes)) {
            const auto* signerInfo = reinterpret_cast<const CMSG_SIGNER_INFO*>(signerInfoBuffer.data());
            CERT_INFO certificateIdentity{};
            certificateIdentity.Issuer = signerInfo->Issuer;
            certificateIdentity.SerialNumber = signerInfo->SerialNumber;
            PCCERT_CONTEXT certificate = CertFindCertificateInStore(
                certificateStore,
                X509_ASN_ENCODING | PKCS_7_ASN_ENCODING,
                0,
                CERT_FIND_SUBJECT_CERT,
                &certificateIdentity,
                nullptr);
            if (certificate != nullptr) {
                const DWORD characters = CertGetNameStringW(
                    certificate,
                    CERT_NAME_ATTR_TYPE,
                    0,
                    const_cast<char*>(szOID_ORGANIZATION_NAME),
                    nullptr,
                    0);
                if (characters > 1) {
                    std::vector<wchar_t> name(characters);
                    if (CertGetNameStringW(
                            certificate,
                            CERT_NAME_ATTR_TYPE,
                            0,
                            const_cast<char*>(szOID_ORGANIZATION_NAME),
                            name.data(),
                            characters) == characters) {
                        organization = std::wstring(name.data());
                    }
                }
                CertFreeCertificateContext(certificate);
            }
        }
    }

    CryptMsgClose(cryptographicMessage);
    CertCloseStore(certificateStore, 0);
    return organization;
}

bool VerifyLogitechAuthenticodeSignature(const std::wstring& path, std::wstring& signerOrganization) {
    WINTRUST_FILE_INFO fileInfo{};
    fileInfo.cbStruct = sizeof(fileInfo);
    fileInfo.pcwszFilePath = path.c_str();

    WINTRUST_DATA trustData{};
    trustData.cbStruct = sizeof(trustData);
    trustData.dwUIChoice = WTD_UI_NONE;
    trustData.fdwRevocationChecks = WTD_REVOKE_NONE;
    trustData.dwUnionChoice = WTD_CHOICE_FILE;
    trustData.pFile = &fileInfo;
    trustData.dwStateAction = WTD_STATEACTION_VERIFY;
    trustData.dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_SAFER_FLAG;

    GUID policy = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    const LONG trustStatus = WinVerifyTrust(nullptr, &policy, &trustData);
    trustData.dwStateAction = WTD_STATEACTION_CLOSE;
    WinVerifyTrust(nullptr, &policy, &trustData);
    if (trustStatus != ERROR_SUCCESS) {
        return false;
    }

    const auto organization = ReadEmbeddedSignerOrganization(path);
    if (!organization || !IsLogitechSignerOrganization(*organization)) {
        return false;
    }
    signerOrganization = *organization;
    return true;
}

class LogitechRuntime {
public:
    ~LogitechRuntime() {
        Unload();
    }

    LogitechRuntime(const LogitechRuntime&) = delete;
    LogitechRuntime& operator=(const LogitechRuntime&) = delete;

    LogitechRuntime() = default;

    bool Load(std::string& error) {
        if (module_ != nullptr) {
            return true;
        }

        std::vector<std::wstring> candidates;
        if (const auto registered = ReadRegisteredRuntimePath()) {
            candidates.push_back(*registered);
        }
        if (const auto fallback = DefaultRuntimePath()) {
            bool duplicate = false;
            for (const auto& candidate : candidates) {
                duplicate = _wcsicmp(candidate.c_str(), fallback->c_str()) == 0;
            }
            if (!duplicate) {
                candidates.push_back(*fallback);
            }
        }

        error = "g_hub_runtime_missing";
        for (const auto& candidate : candidates) {
            const auto path = CanonicalExistingFilePath(candidate);
            if (!path) {
                continue;
            }
            std::wstring signerOrganization;
            if (!VerifyLogitechAuthenticodeSignature(*path, signerOrganization)) {
                error = "g_hub_runtime_untrusted";
                continue;
            }

            HMODULE module = LoadLibraryExW(
                path->c_str(),
                nullptr,
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
            if (module == nullptr) {
                error = "g_hub_runtime_load_failed";
                continue;
            }

            const auto initWithName = reinterpret_cast<LogiLedInitWithNameFunction>(
                GetProcAddress(module, "LogiLedInitWithName"));
            const auto getSdkVersion = reinterpret_cast<LogiLedGetSdkVersionFunction>(
                GetProcAddress(module, "LogiLedGetSdkVersion"));
            const auto setTargetZone = reinterpret_cast<LogiLedSetLightingForTargetZoneFunction>(
                GetProcAddress(module, "LogiLedSetLightingForTargetZone"));
            const auto shutdown = reinterpret_cast<LogiLedShutdownFunction>(
                GetProcAddress(module, "LogiLedShutdown"));
            if (initWithName == nullptr || getSdkVersion == nullptr ||
                setTargetZone == nullptr || shutdown == nullptr) {
                FreeLibrary(module);
                error = "g_hub_runtime_exports_missing";
                continue;
            }

            module_ = module;
            initWithName_ = initWithName;
            getSdkVersion_ = getSdkVersion;
            setTargetZone_ = setTargetZone;
            shutdown_ = shutdown;
            path_ = *path;
            signerOrganization_ = std::move(signerOrganization);
            return true;
        }
        return false;
    }

    void Unload() noexcept {
        initWithName_ = nullptr;
        getSdkVersion_ = nullptr;
        setTargetZone_ = nullptr;
        shutdown_ = nullptr;
        path_.clear();
        signerOrganization_.clear();
        if (module_ != nullptr) {
            FreeLibrary(module_);
            module_ = nullptr;
        }
    }

    bool InitWithName(const char* applicationName) const {
        return initWithName_ != nullptr && initWithName_(applicationName);
    }

    bool GetSdkVersion(int* major, int* minor, int* build) const {
        return getSdkVersion_ != nullptr && getSdkVersion_(major, minor, build);
    }

    bool SetLightingForTargetZone(int zone, int red, int green, int blue) const {
        return setTargetZone_ != nullptr && setTargetZone_(
            kLogitechSpeakerDeviceType,
            zone,
            red,
            green,
            blue);
    }

    void Shutdown() const noexcept {
        if (shutdown_ != nullptr) {
            shutdown_();
        }
    }

    const std::wstring& Path() const noexcept {
        return path_;
    }

    const std::wstring& SignerOrganization() const noexcept {
        return signerOrganization_;
    }

private:
    HMODULE module_ = nullptr;
    LogiLedInitWithNameFunction initWithName_ = nullptr;
    LogiLedGetSdkVersionFunction getSdkVersion_ = nullptr;
    LogiLedSetLightingForTargetZoneFunction setTargetZone_ = nullptr;
    LogiLedShutdownFunction shutdown_ = nullptr;
    std::wstring path_;
    std::wstring signerOrganization_;
};

class LogitechSdkController {
public:
    ~LogitechSdkController() {
        Release();
    }

    bool Acquire(const std::string& applicationName, std::string& sdkVersion, std::string& error) {
        if (acquired_) {
            sdkVersion = VersionString();
            return true;
        }
        std::string loadError;
        if (!runtime_.Load(loadError)) {
            error = loadError;
            runtime_.Unload();
            return false;
        }
        if (!runtime_.InitWithName(applicationName.c_str())) {
            error = "g_hub_init_failed";
            runtime_.Unload();
            return false;
        }
        acquired_ = true;
        // Logitech explicitly warns against setting colours immediately after init.
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
        sdkVersion = VersionString();
        return true;
    }

    bool ApplyFrame(const Frame& frame, int& failedCanonicalZone) {
        if (!acquired_) {
            failedCanonicalZone = -1;
            return false;
        }
        for (std::size_t canonicalZone = 0; canonicalZone < frame.zones.size(); ++canonicalZone) {
            const auto& color = frame.zones[canonicalZone];
            const bool written = runtime_.SetLightingForTargetZone(
                kSdkZoneForCanonicalIndex[canonicalZone],
                color[0],
                color[1],
                color[2]);
            if (!written) {
                failedCanonicalZone = static_cast<int>(canonicalZone);
                return false;
            }
        }
        return true;
    }

    void Release() noexcept {
        if (acquired_) {
            // The runtime restores the lighting snapshot captured by InitWithName.
            runtime_.Shutdown();
            acquired_ = false;
        }
        runtime_.Unload();
    }

    bool IsAcquired() const noexcept {
        return acquired_;
    }

private:
    std::string VersionString() const {
        int major = 0;
        int minor = 0;
        int build = 0;
        if (!runtime_.GetSdkVersion(&major, &minor, &build)) {
            return "unknown";
        }
        return std::to_string(major) + "." + std::to_string(minor) + "." + std::to_string(build);
    }

    bool acquired_ = false;
    LogitechRuntime runtime_;
};

void RunWorker(WorkQueue& queue) {
    LogitechSdkController sdk;
    while (const auto command = queue.Take()) {
        switch (command->type) {
        case CommandType::Acquire: {
            std::string sdkVersion;
            std::string acquireError;
            if (sdk.Acquire(command->argument, sdkVersion, acquireError)) {
                WriteResponse("ACQUIRED sdk=" + sdkVersion);
            } else {
                WriteResponse("ERR acquire " + (acquireError.empty() ? "g_hub_unavailable" : acquireError));
            }
            break;
        }
        case CommandType::Frame: {
            if (!sdk.IsAcquired()) {
                WriteResponse("ERR frame not_acquired seq=" + std::to_string(command->frame.sequence));
                break;
            }
            int failedZone = -1;
            if (sdk.ApplyFrame(command->frame, failedZone)) {
                WriteResponse("FRAME_OK seq=" + std::to_string(command->frame.sequence));
            } else {
                sdk.Release();
                WriteResponse(
                    "ERR frame sdk_write_failed seq=" + std::to_string(command->frame.sequence) +
                    " zone=" + std::to_string(failedZone));
            }
            break;
        }
        case CommandType::Release:
            sdk.Release();
            WriteResponse("RELEASED");
            break;
        case CommandType::Ping:
            WriteResponse(command->argument.empty() ? "PONG" : "PONG " + command->argument);
            break;
        case CommandType::Quit:
            sdk.Release();
            WriteResponse("BYE");
            return;
        }
    }
    // EOF reaches here. The controller destructor restores the saved lighting.
}

bool Expect(bool condition, const char* message) {
    if (!condition) {
        std::cerr << "SELF_TEST_FAILED " << message << '\n';
        return false;
    }
    return true;
}

int RunSelfTest() {
    bool passed = true;
    passed &= Expect(IsLogitechSignerOrganization(L"Logitech Inc"), "current_logitech_signer");
    passed &= Expect(IsLogitechSignerOrganization(L" Logitech Europe S.A. "), "europe_logitech_signer");
    passed &= Expect(!IsLogitechSignerOrganization(L"Not Logitech Inc"), "reject_non_logitech_signer");
    passed &= Expect(
        HasExpectedRuntimeFileName(L"C:\\Program Files\\LGHUB\\sdks\\SDK_LEGACY_LED_X64.DLL"),
        "runtime_filename_case");
    passed &= Expect(
        !HasExpectedRuntimeFileName(L"C:\\Program Files\\LGHUB\\sdks\\unrelated.dll"),
        "runtime_filename_reject");
    const auto frame = ParseCommand("FRAME 42 1 2 3 4 5 6 7 8 9 10 11 12");
    passed &= Expect(frame.command.has_value(), "valid_frame_rejected");
    if (frame.command) {
        passed &= Expect(frame.command->frame.sequence == 42, "frame_sequence");
        passed &= Expect(frame.command->frame.zones[1][0] == 4, "canonical_zone_order");
        passed &= Expect(kSdkZoneForCanonicalIndex == std::array<int, 4>{0, 2, 1, 3}, "sdk_zone_map");
    }
    passed &= Expect(!ParseCommand("FRAME 1 101 0 0 0 0 0 0 0 0 0 0 0").command, "percentage_bound");
    passed &= Expect(!ParseCommand("FRAME 1 0 0").command, "field_count_bound");
    passed &= Expect(!ParseCommand("ACQUIRE").command, "empty_application_name");

    WorkQueue queue;
    Command first;
    first.type = CommandType::Frame;
    first.frame.sequence = 1;
    Command second;
    second.type = CommandType::Frame;
    second.frame.sequence = 2;
    passed &= Expect(queue.Submit(std::move(first)).accepted, "queue_first_frame");
    const auto secondResult = queue.Submit(std::move(second));
    passed &= Expect(secondResult.accepted && secondResult.droppedFrame == 1, "latest_frame_wins");
    const auto taken = queue.Take();
    passed &= Expect(taken && taken->frame.sequence == 2, "latest_frame_delivered");

    WorkQueue releaseQueue;
    Command pending;
    pending.type = CommandType::Frame;
    pending.frame.sequence = 9;
    releaseQueue.Submit(std::move(pending));
    Command release;
    release.type = CommandType::Release;
    const auto releaseResult = releaseQueue.Submit(std::move(release));
    passed &= Expect(releaseResult.droppedFrame == 9, "release_discards_frame");
    const auto releaseTaken = releaseQueue.Take();
    passed &= Expect(releaseTaken && releaseTaken->type == CommandType::Release, "release_priority");

    if (!passed) {
        return EXIT_FAILURE;
    }
    std::cout << "SELF_TEST_OK protocol=" << kProtocolVersion << '\n';
    return EXIT_SUCCESS;
}

int RunRuntimeCheck() {
    LogitechRuntime runtime;
    std::string error;
    if (!runtime.Load(error)) {
        std::cerr << "RUNTIME_CHECK_FAILED " << error << '\n';
        return EXIT_FAILURE;
    }
    std::wcout << L"RUNTIME_CHECK_OK signer=\"" << runtime.SignerOrganization()
               << L"\" path=\"" << runtime.Path() << L"\"\n";
    return EXIT_SUCCESS;
}

} // namespace

int main(int argc, char* argv[]) {
    if (argc == 2 && std::string_view(argv[1]) == "--self-test") {
        return RunSelfTest();
    }
    if (argc == 2 && std::string_view(argv[1]) == "--runtime-check") {
        return RunRuntimeCheck();
    }
    if (argc != 1) {
        std::cerr << "Usage: g560-bridge.exe [--self-test|--runtime-check]\n";
        return EXIT_FAILURE;
    }

    WorkQueue queue;
    std::thread worker([&queue] { RunWorker(queue); });
    WriteResponse("READY protocol=" + std::to_string(kProtocolVersion));

    std::string line;
    bool tooLong = false;
    bool quitSubmitted = false;
    while (ReadBoundedLine(std::cin, line, tooLong)) {
        if (tooLong) {
            WriteResponse("ERR protocol line_too_long");
            continue;
        }
        const ParseResult parsed = ParseCommand(line);
        if (!parsed.command) {
            WriteResponse("ERR protocol " + parsed.error);
            continue;
        }
        const bool quitting = parsed.command->type == CommandType::Quit;
        const SubmitResult submitted = queue.Submit(std::move(*parsed.command));
        if (!submitted.accepted) {
            WriteResponse("ERR protocol " + submitted.error);
        }
        if (submitted.droppedFrame) {
            WriteResponse("FRAME_DROPPED seq=" + std::to_string(*submitted.droppedFrame));
        }
        if (quitting && submitted.accepted) {
            quitSubmitted = true;
            break;
        }
    }

    if (!quitSubmitted && !std::cin.eof()) {
        WriteResponse("ERR protocol input_failure");
    }
    if (!quitSubmitted) {
        queue.CloseInput();
    }
    worker.join();
    return EXIT_SUCCESS;
}
