// background.js - NSE Option Chain OI Fetcher & Level Calculator
// Incorporates the ranking, strike selection, and scoring logic from oi_fetch.py

const INDICES = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50']);

const DEFAULT_SETTINGS = {
  rankMode: 'total',       // 'total' (Call+Put), 'max', 'call_put', 'call', 'put'
  dataBasis: 'total',      // 'total' (Total OI) or 'change' (OI Change)
  strikesEachSide: 5,      // STRIKES_EACH_SIDE = 5 in oi_fetch.py
  topN: 3,                 // TOP_N = 3 in oi_fetch.py
  unit: 100000.0           // UNIT = 100000.0 (Lakhs)
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

    chrome.storage.local.get(['oiSettings'], (store) => {
      const settings = Object.assign({}, DEFAULT_SETTINGS, store.oiSettings || {});
      getNSEOptionLevels(symbol, settings)
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
          const recalculated = calculateOiLevels(current.symbol, cached.records, cached.expiry, settings);
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
function scoreOf(c, p, mode, isAbove) {
  if (mode === 'max') {
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
  return c + p;
}

// Core level picker implementing oi_fetch.py's ATM window and pick_levels logic
function calculateOiLevels(symbol, records, expiry, settings) {
  const {
    rankMode = 'total',
    dataBasis = 'total',
    strikesEachSide = 5,
    topN = 3
  } = settings;

  const rows = records.data || [];
  if (!rows.length) throw new Error('Empty option chain returned by NSE');

  // Spot price from underlyingValue or row underlyingValues
  const spot =
    Number(records.underlyingValue) ||
    Number(rows.find((r) => r.CE?.underlyingValue)?.CE?.underlyingValue) ||
    Number(rows.find((r) => r.PE?.underlyingValue)?.PE?.underlyingValue) ||
    0;

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

  // Find ATM strike (closest to spot) - matching oi_fetch.py
  let atmIndex = 0;
  let minDiff = Infinity;
  for (let i = 0; i < allStrikes.length; i++) {
    const diff = Math.abs(allStrikes[i] - spot);
    if (diff < minDiff) {
      minDiff = diff;
      atmIndex = i;
    }
  }

  // Window: ATM +/- strikesEachSide (STRIKES_EACH_SIDE = 5 in oi_fetch.py)
  const startIdx = Math.max(0, atmIndex - strikesEachSide);
  const endIdx = Math.min(allStrikes.length, atmIndex + strikesEachSide + 1);
  const chosenStrikes = allStrikes.slice(startIdx, endIdx);

  // Score each strike using scoreOf and basis ('total' vs 'change')
  const scored = chosenStrikes.map((s) => {
    const item = strikeMap.get(s);
    const c = dataBasis === 'change' ? item.ceChgOi : item.ceOi;
    const p = dataBasis === 'change' ? item.peChgOi : item.peOi;
    const isAbove = s >= spot;
    const score = scoreOf(c, p, rankMode, isAbove);

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
      scoreFormatted: formatOI(score),
      cFormatted: formatOI(c),
      pFormatted: formatOI(p)
    };
  });

  // Partition into Above (Resistance) and Below (Support) - matching pick_levels() in oi_fetch.py
  const aboveCandidates = scored.filter((x) => x.strike >= spot);
  const belowCandidates = scored.filter((x) => x.strike < spot);

  // Pick top N ranked by score descending (highest first)
  const topAbove = [...aboveCandidates]
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  const topBelow = [...belowCandidates]
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  // For chart visualization & standard S&R ordering:
  // Sort resistance ascending (R1 nearest above spot, R2 above R1, R3 highest)
  const resLevels = [...topAbove].sort((a, b) => a.strike - b.strike);
  // Sort support descending (S1 nearest below spot, S2 below S1, S3 lowest)
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

  // Pine Script compact lines format from oi_fetch.py:
  // SYMBOL | above1,above2,above3 | below1,below2,below3
  const pineAbove = topAbove.map((x) => x.strike).join(',');
  const pineBelow = topBelow.map((x) => x.strike).join(',');
  const pineLine = `${symbol} | ${pineAbove} | ${pineBelow}`;

  return {
    symbol,
    spot,
    expiry,
    mode: rankMode,
    basis: dataBasis,
    strikesEachSide,
    atmStrike: allStrikes[atmIndex],
    pineLine,
    r1: resObjects[0]?.price || null,
    r2: resObjects[1]?.price || null,
    r3: resObjects[2]?.price || null,
    s1: supObjects[0]?.price || null,
    s2: supObjects[1]?.price || null,
    s3: supObjects[2]?.price || null,
    topCalls: resObjects,
    topPuts: supObjects,
    levels: [...resObjects, ...supObjects],
    allChosen: scored
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
        return { chain, expiry };
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

  return { chain, expiry: expiries[0] };
}

async function getNSEOptionLevels(symbol, settings) {
  let result = null;
  let lastErr = null;

  for (const domain of ['www.nseindia.com', 'www.nseindia.in']) {
    try {
      result = await queryDomain(domain, symbol);
      if (result?.chain) break;
    } catch (e) {
      lastErr = e;
    }
  }

  if (!result?.chain) {
    throw new Error(`${symbol}: ${lastErr?.message || 'Non-F&O symbol or NSE blocked'}`);
  }

  const records = result.chain.records || result.chain.payload || result.chain;

  // Cache raw response
  rawChainCache.set(symbol, {
    records,
    expiry: result.expiry,
    timestamp: Date.now()
  });

  return calculateOiLevels(symbol, records, result.expiry, settings);
}
