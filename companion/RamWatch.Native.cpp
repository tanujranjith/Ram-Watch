// RAM Watch native messaging host. One bounded sample per process; no daemon.
// Native Windows APIs + OS JSON parser: no Node/Python/managed runtime.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winhttp.h>
#include <psapi.h>
#include <shlobj.h>
#include <fcntl.h>
#include <io.h>
#include <winrt/base.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Data.Json.h>
#include <iostream>
#include <fstream>
#include <filesystem>
#include <string>
#include <map>
#include <algorithm>
#include <stdexcept>

using namespace winrt::Windows::Data::Json;
using std::string;
using std::wstring;
namespace fs = std::filesystem;

fs::path InstallDirectory() {
  PWSTR local = nullptr;
  winrt::check_hresult(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &local));
  fs::path folder = fs::path(local) / L"RamWatch";
  CoTaskMemFree(local);
  return folder;
}

struct Internet {
  HINTERNET h = nullptr;
  Internet() = default;
  explicit Internet(HINTERNET value) : h(value) {
    if (!h) throw std::runtime_error("Could not open local browser connection.");
  }
  ~Internet() { if (h) WinHttpCloseHandle(h); }
  Internet(const Internet&) = delete;
  Internet& operator=(const Internet&) = delete;
};
void Check(bool ok, const char* message) {
  if (!ok) throw std::runtime_error(message);
}
string Text(IJsonValue const& v) { return winrt::to_string(v.GetString()); }
string Get(JsonObject const& o, const wchar_t* key, string fallback = "") {
  if (!o.HasKey(key) || o.Lookup(key).ValueType() != JsonValueType::String) return fallback;
  return Text(o.Lookup(key));
}
double Num(JsonObject const& o, const wchar_t* key, double fallback = 0) {
  if (!o.HasKey(key) || o.Lookup(key).ValueType() != JsonValueType::Number) return fallback;
  return o.GetNamedNumber(key);
}
void Put(JsonObject& o, const wchar_t* key, string const& s) {
  o.Insert(key, JsonValue::CreateStringValue(winrt::to_hstring(s)));
}
void Put(JsonObject& o, const wchar_t* key, double n) {
  o.Insert(key, JsonValue::CreateNumberValue(n));
}
void Put(JsonObject& o, const wchar_t* key, bool b) {
  o.Insert(key, JsonValue::CreateBooleanValue(b));
}
string Encode(JsonObject const& o) { return winrt::to_string(o.Stringify()); }

class LocalBrowser {
  Internet session{WinHttpOpen(L"RAMWatch/3", WINHTTP_ACCESS_TYPE_NO_PROXY,
                              WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0)};
  Internet connection;
public:
  explicit LocalBrowser(INTERNET_PORT port)
      : connection(WinHttpConnect(session.h, L"127.0.0.1", port, 0)) {
    WinHttpSetTimeouts(session.h, 1000, 1000, 1500, 1500);
  }
  JsonArray Targets() {
    Internet request(WinHttpOpenRequest(connection.h, L"GET", L"/json/list",
                     nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0));
    Check(WinHttpSendRequest(request.h, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
          WINHTTP_NO_REQUEST_DATA, 0, 0, 0) && WinHttpReceiveResponse(request.h, nullptr),
          "Start Chrome with Start-RAM-Watch.cmd before sampling.");
    DWORD status = 0, size = sizeof(status);
    Check(WinHttpQueryHeaders(request.h, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
          WINHTTP_HEADER_NAME_BY_INDEX, &status, &size, WINHTTP_NO_HEADER_INDEX) && status == 200,
          "Local Chrome target list is unavailable.");
    string body;
    char buffer[8192]; DWORD read = 0;
    do {
      Check(WinHttpReadData(request.h, buffer, sizeof(buffer), &read), "Could not read local Chrome targets.");
      Check(body.size() + read <= 1024 * 1024, "Too many Chrome targets.");
      body.append(buffer, read);
    } while (read);
    return JsonArray::Parse(winrt::to_hstring(body));
  }
  HINTERNET WebSocket(wstring const& urlPath) {
    Internet request(WinHttpOpenRequest(connection.h, L"GET", urlPath.c_str(),
                     nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0));
    Check(WinHttpSetOption(request.h, WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET, nullptr, 0),
          "Windows WebSocket API unavailable.");
    Check(WinHttpSendRequest(request.h, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
          WINHTTP_NO_REQUEST_DATA, 0, 0, 0) && WinHttpReceiveResponse(request.h, nullptr),
          "Could not connect to this Chrome tab.");
    return WinHttpWebSocketCompleteUpgrade(request.h, 0);
  }
};

