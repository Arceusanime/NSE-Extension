// bridge.js - Bridges TradingView DOM with Background Service Worker

let currentSymbol = null;
let isFetching = false;
let overlayVisible = false; // DEFAULT: OFF on all tabs until explicitly enabled
let trendlinesVisible = false; // DEFAULT: OFF on all tabs until explicitly enabled
let lastOiData = null;
let showOnChartToggle = true;

// Initialize per-tab overlay visibility independently from sessionStorage
try {
  const saved = sessionStorage.getItem('nse_oi_tab_visible');
  if (saved !== null) {
    overlayVisible = saved === 'true';
  } else {
    overlayVisible = false;
    sessionStorage.setItem('nse_oi_tab_visible', 'false');
  }
} catch (e) {
  overlayVisible = false;
}

try {
  const savedTl = sessionStorage.getItem('nse_tl_tab_visible');
  if (savedTl !== null) {
    trendlinesVisible = savedTl === 'true';
  } else {
    trendlinesVisible = false;
    sessionStorage.setItem('nse_tl_tab_visible', 'false');
  }
} catch (e) {
  trendlinesVisible = false;
}

// Initial broadcast to content.js
window.postMessage({ type: 'OI_VISIBILITY', visible: overlayVisible }, '*');
window.postMessage({ type: 'TRENDLINES_VISIBILITY', visible: trendlinesVisible }, '*');

// Fetch initial settings for showOnChartToggle
chrome.storage.local.get(['oiSettings'], (res) => {
  if (res.oiSettings?.showOnChartToggle !== undefined) {
    showOnChartToggle = res.oiSettings.showOnChartToggle !== false;
  }
  createOrUpdateOnChartPill(overlayVisible);
  createOrUpdateTrendlinePill(trendlinesVisible);
});

// Update visibility scoped strictly to this specific tab
function setTabVisibility(nextVisible) {
  overlayVisible = !!nextVisible;
  try {
    sessionStorage.setItem('nse_oi_tab_visible', String(overlayVisible));
  } catch (e) {}
  window.postMessage({ type: 'OI_VISIBILITY', visible: overlayVisible }, '*');
  createOrUpdateOnChartPill(overlayVisible);
}

function toggleTabVisibility() {
  setTabVisibility(!overlayVisible);
  return overlayVisible;
}

function setTrendlinesVisibility(nextVisible) {
  trendlinesVisible = !!nextVisible;
  try {
    sessionStorage.setItem('nse_tl_tab_visible', String(trendlinesVisible));
  } catch (e) {}
  window.postMessage({ type: 'TRENDLINES_VISIBILITY', visible: trendlinesVisible }, '*');
  createOrUpdateTrendlinePill(trendlinesVisible);
}

function toggleTrendlinesVisibility() {
  setTrendlinesVisibility(!trendlinesVisible);
  return trendlinesVisible;
}

// On-chart floating toggle pill for one-click tab control directly on TradingView
function createOrUpdateOnChartPill(visible) {
  if (!showOnChartToggle) {
    const existing = document.getElementById('nse-oi-tab-toggle');
    if (existing) existing.remove();
    return;
  }
  if (!document.body) {
    window.addEventListener('DOMContentLoaded', () => createOrUpdateOnChartPill(visible), { once: true });
    return;
  }

  let pill = document.getElementById('nse-oi-tab-toggle');
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'nse-oi-tab-toggle';
    pill.style.cssText = `
      position: fixed;
      bottom: 34px;
      left: 62px;
      z-index: 99998;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 8px;
      background: rgba(19, 23, 34, 0.88);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 6px;
      color: #d1d4dc;
      font-family: -apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.2px;
      cursor: pointer;
      user-select: none;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
      transition: all 0.18s ease;
    `;
    pill.addEventListener('mouseenter', () => {
      pill.style.borderColor = 'rgba(255, 255, 255, 0.28)';
      pill.style.transform = 'translateY(-1px)';
    });
    pill.addEventListener('mouseleave', () => {
      pill.style.borderColor = 'rgba(255, 255, 255, 0.12)';
      pill.style.transform = 'translateY(0)';
    });
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggleTabVisibility();
    });
    document.body.appendChild(pill);
  }

  const dotColor = visible ? '#26a69a' : '#787b86';
  const labelText = visible ? 'OI ON' : 'OI OFF';
  pill.title = visible
    ? 'NSE OI Overlay is ACTIVE on this tab (Click to hide)'
    : 'NSE OI Overlay is OFF on this tab (Click to enable)';
  pill.style.opacity = visible ? '1' : '0.55';
  pill.innerHTML = `
    <span style="width: 6px; height: 6px; border-radius: 50%; background: ${dotColor}; display: inline-block; box-shadow: ${visible ? '0 0 5px #26a69a' : 'none'};"></span>
    <span>${labelText}</span>
  `;
}

