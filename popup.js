// popup.js - Controls for NSE OI S&R Extension

const DEFAULT_SETTINGS = {
  rankMode: 'total',
  dataBasis: 'total',
  strikesEachSide: 5,
  topN: 3,
  refPriceSource: 'prev_open',
  customRefPrice: null,
  excludeAtm: true
};

let currentPineLine = '';

function formatOI(num) {
  if (num === null || num === undefined || isNaN(num)) return '0';
  const abs = Math.abs(num);
  const sign = num < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(2)}L`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}k`;
  return `${sign}${abs}`;
}

function render(d) {
  if (!d) return;

  const symbol = d.symbol || 'NSE';
  const mode = (d.mode || 'total').toUpperCase();
  const basis = d.basis === 'change' ? 'OI CHG' : 'TOTAL OI';

  document.getElementById('title').textContent = `${symbol} • S&R`;
  document.getElementById('modeBadge').textContent = `${mode} • ${basis}`;

  const srcLabel = (d.refPriceSource || 'spot').replace(/_/g, ' ').toUpperCase();
  const refText = d.refPrice ? `Ref (${srcLabel}): ${d.refPrice}` : `Spot: ${d.spot || '--'}`;
  const atmText = d.atmStrike
    ? ` | ATM: ${d.atmStrike}${d.excludedAtm ? ' [EXCL]' : ''}`
    : '';

  document.getElementById('meta').textContent = `${refText}${atmText} | Spot: ${d.spot || '--'} | Expiry: ${d.expiry || '--'}`;

  currentPineLine = d.pineLine || `${symbol} | ${d.r1 || ''},${d.r2 || ''},${d.r3 || ''} | ${d.s1 || ''},${d.s2 || ''},${d.s3 || ''}`;

  const items = [
    { lbl: 'R3', val: d.r3, obj: d.topCalls?.[2], cls: 'res' },
    { lbl: 'R2', val: d.r2, obj: d.topCalls?.[1], cls: 'res' },
    { lbl: 'R1', val: d.r1, obj: d.topCalls?.[0], cls: 'res' }
  ];

  if (d.excludedAtm) {
    items.push({
      lbl: 'ATM',
      val: d.excludedAtm,
      cls: 'atm-excl',
      isAtm: true,
      subText: 'Excluded from S&R (Opening Candle Pivot)'
    });
  }

  items.push(
    { lbl: 'S1', val: d.s1, obj: d.topPuts?.[0], cls: 'sup' },
    { lbl: 'S2', val: d.s2, obj: d.topPuts?.[1], cls: 'sup' },
    { lbl: 'S3', val: d.s3, obj: d.topPuts?.[2], cls: 'sup' }
  );

  document.getElementById('rows').innerHTML = items.map(i => {
    const val = i.val || '--';
    if (i.isAtm) {
      return `
        <div class="row ${i.cls}">
          <span class="lbl">${i.lbl}</span>
          <div>
            <span class="strike">${val}</span>
            <span class="breakdown">${i.subText}</span>
          </div>
        </div>
      `;
    }

    const obj = i.obj || {};
    const scoreText = obj.scoreFormatted || (obj.score ? formatOI(obj.score) : '');
    const ce = obj.ceOi ? `CE:${formatOI(obj.ceOi)}` : '';
    const pe = obj.peOi ? `PE:${formatOI(obj.peOi)}` : '';
    const breakdown = (ce && pe) ? `(${ce} | ${pe})` : '';

    return `
      <div class="row ${i.cls}">
        <span class="lbl">${i.lbl}</span>
        <div>
          <span class="strike">${val}</span>
          ${scoreText ? `<span class="oi-val">${scoreText}</span>` : ''}
          ${breakdown ? `<span class="breakdown">${breakdown}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

// Load initial state
chrome.storage.local.get(['activeOiData', 'overlayVisible', 'oiSettings'], (res) => {
  if (res.activeOiData) {
    render(res.activeOiData);
  }
  document.getElementById('toggleVis').checked = res.overlayVisible !== false;

  const settings = Object.assign({}, DEFAULT_SETTINGS, res.oiSettings || {});
  document.getElementById('rankModeSelect').value = settings.rankMode || 'total';
  document.getElementById('dataBasisSelect').value = settings.dataBasis || 'total';
  document.getElementById('strikesRangeSelect').value = String(settings.strikesEachSide || 5);

  const refSrc = settings.refPriceSource || 'prev_open';
  document.getElementById('refPriceSelect').value = refSrc;
  document.getElementById('customPriceRow').style.display = refSrc === 'custom' ? 'grid' : 'none';
  if (settings.customRefPrice) {
    document.getElementById('customPriceInput').value = settings.customRefPrice;
  }
  document.getElementById('excludeAtmCheck').checked = settings.excludeAtm !== false;
});

// Listen for updates from background
chrome.storage.onChanged.addListener((changes) => {
  if (changes.activeOiData) {
    render(changes.activeOiData.newValue);
  }
});

// Save and apply settings change
function updateSettings() {
  const refSrc = document.getElementById('refPriceSelect').value;
  const customVal = parseFloat(document.getElementById('customPriceInput').value);

  const newSettings = {
    rankMode: document.getElementById('rankModeSelect').value,
    dataBasis: document.getElementById('dataBasisSelect').value,
    strikesEachSide: parseInt(document.getElementById('strikesRangeSelect').value, 10) || 5,
    topN: 3,
    refPriceSource: refSrc,
    customRefPrice: (!isNaN(customVal) && customVal > 0) ? customVal : null,
    excludeAtm: document.getElementById('excludeAtmCheck').checked
  };

  chrome.storage.local.set({ oiSettings: newSettings }, () => {
    chrome.runtime.sendMessage({ type: 'RECALCULATE_OI' }, (res) => {
      if (res?.success && res.data) {
        render(res.data);
      }
    });
  });
}

document.getElementById('rankModeSelect').addEventListener('change', updateSettings);
document.getElementById('dataBasisSelect').addEventListener('change', updateSettings);
document.getElementById('strikesRangeSelect').addEventListener('change', updateSettings);
document.getElementById('excludeAtmCheck').addEventListener('change', updateSettings);

document.getElementById('refPriceSelect').addEventListener('change', (e) => {
  const isCustom = e.target.value === 'custom';
  document.getElementById('customPriceRow').style.display = isCustom ? 'grid' : 'none';
  if (isCustom && !document.getElementById('customPriceInput').value) {
    chrome.storage.local.get(['activeOiData'], (res) => {
      if (res.activeOiData?.refPrice) {
        document.getElementById('customPriceInput').value = res.activeOiData.refPrice;
      }
    });
  }
  updateSettings();
});

document.getElementById('customPriceInput').addEventListener('change', updateSettings);
document.getElementById('customPriceInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    updateSettings();
  }
});

document.getElementById('toggleVis').addEventListener('change', (e) => {
  chrome.storage.local.set({ overlayVisible: e.target.checked });
});

document.getElementById('refreshBtn').addEventListener('click', () => {
  chrome.storage.local.set({ manualRefresh: Date.now() });
  chrome.runtime.sendMessage({ type: 'RECALCULATE_OI' }, (res) => {
    if (res?.success && res.data) {
      render(res.data);
    }
  });
});

document.getElementById('openDashboardBtn')?.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

document.getElementById('copyPineBtn').addEventListener('click', () => {
  if (!currentPineLine) return;
  navigator.clipboard.writeText(currentPineLine).then(() => {
    const btn = document.getElementById('copyPineBtn');
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    const box = document.getElementById('pineBox');
    box.style.display = 'block';
    box.textContent = currentPineLine;
    setTimeout(() => {
      btn.textContent = orig;
    }, 2000);
  });
});
