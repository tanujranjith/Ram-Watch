const DEFAULTS = { thresholdMB: 500, enabled: true, sortBy: "ram", memoryMode: "estimate" };

const $ = (id) => document.getElementById(id);
const slider = $("limit");
const enabledBox = $("enabled");
const scrollEl = $("scroll");

let threshold = DEFAULTS.thresholdMB;
let sortBy = DEFAULTS.sortBy;
let saveTimer = null;
let lastSig = "";
let lastScanAt = null;
let shownTotal = 0;
let memoryMode = DEFAULTS.memoryMode;
let totalFrame = null;

// ---------- formatting ----------
function formatMB(mb) {
  if (mb >= 1024) return `${+(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}
function splitMB(mb) {
  return mb >= 1024 ? [(mb / 1024).toFixed(1), "GB"] : [String(Math.round(mb)), "MB"];
}
function host(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch (_) { return ""; }
}
// "Copy of TR CEG - Google Docs" -> { name: "Google Docs", detail: "Copy of TR CEG" }
function labels(t) {
  const title = (t.title || "").trim();
  const h = host(t.url);
  const parts = title.split(/\s+[-–—|•]\s+/).filter(Boolean);
  if (parts.length > 1) {
    const first = parts[0], last = parts[parts.length - 1];
    const key = h.split(".").slice(-2, -1)[0] || "";
    const matches = (p) => key && p.toLowerCase().replace(/\s/g, "").includes(key.toLowerCase());
    let site;
    if (matches(last)) site = "last";
    else if (matches(first)) site = "first";
    else site = last.length <= first.length ? "last" : "first";
    if (site === "last" && last.length <= 30) return { name: last, detail: parts.slice(0, -1).join(" – ") };
    if (site === "first" && first.length <= 30) return { name: first, detail: parts.slice(1).join(" – ") };
  }
  return { name: title || h, detail: h };
}
function faviconSrc(t) {
  const u = new URL(chrome.runtime.getURL("/_favicon/"));
  u.searchParams.set("pageUrl", t.url || "");
  u.searchParams.set("size", "32");
  return u.toString();
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function capTitle(title, max = 72) {
  return title.length > max ? title.slice(0, max - 1).trimEnd() + "…" : title;
}

// ---------- settings ----------
function paintLimit() {
  const min = Number(slider.min), max = Number(slider.max);
  slider.style.setProperty("--fill-pct", ((threshold - min) / (max - min)) * 100 + "%");
  $("limitValue").textContent = formatMB(threshold);
  for (const b of document.querySelectorAll("#chips button")) {
    b.classList.toggle("on", Number(b.dataset.mb) === threshold);
  }
}
function setThreshold(mb, saveNow) {
  threshold = mb;
  slider.value = mb;
  paintLimit();
  lastSig = "";
  render();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({ thresholdMB: threshold }), saveNow ? 0 : 300);
}

slider.addEventListener("input", () => {
  // Snap to 50 MB steps, but let the quick sizes land exactly.
  let v = Number(slider.value);
  const chip = [250, 500, 1024, 2048].find((c) => Math.abs(c - v) <= 25);
  v = chip ?? Math.max(100, Math.round(v / 50) * 50);
  setThreshold(v);
});
document.querySelectorAll("#chips button").forEach((b) =>
  b.addEventListener("click", () => setThreshold(Number(b.dataset.mb), true))
);
enabledBox.addEventListener("change", () => {
  chrome.storage.local.set({ enabled: enabledBox.checked });
  lastSig = "";
  render();
});

// ---------- menu ----------
const menu = $("menu");
$("menuBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  menu.hidden = !menu.hidden;
});
document.addEventListener("click", (e) => {
  if (!menu.contains(e.target)) menu.hidden = true;
});
menu.addEventListener("click", async (e) => {
  const act = e.target.dataset && e.target.dataset.act;
  if (!act) return;
  if (act === "refresh") {
    menu.hidden = true;
    liveRefresh();
  } else if (act === "sort") {
    sortBy = sortBy === "ram" ? "name" : "ram";
    chrome.storage.local.set({ sortBy });
    paintSortLabel();
    lastSig = "";
    render();
    menu.hidden = true;
  } else if (act === "setup") {
    chrome.tabs.create({ url: chrome.runtime.getURL("setup.html") });
  } else if (act === "mode") {
    if (memoryMode !== "process") {
      try {
        const allowed = await chrome.permissions.request({ permissions: ["nativeMessaging"] });
        if (!allowed) return;
      } catch (_) {
        $("modeStatus").textContent = "Chrome could not grant companion access. Open Companion setup.";
        return;
      }
    }
    memoryMode = memoryMode === "process" ? "estimate" : "process";
    await chrome.storage.local.set({ memoryMode });
    paintMode();
    menu.hidden = true;
    lastSig = "";
    liveRefresh();
  }
});
function paintMode() {
  $("modeBtn").textContent = memoryMode === "process" ? "Use page estimates" : "Use renderer footprints";
  $("thresholdLabel").textContent = memoryMode === "process" ? "Alert above footprint" : "Alert above estimate";
  $("modeNote").textContent = memoryMode === "process"
    ? "Windows renderer private memory. Shared renderers count once in the total. Browser, GPU, and separate worker/iframe processes are excluded."
    : "Page estimates can fall back to JS heap and overlap shared memory. Use the companion for renderer footprints.";
}
function paintSortLabel() {
  menu.querySelector('[data-act="sort"]').textContent = sortBy === "ram" ? "Sort by name" : "Sort by memory";
}

// ---------- live data ----------
let refreshing = false;
function liveRefresh() {
  if (refreshing) return;
  refreshing = true;
  $("liveDot").classList.add("pulse");
  chrome.runtime.sendMessage({ type: "scan" }, () => {
    refreshing = false;
    void chrome.runtime.lastError;
    setTimeout(() => $("liveDot").classList.remove("pulse"), 400);
    render();
  });
}

function tickUpdated() {
  const u = $("updated");
  if (!enabledBox.checked) { u.textContent = "Alerts paused"; return; }
  if (!lastScanAt) { u.textContent = "Checking…"; return; }
  const s = Math.max(0, Math.round((Date.now() - lastScanAt) / 1000));
  u.textContent = s < 3 ? "Updated just now" : `Updated ${s}s ago`;
}

function animateTotal(to) {
  cancelAnimationFrame(totalFrame);
  const from = shownTotal;
  const start = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - start) / 450);
    const v = from + (to - from) * (1 - Math.pow(1 - k, 3));
    const [n, unit] = splitMB(v);
    $("totalNum").textContent = n;
    $("totalUnit").textContent = unit;
    if (k < 1) totalFrame = requestAnimationFrame(step);
    else shownTotal = to;
  };
  totalFrame = requestAnimationFrame(step);
}

async function render() {
  const data = await chrome.storage.session.get(["lastScan", "lastScanAt", "lastScanMode", "memoryStatus"]);
  const matchingMode = (data.lastScanMode || "estimate") === memoryMode;
  const scan = matchingMode ? data.lastScan || [] : [];
  $("modeStatus").textContent = !matchingMode ? "Switching measurement mode…"
    : memoryMode === "process" ? data.memoryStatus || "Renderer private memory · sampled at most once per minute"
    : "Page estimates · enable renderer footprints in the menu";
  lastScanAt = matchingMode ? data.lastScanAt || null : null;
  tickUpdated();

  const enabled = enabledBox.checked;
  const awake = RAMWatchMemory.measured(scan);
  const asleep = scan.filter((t) => t.source === "hibernated");
  const unavailable = scan.filter((t) => t.source === "unavailable");
  const heavy = enabled ? awake.filter((t) => t.mb >= threshold) : [];
  const normal = awake.filter((t) => !heavy.includes(t));

  const sig = JSON.stringify([threshold, enabled, sortBy, memoryMode, data.memoryStatus,
    scan.map((t) => [t.tabId, t.mb, t.title, t.source, t.processKey, t.sharedTabs])]);
  if (sig === lastSig) return;
  lastSig = sig;

  // hero
  const total = RAMWatchMemory.totalMB(awake);
  if (awake.length) animateTotal(total);
  else { cancelAnimationFrame(totalFrame); shownTotal = 0; $("totalNum").textContent = "–"; $("totalUnit").textContent = ""; }
  $("totalCap").textContent = (memoryMode === "process"
    ? "Renderer footprint · " + RAMWatchMemory.unique(awake).length + " processes · " + awake.length + " tabs"
    : "Sum of page estimates · " + awake.length + " tabs measured") +
    (unavailable.length ? " · " + unavailable.length + " unavailable" : "") +
    (asleep.length ? " · " + asleep.length + " hibernated" : "");

  const bar = $("totalBar");
  bar.textContent = "";
  const byMem = RAMWatchMemory.unique(awake).sort((a, b) => b.mb - a.mb);
  const shades = [1, .7, .55, .42, .3, .2];
  byMem.slice(0, 6).forEach((t, i) => {
    const seg = el("span");
    const mb = i === 5 ? byMem.slice(5).reduce((s, x) => s + x.mb, 0) : t.mb;
    seg.style.flexGrow = Math.max(mb, 1);
    seg.style.opacity = shades[i];
    seg.title = i === 5 ? `Other tabs · ${formatMB(mb)}` : `${labels(t).name} · ${formatMB(t.mb)}`;
    bar.appendChild(seg);
  });
  const hv = $("heaviest");
  hv.textContent = "";
  if (byMem[0]) {
    const fullTitle = labels(byMem[0]).name;
    hv.title = fullTitle;
    hv.append("Heaviest: ", el("b", "", capTitle(fullTitle, 52)), ` · ${formatMB(byMem[0].mb)}`);
  }

  // tab sections
  const sorter = sortBy === "name"
    ? (a, b) => labels(a).name.localeCompare(labels(b).name)
    : (a, b) => b.mb - a.mb;
  const keepScroll = scrollEl.scrollTop;
  scrollEl.textContent = "";

  if (!scan.length) {
    scrollEl.append(el("div", "hdr", "Tabs"));
    const c = el("div", "card");
    c.append(el("div", "empty", memoryMode === "process"
      ? "Open Companion setup from the menu to connect renderer memory measurements."
      : "Open a website to see its memory here."));
    scrollEl.append(c);
    return;
  }
  const maxMB = Math.max(threshold, ...awake.map((t) => t.mb), 1);
  section("Over limit", heavy.sort(sorter), "heavy", maxMB);
  section("Open tabs", normal.sort(sorter), "", maxMB);
  section("Hibernated", asleep.sort(sorter), "asleep", maxMB);
  section("Unavailable", unavailable.sort(sorter), "unavailable", maxMB);
  scrollEl.scrollTop = keepScroll;
}

function section(title, tabs, kind, maxMB) {
  if (!tabs.length) return;
  scrollEl.append(el("div", "hdr", title));
  const card = el("div", "card list");
  for (const t of tabs) card.append(row(t, kind, maxMB));
  scrollEl.append(card);
}

function row(t, kind, maxMB) {
  const r = el("div", "row" + (kind ? " " + kind : ""));
  const { name, detail } = labels(t);

  const ic = el("div", "ic");
  const img = el("img");
  img.src = faviconSrc(t);
  img.alt = "";
  ic.append(img);

  const txt = el("div", "txt");
  const tt = el("div", "t", capTitle(name));
  tt.title = t.title || t.url;
  txt.append(tt);
  if (kind === "heavy") {
    const pct = Math.round((t.mb / threshold - 1) * 100);
    const measurement = RAMWatchMemory.label(t);
    txt.append(el("div", "s red", `${measurement} · ${formatMB(t.mb)} · ${pct}% over`));
  } else if (kind === "asleep") {
    txt.append(el("div", "s", "Hibernated · 0 MB"));
  } else if (kind === "unavailable") {
    txt.append(el("div", "s", memoryMode === "process" ? "Renderer footprint unavailable" : "No page memory estimate available"));
  } else {
    const measurement = RAMWatchMemory.label(t);
    txt.append(el("div", "s", `${measurement} · ${detail}`));
  }

  const val = el("div", "val", kind === "unavailable" ? "—" : formatMB(t.mb));
  if (kind !== "unavailable") {
    const mini = el("div", "mini");
    const fill = el("span");
    fill.style.width = Math.min(100, (t.mb / maxMB) * 100) + "%";
    mini.append(fill);
    val.append(mini);
  }

  const acts = el("div", "acts");
  if (kind === "asleep") {
    acts.append(button("Wake", "tint", () => act("wake", t.tabId)));
  } else {
    acts.append(button("Hibernate", "tint", () => act("hibernate", t.tabId)));
  }
  acts.append(button("Close", "", () => act("close", t.tabId)));

  r.append(ic, txt, val, acts);
  return r;
}

function button(label, cls, onClick) {
  const b = el("button", "btn" + (cls ? " " + cls : ""), label);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    b.disabled = true;
    onClick();
  });
  return b;
}

function act(type, tabId) {
  chrome.runtime.sendMessage({ type, tabId }, () => {
    void chrome.runtime.lastError;
    lastSig = "";
    liveRefresh();
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.memoryMode) {
    memoryMode = changes.memoryMode.newValue || "estimate";
    paintMode(); lastSig = ""; render();
  }
  if (area === "session" && (changes.lastScan || changes.lastScanAt || changes.memoryStatus)) render();
});

async function init() {
  const s = await chrome.storage.local.get(DEFAULTS);
  threshold = s.thresholdMB;
  sortBy = s.sortBy;
  memoryMode = s.memoryMode;
  slider.value = threshold;
  enabledBox.checked = s.enabled;
  paintLimit();
  paintSortLabel();
  paintMode();
  await render();
  liveRefresh();
  setInterval(tickUpdated, 1000);
}

init();