// A page socket owns its own trace. Never stop a trace started by another client.
class PageProbe {
  Internet socket;
  int nextId = 0;
  string rootFrame;
  DWORD rendererPid = 0;
  bool changed = false, complete = false, lost = false;

  JsonObject Receive() {
    string body;
    char buffer[16384];
    WINHTTP_WEB_SOCKET_BUFFER_TYPE kind;
    do {
      DWORD read = 0;
      Check(WinHttpWebSocketReceive(socket.h, buffer, sizeof(buffer), &read, &kind) == NO_ERROR,
            "Chrome tab did not respond.");
      Check(kind != WINHTTP_WEB_SOCKET_CLOSE_BUFFER_TYPE, "Chrome tab disconnected.");
      Check(body.size() + read <= 2 * 1024 * 1024, "Chrome trace message exceeded the memory limit.");
      body.append(buffer, read);
    } while (kind == WINHTTP_WEB_SOCKET_UTF8_FRAGMENT_BUFFER_TYPE);
    Check(kind == WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE, "Unexpected Chrome response.");
    return JsonObject::Parse(winrt::to_hstring(body));
  }
  void Event(JsonObject const& message) {
    string method = Get(message, L"method");
    if (!message.HasKey(L"params")) return;
    auto params = message.GetNamedObject(L"params");
    if (method == "Tracing.tracingComplete") {
      complete = true;
      lost = params.GetNamedBoolean(L"dataLossOccurred", false);
    }
    if (method != "Tracing.dataCollected") return;
    for (auto const& value : params.GetNamedArray(L"value")) {
      auto e = value.GetObject();
      auto args = e.GetNamedObject(L"args", JsonObject{});
      auto data = args.GetNamedObject(L"data", JsonObject{});
      string name = Get(e, L"name");
      if (name == "TracingStartedInBrowser" && data.HasKey(L"frames")) {
        for (auto const& f : data.GetNamedArray(L"frames")) {
          auto frame = f.GetObject();
          if (Get(frame, L"frame") == rootFrame) {
            auto pid = Num(frame, L"processId");
            if (pid > 0 && pid <= MAXDWORD) rendererPid = static_cast<DWORD>(pid);
          }
        }
      } else if ((name == "FrameCommittedInBrowser" || name == "FrameDeletedInBrowser") &&
                 Get(data, L"frame") == rootFrame) {
        changed = true; // Navigation during the sample: do not assign old memory to a new page.
      }
    }
  }
public:
  PageProbe(LocalBrowser& browser, wstring const& urlPath) : socket(browser.WebSocket(urlPath)) {}
  ~PageProbe() {
    // Closing this DevTools socket also cleans up its owned trace if a command failed.
    if (socket.h) WinHttpWebSocketClose(socket.h, WINHTTP_WEB_SOCKET_SUCCESS_CLOSE_STATUS, nullptr, 0);
  }
  JsonObject Command(const wchar_t* method, JsonObject params = {}) {
    JsonObject message;
    int id = ++nextId;
    Put(message, L"id", static_cast<double>(id));
    Put(message, L"method", winrt::to_string(method));
    message.Insert(L"params", params);
    auto bytes = Encode(message);
    Check(WinHttpWebSocketSend(socket.h, WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE,
          bytes.data(), static_cast<DWORD>(bytes.size())) == NO_ERROR, "Could not send Chrome command.");
    for (;;) {
      auto response = Receive();
      if (Num(response, L"id", -1) != id) { Event(response); continue; }
      if (response.HasKey(L"error")) {
        throw std::runtime_error(Get(response.GetNamedObject(L"error"), L"message", "Chrome command failed."));
      }
      return response.GetNamedObject(L"result", JsonObject{});
    }
  }
  DWORD RendererPid() {
    rootFrame = Get(Command(L"Page.getFrameTree").GetNamedObject(L"frameTree").GetNamedObject(L"frame"), L"id");
    Check(!rootFrame.empty(), "Chrome did not identify the page frame.");
    JsonObject config;
    Put(config, L"recordMode", string("recordUntilFull"));
    Put(config, L"traceBufferSizeInKb", 256.0);
    JsonArray included, excluded;
    included.Append(JsonValue::CreateStringValue(L"disabled-by-default-devtools.timeline"));
    excluded.Append(JsonValue::CreateStringValue(L"*"));
    config.Insert(L"includedCategories", included);
    config.Insert(L"excludedCategories", excluded);
    JsonObject start;
    start.Insert(L"traceConfig", config);
    Put(start, L"transferMode", string("ReportEvents"));
    Command(L"Tracing.start", start);
    Command(L"Tracing.end");
    while (!complete) Event(Receive());
    Check(!lost && !changed && rendererPid, "Page changed or Chrome could not provide its renderer PID.");
    return rendererPid;
  }
};

