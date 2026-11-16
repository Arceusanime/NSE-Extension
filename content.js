// content.js - Renders OI Levels directly onto the TradingView chart canvas
(() => {
  let oiData = null;
  let isVisible = true;
  let statusText = 'Initializing NSE OI...';

  window.addEventListener('message', (e) => {
    if (e.data?.type === 'OI_DATA') {
      oiData = e.data.payload;
      const basisLabel = oiData.basis === 'change' ? 'OI Chg' : 'Total OI';
      const modeLabel = (oiData.mode || 'total').toUpperCase();
      const refSrc = (oiData.refPriceSource || 'ref').replace(/_/g, ' ').toUpperCase();
      const refText = oiData.refPrice ? `${refSrc}:${oiData.refPrice}` : `Spot:${oiData.spot}`;
      const exclText = oiData.excludedAtm ? ` [ATM ${oiData.excludedAtm} Excl]` : '';
      statusText = `${oiData.symbol} (${oiData.expiry}) • ${refText}${exclText} • R1:${oiData.r1} | S1:${oiData.s1} • [${modeLabel} • ${basisLabel}]`;
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

  function formatLevelOI(num) {
    if (!num) return '';
    const abs = Math.abs(num);
    const sign = num < 0 ? '-' : '';
    if (abs >= 1e7) return ` (${sign}${(abs / 1e7).toFixed(2)}Cr OI)`;
    if (abs >= 1e5) return ` (${sign}${(abs / 1e5).toFixed(2)}L OI)`;
    if (abs >= 1e3) return ` (${sign}${(abs / 1e3).toFixed(1)}k OI)`;
    return ` (${sign}${abs} OI)`;
  }

  function drawLevel(y, price, label, oiCount, color, w, h, isAtm = false) {
    if (typeof y !== 'number' || isNaN(y)) return;

    // Off-screen ABOVE current zoom
    if (y < 0) {
      ctx.font = '500 10.5px -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif';
      const txt = `^ ${label}: ${price}`;
      const bw = ctx.measureText(txt).width + 14;
      ctx.fillStyle = color;
      ctx.fillRect(w - bw - 10, 8, bw, 18);
      ctx.fillStyle = '#fff';
      ctx.fillText(txt, w - bw - 3, 20);
      return;
    }

    // Off-screen BELOW current zoom
    if (y > h) {
      ctx.font = '500 10.5px -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif';
      const txt = `v ${label}: ${price}`;
      const bw = ctx.measureText(txt).width + 14;
      ctx.fillStyle = color;
      ctx.fillRect(w - bw - 10, h - 26, bw, 18);
      ctx.fillStyle = '#fff';
      ctx.fillText(txt, w - bw - 3, h - 13);
      return;
    }

    // Horizontal line directly across the chart
    ctx.beginPath();
    ctx.setLineDash(isAtm ? [3, 4] : [6, 4]);
    ctx.strokeStyle = color;
    ctx.lineWidth = isAtm ? 1.2 : 1.6;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();

    // Left badge with Strike & OI count
    ctx.setLineDash([]);
    const oiLabel = isAtm ? ' [EXCL]' : (typeof oiCount === 'string' ? ` (${oiCount})` : formatLevelOI(oiCount));
    const leftText = `${label} - ${price}${oiLabel}`;
    ctx.font = '600 11px -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif';
    const tw = ctx.measureText(leftText).width;

    ctx.fillStyle = color;
    ctx.fillRect(10, y - 18, tw + 14, 18);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(leftText, 17, y - 5);

    // Right price pill flush with the Y-axis
    const rightText = String(price);
    const rw = ctx.measureText(rightText).width + 14;
    ctx.fillStyle = color;
    ctx.fillRect(w - rw, y - 9, rw, 18);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(rightText, w - rw + 7, y + 4);
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
        drawLevel(y, price, lvl.label, lvl.oi, lvl.color, overlay.width, overlay.height, !!lvl.isAtm);
      }
    }
  }

  render();
})();
