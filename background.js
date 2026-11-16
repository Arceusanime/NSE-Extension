// background.js - NSE Option Chain OI Fetcher & Level Calculator
// Incorporates the ranking, strike selection, and scoring logic from oi_fetch.py

const INDICES = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50']);

const INDEX_NAME_MAP = {
  'NIFTY': 'NIFTY 50',
  'BANKNIFTY': 'NIFTY BANK',
  'FINNIFTY': 'NIFTY FINANCIAL SERVICES',
  'MIDCPNIFTY': 'NIFTY MIDCAP SELECT',
  'NIFTYNXT50': 'NIFTY NEXT 50'
};

const DEFAULT_SETTINGS = {
  rankMode: 'total',           // 'total' (Call+Put), 'max', 'call_put', 'call', 'put'
  dataBasis: 'total',          // 'total' (Total OI) or 'change' (OI Change)
  strikesEachSide: 5,          // STRIKES_EACH_SIDE = 5
  topN: 3,                     // TOP_N = 3
  refPriceSource: 'prev_open', // 'prev_open', 'today_open', 'custom', 'spot'
  customRefPrice: null,        // e.g. 1336
  excludeAtm: true,            // Exclude the rounded ATM strike candle
  lineStyle: 'solid',          // 'solid' | 'dashed'
  labelPosition: 'right',      // 'right' | 'left'
  lineScope: 'today'           // 'today' | 'full'
};

// In-memory cache for raw option chain data to make settings changes instant
const rawChainCache = new Map();
const CACHE_TTL_MS = 45 * 1000; // 45 seconds cache

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'FETCH_OI') {
    const symbol = (msg.symbol || '').trim().toUpperCase();
    if (!symbol) {
      sendResponse({ success: false, error: 'Invalid symbol' });
      return true;
    }

    const extra = msg.chartOpenPrice ? { chartOpenPrice: Number(msg.chartOpenPrice) } : {};

    chrome.storage.local.get(['oiSettings'], (store) => {
      const settings = Object.assign({}, DEFAULT_SETTINGS, store.oiSettings || {});
      getNSEOptionLevels(symbol, settings, extra)
        .then((data) => {
          chrome.storage.local.set({ activeOiData: data });
          sendResponse({ success: true, data });
        })
        .catch((err) => sendResponse({ success: false, error: err.message }));
    });
    return true;
  }

  if (msg.type === 'RECALCULATE_OI') {
    chrome.storage.local.get(['activeOiData', 'oiSettings'], (store) => {
      const current = store.activeOiData;
      if (!current || !current.symbol) {
        sendResponse({ success: false, error: 'No active symbol' });
        return;
      }
      const settings = Object.assign({}, DEFAULT_SETTINGS, store.oiSettings || {});
      const cached = rawChainCache.get(current.symbol);
      if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
        try {
          const recalculated = calculateOiLevels(current.symbol, cached.records, cached.expiry, settings, cached.priceInfo);
          chrome.storage.local.set({ activeOiData: recalculated });
          sendResponse({ success: true, data: recalculated });
          return;
        } catch (e) {
          // Fall through to network fetch if recalculation fails
        }
      }
      getNSEOptionLevels(current.symbol, settings)
        .then((data) => {
          chrome.storage.local.set({ activeOiData: data });
          sendResponse({ success: true, data });
        })
        .catch((err) => sendResponse({ success: false, error: err.message }));
    });
    return true;
  }
});

// Format numbers into Indian financial units (Lakhs, Crores, or Thousands)
function formatOI(num) {
  if (num === null || num === undefined || isNaN(num)) return '0';
  const abs = Math.abs(num);
  const sign = num < 0 ? '-' : '';
  if (abs >= 1e7) {
    return `${sign}${(abs / 1e7).toFixed(2)}Cr`;
  }
  if (abs >= 1e5) {
    return `${sign}${(abs / 1e5).toFixed(2)}L`;
  }
  if (abs >= 1e3) {
    return `${sign}${(abs / 1e3).toFixed(1)}k`;
  }
  return `${sign}${abs}`;
}

// Score function matching oi_fetch.py: score_of(c, p, mode)
function scoreOf(c, p, mode, isAbove, dataBasis = 'total') {
  if (mode === 'max') {
    if (dataBasis === 'change') {
      return Math.abs(c) >= Math.abs(p) ? c : p;
    }
    return Math.max(c, p);
  }
  if (mode === 'call') {
    return c;
  }
  if (mode === 'put') {
    return p;
  }
  if (mode === 'call_put') {
    // Classic S&R: Call OI defines resistance above, Put OI defines support below
    return isAbove ? c : p;
  }
  // Default mode 'total': Call + Put total OI
  if (dataBasis === 'change') {
    // When measuring net change activity across both sides, sum magnitudes
    return Math.abs(c) + Math.abs(p);
  }
  return c + p;
}

