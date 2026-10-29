const extensionId = document.getElementById("extensionId");
const status = document.getElementById("status");
extensionId.value = chrome.runtime.id;
document.getElementById("copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(chrome.runtime.id); status.textContent = "Extension ID copied."; }
  catch (_) { extensionId.select(); status.textContent = "Select and copy the ID above."; }
});
document.getElementById("enable").addEventListener("click", async (event) => {
  try {
    const allowed = await chrome.permissions.request({ permissions: ["nativeMessaging"] });
    if (!allowed) { status.textContent = "Companion access was not granted."; return; }
    event.target.disabled = true;
    status.textContent = "Checking the companion…";
    await chrome.storage.local.set({ memoryMode: "process" });
    await chrome.runtime.sendMessage({ type: "scan" });
    const data = await chrome.storage.session.get(["memoryStatus", "lastScan"]);
    const hasFootprint = (data.lastScan || []).some((r) => r.source === "renderer");
    status.textContent = data.memoryStatus || (hasFootprint
      ? "Renderer footprints are connected. Open RAM Watch to see them."
      : "Open a website in this monitored Chrome window. The next scheduled sample will pick it up.");
  } catch (e) { status.textContent = String(e.message || e); }
  finally { event.target.disabled = false; }
});