JsonObject ProcessMemory(DWORD pid, bool selfTest = false) {
  HANDLE handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  Check(handle != nullptr, "Renderer exited before memory could be sampled.");
  struct Close { HANDLE h; ~Close() { CloseHandle(h); } } close{handle};
  wchar_t image[32768]; DWORD length = _countof(image);
  Check(QueryFullProcessImageNameW(handle, 0, image, &length), "Could not identify renderer executable.");
  if (!selfTest) {
    Check(_wcsicmp(fs::path(image).filename().c_str(), L"chrome.exe") == 0, "PID does not belong to Chrome.");
  }
  PROCESS_MEMORY_COUNTERS_EX memory{};
  memory.cb = sizeof(memory);
  Check(GetProcessMemoryInfo(handle, reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&memory), sizeof(memory)),
        "Windows denied access to renderer memory counters.");
  FILETIME created{}, exited{}, kernel{}, user{};
  Check(GetProcessTimes(handle, &created, &exited, &kernel, &user), "Could not identify renderer lifetime.");
  ULARGE_INTEGER time; time.LowPart = created.dwLowDateTime; time.HighPart = created.dwHighDateTime;
  JsonObject result;
  Put(result, L"pid", static_cast<double>(pid));
  Put(result, L"processKey", std::to_string(pid) + ":" + std::to_string(time.QuadPart));
  // Same Windows private-commit counter used by Chromium's process_metrics_win.cc.
  Put(result, L"bytes", static_cast<double>(memory.PrivateUsage));
  Put(result, L"workingSetBytes", static_cast<double>(memory.WorkingSetSize));
  Put(result, L"peakWorkingSetBytes", static_cast<double>(memory.PeakWorkingSetSize));
  return result;
}

INTERNET_PORT BrowserPort() {
#ifdef RAMWATCH_TESTING
  wchar_t testPort[16];
  if (GetEnvironmentVariableW(L"RAMWATCH_TEST_PORT", testPort, 16)) {
    auto n = std::stoul(testPort);
    Check(n > 0 && n <= 65535, "Invalid test port.");
    return static_cast<INTERNET_PORT>(n);
  }
#endif
  fs::path file = InstallDirectory() / L"ChromeProfile" / L"DevToolsActivePort";
  std::ifstream input(file);
  unsigned long port = 0;
  Check(static_cast<bool>(input >> port) && port > 0 && port <= 65535,
        "Open Chrome using Start-RAM-Watch.cmd. Footprints require the monitored Chrome profile.");
  return static_cast<INTERNET_PORT>(port);
}

