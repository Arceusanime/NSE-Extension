// popup.js - Controls for NSE OI S&R Extension

const DEFAULT_SETTINGS = {
  rankMode: 'call_put',
  dataBasis: 'total',
  strikesEachSide: 5,
  topN: 3,
  refPriceSource: 'prev_open',
  customRefPrice: null,
  excludeAtm: true,
  lineStyle: 'solid',
  labelPosition: 'right',
  lineScope: 'today'
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

  const resCards = [
    { lbl: 'R1', val: d.r1, obj: d.topCalls?.[0] },
    { lbl: 'R2', val: d.r2, obj: d.topCalls?.[1] },
    { lbl: 'R3', val: d.r3, obj: d.topCalls?.[2] }
  ];

  const supCards = [
    { lbl: 'S1', val: d.s1, obj: d.topPuts?.[0] },
    { lbl: 'S2', val: d.s2, obj: d.topPuts?.[1] },
    { lbl: 'S3', val: d.s3, obj: d.topPuts?.[2] }
  ];

  function renderCard(item, type) {
    const val = item.val || '--';
    const obj = item.obj || {};
    const scoreText = obj.scoreFormatted || (obj.score ? formatOI(obj.score) : '');
    const oiText = type === 'res'
      ? (obj.ceOi ? `CE:${formatOI(obj.ceOi)}` : '')
      : (obj.peOi ? `PE:${formatOI(obj.peOi)}` : '');

    return `
      <div class="matrix-card ${type}">
        <div class="card-head">
          <span class="card-badge ${type}">${item.lbl}</span>
          <span class="card-strike">${val}</span>
        </div>
        <div class="card-meta">
          <span class="card-score">${scoreText || '--'}</span>
          <span class="card-oi">${oiText}</span>
        </div>
      </div>
    `;
  }

  const atmHtml = d.excludedAtm ? `
    <div class="atm-strip">
      <span class="atm-strip-badge">ATM</span>
      <span class="atm-strip-strike">${d.excludedAtm}</span>
      <span class="atm-strip-note">Excluded from S&amp;R (Pivot Anchor)</span>
    </div>
  ` : '';

  document.getElementById('rows').innerHTML = `
    <div class="matrix-section">
      <div class="matrix-grid">
        ${resCards.map(c => renderCard(c, 'res')).join('')}
      </div>
      ${atmHtml}
      <div class="matrix-grid">
        ${supCards.map(c => renderCard(c, 'sup')).join('')}
      </div>
    </div>
  `;
}

const themeToggleCheckbox = document.getElementById('themeToggleCheckbox');

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  if (themeToggleCheckbox) {
    themeToggleCheckbox.checked = (theme === 'light');
  }
}

function updateEyeIcon(visible) {
  const btn = document.getElementById('toggleLinesBtn');
  const open = document.getElementById('eyeOpenIcon');
  const closed = document.getElementById('eyeClosedIcon');
  if (!btn || !open || !closed) return;
  if (visible) {
    btn.classList.add('active');
    btn.classList.remove('muted');
    btn.title = 'Lines visible on chart (Click to hide)';
    open.style.display = 'block';
    closed.style.display = 'none';
  } else {
    btn.classList.remove('active');
    btn.classList.add('muted');
    btn.title = 'Lines hidden on chart (Click to show)';
    open.style.display = 'none';
    closed.style.display = 'block';
  }
}

// Load initial state
chrome.storage.local.get(['activeOiData', 'overlayVisible', 'oiSettings', 'themeMode', 'accentColor'], (res) => {
  // Theme & Accent setup
  const theme = res.themeMode || 'dark';
  const accent = res.accentColor || 'mono';
  applyTheme(theme);
  document.documentElement.setAttribute('data-accent', accent);

  if (res.activeOiData) {
    render(res.activeOiData);
  }
  updateEyeIcon(res.overlayVisible !== false);

  const settings = Object.assign({}, DEFAULT_SETTINGS, res.oiSettings || {});
  document.getElementById('rankModeSelect').value = settings.rankMode || 'call_put';
  document.getElementById('dataBasisSelect').value = settings.dataBasis || 'total';
  document.getElementById('strikesRangeSelect').value = String(settings.strikesEachSide || 5);
  document.getElementById('lineStyleSelect').value = settings.lineStyle || 'solid';
  document.getElementById('labelPosSelect').value = settings.labelPosition || 'right';
  document.getElementById('lineScopeSelect').value = settings.lineScope || 'today';

  const refSrc = settings.refPriceSource || 'prev_open';
  document.getElementById('refPriceSelect').value = refSrc;
  document.getElementById('customPriceRow').style.display = refSrc === 'custom' ? 'grid' : 'none';
  if (settings.customRefPrice) {
    document.getElementById('customPriceInput').value = settings.customRefPrice;
  }
  document.getElementById('excludeAtmCheck').checked = settings.excludeAtm !== false;
});

// Theme and Accent event listeners
themeToggleCheckbox?.addEventListener('change', () => {
  const next = themeToggleCheckbox.checked ? 'light' : 'dark';
  applyTheme(next);
  chrome.storage.local.set({ themeMode: next });
});

document.querySelectorAll('.accent-dot').forEach((dot) => {
  dot.addEventListener('click', () => {
    const color = dot.getAttribute('data-color');
    if (color) {
      document.documentElement.setAttribute('data-accent', color);
      chrome.storage.local.set({ accentColor: color });
    }
  });
});

// Listen for updates from background
chrome.storage.onChanged.addListener((changes) => {
  if (changes.activeOiData) {
    render(changes.activeOiData.newValue);
  }
  if (changes.overlayVisible) {
    updateEyeIcon(changes.overlayVisible.newValue !== false);
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
    excludeAtm: document.getElementById('excludeAtmCheck').checked,
    lineStyle: document.getElementById('lineStyleSelect').value,
    labelPosition: document.getElementById('labelPosSelect').value,
    lineScope: document.getElementById('lineScopeSelect').value
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
document.getElementById('lineStyleSelect').addEventListener('change', updateSettings);
document.getElementById('labelPosSelect').addEventListener('change', updateSettings);
document.getElementById('lineScopeSelect').addEventListener('change', updateSettings);

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

document.getElementById('toggleLinesBtn')?.addEventListener('click', () => {
  chrome.storage.local.get(['overlayVisible'], (res) => {
    const next = res.overlayVisible === false ? true : false;
    chrome.storage.local.set({ overlayVisible: next });
    updateEyeIcon(next);
  });
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
