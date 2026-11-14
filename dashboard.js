// dashboard.js - Scanner & S&R Analysis Dashboard for NSE Option Chain

const INDICES_SET = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50']);

const DEFAULT_WATCHLIST = [
  'NIFTY',
  'BANKNIFTY',
  'FINNIFTY',
  'MIDCPNIFTY',
  'RELIANCE',
  'HDFCBANK',
  'ICICIBANK',
  'INFY',
  'TCS',
  'SBIN',
  'BHARTIARTL',
  'KOTAKBANK',
  'LT',
  'AXISBANK',
  'TATAMOTORS',
  'BAJFINANCE',
  'MARUTI',
  'SUNPHARMA',
  'TITAN',
  'TATASTEEL'
];

let scannedData = [];
let isScanning = false;

// Format numbers
function fmt(num) {
  if (num === null || num === undefined || isNaN(num)) return '--';
  return Number(num).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function formatOI(num) {
  if (num === null || num === undefined || isNaN(num)) return '';
  const abs = Math.abs(num);
  const sign = num < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(2)}L`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}k`;
  return `${sign}${abs}`;
}

// Compute Point Gap and metrics for a stock
function enrichStockData(raw) {
  const r1 = Number(raw.r1) || 0;
  const r2 = Number(raw.r2) || 0;
  const r3 = Number(raw.r3) || 0;
  const s1 = Number(raw.s1) || 0;
  const s2 = Number(raw.s2) || 0;
  const s3 = Number(raw.s3) || 0;
  const ref = Number(raw.refPrice) || Number(raw.spot) || 0;
  const spot = Number(raw.spot) || 0;

  const pointGap = (r1 && s1) ? +(r1 - s1).toFixed(2) : 0;
  const pointGapPct = (pointGap > 0 && ref > 0) ? +((pointGap / ref) * 100).toFixed(2) : 0;
  const fullGap = (r3 && s3) ? +(r3 - s3).toFixed(2) : 0;
  const upsideGap = (r1 && ref) ? +(r1 - ref).toFixed(2) : 0;
  const downsideGap = (s1 && ref) ? +(ref - s1).toFixed(2) : 0;

  return {
    ...raw,
    r1, r2, r3, s1, s2, s3, refPrice: ref, spot,
    pointGap,
    pointGapPct,
    fullGap,
    upsideGap,
    downsideGap,
    isIndex: INDICES_SET.has(raw.symbol)
  };
}

// Render KPI Cards
function updateKpiCards(data) {
  document.getElementById('statTracked').textContent = data.length;

  const validGaps = data.filter((d) => d.pointGap > 0);
  if (!validGaps.length) {
    document.getElementById('statAvgGap').textContent = '-- pts';
    document.getElementById('statMaxGap').textContent = '--';
    document.getElementById('statMinGap').textContent = '--';
    return;
  }

  const avgGap = (validGaps.reduce((acc, c) => acc + c.pointGap, 0) / validGaps.length).toFixed(1);
  document.getElementById('statAvgGap').textContent = `${avgGap} pts`;

  const sortedByGap = [...validGaps].sort((a, b) => b.pointGap - a.pointGap);
  const max = sortedByGap[0];
  const min = sortedByGap[sortedByGap.length - 1];

  document.getElementById('statMaxGap').textContent = `${max.symbol} (${max.pointGap} pts)`;
  document.getElementById('statMaxGapSub').textContent = `Spread: ${max.pointGapPct}% (${max.r1} - ${max.s1})`;

  document.getElementById('statMinGap').textContent = `${min.symbol} (${min.pointGap} pts)`;
  document.getElementById('statMinGapSub').textContent = `Spread: ${min.pointGapPct}% (${min.r1} - ${min.s1})`;
}

// Filter and Sort Table
function filterAndSortData() {
  const query = document.getElementById('searchInput').value.trim().toUpperCase();
  const cat = document.getElementById('categoryFilter').value;
  const sortBy = document.getElementById('sortBySelect').value;
  const minGap = parseFloat(document.getElementById('gapThreshold').value) || 0;

  let list = scannedData.filter((item) => {
    if (query && !item.symbol.includes(query)) return false;
    if (cat === 'indices' && !item.isIndex) return false;
    if (cat === 'stocks' && item.isIndex) return false;
    if (item.pointGap < minGap) return false;
    return true;
  });

  list.sort((a, b) => {
    switch (sortBy) {
      case 'gap_desc':
        return b.pointGap - a.pointGap;
      case 'gap_asc':
        return a.pointGap - b.pointGap;
      case 'pct_desc':
        return b.pointGapPct - a.pointGapPct;
      case 'upside_desc':
        return b.upsideGap - a.upsideGap;
      case 'downside_desc':
        return b.downsideGap - a.downsideGap;
      case 'full_gap_desc':
        return b.fullGap - a.fullGap;
      case 'symbol_asc':
        return a.symbol.localeCompare(b.symbol);
      default:
        return b.pointGap - a.pointGap;
    }
  });

  return list;
}