JsonObject Sample(JsonObject const& request) {
  Check(Get(request, L"type") == "sample", "Unsupported native message.");
  auto wanted = request.GetNamedArray(L"targets");
  Check(wanted.Size() <= 256, "At most 256 tabs can be sampled at once.");
  auto port = BrowserPort();
  LocalBrowser browser(port);
  std::map<string, string> endpoints;
  string prefix = "ws://127.0.0.1:" + std::to_string(port);
  string localhostPrefix = "ws://localhost:" + std::to_string(port);
  for (auto const& value : browser.Targets()) {
    auto t = value.GetObject();
    string url = Get(t, L"webSocketDebuggerUrl"), tail;
    if (url.rfind(prefix + "/devtools/page/", 0) == 0) tail = url.substr(prefix.size());
    else if (url.rfind(localhostPrefix + "/devtools/page/", 0) == 0) tail = url.substr(localhostPrefix.size());
    if (!tail.empty() && Get(t, L"type") == "page") endpoints[Get(t, L"id")] = tail;
  }
  JsonArray rows;
  std::map<DWORD, JsonObject> memoryByPid;
  auto started = GetTickCount64();
  for (auto const& value : wanted) {
    if (GetTickCount64() - started > 8000) break;
    auto target = value.GetObject();
    auto found = endpoints.find(Get(target, L"targetId"));
    if (found == endpoints.end()) continue; // Never guess by page URL/title.
    JsonObject result;
    Put(result, L"tabId", Num(target, L"tabId", -1));
    try {
      PageProbe page(browser, winrt::to_hstring(found->second).c_str());
      DWORD pid = page.RendererPid();
#ifdef RAMWATCH_TESTING
      if (pid == 1) pid = GetCurrentProcessId();
#endif
      if (!memoryByPid.count(pid)) memoryByPid[pid] = ProcessMemory(pid,
#ifdef RAMWATCH_TESTING
        true
#else
        false
#endif
      );
      for (auto const& field : memoryByPid.at(pid)) result.Insert(field.Key(), field.Value());
    } catch (std::exception const& e) { Put(result, L"error", string(e.what())); }
      catch (winrt::hresult_error const&) { Put(result, L"error", string("Chrome sent an unsupported response.")); }
    rows.Append(result);
  }
  JsonObject response;
  Put(response, L"ok", true);
  response.Insert(L"rows", rows);
  Put(response, L"elapsedMs", static_cast<double>(GetTickCount64() - started));
  response.Insert(L"helperMemory", ProcessMemory(GetCurrentProcessId(), true));
  return response;
}

void ReadExact(char* bytes, size_t size) {
  std::cin.read(bytes, size);
  Check(static_cast<size_t>(std::cin.gcount()) == size, "Native message ended early.");
}

const char* Launcher = R"CMD(@echo off
setlocal
set "chrome=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%chrome%" set "chrome=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%chrome%" set "chrome=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not exist "%chrome%" (
  echo Chrome was not found. Install Google Chrome before using this launcher.
  pause
  exit /b 1
)
start "" "%chrome%" --user-data-dir="%LOCALAPPDATA%\RamWatch\ChromeProfile" --remote-debugging-port=0 --remote-debugging-address=127.0.0.1 --disk-cache-size=67108864 --media-cache-size=16777216 --no-first-run
)CMD";

void Install(wstring const& extensionId) {
  Check(extensionId.size() == 32 && std::all_of(extensionId.begin(), extensionId.end(),
    [](wchar_t c) { return c >= L'a' && c <= L'p'; }), "Paste the 32-letter extension ID from Companion setup.");
  auto folder = InstallDirectory();
  fs::create_directories(folder);
  wchar_t ownPath[32768];
  Check(GetModuleFileNameW(nullptr, ownPath, _countof(ownPath)) != 0, "Could not locate helper.");
  auto installed = folder / L"RamWatch.Native.exe";
  if (_wcsicmp(fs::absolute(ownPath).c_str(), installed.c_str()) != 0) {
    fs::copy_file(ownPath, installed, fs::copy_options::overwrite_existing);
  }
  JsonObject manifest;
  Put(manifest, L"name", string("com.ramwatch.memory"));
  Put(manifest, L"description", string("RAM Watch one-shot renderer footprint sampler"));
  Put(manifest, L"path", winrt::to_string(installed.wstring()));
  Put(manifest, L"type", string("stdio"));
  JsonArray origins;
  origins.Append(JsonValue::CreateStringValue(L"chrome-extension://" + extensionId + L"/"));
  manifest.Insert(L"allowed_origins", origins);
  auto manifestFile = folder / L"NativeMessagingHost.json";
  std::ofstream hostFile(manifestFile, std::ios::binary);
  hostFile << Encode(manifest);
  hostFile.close();
  Check(static_cast<bool>(hostFile), "Could not write native host manifest.");
  std::ofstream launcher(folder / L"Start-RAM-Watch.cmd", std::ios::binary);
  launcher << Launcher;
  launcher.close();
  Check(static_cast<bool>(launcher), "Could not write Chrome launcher.");
  HKEY key = nullptr;
  Check(RegCreateKeyExW(HKEY_CURRENT_USER,
    L"Software\\Google\\Chrome\\NativeMessagingHosts\\com.ramwatch.memory",
    0, nullptr, 0, KEY_SET_VALUE, nullptr, &key, nullptr) == ERROR_SUCCESS, "Could not register host for this user.");
  auto registryPath = manifestFile.wstring();
  auto status = RegSetValueExW(key, nullptr, 0, REG_SZ,
    reinterpret_cast<const BYTE*>(registryPath.c_str()),
    static_cast<DWORD>((registryPath.size() + 1) * sizeof(wchar_t)));
  RegCloseKey(key);
  Check(status == ERROR_SUCCESS, "Could not finish native host registration.");
  std::cout << "Companion installed for this user. No background service or startup task was created.\n"
    << "Launch Chrome with: " << winrt::to_string((folder / L"Start-RAM-Watch.cmd").wstring()) << "\n";
}

