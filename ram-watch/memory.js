// Shared accounting rules. Renderer footprints and page estimates stay separate.
globalThis.RAMWatchMemory = {
  measured(rows) {
    return rows.filter((r) => Number.isFinite(r.mb) && r.mb >= 0 &&
      !["hibernated", "unavailable"].includes(r.source));
  },
  unique(rows) {
    const seen = new Set();
    return rows.filter((r) => {
      const key = r.source === "renderer" ? r.processKey : "tab:" + r.tabId;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  },
  totalMB(rows) {
    return this.unique(this.measured(rows)).reduce((sum, r) => sum + r.mb, 0);
  },
  label(row) {
    if (row.source === "renderer") {
      return row.sharedTabs > 1 ? "Shared renderer (" + row.sharedTabs + " tabs)" : "Renderer footprint";
    }
    return row.source === "js-heap" ? "JS heap" : "Page estimate";
  },
};
