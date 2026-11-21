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
  lineScope: 'candles',
  overlayScope: 'tab',
  showOnChartToggle: true,
  trendlineSensitivity: 'conservative',
  showChannels: true,
  showConfluence: true
};

let currentPineLine = '';
let activeTradingViewTabId = null;
let currentTabVisible = false; // Default: OFF (only enabled on selected tab)
let currentTrendlinesVisible = false;

function updateTrendlineHeaderBtn(active) {
  const btn = document.getElementById('toggleTrendlineHeaderBtn');
  if (!btn) return;
  if (active) {
    btn.classList.add('active');
    btn.style.borderColor = 'rgba(255, 112, 67, 0.6)';
    btn.style.background = 'rgba(255, 112, 67, 0.15)';
    btn.title = 'Auto-Trendlines ACTIVE on this tab (Click to hide)';
  } else {
    btn.classList.remove('active');
    btn.style.borderColor = 'var(--border)';
    btn.style.background = 'var(--bg-card)';
    btn.title = 'Auto-Trendlines OFF (Click to calculate & plot)';
  }
}

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
  const refDisplay = d.refPrice ? `Ref: <strong>${d.refPrice}</strong> (${srcLabel})` : `Spot: <strong>${d.spot || '--'}</strong>`;
  const spotDisplay = `Spot: <strong>${d.spot || '--'}</strong>`;
  const expDisplay = `Exp: <strong>${d.expiry || '--'}</strong>`;

  document.getElementById('meta').innerHTML = `
    <span>${refDisplay}</span>
    <span>${spotDisplay}</span>
    <span>${expDisplay}</span>
  `;

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
          <span class="card-tag ${type}">${item.lbl}</span>
          <span class="card-oi">${scoreText}</span>
        </div>
        <div class="card-body-row">
          <span class="card-price">${val}</span>
          <span class="card-sub ${type}">${oiText}</span>
        </div>
      </div>
    `;
  }

  const resHtml = resCards.map(c => renderCard(c, 'res')).join('');
  const supHtml = supCards.map(c => renderCard(c, 'sup')).join('');

  const atmOiBadge = d.atmOi
    ? `<span class="atm-oi-badge">${d.basis === 'change' ? 'Δ ' : ''}${d.atmOi}</span>`
    : '';
  const atmSub = (d.atmCeOi || d.atmPeOi)
    ? `<span class="atm-sub-oi">CE: ${d.atmCeOi || '--'} • PE: ${d.atmPeOi || '--'}</span>`
    : '<span class="atm-sub-oi">Anchor Center</span>';

  // Only for pre-market open, display the exact unrounded price.
  // For other options (prev_open, today_open, spot), display the rounded strike (how it was earlier).
  const isPreOpen = d.refPriceSource === 'pre_open';
  const atmDisplayPrice = isPreOpen
    ? (d.refPrice || d.excludedAtm || d.atmStrike)
    : (d.excludedAtm || d.atmStrike || (d.refPrice ? Math.round(Number(d.refPrice) / 10) * 10 : '--'));

  const atmStripHtml = (atmDisplayPrice)
    ? `<div class="atm-strip">
         <div class="atm-strip-left">
           <span class="atm-tag">ATM REF</span>
           <span class="atm-val">${atmDisplayPrice}</span>
           ${atmOiBadge}
         </div>
         <div class="atm-strip-right">
           ${atmSub}
         </div>
       </div>`
    : '';

  document.getElementById('rows').innerHTML = `
    <div class="matrix-grid">${resHtml}</div>
    ${atmStripHtml}
    <div class="matrix-grid">${supHtml}</div>
  `;
}

// Light / Dark Theme toggle
const themeToggleCheckbox = document.getElementById('themeToggleCheckbox');

function applyTheme(theme) {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    if (themeToggleCheckbox) themeToggleCheckbox.checked = true;
  } else {
    document.documentElement.removeAttribute('data-theme');
    if (themeToggleCheckbox) themeToggleCheckbox.checked = false;
  }
}

// Eye toggle icon state
function updateEyeIcon(visible) {
  const btn = document.getElementById('toggleLinesBtn');
  const openIcon = document.getElementById('eyeOpenIcon');
  const closedIcon = document.getElementById('eyeClosedIcon');
  const scope = document.getElementById('overlayScopeSelect')?.value || 'tab';
  const scopeLabel = scope === 'tab' ? 'This tab' : 'All tabs';

  if (!btn || !openIcon || !closedIcon) return;

  if (visible) {
    btn.classList.add('active');
    btn.title = `Lines visible (${scopeLabel}) - Click to hide`;
    openIcon.style.display = 'block';
    closedIcon.style.display = 'none';
  } else {
    btn.classList.remove('active');
    btn.title = `Lines hidden (${scopeLabel}) - Click to enable`;
    openIcon.style.display = 'none';
    closedIcon.style.display = 'block';
  }
}

// Reliable active tab query across popups and multiple browser windows
function getActiveTab(callback) {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    if (tabs && tabs.length > 0 && tabs[0].id) {
      callback(tabs[0]);
    } else {
      chrome.tabs.query({ active: true, currentWindow: true }, (fallbackTabs) => {
        callback(fallbackTabs?.[0] || null);
      });
    }
  });
}

// Load initial state & bind to active tab
chrome.storage.local.get(['oiSettings', 'themeMode', 'accentColor', 'activeOiData'], (res) => {
  const theme = res.themeMode || 'dark';
  const accent = res.accentColor || 'mono';
  applyTheme(theme);
  document.documentElement.setAttribute('data-accent', accent);

  const settings = Object.assign({}, DEFAULT_SETTINGS, res.oiSettings || {});
  document.getElementById('rankModeSelect').value = settings.rankMode || 'call_put';
  document.getElementById('dataBasisSelect').value = settings.dataBasis || 'total';
  document.getElementById('strikesRangeSelect').value = String(settings.strikesEachSide || 5);
  document.getElementById('lineStyleSelect').value = settings.lineStyle || 'solid';
  document.getElementById('labelPosSelect').value = settings.labelPosition || 'right';
  document.getElementById('lineScopeSelect').value = settings.lineScope || 'candles';
  document.getElementById('overlayScopeSelect').value = settings.overlayScope || 'tab';
  document.getElementById('showOnChartToggleCheck').checked = settings.showOnChartToggle !== false;
  document.getElementById('tlSensitivitySelect').value = settings.trendlineSensitivity || 'conservative';
  document.getElementById('tlChannelsCheck').checked = settings.showChannels !== false;
  document.getElementById('tlConfluenceCheck').checked = settings.showConfluence !== false;

  const refSrc = settings.refPriceSource || 'prev_open';
  document.getElementById('refPriceSelect').value = refSrc;
  document.getElementById('customPriceRow').style.display = refSrc === 'custom' ? 'grid' : 'none';
  if (settings.customRefPrice) {
    document.getElementById('customPriceInput').value = settings.customRefPrice;
  }
  document.getElementById('excludeAtmCheck').checked = settings.excludeAtm !== false;

  // Query active TradingView tab for tab-isolated status
  getActiveTab((tab) => {
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'GET_TAB_OI_STATUS' }, (tabRes) => {
        if (!chrome.runtime.lastError && tabRes && tabRes.isTradingView) {
          activeTradingViewTabId = tab.id;
          currentTabVisible = tabRes.visible === true;
          updateEyeIcon(currentTabVisible);
          currentTrendlinesVisible = tabRes.trendlinesVisible === true;
          updateTrendlineHeaderBtn(currentTrendlinesVisible);

          if (tabRes.data) {
            render(tabRes.data);
            return;
          }
        }

        // Tab is not yet enabled or not TradingView: default to OFF
        updateEyeIcon(false);
        updateTrendlineHeaderBtn(false);
        if (res.activeOiData) {
          render(res.activeOiData);
        }
      });
    } else {
      updateEyeIcon(false);
      updateTrendlineHeaderBtn(false);
      if (res.activeOiData) render(res.activeOiData);
    }
  });
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
  if (changes.activeOiData && !activeTradingViewTabId) {
    render(changes.activeOiData.newValue);
  }
  if (changes.globalOverlayVisible && document.getElementById('overlayScopeSelect')?.value === 'all') {
    updateEyeIcon(changes.globalOverlayVisible.newValue === true);
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
    lineScope: document.getElementById('lineScopeSelect').value,
    overlayScope: document.getElementById('overlayScopeSelect').value,
    showOnChartToggle: document.getElementById('showOnChartToggleCheck').checked,
    trendlineSensitivity: document.getElementById('tlSensitivitySelect')?.value || 'conservative',
    showChannels: document.getElementById('tlChannelsCheck')?.checked !== false,
    showConfluence: document.getElementById('tlConfluenceCheck')?.checked !== false
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
document.getElementById('tlSensitivitySelect')?.addEventListener('change', updateSettings);
document.getElementById('tlChannelsCheck')?.addEventListener('change', updateSettings);
document.getElementById('tlConfluenceCheck')?.addEventListener('change', updateSettings);

// Header button for toggling auto-trendlines
document.getElementById('toggleTrendlineHeaderBtn')?.addEventListener('click', () => {
  getActiveTab((tab) => {
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_TRENDLINES' }, (tabRes) => {
        if (!chrome.runtime.lastError && tabRes) {
          currentTrendlinesVisible = tabRes.visible === true;
          updateTrendlineHeaderBtn(currentTrendlinesVisible);
        }
      });
    }
  });
});

// Button for on-demand recalculation of trendlines based on current chart view
document.getElementById('recalcTrendlinesBtn')?.addEventListener('click', () => {
  const btn = document.getElementById('recalcTrendlinesBtn');
  getActiveTab((tab) => {
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'SET_TRENDLINES', visible: true }, () => {
        chrome.tabs.sendMessage(tab.id, { type: 'RECALCULATE_TRENDLINES' }, () => {
          currentTrendlinesVisible = true;
          updateTrendlineHeaderBtn(true);
          if (btn) {
            const original = btn.innerText;
            btn.innerText = '✓ Trendlines Plotted!';
            btn.style.borderColor = 'var(--accent)';
            setTimeout(() => {
              btn.innerText = original;
              btn.style.borderColor = '';
            }, 1400);
          }
        });
      });
    }
  });
});
document.getElementById('overlayScopeSelect').addEventListener('change', () => {
  updateSettings();
  updateEyeIcon(currentTabVisible);
});
document.getElementById('showOnChartToggleCheck').addEventListener('change', updateSettings);

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

// Toggle lines: controls strictly the active tab (or all tabs if selected)
document.getElementById('toggleLinesBtn')?.addEventListener('click', () => {
  const scope = document.getElementById('overlayScopeSelect')?.value || 'tab';

  if (scope === 'tab') {
    getActiveTab((tab) => {
      const targetId = activeTradingViewTabId || tab?.id;
      if (targetId) {
        chrome.tabs.sendMessage(targetId, { type: 'TOGGLE_TAB_VISIBILITY' }, (res) => {
          if (!chrome.runtime.lastError && res && typeof res.visible === 'boolean') {
            currentTabVisible = res.visible;
            updateEyeIcon(currentTabVisible);
          } else {
            // Content script was not ready or tab needs reload
            const metaEl = document.getElementById('meta');
            if (metaEl) {
              metaEl.textContent = 'Please refresh this TradingView tab (F5) once to connect.';
            }
          }
        });
      }
    });
  } else {
    // Global scope: explicitly broadcast to ALL tabs
    chrome.storage.local.get(['globalOverlayVisible'], (res) => {
      const next = res.globalOverlayVisible === true ? false : true;
      chrome.storage.local.set({ globalOverlayVisible: next });
      currentTabVisible = next;
      updateEyeIcon(next);

      chrome.tabs.query({}, (allTabs) => {
        allTabs.forEach((t) => {
          if (t.id) {
            chrome.tabs.sendMessage(t.id, { type: 'SET_TAB_VISIBILITY', visible: next }, () => {
              if (chrome.runtime.lastError) {}
            });
          }
        });
      });
    });
  }
});

document.getElementById('refreshBtn').addEventListener('click', () => {
  chrome.storage.local.set({ manualRefresh: Date.now() });
  getActiveTab((tab) => {
    const targetId = activeTradingViewTabId || tab?.id;
    if (targetId) {
      chrome.tabs.sendMessage(targetId, { type: 'REFRESH_TAB_OI' }, () => {
        if (chrome.runtime.lastError) {}
      });
    }
  });
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

// GitHub Update Management in Popup
const localVer = chrome.runtime.getManifest().version;
const installedVerEl = document.getElementById('installedVerVal');
if (installedVerEl) {
  installedVerEl.textContent = `v${localVer}`;
}

chrome.storage.local.get(['updateInfo'], (res) => {
  const info = res.updateInfo;
  if (info?.hasUpdate) {
    const banner = document.getElementById('updateBanner');
    if (banner) {
      banner.style.display = 'flex';
      const tag = document.getElementById('updateVersionTag');
      if (tag) tag.textContent = `v${info.remoteVersion}`;
    }
    const msg = document.getElementById('updateStatusMsg');
    if (msg) {
      msg.textContent = `Update v${info.remoteVersion} on GitHub! Run update.bat & reload.`;
      msg.style.color = '#38bdf8';
    }
  }
});

// Dismiss banner
document.getElementById('updateBannerDismissBtn')?.addEventListener('click', () => {
  const banner = document.getElementById('updateBanner');
  if (banner) banner.style.display = 'none';
});

// Reload Extension buttons
document.getElementById('updateBannerReloadBtn')?.addEventListener('click', () => {
  chrome.runtime.reload();
});
document.getElementById('manualReloadBtn')?.addEventListener('click', () => {
  chrome.runtime.reload();
});

// Manual Check Update button
document.getElementById('checkUpdateBtn')?.addEventListener('click', () => {
  const btn = document.getElementById('checkUpdateBtn');
  const msg = document.getElementById('updateStatusMsg');
  if (!btn || !msg) return;

  btn.disabled = true;
  btn.textContent = 'Checking...';
  msg.textContent = 'Querying GitHub repository...';

  chrome.runtime.sendMessage({ type: 'CHECK_UPDATES' }, (res) => {
    btn.disabled = false;
    btn.textContent = 'Check Update';
    if (res?.success && res.updateInfo) {
      const info = res.updateInfo;
      if (info.hasUpdate) {
        const banner = document.getElementById('updateBanner');
        if (banner) {
          banner.style.display = 'flex';
          const tag = document.getElementById('updateVersionTag');
          if (tag) tag.textContent = `v${info.remoteVersion}`;
        }
        msg.textContent = `Update v${info.remoteVersion} found! Run update.bat & reload.`;
        msg.style.color = '#38bdf8';
      } else {
        msg.textContent = `Up to date (v${info.currentVersion}).`;
        msg.style.color = 'var(--text-muted)';
      }
    } else {
      msg.textContent = res?.error || 'Check failed. Verify connection.';
      msg.style.color = '#ef5350';
    }
  });
});
