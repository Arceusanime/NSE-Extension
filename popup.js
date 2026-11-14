// popup.js - Controls for NSE OI S&R Extension

const DEFAULT_SETTINGS = {
  rankMode: 'total',
  dataBasis: 'total',
  strikesEachSide: 5,
  topN: 3
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

  const atmText = d.atmStrike ? ` | ATM: ${d.atmStrike}` : '';
  document.getElementById('meta').textContent = `Spot: ${d.spot || '--'} | Expiry: ${d.expiry || '--'}${atmText}`;

  currentPineLine = d.pineLine || `${symbol} | ${d.r1 || ''},${d.r2 || ''},${d.r3 || ''} | ${d.s1 || ''},${d.s2 || ''},${d.s3 || ''}`;

  const items = [
    { lbl: 'R3', val: d.r3, obj: d.topCalls?.[2], cls: 'res' },
    { lbl: 'R2', val: d.r2, obj: d.topCalls?.[1], cls: 'res' },
    { lbl: 'R1', val: d.r1, obj: d.topCalls?.[0], cls: 'res' },
    { lbl: 'S1', val: d.s1, obj: d.topPuts?.[0], cls: 'sup' },
    { lbl: 'S2', val: d.s2, obj: d.topPuts?.[1], cls: 'sup' },
    { lbl: 'S3', val: d.s3, obj: d.topPuts?.[2], cls: 'sup' }
  ];

  document.getElementById('rows').innerHTML = items.map(i => {
    const val = i.val || '--';
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
});

// Listen for updates from background
chrome.storage.onChanged.addListener((changes) => {
  if (changes.activeOiData) {
    render(changes.activeOiData.newValue);
  }
});

// Save and apply settings change
function updateSettings() {
  const newSettings = {
    rankMode: document.getElementById('rankModeSelect').value,
    dataBasis: document.getElementById('dataBasisSelect').value,
    strikesEachSide: parseInt(document.getElementById('strikesRangeSelect').value, 10) || 5,
    topN: 3
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
