// bridge.js - Bridges TradingView DOM with Background Service Worker

let currentSymbol = null;
let isFetching = false;
let overlayVisible = true;

chrome.storage.local.get(['overlayVisible'], (res) => {
  overlayVisible = res.overlayVisible !== false;
  window.postMessage({ type: 'OI_VISIBILITY', visible: overlayVisible }, '*');
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.overlayVisible) {
    overlayVisible = changes.overlayVisible.newValue;
    window.postMessage({ type: 'OI_VISIBILITY', visible: overlayVisible }, '*');
  }
  if (changes.oiSettings) {
    window.postMessage({ type: 'OI_SETTINGS', settings: changes.oiSettings.newValue }, '*');
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
      window.postMessage({ type: 'OI_DATA', payload: res.data }, '*');
    } else {
      window.postMessage({ type: 'OI_STATUS', text: `${res?.error || 'No NSE OI data'}` }, '*');
    }
  });
}

setInterval(watchChartTicker, 1000);