// Render Table
function renderTable() {
  const tbody = document.getElementById('stocksTableBody');
  const items = filterAndSortData();

  if (!items.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="10" style="text-align: center; color: var(--text-muted); padding: 40px;">
          ${scannedData.length ? 'No stocks match the current filter criteria.' : 'Click "⚡ Scan All Watchlist" to load real-time option chain data.'}
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = items.map((item, idx) => {
    const symTag = item.isIndex ? '<span class="sym-tag index">INDEX</span>' : '<span class="sym-tag">STOCK</span>';
    const refSrc = (item.refPriceSource || 'spot').replace(/_/g, ' ').toUpperCase();
    const atmExcl = item.excludedAtm ? `${item.excludedAtm} <span style="font-size:9px; color:#ffb74d;">[EXCL]</span>` : (item.atmStrike || '--');
    
    const r1Oi = item.topCalls?.[0]?.scoreFormatted || formatOI(item.topCalls?.[0]?.oi);
    const r2Oi = item.topCalls?.[1]?.scoreFormatted || formatOI(item.topCalls?.[1]?.oi);
    const r3Oi = item.topCalls?.[2]?.scoreFormatted || formatOI(item.topCalls?.[2]?.oi);
    
    const s1Oi = item.topPuts?.[0]?.scoreFormatted || formatOI(item.topPuts?.[0]?.oi);
    const s2Oi = item.topPuts?.[1]?.scoreFormatted || formatOI(item.topPuts?.[1]?.oi);
    const s3Oi = item.topPuts?.[2]?.scoreFormatted || formatOI(item.topPuts?.[2]?.oi);

    const tvUrl = `https://www.tradingview.com/chart/?symbol=NSE:${encodeURIComponent(item.symbol)}`;

    return `
      <tr>
        <td style="color: var(--text-muted); font-weight: 600;">${idx + 1}</td>
        <td>
          <div class="sym-col">
            ${item.symbol} ${symTag}
          </div>
        </td>
        <td>
          <span class="gap-pill">
            ${item.pointGap > 0 ? `${item.pointGap} pts` : '--'}
            <span class="gap-pct">(${item.pointGapPct}%)</span>
          </span>
        </td>
        <td>
          <strong>${fmt(item.refPrice)}</strong>
          <span style="font-size: 9px; color: var(--text-muted); display: block;">${refSrc}</span>
        </td>
        <td>${fmt(item.spot)}</td>
        <td class="atm-badge">${atmExcl}</td>
        <td>
          <span class="res-badge">${fmt(item.r1)}</span><span class="oi-sub">${r1Oi}</span> | 
          <span class="res-badge">${fmt(item.r2)}</span><span class="oi-sub">${r2Oi}</span> | 
          <span class="res-badge">${fmt(item.r3)}</span><span class="oi-sub">${r3Oi}</span>
        </td>
        <td>
          <span class="sup-badge">${fmt(item.s1)}</span><span class="oi-sub">${s1Oi}</span> | 
          <span class="sup-badge">${fmt(item.s2)}</span><span class="oi-sub">${s2Oi}</span> | 
          <span class="sup-badge">${fmt(item.s3)}</span><span class="oi-sub">${s3Oi}</span>
        </td>
        <td>
          <span style="color: #66bb6a; font-weight: 600;">▲ +${item.upsideGap}</span> / 
          <span style="color: #ef5350; font-weight: 600;">▼ -${item.downsideGap}</span>
        </td>
        <td>
          <a href="${tvUrl}" target="_blank" class="tv-link" title="Open ${item.symbol} on TradingView">
            Chart ↗
          </a>
        </td>
      </tr>
    `;
  }).join('');
}

// Scanner Engine
async function scanAllWatchlist() {
  if (isScanning) return;
  isScanning = true;

  const btn = document.getElementById('scanAllBtn');
  const pill = document.getElementById('statusPill');
  const progressContainer = document.getElementById('progressContainer');
  const progressBar = document.getElementById('progressBar');

  btn.disabled = true;
  btn.textContent = 'Scanning...';
  pill.textContent = 'Scanning...';
  pill.style.background = '#ff9800';
  progressContainer.style.display = 'block';
  progressBar.style.width = '0%';

  chrome.storage.local.get(['customWatchlist', 'oiSettings'], async (store) => {
    const list = store.customWatchlist || DEFAULT_WATCHLIST;
    const settings = store.oiSettings || {};

    // Override settings from toolbar if changed
    const activeSettings = {
      ...settings,
      refPriceSource: document.getElementById('refPriceSourceSelect').value,
      rankMode: document.getElementById('rankModeSelect').value,
      dataBasis: document.getElementById('dataBasisSelect').value,
      excludeAtm: document.getElementById('excludeAtmCheck').checked
    };

    scannedData = [];
    const total = list.length;

    for (let i = 0; i < total; i++) {
      const symbol = list[i].trim().toUpperCase();
      if (!symbol) continue;

      pill.textContent = `Scanning [${i + 1}/${total}] ${symbol}`;
      progressBar.style.width = `${Math.round(((i + 1) / total) * 100)}%`;

      try {
        await new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: 'FETCH_OI', symbol }, (res) => {
            if (res?.success && res.data) {
              const enriched = enrichStockData(res.data);
              scannedData.push(enriched);
              updateKpiCards(scannedData);
              renderTable();
            }
            // Gentle pause between calls to respect NSE rate limits
            setTimeout(resolve, 350);
          });
        });
      } catch (err) {
        console.error(`Failed to scan ${symbol}:`, err);
      }
    }

    // Save scan cache
    chrome.storage.local.set({
      scannerCache: scannedData,
      scannerLastTime: new Date().toLocaleTimeString()
    });

    isScanning = false;
    btn.disabled = false;
    btn.textContent = '⚡ Scan All Watchlist';
    pill.textContent = 'Complete';
    pill.style.background = '#26a69a';
    document.getElementById('statScannedTime').textContent = `Scanned at ${new Date().toLocaleTimeString()}`;
    setTimeout(() => {
      progressContainer.style.display = 'none';
    }, 1500);
  });
}

