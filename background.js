// Advice.co.th Product Scraper — background service worker.
// Handles listing-scrape + per-product detail enrichment via hidden tabs,
// then exports the merged result as JSON or CSV.

let lastScrapedData = null;
const DETAIL_BATCH_DELAY_MS = 1200;
const DETAIL_TAB_TIMEOUT_MS = 30000;

function stripThai(text) {
  if (!text) return '';
  return text.replace(/[\u0E00-\u0E7F]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Keep-alive: MV3 service workers die ~30s after last event.
// Use both setInterval (fires every 15s) AND chrome.alarms (wakes SW) for redundancy.
let _heartbeatTimer = null;
function startHeartbeat() {
  if (_heartbeatTimer !== null) return;
  _heartbeatTimer = setInterval(async () => {
    try {
      const stored = await chrome.storage.local.get("lastScraped");
      if (stored.lastScraped) lastScrapedData = stored.lastScraped;
      await chrome.storage.local.set({ _heartbeat: Date.now() });
    } catch (_) {}
  }, 15000);
}
startHeartbeat();

// Alarm backup: fires even if setInterval is throttled
chrome.alarms.create("keepAlive", { periodInMinutes: 0.25 }); // every 15s
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepAlive") {
    chrome.storage.local.set({ _heartbeatAlarm: Date.now() }).catch(() => {});
  }
});