// Core level picker implementing ATM window, opening price reference, and ATM strike exclusion
function calculateOiLevels(symbol, records, expiry, settings, priceInfo = {}) {
  const {
    rankMode = 'total',
    dataBasis = 'total',
    strikesEachSide = 5,
    topN = 3,
    refPriceSource = 'prev_open',
    customRefPrice = null,
    excludeAtm = true,
    lineStyle = 'solid',
    labelPosition = 'right',
    lineScope = 'today'
  } = settings;

  const rows = records.data || [];
  if (!rows.length) throw new Error('Empty option chain returned by NSE');

  // Spot price from underlyingValue or row underlyingValues
  const spot =
    Number(records.underlyingValue) ||
    Number(rows.find((r) => r.CE?.underlyingValue)?.CE?.underlyingValue) ||
    Number(rows.find((r) => r.PE?.underlyingValue)?.PE?.underlyingValue) ||
    0;

  // Determine reference price based on settings
  let refPrice = spot;
  let effectiveSource = refPriceSource;

  if (refPriceSource === 'custom' && customRefPrice !== null && !isNaN(Number(customRefPrice)) && Number(customRefPrice) > 0) {
    refPrice = Number(customRefPrice);
    effectiveSource = 'custom';
  } else if (refPriceSource === 'prev_open') {
    if (priceInfo?.chartOpenPrice && !isNaN(Number(priceInfo.chartOpenPrice))) {
      refPrice = Number(priceInfo.chartOpenPrice);
      effectiveSource = 'chart_open';
    } else if (priceInfo?.prevOpen && !isNaN(Number(priceInfo.prevOpen))) {
      refPrice = Number(priceInfo.prevOpen);
      effectiveSource = 'prev_open';
    } else if (priceInfo?.todayOpen && !isNaN(Number(priceInfo.todayOpen))) {
      refPrice = Number(priceInfo.todayOpen);
      effectiveSource = 'today_open_fallback';
    } else if (priceInfo?.prevClose && !isNaN(Number(priceInfo.prevClose))) {
      refPrice = Number(priceInfo.prevClose);
      effectiveSource = 'prev_close_fallback';
    } else {
      effectiveSource = 'spot_fallback';
    }
  } else if (refPriceSource === 'today_open') {
    if (priceInfo?.todayOpen && !isNaN(Number(priceInfo.todayOpen))) {
      refPrice = Number(priceInfo.todayOpen);
      effectiveSource = 'today_open';
    } else if (priceInfo?.chartOpenPrice && !isNaN(Number(priceInfo.chartOpenPrice))) {
      refPrice = Number(priceInfo.chartOpenPrice);
      effectiveSource = 'chart_open';
    } else if (priceInfo?.prevOpen && !isNaN(Number(priceInfo.prevOpen))) {
      refPrice = Number(priceInfo.prevOpen);
      effectiveSource = 'prev_open_fallback';
    } else {
      effectiveSource = 'spot_fallback';
    }
  } else {
    // 'spot'
    refPrice = spot;
    effectiveSource = 'spot';
  }

  // Build strike map for target expiry
  const strikeMap = new Map();
  for (const row of rows) {
    if (expiry && row.expiryDate && row.expiryDate.toLowerCase() !== expiry.toLowerCase()) {
      continue;
    }
    const strike = Number(row.strikePrice);
    if (!strike || isNaN(strike)) continue;

    strikeMap.set(strike, {
      strike,
      ceOi: Number(row.CE?.openInterest || 0),
      ceChgOi: Number(row.CE?.changeinOpenInterest || 0),
      peOi: Number(row.PE?.openInterest || 0),
      peChgOi: Number(row.PE?.changeinOpenInterest || 0),
      ceLtp: Number(row.CE?.lastPrice || 0),
      peLtp: Number(row.PE?.lastPrice || 0)
    });
  }

  const allStrikes = Array.from(strikeMap.keys()).sort((a, b) => a - b);
  if (!allStrikes.length) throw new Error(`No option strikes found for ${symbol} expiry ${expiry}`);

  // Find ATM strike (closest to reference price)
  let atmIndex = 0;
  let minDiff = Infinity;
  for (let i = 0; i < allStrikes.length; i++) {
    const diff = Math.abs(allStrikes[i] - refPrice);
    if (diff < minDiff) {
      minDiff = diff;
      atmIndex = i;
    }
  }
  const atmStrike = allStrikes[atmIndex];

  // Window: ATM +/- strikesEachSide
  const startIdx = Math.max(0, atmIndex - strikesEachSide);
  const endIdx = Math.min(allStrikes.length, atmIndex + strikesEachSide + 1);
  const chosenStrikes = allStrikes.slice(startIdx, endIdx);

  // Score each strike using scoreOf and basis ('total' vs 'change')
  const scored = chosenStrikes.map((s) => {
    const item = strikeMap.get(s);
    const c = dataBasis === 'change' ? item.ceChgOi : item.ceOi;
    const p = dataBasis === 'change' ? item.peChgOi : item.peOi;
    const isAbove = s >= refPrice;
    const score = scoreOf(c, p, rankMode, isAbove, dataBasis);

    return {
      price: s,
      strike: s,
      score,
      oi: score,
      c,
      p,
      ceOi: item.ceOi,
      ceChgOi: item.ceChgOi,
      peOi: item.peOi,
      peChgOi: item.peChgOi,
      ceLtp: item.ceLtp,
      peLtp: item.peLtp,
      scoreFormatted: formatOI(score)
    };
  });

  // Partition into Above (Resistance) and Below (Support)
  // When excludeAtm is true, strictly exclude the rounded ATM strike:
  // Above candidates: strike > atmStrike
  // Below candidates: strike < atmStrike
  let aboveCandidates;
  let belowCandidates;

  if (excludeAtm !== false) {
    aboveCandidates = scored.filter((x) => x.strike > atmStrike);
    belowCandidates = scored.filter((x) => x.strike < atmStrike);
  } else {
    aboveCandidates = scored.filter((x) => x.strike >= refPrice);
    belowCandidates = scored.filter((x) => x.strike < refPrice);
  }

  // Pick top N ranked by score descending
  // When dataBasis === 'change', rank by absolute magnitude (Math.abs(score))
  // so that strikes with massive institutional activity (fresh build-up or unwinding)
  // are properly prioritized (matching Sensibull bar heights).
  const sortFn = dataBasis === 'change'
    ? (a, b) => Math.abs(b.score) - Math.abs(a.score)
    : (a, b) => b.score - a.score;

  const topAbove = [...aboveCandidates]
    .sort(sortFn)
    .slice(0, topN);

  const topBelow = [...belowCandidates]
    .sort(sortFn)
    .slice(0, topN);

  // For chart visualization & standard S&R ordering:
  // Sort resistance ascending (R1 nearest above ATM, R2 above R1, R3 highest)
  const resLevels = [...topAbove].sort((a, b) => a.strike - b.strike);
  // Sort support descending (S1 nearest below ATM, S2 below S1, S3 lowest)
  const supLevels = [...topBelow].sort((a, b) => b.strike - a.strike);

  const resObjects = resLevels.map((item, idx) => ({
    ...item,
    price: item.strike,
    strike: item.strike,
    oi: item.score || item.ceOi,
    chgOi: item.ceChgOi,
    label: `R${idx + 1}`,
    color: idx === 0 ? '#ff7043' : '#ef5350'
  }));

  const supObjects = supLevels.map((item, idx) => ({
    ...item,
    price: item.strike,
    strike: item.strike,
    oi: item.score || item.peOi,
    chgOi: item.peChgOi,
    label: `S${idx + 1}`,
    color: idx === 0 ? '#26a69a' : '#66bb6a'
  }));

  // Pine Script compact lines format:
  // SYMBOL | above1,above2,above3 | below1,below2,below3
  const pineAbove = topAbove.map((x) => x.strike).join(',');
  const pineBelow = topBelow.map((x) => x.strike).join(',');
  const pineLine = `${symbol} | ${pineAbove} | ${pineBelow}`;

  return {
    symbol,
    spot,
    refPrice,
    refPriceSource: effectiveSource,
    prevOpen: priceInfo?.prevOpen || null,
    todayOpen: priceInfo?.todayOpen || null,
    prevClose: priceInfo?.prevClose || null,
    atmStrike,
    excludedAtm: (excludeAtm !== false) ? atmStrike : null,
    excludeAtm: excludeAtm !== false,
    expiry,
    mode: rankMode,
    basis: dataBasis,
    lineStyle,
    labelPosition,
    lineScope,
    strikesEachSide,
    pineLine,
    r1: resObjects[0]?.price || null,
    r2: resObjects[1]?.price || null,
    r3: resObjects[2]?.price || null,
    s1: supObjects[0]?.price || null,
    s2: supObjects[1]?.price || null,
    s3: supObjects[2]?.price || null,
    topCalls: resObjects,
    topPuts: supObjects,
    levels: [...resObjects, ...supObjects]
  };
}

