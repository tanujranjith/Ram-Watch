// RAM Watch - background service worker
// A one-minute alarm wakes the worker; there is no permanent background loop.
importScripts("memory.js");

const DEFAULTS = { thresholdMB: 500, enabled: true, memoryMode: "estimate" };
const ALARM = "ramwatch-scan";
const MB = 1024 * 1024;
const SAMPLE_MS = 60000;
const NATIVE_HOST = "com.ramwatch.memory";

// ---------- setup ----------
chrome.runtime.onInstalled.addListener(async () => {
  const s = await chrome.storage.local.get(DEFAULTS);
  await chrome.storage.local.set({ ...DEFAULTS, ...s });
  startAlarm();
  scan();
});

chrome.runtime.onStartup.addListener(() => {
  startAlarm();
  scan();
});

function startAlarm() {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) {
    chrome.storage.local.get(DEFAULTS).then((s) => { if (s.enabled) scan(); });
  }
});

// Re-check right away when the limit or on/off switch changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.thresholdMB || changes.enabled || changes.memoryMode) {
    clearAllWarnings().then(async () => {
      await scan();
      const [{ memoryMode }, { lastScanMode }] = await Promise.all([
        chrome.storage.local.get(DEFAULTS), chrome.storage.session.get("lastScanMode"),
      ]);
      if (memoryMode !== lastScanMode) await scan();
    });
  }
});

// Clean up when a tab goes away.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  chrome.notifications.clear(notifId(tabId));
  const { warned = {} } = await chrome.storage.session.get("warned");
  delete warned[tabId];
  await chrome.storage.session.set({ warned });
});

chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  if (!change.url && change.status !== "loading") return;
  const { processSample: cached } = await chrome.storage.session.get("processSample");
  if (!cached?.rows.some((r) => r.tabId === tabId)) return;
  cached.rows = cached.rows.filter((r) => r.tabId !== tabId);
  await chrome.storage.session.set({ processSample: cached });
});

// ---------- measuring ----------
const hibernating = new Set();
const TAB_TIMEOUT_MS = 5000;

function withTimeout(p, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    Promise.resolve(p).then((value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); });
  });
}

async function processSample(tabs) {
  const { processSample: cache } = await chrome.storage.session.get("processSample");
  // Popup openings and worker restarts share the same one-minute rate limit.
  if (cache && Date.now() - cache.at < SAMPLE_MS) return cache;
  const sample = { at: Date.now(), rows: [], error: "" };
  try {
    const allowed = await chrome.permissions.contains({ permissions: ["nativeMessaging", "debugger"] });
    if (!allowed) throw new Error("Enable renderer footprints from the menu after companion setup.");
    const ids = new Set(tabs.filter(canMeasure).map((t) => t.id));
    const targets = (await chrome.debugger.getTargets())
      .filter((t) => t.type === "page" && ids.has(t.tabId))
      .map((t) => ({ tabId: t.tabId, targetId: t.id }));
    if (targets.length) {
      const response = await withTimeout(chrome.runtime.sendNativeMessage(NATIVE_HOST,
        { type: "sample", targets }), 15000);
      if (!response || !response.ok) {
        throw new Error(response?.error || "Companion did not respond. Check companion setup.");
      }
      const byId = new Map(tabs.map((t) => [t.id, t]));
      sample.rows = (response.rows || []).filter((r) => byId.has(r.tabId) &&
        Number.isSafeInteger(r.pid) && r.pid > 0 && typeof r.processKey === "string" &&
        Number.isFinite(r.bytes) && r.bytes >= 0)
        .map((r) => ({ ...r, url: byId.get(r.tabId).url }));
      sample.helperMemory = response.helperMemory;
      sample.elapsedMs = response.elapsedMs;
      if (sample.rows.length < targets.length) {
        sample.error = sample.rows.length
          ? "Some tabs could not be sampled. They are shown as unavailable."
          : "Open this extension in Chrome started with Start-RAM-Watch.cmd.";
      }
    }
  } catch (e) {
    sample.error = String(e?.message || e).includes("native messaging host")
      ? "Install the companion, then open Start-RAM-Watch.cmd. See Companion setup in the menu."
      : String(e?.message || e);
  }
  await chrome.storage.session.set({ processSample: sample });
  return sample;
}

function canMeasure(tab) {
  if (tab.discarded || !tab.url || hibernating.has(tab.id)) return false;
  return /^(https?|file):/.test(tab.url);
}

