// Kweelamin upload section logic for popup.html
(function () {
  const urlInput = document.getElementById("kweelamin-url");
  const sendBtn = document.getElementById("kweelamin-send");
  const statusEl = document.getElementById("kweelamin-status");
  let progressInterval = null;

  if (!urlInput || !sendBtn || !statusEl) return;

  // Load saved URL
  chrome.storage.local.get("kweelaminUrl", (d) => {
    if (d.kweelaminUrl) urlInput.value = d.kweelaminUrl;
  });

  urlInput.addEventListener("input", () => {
    const url = urlInput.value.trim();
    chrome.storage.local.set({ kweelaminUrl: url });
    sendBtn.disabled = !url;
    sendBtn.style.opacity = url ? "1" : "0.5";
  });

  // Enable button if URL already saved
  if (urlInput.value.trim()) {
    sendBtn.disabled = false;
    sendBtn.style.opacity = "1";
  }

  function startProgressPolling() {
    let lastTs = 0;
    progressInterval = setInterval(() => {
      chrome.storage.local.get("kweelaminProgress", (d) => {
        if (d.kweelaminProgress && d.kweelaminProgress.ts !== lastTs) {
          lastTs = d.kweelaminProgress.ts;
          statusEl.textContent = d.kweelaminProgress.text;
          statusEl.style.color =
            d.kweelaminProgress.percent >= 100 ? "#10b981" : "#f59e0b";
          if (d.kweelaminProgress.percent >= 100) {
            clearInterval(progressInterval);
            progressInterval = null;
            sendBtn.disabled = false;
            sendBtn.textContent = "Send to Kweelamin";
          }
        }
      });
    }, 1000);
  }

  function stopProgressPolling() {
    if (progressInterval) {
      clearInterval(progressInterval);
      progressInterval = null;
    }
  }

  sendBtn.addEventListener("click", async () => {
    const serverUrl = urlInput.value.trim();
    if (!serverUrl) return;

    sendBtn.disabled = true;
    sendBtn.textContent = "Uploading...";
    statusEl.textContent = "Starting upload...";
    statusEl.style.color = "#f59e0b";

    // Clear old progress
    chrome.storage.local.set({
      kweelaminProgress: { text: "Starting...", percent: 0, ts: Date.now() },
    });

    // Start polling for progress from background
    startProgressPolling();

    try {
      const response = await chrome.runtime.sendMessage({
        action: "sendToKweelamin",
        serverUrl: serverUrl,
      });

      stopProgressPolling();

      if (response?.success) {
        const parts = [];
        if (response.synced) parts.push(response.synced + " products");
        if (response.imagesUploaded)
          parts.push(response.imagesUploaded + " images");
        if (response.imagesFailed)
          parts.push(response.imagesFailed + " failed");
        statusEl.textContent = "Done! " + parts.join(", ");
        statusEl.style.color = "#10b981";
      } else {
        statusEl.textContent =
          "Error: " + (response?.error || "Unknown error");
        statusEl.style.color = "#ef4444";
      }
    } catch (e) {
      stopProgressPolling();
      statusEl.textContent = "Error: " + e.message;
      statusEl.style.color = "#ef4444";
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = "Send to Kweelamin";
    }
  });
})();
