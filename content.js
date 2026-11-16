// content.js - Renders OI Levels directly onto the TradingView chart canvas
(() => {
  let oiData = null;
  let isVisible = true;
  let statusText = 'Initializing NSE OI...';

  // Configurable appearance settings with user-preferred defaults
  let displaySettings = {
    lineStyle: 'solid',       // 'solid' | 'dashed'
    labelPosition: 'right',   // 'right' | 'left'
    lineScope: 'today'        // 'today' | 'full'
  };

  window.addEventListener('message', (e) => {
    if (e.data?.type === 'OI_DATA') {
      oiData = e.data.payload;
      if (oiData.lineStyle) displaySettings.lineStyle = oiData.lineStyle;
      if (oiData.labelPosition) displaySettings.labelPosition = oiData.labelPosition;
      if (oiData.lineScope) displaySettings.lineScope = oiData.lineScope;

      const basisLabel = oiData.basis === 'change' ? 'OI Chg' : 'Total OI';
      const modeLabel = (oiData.mode || 'total').toUpperCase();
      const refSrc = (oiData.refPriceSource || 'ref').replace(/_/g, ' ').toUpperCase();
      const refText = oiData.refPrice ? `${refSrc}:${oiData.refPrice}` : `Spot:${oiData.spot}`;
      const exclText = oiData.excludedAtm ? ` [ATM ${oiData.excludedAtm} Excl]` : '';
      statusText = `${oiData.symbol} (${oiData.expiry}) • ${refText}${exclText} • R1:${oiData.r1} | S1:${oiData.s1} • [${modeLabel} • ${basisLabel}]`;
    } else if (e.data?.type === 'OI_SETTINGS') {
      if (e.data.settings) {
        if (e.data.settings.lineStyle) displaySettings.lineStyle = e.data.settings.lineStyle;
        if (e.data.settings.labelPosition) displaySettings.labelPosition = e.data.settings.labelPosition;
        if (e.data.settings.lineScope) displaySettings.lineScope = e.data.settings.lineScope;
      }
    } else if (e.data?.type === 'OI_STATUS') {
      oiData = null;
      statusText = e.data.text;
    } else if (e.data?.type === 'OI_VISIBILITY') {
      isVisible = e.data.visible;
    }
  });

  const overlay = document.createElement('canvas');
  overlay.id = 'nse-oi-overlay';
  overlay.style.position = 'fixed';
  overlay.style.pointerEvents = 'none';
  overlay.style.zIndex = '99999';
  document.body.appendChild(overlay);
  const ctx = overlay.getContext('2d');

  function findMainChartCanvas() {
    let best = null;
    let maxArea = 0;
    for (const c of document.querySelectorAll('canvas')) {
      if (c.id === 'nse-oi-overlay') continue;
      const r = c.getBoundingClientRect();
      if (r.width * r.height > maxArea && r.width > 300 && r.height > 200) {
        maxArea = r.width * r.height;
        best = c;
      }
    }
    return best;
  }

  function getExactPriceToY() {
    try {
      const col = window._exposed_chartWidgetCollection;
      if (!col) return null;

      const widget =
        typeof col.activeChartWidget?.value === 'function'
          ? col.activeChartWidget.value()
          : (typeof col.activeChartWidget === 'function'
            ? col.activeChartWidget()
            : (col.getAll?.()?.[0] || col._activeChartWidget));

      const model = widget?.model?.() || widget?._model;
      const mainSeries = model?.mainSeries?.() || model?._mainSeries;
      const priceScale = mainSeries?.priceScale?.() || widget?.priceScale?.();
      const firstValue = mainSeries?.firstValue?.();

      if (priceScale && typeof priceScale.priceToCoordinate === 'function') {
        return (price) => {
          try {
            return firstValue != null
              ? priceScale.priceToCoordinate(price, firstValue)
              : priceScale.priceToCoordinate(price);
          } catch (e) {
            return null;
          }
        };
      }
      if (mainSeries && typeof mainSeries.priceToCoordinate === 'function') {
        return (price) => {
          try {
            return mainSeries.priceToCoordinate(price);
          } catch (e) {
            return null;
          }
        };
      }
    } catch (e) {}
    return null;
  }

  // Calculate the horizontal pixel coordinate where the current trading day's session begins
  function getExactDayStartX() {
    try {
      const col = window._exposed_chartWidgetCollection;
      if (!col) return 0;

      const widget =
        typeof col.activeChartWidget?.value === 'function'
          ? col.activeChartWidget.value()
          : (typeof col.activeChartWidget === 'function'
            ? col.activeChartWidget()
            : (col.getAll?.()?.[0] || col._activeChartWidget));

      const model = widget?.model?.() || widget?._model;
      if (!model) return 0;

      const mainSeries = model.mainSeries?.() || model._mainSeries;
      const timeScale = model.timeScale?.() || widget.timeScale?.();
      if (!mainSeries || !timeScale) return 0;

      const bars = mainSeries.bars?.() || mainSeries._bars;
      if (!bars) return 0;

      const lastIndex = typeof bars.lastIndex === 'function' ? bars.lastIndex() : bars.lastIndex;
      if (lastIndex == null || isNaN(lastIndex)) return 0;

      const getBarTime = (bar) => {
        if (!bar) return null;
        const t = typeof bar.time === 'number' ? bar.time : (Array.isArray(bar) ? bar[0] : (bar.value ? bar.value[0] : null));
        if (typeof t !== 'number') return null;
        return t > 1e11 ? t : t * 1000;
      };

      const lastBar = typeof bars.valueAt === 'function' ? bars.valueAt(lastIndex) : (bars[lastIndex] || null);
      const lastTime = getBarTime(lastBar);
      if (!lastTime) return 0;

      const lastDate = new Date(lastTime);
      const targetDay = lastDate.getDate();
      const targetMonth = lastDate.getMonth();
      const targetYear = lastDate.getFullYear();

      // Walk backward to find the earliest candle of the same calendar day
      let startBarIndex = lastIndex;
      const firstIndex = typeof bars.firstIndex === 'function' ? bars.firstIndex() : 0;
      const minBound = Math.max(firstIndex, lastIndex - 600); // 1-minute chart has ~375 bars per session

      for (let i = lastIndex - 1; i >= minBound; i--) {
        const bar = typeof bars.valueAt === 'function' ? bars.valueAt(i) : bars[i];
        const t = getBarTime(bar);
        if (!t) continue;
        const d = new Date(t);
        if (d.getDate() === targetDay && d.getMonth() === targetMonth && d.getFullYear() === targetYear) {
          startBarIndex = i;
        } else {
          break; // Crossed into previous day
        }
      }

      if (typeof timeScale.indexToCoordinate === 'function') {
        const coord = timeScale.indexToCoordinate(startBarIndex);
        if (typeof coord === 'number' && !isNaN(coord)) {
          return Math.max(0, coord);
        }
      }
    } catch (e) {}
    return 0;
  }

  function formatLevelOI(num) {
    if (!num) return '';
    const abs = Math.abs(num);
    const sign = num < 0 ? '-' : '';
    if (abs >= 1e7) return ` (${sign}${(abs / 1e7).toFixed(2)}Cr OI)`;
    if (abs >= 1e5) return ` (${sign}${(abs / 1e5).toFixed(2)}L OI)`;
    if (abs >= 1e3) return ` (${sign}${(abs / 1e3).toFixed(1)}k OI)`;
    return ` (${sign}${abs} OI)`;
  }

  function drawLevel(y, price, label, oiCount, color, w, h, isAtm = false, startX = 0) {
    if (typeof y !== 'number' || isNaN(y)) return;

    const lineStyle = displaySettings.lineStyle || 'solid';
    const labelPos = displaySettings.labelPosition || 'right';

    // Off-screen ABOVE current zoom
    if (y < 0) {
      ctx.font = '500 10.5px -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif';
      const txt = `^ ${label}: ${price}`;
      const bw = ctx.measureText(txt).width + 14;
      const bx = labelPos === 'left' ? 10 : (w - bw - 10);
      ctx.fillStyle = color;
      ctx.fillRect(bx, 8, bw, 18);
      ctx.fillStyle = '#fff';
      ctx.fillText(txt, bx + 7, 20);
      return;
    }

    // Off-screen BELOW current zoom
    if (y > h) {
      ctx.font = '500 10.5px -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif';
      const txt = `v ${label}: ${price}`;
      const bw = ctx.measureText(txt).width + 14;
      const bx = labelPos === 'left' ? 10 : (w - bw - 10);
      ctx.fillStyle = color;
      ctx.fillRect(bx, h - 26, bw, 18);
      ctx.fillStyle = '#fff';
      ctx.fillText(txt, bx + 7, h - 13);
      return;
    }

    // Format OI badge text
    const oiLabel = isAtm ? ' [EXCL]' : (typeof oiCount === 'string' ? ` (${oiCount})` : formatLevelOI(oiCount));
    const fullBadgeText = `${label} - ${price}${oiLabel}`;
    ctx.font = '600 11px -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif';
    const bw = ctx.measureText(fullBadgeText).width + 16;

    // Horizontal line: solid (or dashed if configured / ATM)
    ctx.beginPath();
    if (lineStyle === 'dashed' || (isAtm && lineStyle !== 'solid')) {
      ctx.setLineDash(isAtm ? [3, 4] : [6, 4]);
    } else {
      ctx.setLineDash([]); // SOLID LINE (default)
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = isAtm ? 1.4 : 1.8;

    // Draw line from startX (start of day) to right edge
    ctx.moveTo(startX, y);
    ctx.lineTo(w, y);
    ctx.stroke();

    // Reset dash for badge rendering
    ctx.setLineDash([]);

    if (labelPos === 'right') {
      // Full label badge on the RIGHT side of the chart (flush against price scale)
      const rx = w - bw - 4;
      ctx.fillStyle = color;
      ctx.fillRect(rx, y - 9, bw, 19);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(fullBadgeText, rx + 8, y + 4.5);
    } else {
      // Left-side badge (legacy)
      ctx.fillStyle = color;
      ctx.fillRect(10, y - 18, bw, 18);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(fullBadgeText, 17, y - 5);

      // Right price pill flush with the Y-axis
      const rightText = String(price);
      const rw = ctx.measureText(rightText).width + 14;
      ctx.fillStyle = color;
      ctx.fillRect(w - rw, y - 9, rw, 18);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(rightText, w - rw + 7, y + 4);
    }
  }

  function render() {
    requestAnimationFrame(render);

    const target = findMainChartCanvas();
    if (!target || !isVisible) {
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      return;
    }

    const rect = target.getBoundingClientRect();
    if (overlay.width !== rect.width || overlay.height !== rect.height) {
      overlay.width = rect.width;
      overlay.height = rect.height;
    }
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;

    ctx.clearRect(0, 0, overlay.width, overlay.height);

    // Bottom-left status pill
    ctx.font = '500 11px -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif';
    const pw = ctx.measureText(statusText).width + 20;
    ctx.fillStyle = 'rgba(19, 23, 34, 0.94)';
    ctx.fillRect(10, rect.height - 48, pw, 24);
    ctx.strokeStyle = '#2962ff';
    ctx.lineWidth = 1;
    ctx.strokeRect(10, rect.height - 48, pw, 24);
    ctx.fillStyle = '#d1d4dc';
    ctx.fillText(statusText, 18, rect.height - 32);

    if (!oiData) return;

    const priceToY = getExactPriceToY();
    if (!priceToY) return;

    // Determine line starting X coordinate (start of today's session vs full chart)
    const startX = (displaySettings.lineScope === 'full') ? 0 : getExactDayStartX();

    // If start of today is off-screen to the right, skip drawing to avoid drawing on history
    if (startX >= overlay.width) return;

    // Directly plot the 3 Resistance and 3 Support levels
    const levels = [
      { price: oiData.r3, oi: oiData.topCalls?.[2]?.scoreFormatted || oiData.topCalls?.[2]?.oi, label: 'R3', color: '#ef5350' },
      { price: oiData.r2, oi: oiData.topCalls?.[1]?.scoreFormatted || oiData.topCalls?.[1]?.oi, label: 'R2', color: '#ef5350' },
      { price: oiData.r1, oi: oiData.topCalls?.[0]?.scoreFormatted || oiData.topCalls?.[0]?.oi, label: 'R1', color: '#ff7043' },
      { price: oiData.s1, oi: oiData.topPuts?.[0]?.scoreFormatted  || oiData.topPuts?.[0]?.oi,  label: 'S1', color: '#26a69a' },
      { price: oiData.s2, oi: oiData.topPuts?.[1]?.scoreFormatted  || oiData.topPuts?.[1]?.oi,  label: 'S2', color: '#26a69a' },
      { price: oiData.s3, oi: oiData.topPuts?.[2]?.scoreFormatted  || oiData.topPuts?.[2]?.oi,  label: 'S3', color: '#66bb6a' }
    ];

    if (oiData.excludedAtm) {
      levels.push({
        price: oiData.excludedAtm,
        oi: '',
        label: 'ATM REF',
        color: '#787b86',
        isAtm: true
      });
    }

    for (const lvl of levels) {
      const price = Number(lvl.price);
      if (price && !isNaN(price)) {
        const y = priceToY(price);
        drawLevel(y, price, lvl.label, lvl.oi, lvl.color, overlay.width, overlay.height, !!lvl.isAtm, startX);
      }
    }
  }

  render();
})();