async function fetchJson(domain, path) {
  const pageUrl = `https://${domain}/option-chain`;
  try {
    await fetch(pageUrl, {
      headers: { 'Accept': 'text/html' },
      credentials: 'include'
    });
  } catch (e) {
    // Ignore cookie warming error and try API
  }

  const res = await fetch(`https://${domain}${path}`, {
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Referer': pageUrl,
      'X-Requested-With': 'XMLHttpRequest'
    },
    credentials: 'include'
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function queryDomain(domain, symbol) {
  const isIndex = INDICES.has(symbol);
  const type = isIndex ? 'Indices' : 'Equity';
  const sym = encodeURIComponent(symbol);

  // Strategy A: Modern v3 API
  try {
    const info = await fetchJson(domain, `/api/option-chain-contract-info?symbol=${sym}`);
    const expiries = info?.expiryDates || info?.payload?.expiryDates || [];
    if (expiries.length > 0) {
      const expiry = expiries[0];
      const chain = await fetchJson(
        domain,
        `/api/option-chain-v3?type=${type}&symbol=${sym}&expiry=${encodeURIComponent(expiry)}`
      );
      if (chain?.records || chain?.payload || chain?.data) {
        return { chain, expiry, domain };
      }
    }
  } catch (e) {
    // Fallback to Strategy B
  }

  // Strategy B: Legacy / full chain API
  const legacyPath = isIndex
    ? `/api/option-chain-indices?symbol=${sym}`
    : `/api/option-chain-equities?symbol=${sym}`;

  const chain = await fetchJson(domain, legacyPath);
  const records = chain.records || chain.payload || chain;
  const expiries = records.expiryDates || [];
  if (!expiries.length) throw new Error('No F&O expiry found');

  return { chain, expiry: expiries[0], domain };
}

async function getSymbolPriceInfo(domain, symbol) {
  const isIndex = INDICES.has(symbol);
  const info = { todayOpen: null, prevOpen: null, prevClose: null };

  try {
    if (isIndex) {
      const idxName = INDEX_NAME_MAP[symbol] || symbol;
      try {
        const all = await fetchJson(domain, '/api/allIndices');
        const match = (all?.data || []).find((d) =>
          d.index?.toUpperCase() === idxName.toUpperCase() ||
          d.indexSymbol?.toUpperCase() === idxName.toUpperCase() ||
          d.index?.toUpperCase().includes(symbol)
        );
        if (match) {
          info.todayOpen = Number(match.open) || null;
          info.prevClose = Number(match.previousClose) || null;
        }
      } catch (e) {}

      try {
        const hist = await fetchJson(domain, `/api/historical/indicesHistory?indexType=${encodeURIComponent(idxName)}`);
        const recs = hist?.data?.indexCloseOnlineRecords || hist?.data || [];
        if (recs.length >= 2) {
          info.prevOpen = Number(recs[1].OPEN_INDEX_VAL || recs[1].open) || null;
        }
      } catch (e) {}
    } else {
      const sym = encodeURIComponent(symbol);
      try {
        const quote = await fetchJson(domain, `/api/quote-equity?symbol=${sym}`);
        info.todayOpen = Number(quote?.priceInfo?.open) || null;
        info.prevClose = Number(quote?.priceInfo?.previousClose) || null;
      } catch (e) {}

      try {
        const hist = await fetchJson(domain, `/api/historical/cm/equity?symbol=${sym}&series=[%22EQ%22]`);
        const recs = hist?.data || [];
        if (recs.length >= 2) {
          info.prevOpen = Number(recs[1].CH_OPENING_PRICE || recs[1].open) || null;
        }
      } catch (e) {}
    }
  } catch (err) {
    // Graceful fallback if price endpoints fail
  }

  return info;
}

async function getNSEOptionLevels(symbol, settings, extraPriceInfo = {}) {
  let result = null;
  let lastErr = null;

  for (const domain of ['www.nseindia.com', 'www.nseindia.in']) {
    try {
      result = await queryDomain(domain, symbol);
      if (result?.chain) {
        result.domain = domain;
        break;
      }
    } catch (e) {
      lastErr = e;
    }
  }

  if (!result?.chain) {
    throw new Error(`${symbol}: ${lastErr?.message || 'Non-F&O symbol or NSE blocked'}`);
  }

  const records = result.chain.records || result.chain.payload || result.chain;

  // Fetch price info (prevOpen, todayOpen, prevClose)
  let priceInfo = {};
  try {
    priceInfo = await getSymbolPriceInfo(result.domain || 'www.nseindia.com', symbol);
  } catch (e) {}

  if (extraPriceInfo && typeof extraPriceInfo === 'object') {
    Object.assign(priceInfo, extraPriceInfo);
  }

  // Cache raw response with price info
  rawChainCache.set(symbol, {
    records,
    expiry: result.expiry,
    priceInfo,
    timestamp: Date.now()
  });

  return calculateOiLevels(symbol, records, result.expiry, settings, priceInfo);
}
