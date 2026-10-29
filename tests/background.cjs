const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const assert = require("node:assert/strict");
const extension = path.resolve(__dirname, "../ram-watch");
const MB = 1024 * 1024;
const manifest = JSON.parse(fs.readFileSync(path.join(extension, "manifest.json"), "utf8"));
assert.ok(manifest.permissions.includes("debugger"), "Chrome does not support optional debugger permission");
assert.ok(!manifest.optional_permissions.includes("debugger"));
assert.ok(manifest.optional_permissions.includes("nativeMessaging"));
function event() {
  return { listeners: [], addListener(fn) { this.listeners.push(fn); } };
}
function harness(options = {}) {
  const settings = { memoryMode: "process", thresholdMB: 250, enabled: true, ...options.settings };
  const state = {
    now: 200000, calls: 0, scripts: 0, badges: [], notifications: [],
    session: options.session || {}, tabs: [
      { id: 1, url: "https://docs.test/", title: "Docs" },
      { id: 2, url: "https://docs.test/other", title: "Related Docs" },
      { id: 3, url: "https://calendar.test/", title: "Calendar" },
      { id: 4, url: "chrome://settings", title: "Settings" },
      { id: 5, url: "https://sleeping.test/", title: "Sleeping", discarded: true },
    ],
  };
  const read = async (object, keys) => typeof keys === "string" ? { [keys]: object[keys] }
    : Array.isArray(keys) ? Object.fromEntries(keys.map((k) => [k, object[k]])) : { ...keys, ...object };
  let context;
  const chrome = {
    runtime: {
      onInstalled: event(), onStartup: event(), onMessage: event(),
      sendNativeMessage: async () => {
        state.calls++;
        if (options.nativeError) return { ok: false, error: options.nativeError };
        return { ok: true, rows: [
          { tabId: 1, pid: 10, processKey: "10:a", bytes: 426 * MB },
          { tabId: 2, pid: 10, processKey: "10:a", bytes: 426 * MB },
          { tabId: 3, pid: 20, processKey: "20:b", bytes: 98 * MB },
        ] };
      },
    },
    tabs: { onUpdated: event(), onRemoved: event(), query: async () => state.tabs },
    permissions: { contains: async () => options.permissions !== false },
    debugger: { getTargets: async () => state.tabs.map((t) => ({ type: "page", tabId: t.id, id: "target-" + t.id })) },
    storage: {
      onChanged: event(),
      local: { get: (keys) => read(settings, keys), set: async (values) => Object.assign(settings, values) },
      session: { get: (keys) => read(state.session, keys), set: async (values) => Object.assign(state.session, values) },
    },
    alarms: { onAlarm: event(), get: async () => ({ periodInMinutes: 1 }), create: () => {} },
    notifications: {
      onClicked: event(), onButtonClicked: event(), clear: () => {},
      create: (id, info) => { state.notifications.push({ id, ...info }); return Promise.resolve(id); },
    },
    action: { setBadgeBackgroundColor: () => {}, setBadgeText: (badge) => state.badges.push(badge.text) },
    scripting: { executeScript: async () => {
      state.scripts++;
      return [{ result: { bytes: 151 * MB, source: "js-heap" } }];
    } },
  };
  class Clock extends Date { static now() { return state.now; } }
  context = vm.createContext({ chrome, Date: Clock, setTimeout, clearTimeout });
  context.importScripts = (file) => vm.runInContext(fs.readFileSync(path.join(extension, file), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(extension, "background.js"), "utf8"), context);
  return { state, chrome, run: () => vm.runInContext("scan()", context), context };
}
(async () => {
  const h = harness();
  await h.run();
  assert.equal(h.state.calls, 1);
  assert.equal(h.state.scripts, 0, "Never substitute heap for footprint");
  assert.equal(h.state.session.lastScan.find((r) => r.tabId === 1).sharedTabs, 2);
  assert.equal(vm.runInContext("RAMWatchMemory.totalMB([])", h.context), 0);
  assert.equal(h.context.RAMWatchMemory.totalMB(h.state.session.lastScan), 524, "Unique renderer total");
  assert.equal(h.state.badges.at(-1), "1", "One heavy renderer");
  assert.equal(h.state.notifications.length, 1, "One warning per shared renderer");
  assert.match(h.state.notifications[0].title, /Shared renderer/);
  await h.run();
  assert.equal(h.state.calls, 1, "Popup refresh uses cache");
  const restarted = harness({ session: structuredClone(h.state.session) });
  await restarted.run();
  assert.equal(restarted.state.calls, 0, "Worker restart preserves rate limit");
  await h.chrome.tabs.onUpdated.listeners[0](1, { status: "loading" });
  await h.run();
  assert.equal(h.state.session.lastScan.find((r) => r.tabId === 1).source, "unavailable");
  assert.equal(h.state.calls, 1, "Navigation does not bypass sample interval");
  h.state.now += 60001;
  await h.run();
  assert.equal(h.state.calls, 2, "Next minute takes a fresh sample");
  const failed = harness({ nativeError: "Monitored Chrome is not running" });
  await failed.run();
  assert.equal(failed.state.scripts, 0);
  assert.equal(failed.state.session.memoryStatus, "Monitored Chrome is not running");
  assert.equal(failed.context.RAMWatchMemory.measured(failed.state.session.lastScan).length, 0);
  assert.equal(failed.state.notifications.length, 0);
  const noPermission = harness({ permissions: false });
  await noPermission.run();
  assert.equal(noPermission.state.calls, 0);
  const estimate = harness({ settings: { memoryMode: "estimate" } });
  await estimate.run();
  assert.equal(estimate.state.calls, 0);
  assert.equal(estimate.state.session.lastScan.find((r) => r.tabId === 1).mb, 151);
  const paused = harness({ settings: { enabled: false } });
  paused.chrome.alarms.onAlarm.listeners[0]({ name: "ramwatch-scan" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(paused.state.calls, 0, "Paused alerts do not wake the companion");
  console.log("Background checks passed: footprint accounting, cache/restart, navigation, failures, permissions, legacy mode, and pause.");
})().catch((e) => { console.error(e); process.exitCode = 1; });