// Export CSV
function exportCsv() {
  if (!scannedData.length) {
    alert('No data to export. Please run a scan first.');
    return;
  }

  const items = filterAndSortData();
  const headers = ['Symbol', 'Category', 'Ref Price', 'Spot Price', 'ATM Strike', 'Point Gap (R1 - S1)', 'Point Gap %', 'R1', 'R2', 'R3', 'S1', 'S2', 'S3', 'Upside Room', 'Downside Room', 'Pine Line'];
  
  const rows = items.map(d => [
    d.symbol,
    d.isIndex ? 'Index' : 'Equity',
    d.refPrice,
    d.spot,
    d.atmStrike,
    d.pointGap,
    d.pointGapPct + '%',
    d.r1, d.r2, d.r3,
    d.s1, d.s2, d.s3,
    d.upsideGap,
    d.downsideGap,
    `"${d.pineLine || ''}"`
  ]);

  const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement('a');
  link.setAttribute('href', encodedUri);
  link.setAttribute('download', `NSE_OI_Point_Gap_Scanner_${new Date().toISOString().slice(0,10)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// Watchlist modal management
const modal = document.getElementById('watchlistModal');
const textarea = document.getElementById('watchlistTextarea');

document.getElementById('openWatchlistBtn').addEventListener('click', () => {
  chrome.storage.local.get(['customWatchlist'], (res) => {
    const list = res.customWatchlist || DEFAULT_WATCHLIST;
    textarea.value = list.join(', ');
    modal.style.display = 'flex';
  });
});

document.getElementById('cancelWatchlistBtn').addEventListener('click', () => {
  modal.style.display = 'none';
});

document.getElementById('resetWatchlistBtn').addEventListener('click', () => {
  textarea.value = DEFAULT_WATCHLIST.join(', ');
});

document.getElementById('saveWatchlistBtn').addEventListener('click', () => {
  const raw = textarea.value;
  const list = raw
    .split(/[\n,]+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);

  const unique = Array.from(new Set(list));
  chrome.storage.local.set({ customWatchlist: unique }, () => {
    modal.style.display = 'none';
    document.getElementById('statTracked').textContent = unique.length;
    alert(`Saved ${unique.length} symbols to watchlist. Click "Scan All" to analyze!`);
  });
});

// Event Listeners for Filters & Sort
document.getElementById('searchInput').addEventListener('input', renderTable);
document.getElementById('categoryFilter').addEventListener('change', renderTable);
document.getElementById('sortBySelect').addEventListener('change', renderTable);
document.getElementById('gapThreshold').addEventListener('change', renderTable);

document.getElementById('refPriceSourceSelect').addEventListener('change', scanAllWatchlist);
document.getElementById('rankModeSelect').addEventListener('change', scanAllWatchlist);
document.getElementById('dataBasisSelect').addEventListener('change', scanAllWatchlist);
document.getElementById('excludeAtmCheck').addEventListener('change', scanAllWatchlist);

document.getElementById('scanAllBtn').addEventListener('click', scanAllWatchlist);
document.getElementById('exportCsvBtn').addEventListener('click', exportCsv);

// Initialize on Load
chrome.storage.local.get(['customWatchlist', 'scannerCache', 'scannerLastTime', 'oiSettings'], (res) => {
  const list = res.customWatchlist || DEFAULT_WATCHLIST;
  document.getElementById('statTracked').textContent = list.length;

  if (res.oiSettings) {
    if (res.oiSettings.refPriceSource) document.getElementById('refPriceSourceSelect').value = res.oiSettings.refPriceSource;
    if (res.oiSettings.rankMode) document.getElementById('rankModeSelect').value = res.oiSettings.rankMode;
    if (res.oiSettings.dataBasis) document.getElementById('dataBasisSelect').value = res.oiSettings.dataBasis;
    if (res.oiSettings.excludeAtm !== undefined) document.getElementById('excludeAtmCheck').checked = res.oiSettings.excludeAtm !== false;
  }

  if (res.scannerCache && res.scannerCache.length > 0) {
    scannedData = res.scannerCache;
    if (res.scannerLastTime) {
      document.getElementById('statScannedTime').textContent = `Cached from ${res.scannerLastTime}`;
    }
    updateKpiCards(scannedData);
    renderTable();
  }
});