// On-chart floating toggle pill for Auto-Trendlines & Patterns
function createOrUpdateTrendlinePill(visible) {
  if (!showOnChartToggle) {
    const existing = document.getElementById('nse-tl-tab-toggle');
    if (existing) existing.remove();
    return;
  }
  if (!document.body) {
    window.addEventListener('DOMContentLoaded', () => createOrUpdateTrendlinePill(visible), { once: true });
    return;
  }

  let pill = document.getElementById('nse-tl-tab-toggle');
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'nse-tl-tab-toggle';
    pill.style.cssText = `
      position: fixed;
      bottom: 34px;
      left: 136px;
      z-index: 99998;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 8px;
      background: rgba(19, 23, 34, 0.88);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 6px;
      color: #d1d4dc;
      font-family: -apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.2px;
      cursor: pointer;
      user-select: none;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
      transition: all 0.18s ease;
    `;
    pill.addEventListener('mouseenter', () => {
      pill.style.borderColor = 'rgba(255, 255, 255, 0.28)';
      pill.style.transform = 'translateY(-1px)';
    });
    pill.addEventListener('mouseleave', () => {
      pill.style.borderColor = 'rgba(255, 255, 255, 0.12)';
      pill.style.transform = 'translateY(0)';
    });
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggleTrendlinesVisibility();
    });
    document.body.appendChild(pill);
  }

  const dotColor = visible ? '#ff7043' : '#787b86';
  const labelText = visible ? '📐 TL ON' : '📐 TL OFF';
  pill.title = visible
    ? 'Auto Trendlines & Patterns are ACTIVE (Click to hide)'
    : 'Auto Trendlines & Patterns are OFF (Click to calculate & plot)';
  pill.style.opacity = visible ? '1' : '0.55';
  pill.style.borderColor = visible ? 'rgba(255, 112, 67, 0.45)' : 'rgba(255, 255, 255, 0.12)';
  pill.innerHTML = `
    <span style="width: 6px; height: 6px; border-radius: 50%; background: ${dotColor}; display: inline-block; box-shadow: ${visible ? '0 0 5px #ff7043' : 'none'};"></span>
    <span>${labelText}</span>
  `;
}

// Runtime message listener for tab-specific queries from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_TAB_OI_STATUS') {
    sendResponse({
      isTradingView: true,
      symbol: currentSymbol,
      visible: overlayVisible,
      trendlinesVisible: trendlinesVisible,
      data: lastOiData
    });
    return true;
  }
  if (msg.type === 'TOGGLE_TAB_VISIBILITY') {
    const next = toggleTabVisibility();
    sendResponse({ success: true, visible: next });
    return true;
  }
  if (msg.type === 'SET_TAB_VISIBILITY') {
    setTabVisibility(msg.visible === true);
    sendResponse({ success: true, visible: overlayVisible });
    return true;
  }
  if (msg.type === 'TOGGLE_TRENDLINES') {
    const next = toggleTrendlinesVisibility();
    sendResponse({ success: true, visible: next });
    return true;
  }
  if (msg.type === 'SET_TRENDLINES') {
    setTrendlinesVisibility(msg.visible === true);
    sendResponse({ success: true, visible: trendlinesVisible });
    return true;
  }
  if (msg.type === 'RECALCULATE_TRENDLINES') {
    window.postMessage({ type: 'RECALCULATE_TRENDLINES' }, '*');
    sendResponse({ success: true });
    return true;
  }
  if (msg.type === 'REFRESH_TAB_OI') {
    currentSymbol = null;
    watchChartTicker();
    sendResponse({ success: true });
    return true;
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.globalOverlayVisible) {
    setTabVisibility(changes.globalOverlayVisible.newValue === true);
  }
  if (changes.oiSettings) {
    window.postMessage({ type: 'OI_SETTINGS', settings: changes.oiSettings.newValue }, '*');
    window.postMessage({ type: 'TRENDLINE_SETTINGS', settings: changes.oiSettings.newValue }, '*');
    if (changes.oiSettings.newValue?.showOnChartToggle !== undefined) {
      showOnChartToggle = changes.oiSettings.newValue.showOnChartToggle !== false;
      createOrUpdateOnChartPill(overlayVisible);
      createOrUpdateTrendlinePill(trendlinesVisible);
    }
  }
  if (changes.manualRefresh || changes.oiSettings) {
    currentSymbol = null;
    watchChartTicker();
  }
});