int wmain(int argc, wchar_t** argv) {
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    if (argc == 2 && wcscmp(argv[1], L"--install") == 0) {
      std::cout << "Paste the 32-letter extension ID from Companion setup: ";
      wstring extensionId;
      std::getline(std::wcin, extensionId);
      Install(extensionId);
      return 0;
    }
    if (argc == 3 && wcscmp(argv[1], L"--install") == 0) {
      Install(argv[2]);
      return 0;
    }
    if (argc == 2 && wcscmp(argv[1], L"--unregister") == 0) {
      auto result = RegDeleteKeyW(HKEY_CURRENT_USER,
        L"Software\\Google\\Chrome\\NativeMessagingHosts\\com.ramwatch.memory");
      Check(result == ERROR_SUCCESS || result == ERROR_FILE_NOT_FOUND, "Could not unregister native host.");
      std::cout << "Companion disabled. Chrome profile data was kept.\n";
      return 0;
    }
    if (argc == 2 && wcscmp(argv[1], L"--self-test") == 0) {
      auto own = ProcessMemory(GetCurrentProcessId(), true);
      Check(Num(own, L"bytes") > 0, "Memory self-test failed.");
      std::cout << Encode(own) << "\n";
      return 0;
    }
    // Hard cap includes pipe reads and any stuck browser command. Socket teardown
    // ends this client's trace; Chrome gets an error rather than fabricated data.
    HANDLE timer = nullptr;
    Check(CreateTimerQueueTimer(&timer, nullptr, [](PVOID, BOOLEAN) { ExitProcess(2); },
          nullptr, 12000, 0, WT_EXECUTEONLYONCE), "Could not set host time limit.");
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
    JsonObject response;
    try {
      uint32_t size = 0;
      ReadExact(reinterpret_cast<char*>(&size), sizeof(size));
      Check(size > 0 && size <= 65536, "Invalid native message size.");
      string payload(size, '\0');
      ReadExact(payload.data(), size);
      response = Sample(JsonObject::Parse(winrt::to_hstring(payload)));
    } catch (std::exception const& e) {
      Put(response, L"ok", false); Put(response, L"error", string(e.what()));
    } catch (winrt::hresult_error const&) {
      Put(response, L"ok", false); Put(response, L"error", string("Invalid native message or Windows API failure."));
    }
    auto bytes = Encode(response);
    uint32_t length = static_cast<uint32_t>(bytes.size());
    Check(length <= 1024 * 1024, "Native response too large.");
    std::cout.write(reinterpret_cast<char*>(&length), sizeof(length));
    std::cout.write(bytes.data(), bytes.size());
    std::cout.flush();
    DeleteTimerQueueTimer(nullptr, timer, INVALID_HANDLE_VALUE);
    return 0;
  } catch (std::exception const& e) { std::cerr << e.what() << "\n"; return 1; }
    catch (winrt::hresult_error const& e) { std::cerr << winrt::to_string(e.message()) << "\n"; return 1; }
    catch (...) { return 1; }
}
