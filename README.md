# RAM Watch 3.0

RAM Watch has two distinct measurement modes:

- **Renderer footprints** use the Windows companion and a monitored Chrome profile. The number is Windows private committed bytes for the tab's main renderer process, using the same Windows counter type Chromium uses for Task Manager's memory footprint.
- **Page estimates** are the original JavaScript/page measurements. They cannot replace Task Manager's footprint figures. They remain available without companion setup and are labeled as estimates.

## Install the complete package

1. Extract **ram-watch-complete.zip** to a permanent folder.
2. Run **companion\Start-RAM-Watch.cmd**. It uses your existing Chrome executable with a dedicated profile under **%LOCALAPPDATA%\RamWatch\ChromeProfile**.
3. In that Chrome window, open **chrome://extensions**, enable Developer mode, choose **Load unpacked**, and select the extracted **ram-watch** folder.
4. Open the RAM Watch popup menu → **Companion setup**. Copy the displayed extension ID.
5. Run **companion\Install.cmd**, paste that ID, then use **Enable renderer footprints** on the setup page. Chrome requests the optional **nativeMessaging** permission. The **debugger** permission is required by Chrome at extension load/re-enable time (it cannot be optional).
6. Open your sites in that monitored Chrome window. Sampling occurs at most once per minute. Popup refreshes reuse the current sample.

The current Chrome default profile cannot be monitored this way. Chrome 136+ requires a non-default profile for remote debugging. The supplied launcher binds a random local port to loopback; it does not change your usual Chrome profile or migrate cookies/passwords. Sign into sites separately in the monitored profile if needed.

The debugger permission is used only for **getTargets()**, to associate exact Chrome target IDs with tab IDs. The extension does not attach debuggers or match tabs by title/URL. The native helper uses a short DevTools trace to identify each main renderer PID, closes it immediately, reads **GetProcessMemoryInfo().PrivateUsage**, returns the results, and exits. If another profiler is already tracing, that tab is unavailable; RAM Watch does not stop the other profiler.

## Resource budget

- Native C++ Windows executable, about 342 KiB. No Node, Python, Electron, .NET runtime, background service, or startup task is installed.
- No companion process remains between samples. A sample has an 8-second batch budget and 12-second absolute host deadline.
- Sampling is limited to once per minute, across popup openings and extension service-worker restarts. New or navigated tabs can wait until the next sample.
- Pausing alerts also skips scheduled companion samples. Opening the popup still refreshes its display from the cached sample.
- Trace buffers are limited to 256 KiB per tab session. Trace message and native message sizes are bounded. No screenshots, CPU profiles, memory dumps, trace files, measurement history, or telemetry are collected.
- The launcher requests a 64 MiB disk cache and 16 MiB media cache. These are browser cache targets, not a hard limit on the whole profile. Site storage, downloads, service workers, sign-ins, and Chrome's other files can grow.
- Prefer using the monitored profile for browsing instead of keeping a duplicate session open in your usual Chrome profile.

Local fixture verification measured approximately **12.5 MiB peak working set** and **2.5 MiB private committed memory** during a four-target sample, which completed in **94 ms after connection**. The helper exited afterward. These figures exclude Chrome and its tracing overhead, process startup/scanning by security software, and real-world browser latency; they are not a guaranteed maximum. See **tests/verification.json** for the recorded check.

## Accuracy and scope

- A tab row shows its **main renderer** footprint. Browser, GPU, and separate iframe/worker processes are additional tasks in Chrome Task Manager and are not arbitrarily assigned to that tab.
- Multiple tabs can share a renderer. Each row identifies that sharing; the total counts the process only once. This is not exact memory attribution to each tab.
- Windows private footprint includes committed memory that may be paged out. The helper also reports its own working set for diagnostics; those metrics should not be confused.
- Values are stored in bytes, with displayed MB using 1,048,576 bytes. Threshold comparisons use the underlying value before display rounding.
- Failed/unsupported measurements appear as **Unavailable**. Footprint mode never silently substitutes JavaScript heap data.
- Chrome's memory usage changes continuously. Compare roughly simultaneous samples of the same renderer PID. The complete live Chrome flow still requires user verification; local protocol fixtures are not proof of compatibility with every Chrome build.

## Remove

Run **companion\Uninstall.cmd**. It unregisters the native host and removes its executable/manifest/launcher. The **ChromeProfile** directory is deliberately retained because it may contain browsing data. Remove that profile manually only if you want to discard it.

The debugging connection permits local software running as your user to control the monitored profile. It binds only to loopback, but it should still be used only for a profile you intend to expose to local debugging.

## Build and checks

Source is included in this workspace. Build tools are not required to use the packaged executable.

- **companion\build.cmd**: Visual Studio 2022 Build Tools, Desktop development with C++, Windows SDK. Static release runtime; generated object files are removed.
- **companion\build.cmd test**: test executable with a loopback fixture endpoint. Test-only overrides are compiled out of the release executable.
- **node tests\background.cjs**: accounting, shared renderers, cache lifetime/restarts, navigation invalidation, disconnected host, permissions, legacy mode, pause.
- **node tests\native.cjs**: native messaging framing, WinHTTP WebSockets, fragmentation/event ordering, exact target matching, shared renderer caching, navigation/profiler failures, native size limits, and real Windows self-memory reads. Uses a local fake CDP endpoint; does not launch Chrome or install anything.
- **node scripts\package.cjs**: builds the extension-only ZIP and the complete runnable bundle using Node's built-in compression. Compilers, object files, test executables, and tests are excluded from the runnable package.

## Primary references

- [Chromium's Windows private-memory counter](https://github.com/chromium/chromium/blob/main/base/process/process_metrics_win.cc)
- [Chromium's Task Manager footprint accounting](https://github.com/chromium/chromium/blob/main/chrome/browser/task_manager/sampling/task_manager_impl.cc)
- [Chrome remote debugging and non-default profiles](https://developer.chrome.com/blog/remote-debugging-port)
- [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Microsoft PROCESS_MEMORY_COUNTERS_EX](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex)