function normalizeTicker(raw) {
  if (!raw) return null;
  const clean = raw.includes(':') ? raw.split(':')[1] : raw;
  let s = clean.trim().toUpperCase().replace(/[^A-Z0-9&_-]/g, '');
  if (!s) return null;

  // TradingView index aliases to NSE names
  const map = {
    'NIFTY50': 'NIFTY',
    'NIFTY_50': 'NIFTY',
    'NIFTYBANK': 'BANKNIFTY',
    'NIFTY_BANK': 'BANKNIFTY',
    'CNXBANKS': 'BANKNIFTY',
    'CNXFINANCE': 'FINNIFTY',
    'NIFTYFINSERVICE': 'FINNIFTY',
    'NIFTY_FIN_SERVICE': 'FINNIFTY',
    'NIFTYMIDSELECT': 'MIDCPNIFTY',
    'NIFTY_MID_SELECT': 'MIDCPNIFTY',
    'NIFTYNXT50': 'NIFTYNXT50',
    'NIFTY_NEXT_50': 'NIFTYNXT50',
    // Stock aliases where TradingView uses underscores instead of dashes/ampersands
    'BAJAJ_AUTO': 'BAJAJ-AUTO',
    'M_M': 'M&M',
    'L_TFH': 'L&TFH',
    'MCDOWELL_N': 'MCDOWELL-N',
    'NAM_INDIA': 'NAM-INDIA'
  };

  return map[s] || s;
}

function readActiveTicker() {
  // 1. Header symbol search button
  const headerBtn = document.querySelector('#header-toolbar-symbol-search');
  if (headerBtn?.textContent?.trim()) {
    const sym = normalizeTicker(headerBtn.textContent);
    if (sym) return sym;
  }

  // 2. Legend series item
  const legendTitle = document.querySelector('[data-name="legend-series-item"] [data-name="legend-source-title"]');
  if (legendTitle?.textContent?.trim()) {
    const sym = normalizeTicker(legendTitle.textContent);
    if (sym) return sym;
  }

  // 3. Fallback to generic symbol search input / title
  const searchEl = document.querySelector('div[id*="symbol-search"], button[id*="symbol-search"]');
  if (searchEl?.textContent?.trim()) {
    const sym = normalizeTicker(searchEl.textContent);
    if (sym) return sym;
  }

  // 4. URL search parameter
  try {
    const urlSym = new URL(window.location.href).searchParams.get('symbol');
    if (urlSym) {
      const sym = normalizeTicker(urlSym);
      if (sym) return sym;
    }
  } catch (e) {}

  // 5. Document title (e.g. "NIFTY Chart", "RELIANCE 2450.00...")
  if (document.title) {
    const match = document.title.match(/^([A-Z0-9&_-]+)/);
    if (match && match[1]) {
      return normalizeTicker(match[1]);
    }
  }

  return null;
}

function readChartOpenPrice() {
  try {
    const text = document.querySelector('[data-name="legend-series-item"], [class*="valuesWrapper"]')?.textContent || '';
    const match = text.match(/O\s*([0-9,]+(?:\.[0-9]+)?)/i);
    if (match && match[1]) {
      const val = parseFloat(match[1].replace(/,/g, ''));
      if (!isNaN(val) && val > 0) return val;
    }
  } catch (e) {}
  return null;
}

function watchChartTicker() {
  if (isFetching) return;
  const ticker = readActiveTicker();
  if (!ticker || ticker === currentSymbol) return;

  currentSymbol = ticker;
  isFetching = true;
  window.postMessage({ type: 'OI_STATUS', text: `Loading ${ticker} NSE OI...` }, '*');

  const chartOpenPrice = readChartOpenPrice();
  chrome.runtime.sendMessage({ type: 'FETCH_OI', symbol: ticker, chartOpenPrice }, (res) => {
    isFetching = false;
    if (res?.success && res.data) {
      lastOiData = res.data;
      window.postMessage({ type: 'OI_DATA', payload: res.data }, '*');
      window.postMessage({ type: 'OI_VISIBILITY', visible: overlayVisible }, '*');
    } else {
      window.postMessage({ type: 'OI_STATUS', text: `${res?.error || 'No NSE OI data'}` }, '*');
    }
  });
}

setInterval(watchChartTicker, 1000);