// Estimate memory owned by a page. The browser API includes more page data
// when available; the legacy fallback measures only the JavaScript heap.
async function measurePage(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async () => {
        try {
          if (crossOriginIsolated && performance.measureUserAgentSpecificMemory) {
            const estimate = await performance.measureUserAgentSpecificMemory();
            if (Number.isFinite(estimate.bytes)) {
              return { bytes: estimate.bytes, source: "page-estimate" };
            }
          }
        } catch (_) {}

        const heap = performance && performance.memory
          ? performance.memory.usedJSHeapSize
          : null;
        return Number.isFinite(heap) ? { bytes: heap, source: "js-heap" } : null;
      },
    });
    return res && res.result && Number.isFinite(res.result.bytes) ? res.result : null;
  } catch (_) {
    return null; // page blocked injection, still loading, etc.
  }
}

// ---------- scanning ----------
let scanning = null;

function scan() {
  if (!scanning) scanning = doScan().finally(() => (scanning = null));
  return scanning;
}

async function doScan() {
  const { thresholdMB, enabled, memoryMode } = await chrome.storage.local.get(DEFAULTS);
  let tabs = await chrome.tabs.query({});
  let measurable = tabs.filter(canMeasure);

  const results = [];
  let capturedAt = Date.now();
  let memoryStatus = "";

  if (memoryMode === "process") {
    const sample = await processSample(tabs);
    tabs = await chrome.tabs.query({});
    measurable = tabs.filter(canMeasure);
    capturedAt = sample.at;
    memoryStatus = sample.error;
    const measured = new Map(sample.rows.map((r) => [r.tabId, r]));
    for (const t of measurable) {
      const m = measured.get(t.id);
      if (m && m.url === t.url) {
        results.push({ ...row(t, m.bytes / MB, "renderer"),
          bytes: m.bytes, pid: m.pid, processKey: m.processKey });
      } else results.push(row(t, null, "unavailable"));
    }
    const sharing = new Map();
    for (const r of results) if (r.processKey) sharing.set(r.processKey, (sharing.get(r.processKey) || 0) + 1);
    for (const r of results) if (r.processKey) r.sharedTabs = sharing.get(r.processKey);
  } else {
  await Promise.all(
    measurable.map(async (t) => {
      // A frozen or busy tab must never stall the whole scan.
      const measurement = await withTimeout(measurePage(t.id), TAB_TIMEOUT_MS);
      if (!measurement) results.push(row(t, null, "unavailable"));
      else results.push(row(t, measurement.bytes / MB, measurement.source));
    })
  );
  }

  // Keep tabs without a supported measurement visible instead of silently
  // omitting them from the total.
  for (const t of tabs) {
    if (t.discarded) results.push(row(t, 0, "hibernated"));
    else if (!canMeasure(t)) results.push(row(t, null, "unavailable"));
  }

  results.sort((a, b) => (b.mb ?? -1) - (a.mb ?? -1));
  await chrome.storage.session.set({ lastScan: results, lastScanAt: capturedAt,
    lastScanMode: memoryMode, memoryStatus });

  const heavy = enabled
    ? RAMWatchMemory.unique(RAMWatchMemory.measured(results).filter((r) => r.mb >= thresholdMB))
    : [];
  updateBadge(heavy.length);
  if (enabled) await notifyHeavy(heavy, thresholdMB);
  else await clearAllWarnings();
}

function row(t, mb, source) {
  return {
    tabId: t.id,
    windowId: t.windowId,
    title: t.title || t.url,
    url: t.url,
    favIconUrl: t.favIconUrl || "",
    active: t.active,
    mb,
    source,
  };
}

function updateBadge(count) {
  chrome.action.setBadgeBackgroundColor({ color: "#E5484D" });
  chrome.action.setBadgeText({ text: count ? String(count) : "" });
}

// ---------- notifications ----------
function notifId(tabId) {
  return `ramwatch-${tabId}`;
}

async function resetWarnings() {
  await chrome.storage.session.set({ warned: {} });
}

async function clearAllWarnings() {
  const { warned = {} } = await chrome.storage.session.get("warned");
  for (const id of Object.keys(warned)) chrome.notifications.clear(notifId(Number(id)));
  await resetWarnings();
}