// Ensure alarm persists across restarts
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("keepAlive", { periodInMinutes: 0.25 }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(t => {
  if (t.reason === "install") {
    console.log("[Advice Scraper] Extension installed");
    chrome.storage.sync.set({ autoScrape: false, exportFormat: "json", fetchDetails: true });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "scrapePage") {
    // Just pass through to content script — enrichment happens in the page.
    scrapeListing()
      .then(data => {
        lastScrapedData = data;
        sendResponse({ success: true, data });
      })
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.action === "getScrapedData") {
    if (lastScrapedData) {
      sendResponse({ data: lastScrapedData });
    } else {
      chrome.storage.local.get("lastScraped").then(storage => {
        sendResponse({ data: storage.lastScraped || null });
      }).catch(() => sendResponse({ data: null }));
    }
    return true;
  }

  if (msg.action === "exportData") {
    console.log('[background] exportData called, format:', msg.format);
    exportData(msg.format || "json")
      .then(() => {
        console.log('[background] exportData success');
        sendResponse({ success: true });
      })
      .catch(err => {
        console.error('[background] exportData error:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (msg.action === "getPageInfo") {
    getPageInfo()
      .then(info => sendResponse(info))
      .catch(() => sendResponse({ isAdviceSite: false, hasProducts: false }));
    return true;
  }

  if (msg.action === "enrichDoneFromContent") {
    // Content script finished enrichment — update in-memory cache.
    if (msg.products) {
      lastScrapedData = { ...(lastScrapedData || {}), products: msg.products, detailsFetchedAt: new Date().toISOString() };
    }
    return false;
  }

  if (msg.action === "sendToKweelamin") {
    sendToKweelamin(msg.serverUrl)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  return false;
});

async function scrapeListing() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found");
  if (!tab.url?.includes("advice.co.th")) {
    throw new Error("Not on advice.co.th website. Please navigate to the target site first.");
  }
  const result = await chrome.tabs.sendMessage(tab.id, { action: "scrape" });
  if (!result) throw new Error("Failed to scrape. Content script may not be loaded yet.");
  await chrome.storage.local.set({ lastScraped: result });
  return result;
}

async function getPageInfo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { isAdviceSite: false, hasProducts: false };
  try {
    return await chrome.tabs.sendMessage(tab.id, { action: "getPageInfo" });
  } catch {
    return {
      isAdviceSite: tab.url?.includes("advice.co.th") || false,
      hasProducts: tab.url?.includes("/product/") || false,
      url: tab.url,
    };
  }
}

// Open a hidden tab pointed at the given URL, wait for it to load, send
// the scrapeDetail message, and return the parsed detail object.
async function scrapeDetailInHiddenTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForTabComplete(tab.id, DETAIL_TAB_TIMEOUT_MS);
    // Inject the content script if it isn't there yet.
    await ensureContentScript(tab.id);
    const detail = await chrome.tabs.sendMessage(tab.id, { action: "scrapeDetail", url });
    return detail;
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch {}
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Tab ${tabId} did not finish loading within ${timeoutMs}ms`));
    }, timeoutMs);
    function listener(updatedTabId, info) {
      if (updatedTabId !== tabId) return;
      if (info.status === "complete") {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        // Small extra delay so dynamic content (lazy images, AJAX) has a chance.
        setTimeout(resolve, 800);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-script.js"],
    });
  } catch (err) {
    // Already injected or can't inject — either way, the message will fail loudly
    // if the content script isn't there.
    console.warn("[Advice Scraper] ensureContentScript:", err.message);
  }
}

async function enrichWithDetails(products, onProgress) {
  const total = products.length;
  const enriched = [];
  for (let i = 0; i < total; i++) {
    const product = products[i];
    if (!product?.url) {
      enriched.push(product);
      continue;
    }
    try {
      const detail = await scrapeDetailInHiddenTab(product.url);
      enriched.push({ ...product, ...detail, detailFetched: true });
    } catch (err) {
      console.warn(`[Advice Scraper] detail fetch failed for ${product.url}:`, err.message);
      enriched.push({ ...product, detailFetched: false, detailError: err.message });
    }
    if (onProgress) {
      try { onProgress({ done: i + 1, total, current: product.url }); } catch {}
    }
    // Polite pause between requests.
    await new Promise(r => setTimeout(r, DETAIL_BATCH_DELAY_MS));
  }
  return enriched;
}

async function exportData(format) {
  console.log('[background] exportData started, format:', format);
  const exportKeepAlive = setInterval(() => {}, 1000);
  try {
    const stored = await chrome.storage.local.get("lastScraped");
    const data = stored.lastScraped;
    console.log('[background] exportData got data:', data ? Object.keys(data) : 'null');
    if (!data) throw new Error("No data to export. Please scrape first.");

    let payload, mime, ext;
    if (format === "csv") {
      payload = productsToCsv(data.products || []);
      mime = "text/csv;charset=utf-8";
      ext = "csv";
    } else {
      payload = JSON.stringify(data, null, 2);
      mime = "application/json";
      ext = "json";
    }
    // Use data URL with proper UTF-8 base64 encoding
    const encoder = new TextEncoder();
    const bytes = encoder.encode(payload);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);
    const url = `data:${mime};base64,${base64}`;
    const filename = `advice-products-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
    console.log('[background] starting download, filename:', filename, 'data URL length:', url.length);
    const downloadId = await chrome.downloads.download({ url, filename, saveAs: true });
    console.log('[background] download started, id:', downloadId);
    return downloadId;
  } finally {
    clearInterval(exportKeepAlive);
  }
}

const CSV_COLUMNS = [
  "Brand",
  "Product Name",
  "Product Code",
  "SKU",
  "URL",
  "Image URL",
  "All Images",
  "Specifications",
  "Description",
  "Spec Table",
  "Price",
  "Price Value",
  "Original Price",
  "Original Price Value",
  "Discount",
  "Warranty",
  "Shipping",
  "Online Only",
  "Stock",
  "Free Gifts",
  "Free Gifts Detail",
  "Installment",
  "Detail Fetched",
];

function csvCell(v) {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    s = `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function productsToCsv(products) {
  if (!products.length) return CSV_COLUMNS.join(",") + "\n";
  const rows = [CSV_COLUMNS.join(",")];
  for (const p of products) {
    const specsTable = Array.isArray(p.specifications)
      ? p.specifications.map(r => `${stripThai(r.key)}=${stripThai(r.value)}`).join(" | ")
      : "";
    const description = Array.isArray(p.description) ? p.description.map(d => stripThai(d)).join(" | ") : "";
    const freeGiftsDetail = Array.isArray(p.freeGiftsDetail)
      ? p.freeGiftsDetail.map(g => `${stripThai(g.name)} (x${g.quantity}, ${g.price || "฿0"})`).join(" | ")
      : "";
    const allImages = Array.isArray(p.images) ? p.images.join(" | ") : (p.imageUrl || "");
    const row = [
      stripThai(p.brand),
      stripThai(p.name),
      p.productCode,
      p.sku,
      p.url,
      p.imageUrl,
      allImages,
      specsTable,
      description,
      specsTable,
      p.price,
      p.priceValue != null ? p.priceValue : "",
      p.originalPrice,
      p.originalPriceValue != null ? p.originalPriceValue : "",
      p.discount,
      stripThai(p.warranty),
      stripThai(p.shipping),
      p.isOnlineOnly ? "Yes" : "No",
      p.stock,
      Array.isArray(p.freeGifts) ? p.freeGifts.map(g => stripThai(g)).join("; ") : "",
      freeGiftsDetail,
      p.installment,
      p.detailFetched === true ? "Yes" : (p.detailFetched === false ? "Failed" : ""),
    ].map(csvCell);
    rows.push(row.join(","));
  }
  return rows.join("\n");
}

async function captureAdviceCookies() {
  try {
    // Try multiple domain patterns to find all relevant cookies
    const domains = ["advice.co.th", ".advice.co.th", "www.advice.co.th", "img.advice.co.th"];
    const allCookies = new Map();

    for (const domain of domains) {
      try {
        const cookies = await chrome.cookies.getAll({ domain });
        for (const c of cookies) {
          allCookies.set(`${c.domain}:${c.name}`, c);
        }
      } catch (e) { /* ignore */ }
    }

    const cookies = Array.from(allCookies.values());
    if (cookies.length === 0) {
      console.log("[Kweelamin] No advice.co.th cookies found");
      return null;
    }

    console.log("[Kweelamin] Captured cookies:");
    for (const c of cookies) {
      console.log(`  ${c.name} (domain: ${c.domain}, httpOnly: ${c.httpOnly}, sameSite: ${c.sameSite})`);
    }

    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join("; ");
    return cookieString;
  } catch (e) {
    console.warn("[Kweelamin] Cookie capture failed:", e.message);
    return null;
  }
}

async function sendToKweelamin(serverUrl) {
  console.log("[Kweelamin] Starting upload to", serverUrl);
  const stored = await chrome.storage.local.get("lastScraped");
  const data = stored.lastScraped;
  if (!data || !data.products || data.products.length === 0) {
    return { success: false, error: "No scraped data found. Please scrape first." };
  }

  const products = data.products;
  const totalProducts = products.length;
  console.log("[Kweelamin] Total products:", totalProducts);

  function setProgress(text, percent) {
    chrome.storage.local.set({ kweelaminProgress: { text, percent, ts: Date.now() } });
  }

  setProgress(`Uploading ${totalProducts} products...`, 10);

  // Step 1: Capture and send Cloudflare cookies for image proxying
  setProgress("Capturing Cloudflare cookies...", 5);
  const cookies = await captureAdviceCookies();
  if (cookies) {
    try {
      const userAgent = navigator.userAgent || "";
      await fetch(`${serverUrl}/api/advice-cookies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookies, userAgent }),
      });
      console.log("[Kweelamin] Cookies sent to server");
    } catch (e) {
      console.warn("[Kweelamin] Failed to send cookies:", e.message);
    }
  }

  const metadataProducts = products.map(p => ({
    name: p.name,
    brand: p.brand,
    url: p.url,
    priceValue: p.priceValue,
    originalPriceValue: p.originalPriceValue,
    specifications: p.specifications,
    description: p.description,
    images: p.images || (p.imageUrl ? [p.imageUrl] : []),
  }));

  // Upload in chunks of 30 to avoid NGINX body size limits (default 1MB)
  const UPLOAD_CHUNK = 30;
  let totalSynced = 0;
  let totalSkipped = 0;

  for (let i = 0; i < metadataProducts.length; i += UPLOAD_CHUNK) {
    const chunk = metadataProducts.slice(i, i + UPLOAD_CHUNK);
    setProgress(`Uploading products ${i + 1}-${Math.min(i + UPLOAD_CHUNK, metadataProducts.length)} of ${metadataProducts.length}...`, 10);

    try {
      const response = await fetch(`${serverUrl}/api/advice-extension-upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ products: chunk, skipImages: true }),
      });
      const text = await response.text();
      let result;
      try { result = JSON.parse(text); } catch { result = null; }
      console.log("[Kweelamin] Chunk upload result:", result);
      if (!response.ok || !result) {
        const errMsg = result?.error || `Server returned ${response.status}: ${text.slice(0, 200)}`;
        console.error("[Kweelamin] Chunk upload failed:", errMsg);
        setProgress("Error: " + errMsg, 0);
        return { success: false, error: errMsg };
      }
      totalSynced += result.synced || 0;
      totalSkipped += result.skipped || 0;
    } catch (e) {
      console.error("[Kweelamin] Upload failed:", e);
      setProgress("Error: " + e.message, 0);
      return { success: false, error: "Failed to connect: " + e.message };
    }
  }

  const uploadResult = { success: true, synced: totalSynced, skipped: totalSkipped };

  // Step 2: Fetch images via content script on advice.co.th tab
  let imagesUploaded = 0;
  let imagesFailed = 0;
  const [tab] = await chrome.tabs.query({ url: "https://www.advice.co.th/*" });

  if (tab) {
    // Ensure content script is injected
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content-script.js"],
      });
      // Wait for the content script to initialize its message listener
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.warn("[Kweelamin] Content script injection failed (may already be loaded):", e.message);
    }

    setProgress("Fetching images from advice.co.th...", 30);
    const BATCH_SIZE = 20;

    for (let batchStart = 0; batchStart < products.length; batchStart += BATCH_SIZE) {
      const batch = products.slice(batchStart, batchStart + BATCH_SIZE);
      const items = batch.map(p => ({
        name: p.name,
        urls: (p.images || (p.imageUrl ? [p.imageUrl] : [])).slice(0, 5),
      }));

      const totalImagesInBatch = items.reduce((sum, it) => sum + Math.min(it.urls.length, 5), 0);
      setProgress(`Fetching images ${batchStart + 1}-${Math.min(batchStart + BATCH_SIZE, products.length)} of ${totalProducts}...`, 30 + Math.floor((batchStart / products.length) * 50));

      try {
        const fetchResult = await chrome.tabs.sendMessage(tab.id, {
          action: "fetchImages",
          items: items,
        });

        if (fetchResult && fetchResult.results) {
          for (const r of fetchResult.results) {
            for (let i = 0; i < r.base64Images.length; i++) {
              try {
                const imgResponse = await fetch(`${serverUrl}/api/advice-extension-upload`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    singleImage: true,
                    productName: r.name,
                    imageIndex: i,
                    base64: r.base64Images[i],
                  }),
                });
                if (imgResponse.ok) {
                  imagesUploaded++;
                } else {
                  imagesFailed++;
                }
              } catch (e) {
                imagesFailed++;
              }
            }
          }
        }
      } catch (e) {
        console.error("[Kweelamin] Content script fetch failed:", e.message);
        imagesFailed += totalImagesInBatch;
      }
    }

    // Step 3: Apply local images to products
    setProgress("Applying local images to products...", 90);
    try {
      const applyResponse = await fetch(`${serverUrl}/api/advice-extension-upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apply: true }),
      });
      const applyText = await applyResponse.text();
      let applyResult;
      try { applyResult = JSON.parse(applyText); } catch { applyResult = null; }
      console.log("[Kweelamin] Apply result:", applyResult);
    } catch (e) {
      console.warn("[Kweelamin] Apply failed:", e.message);
    }
  } else {
    console.log("[Kweelamin] No advice.co.th tab found, skipping images");
  }

  const msg = `Done! ${uploadResult.synced || 0} products synced, ${imagesUploaded} images uploaded, ${imagesFailed} failed.`;
  setProgress(msg, 100);
  console.log("[Kweelamin]", msg);

  return {
    success: true,
    synced: uploadResult.synced || 0,
    skipped: uploadResult.skipped || 0,
    imagesUploaded,
    imagesFailed,
  };
}

console.log("[Advice Scraper] Background service worker loaded");