async function notifyHeavy(heavy, thresholdMB) {
  const { warned = {} } = await chrome.storage.session.get("warned");

  // A tab that dropped back under the limit can warn again later.
  const heavyIds = new Set(heavy.map((h) => String(h.tabId)));
  for (const id of Object.keys(warned)) {
    if (!heavyIds.has(id)) {
      delete warned[id];
      chrome.notifications.clear(notifId(Number(id)));
    }
  }

  for (const h of heavy) {
    if (warned[h.tabId]) continue;
    warned[h.tabId] = true;
    chrome.notifications.create(notifId(h.tabId), {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: RAMWatchMemory.label(h) + ": " + formatMB(h.mb),
      message: `"${truncate(h.title, 60)}" is over your ${formatMB(thresholdMB)} alert threshold.`,
      buttons: [{ title: "Hibernate tab" }, { title: "Close tab" }],
      priority: 2,
      requireInteraction: true,
    });
  }
  await chrome.storage.session.set({ warned });
}

chrome.notifications.onButtonClicked.addListener(async (id, btn) => {
  if (!id.startsWith("ramwatch-")) return;
  const tabId = Number(id.slice("ramwatch-".length));
  chrome.notifications.clear(id);
  if (btn === 0) await hibernateTab(tabId);
  else await closeTab(tabId);
});

// Clicking the notification body jumps to the tab.
chrome.notifications.onClicked.addListener(async (id) => {
  if (!id.startsWith("ramwatch-")) return;
  const tabId = Number(id.slice("ramwatch-".length));
  chrome.notifications.clear(id);
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (_) {}
});

// ---------- actions ----------
async function hibernateTab(tabId) {
  hibernating.add(tabId);
  try {
    let tab = await chrome.tabs.get(tabId);
    if (tab.discarded) return { ok: true };
    const mb = await lastKnownMB(tabId);

    if (tab.active) {
      // Chrome can't discard the tab you're looking at, so switch away first.
      const others = (await chrome.tabs.query({ windowId: tab.windowId }))
        .filter((t) => t.id !== tabId)
        .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      if (!others.length) {
        toast("Can't hibernate this tab", "It's the only tab in its window. Open another tab, or close it instead.");
        return { ok: false, error: "only-tab" };
      }
      await chrome.tabs.update(others[0].id, { active: true });
    }

    // Chrome sometimes needs a moment after a tab switch, so retry a few times.
    let done = null, lastErr = "";
    for (let i = 0; i < 4 && !done; i++) {
      if (i) await sleep(250 * i);
      try {
        const r = await chrome.tabs.discard(tabId);
        if (r && r.discarded) done = r;
      } catch (e) {
        lastErr = String(e && e.message ? e.message : e);
      }
      if (!done) {
        const t = await chrome.tabs.get(tabId).catch(() => null);
        if (t && t.discarded) done = t;
      }
    }

    if (!done) {
      toast("Couldn't hibernate tab", lastErr || "Chrome refused to put this tab to sleep. Try Close instead.");
      return { ok: false, error: lastErr || "not-discarded" };
    }
    toast("Tab hibernated", `"${truncate(done.title || "Tab", 50)}" is asleep${mb ? `. Its last recorded measurement was ${formatMB(mb)}` : ""}. Click it to wake it up.`);
    scan();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    setTimeout(() => hibernating.delete(tabId), 3000);
  }
}

async function lastKnownMB(tabId) {
  const { lastScan = [] } = await chrome.storage.session.get("lastScan");
  const r = lastScan.find((x) => x.tabId === tabId);
  return r ? r.mb : 0;
}

function toast(title, message) {
  chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title, message });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function closeTab(tabId) {
  try {
    await chrome.tabs.remove(tabId);
    scan();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ---------- popup messages ----------
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    if (msg.type === "scan") {
      await scan();
      reply({ ok: true });
    } else if (msg.type === "hibernate") {
      reply(await hibernateTab(msg.tabId));
    } else if (msg.type === "close") {
      reply(await closeTab(msg.tabId));
    } else if (msg.type === "wake") {
      try {
        const t = await chrome.tabs.update(msg.tabId, { active: true });
        await chrome.windows.update(t.windowId, { focused: true });
        reply({ ok: true });
      } catch (e) {
        reply({ ok: false, error: String(e) });
      }
    }
  })();
  return true; // keep the channel open for the async reply
});

// ---------- helpers ----------
function formatMB(mb) {
  return mb >= 1024 ? (mb / 1024).toFixed(1) + " GB" : Math.round(mb) + " MB";
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Make sure the alarm survives service worker restarts.
chrome.alarms.get(ALARM).then((a) => {
  if (!a || a.periodInMinutes !== 1) startAlarm();
});
