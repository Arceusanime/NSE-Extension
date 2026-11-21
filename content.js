// content.js - Renders OI Levels directly onto the TradingView chart canvas
(() => {
  let oiData = null;
  let isVisible = false; // Default: OFF (only displays when explicitly enabled on this tab)
  let statusText = 'Initializing NSE OI...';

  // Configurable appearance settings with user-preferred defaults
  let displaySettings = {
    lineStyle: 'solid',       // 'solid' | 'dashed'
    labelPosition: 'right',   // 'right' | 'left'
    lineScope: 'candles'      // 'candles' (Session Candles Only) | 'today' | 'full'
  };

  // Algorithmic Trendline & Pattern Engine state
  let trendlinesVisible = false;
  let cachedTrendlineResult = null;
  let lastTrendlineCalcTime = 0;
  let lastTrendlineBarIndex = -1;
  let trendlineSettings = {
    sensitivity: 'conservative', // 'conservative' (3+ touches) | 'responsive' (2+ touches)
    showChannels: true,
    showConfluence: true
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
      // Invalidate trendline cache when new OI arrives to refresh confluence
      lastTrendlineCalcTime = 0;
    } else if (e.data?.type === 'OI_SETTINGS') {
      if (e.data.settings) {
        if (e.data.settings.lineStyle) displaySettings.lineStyle = e.data.settings.lineStyle;
        if (e.data.settings.labelPosition) displaySettings.labelPosition = e.data.settings.labelPosition;
        if (e.data.settings.lineScope) displaySettings.lineScope = e.data.settings.lineScope;
        if (e.data.settings.trendlineSensitivity) trendlineSettings.sensitivity = e.data.settings.trendlineSensitivity;
        if (e.data.settings.showChannels !== undefined) trendlineSettings.showChannels = e.data.settings.showChannels !== false;
        if (e.data.settings.showConfluence !== undefined) trendlineSettings.showConfluence = e.data.settings.showConfluence !== false;
        lastTrendlineCalcTime = 0;
      }
    } else if (e.data?.type === 'OI_STATUS') {
      oiData = null;
      statusText = e.data.text;
    } else if (e.data?.type === 'OI_VISIBILITY') {
      isVisible = e.data.visible;
    } else if (e.data?.type === 'TRENDLINES_VISIBILITY') {
      trendlinesVisible = e.data.visible === true;
      if (trendlinesVisible) lastTrendlineCalcTime = 0; // Force immediate recalculation
    } else if (e.data?.type === 'RECALCULATE_TRENDLINES') {
      lastTrendlineCalcTime = 0;
    }
  });

  const overlay = document.createElement('canvas');
  overlay.id = 'nse-oi-overlay';
  overlay.style.position = 'fixed';
  overlay.style.pointerEvents = 'none';
  overlay.style.zIndex = '99999';
  if (document.body) {
    document.body.appendChild(overlay);
  } else {
    window.addEventListener('DOMContentLoaded', () => document.body?.appendChild(overlay), { once: true });
  }
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

  function getTradingViewContext() {
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
      if (!model) return null;

      const mainSeries = model.mainSeries?.() || model._mainSeries;
      const timeScale = model.timeScale?.() || widget.timeScale?.();
      const bars = mainSeries?.bars?.() || mainSeries?._bars;
      if (!mainSeries || !timeScale || !bars) return null;

      const lastIndex = typeof bars.lastIndex === 'function' ? bars.lastIndex() : bars.lastIndex;
      if (lastIndex == null || isNaN(lastIndex)) return null;

      return { widget, model, mainSeries, timeScale, bars, lastIndex };
    } catch (e) {
      return null;
    }
  }

  function getBarOHLC(bar) {
    if (!bar) return null;
    if (Array.isArray(bar)) {
      return {
        time: bar[0] > 1e11 ? bar[0] : bar[0] * 1000,
        open: Number(bar[1]),
        high: Number(bar[2]),
        low: Number(bar[3]),
        close: Number(bar[4]),
        volume: Number(bar[5] || 0)
      };
    }
    if (Array.isArray(bar.value)) {
      return {
        time: bar.value[0] > 1e11 ? bar.value[0] : bar.value[0] * 1000,
        open: Number(bar.value[1]),
        high: Number(bar.value[2]),
        low: Number(bar.value[3]),
        close: Number(bar.value[4]),
        volume: Number(bar.value[5] || 0)
      };
    }
    const open = typeof bar.open === 'function' ? bar.open() : (bar.open ?? bar.o);
    const high = typeof bar.high === 'function' ? bar.high() : (bar.high ?? bar.h);
    const low = typeof bar.low === 'function' ? bar.low() : (bar.low ?? bar.l);
    const close = typeof bar.close === 'function' ? bar.close() : (bar.close ?? bar.c);
    const time = typeof bar.time === 'function' ? bar.time() : (bar.time ?? bar.t);

    if (open != null && high != null && low != null && close != null &&
        !isNaN(Number(open)) && !isNaN(Number(high)) && !isNaN(Number(low)) && !isNaN(Number(close))) {
      return {
        time: typeof time === 'number' ? (time > 1e11 ? time : time * 1000) : 0,
        open: Number(open),
        high: Number(high),
        low: Number(low),
        close: Number(close),
        volume: Number(bar.volume ?? bar.v ?? 0)
      };
    }
    return null;
  }

  // Calculate the horizontal pixel range (startX to endX) for the current trading day's session
  function getExactDayRange() {
    try {
      const tvCtx = getTradingViewContext();
      if (!tvCtx) return null;
      const { bars, timeScale, lastIndex } = tvCtx;

      const getBarTime = (bar) => {
        if (!bar) return null;
        const ohlc = getBarOHLC(bar);
        return ohlc ? ohlc.time : null;
      };

      const lastBar = typeof bars.valueAt === 'function' ? bars.valueAt(lastIndex) : (bars[lastIndex] || null);
      const lastTime = getBarTime(lastBar);
      if (!lastTime) return null;

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
        const startCoord = timeScale.indexToCoordinate(startBarIndex);
        const endCoord = timeScale.indexToCoordinate(lastIndex);

        let barSpacing = 6;
        if (typeof timeScale.barSpacing === 'function') {
          barSpacing = timeScale.barSpacing();
        } else if (typeof timeScale._barSpacing === 'number') {
          barSpacing = timeScale._barSpacing;
        }
        const halfBar = Math.max(2, Math.round(barSpacing / 2));

        if (typeof startCoord === 'number' && !isNaN(startCoord) &&
            typeof endCoord === 'number' && !isNaN(endCoord)) {
          return {
            startX: Math.max(0, startCoord - halfBar),
            endX: endCoord + halfBar + 2
          };
        }
      }
    } catch (e) {}
    return null;
  }

  // --- ALGORITHMIC TRENDLINE & PATTERN CALCULATION ENGINE ---
  function computeTrendlines(tvCtx) {
    if (!tvCtx) return null;
    const { bars, lastIndex } = tvCtx;

    // 1. Collect recent session bars (up to 200 bars)
    const firstIndex = typeof bars.firstIndex === 'function' ? bars.firstIndex() : 0;
    const minBound = Math.max(firstIndex, lastIndex - 200);

    const barsList = [];
    for (let i = minBound; i <= lastIndex; i++) {
      const rawBar = typeof bars.valueAt === 'function' ? bars.valueAt(i) : bars[i];
      const ohlc = getBarOHLC(rawBar);
      if (ohlc) {
        barsList.push({
          barIndex: i,
          listIdx: barsList.length,
          ...ohlc
        });
      }
    }

    if (barsList.length < 15) return null;

    // 2. Compute 14-period Average True Range (ATR)
    let trSum = 0;
    const nAtr = Math.min(14, barsList.length - 1);
    for (let i = barsList.length - nAtr; i < barsList.length; i++) {
      const cur = barsList[i];
      const prev = barsList[i - 1];
      const tr = Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close)
      );
      trSum += tr;
    }
    const atr = Math.max(0.5, trSum / nAtr);

    // 3. Adaptive Swing Pivot Detection
    const isResp = trendlineSettings.sensitivity === 'responsive';
    const L = isResp ? 3 : 4;
    const R = isResp ? 2 : 3;

    const pivotHighs = [];
    const pivotLows = [];

    for (let i = L; i < barsList.length - R; i++) {
      const cur = barsList[i];
      let isHigh = true;
      let isLow = true;

      for (let j = i - L; j <= i + R; j++) {
        if (j === i) continue;
        if (barsList[j].high > cur.high) isHigh = false;
        if (barsList[j].low < cur.low) isLow = false;
      }

      if (isHigh) {
        let minSurrounding = Infinity;
        for (let j = i - L; j <= i + R; j++) minSurrounding = Math.min(minSurrounding, barsList[j].low);
        if (cur.high - minSurrounding >= 0.4 * atr) {
          pivotHighs.push({ ...cur, listIdx: i });
        }
      }
      if (isLow) {
        let maxSurrounding = -Infinity;
        for (let j = i - L; j <= i + R; j++) maxSurrounding = Math.max(maxSurrounding, barsList[j].high);
        if (maxSurrounding - cur.low >= 0.4 * atr) {
          pivotLows.push({ ...cur, listIdx: i });
        }
      }
    }

    // 4. Candidate Generation & Scoring for Resistance Trendlines (from Pivot Highs)
    let bestResistance = null;
    let maxResScore = -Infinity;

    for (let a = 0; a < pivotHighs.length; a++) {
      for (let b = a + 1; b < pivotHighs.length; b++) {
        const p1 = pivotHighs[a];
        const p2 = pivotHighs[b];
        const dx = p2.listIdx - p1.listIdx;
        if (dx < 4) continue;

        const m = (p2.high - p1.high) / dx;
        if (m > 0.15 * atr) continue; // Reject steep ascending resistance

        let score = 100;
        const touches = [{ barIndex: p1.barIndex, listIdx: p1.listIdx, price: p1.high, time: p1.time }];
        let lastTouchIdx = p1.listIdx;
        let violations = 0;

        for (let k = p1.listIdx; k < barsList.length; k++) {
          const bar = barsList[k];
          const expectedPrice = p1.high + m * (k - p1.listIdx);

          if (bar.close > expectedPrice + 0.25 * atr) {
            violations++;
            score -= 60;
          }

          const dist = Math.abs(bar.high - expectedPrice);
          if (dist <= 0.18 * atr && bar.close <= expectedPrice + 0.08 * atr) {
            if (k - lastTouchIdx >= 3) {
              touches.push({ barIndex: bar.barIndex, listIdx: k, price: bar.high, time: bar.time });
              lastTouchIdx = k;
              score += 35;
            }
          }
        }

        if (violations > 1) continue;
        if (touches.length < 2) continue;
        if (!isResp && touches.length < 3) score -= 30;

        if (lastTouchIdx >= barsList.length * 0.6) score += 20;

        if (score > maxResScore) {
          maxResScore = score;
          bestResistance = {
            type: 'resistance',
            p1,
            p2,
            m,
            score,
            touches,
            startIndex: p1.barIndex,
            startListIdx: p1.listIdx,
            startPrice: p1.high,
            endIndex: lastIndex,
            currentLinePrice: p1.high + m * (barsList.length - 1 - p1.listIdx),
            projectedPrice: p1.high + m * (barsList.length + 3 - p1.listIdx)
          };
        }
      }
    }

    // 5. Candidate Generation & Scoring for Support Trendlines (from Pivot Lows)
    let bestSupport = null;
    let maxSupScore = -Infinity;

    for (let a = 0; a < pivotLows.length; a++) {
      for (let b = a + 1; b < pivotLows.length; b++) {
        const p1 = pivotLows[a];
        const p2 = pivotLows[b];
        const dx = p2.listIdx - p1.listIdx;
        if (dx < 4) continue;

        const m = (p2.low - p1.low) / dx;
        if (m < -0.15 * atr) continue; // Reject steep descending support

        let score = 100;
        const touches = [{ barIndex: p1.barIndex, listIdx: p1.listIdx, price: p1.low, time: p1.time }];
        let lastTouchIdx = p1.listIdx;
        let violations = 0;

        for (let k = p1.listIdx; k < barsList.length; k++) {
          const bar = barsList[k];
          const expectedPrice = p1.low + m * (k - p1.listIdx);

          if (bar.close < expectedPrice - 0.25 * atr) {
            violations++;
            score -= 60;
          }

          const dist = Math.abs(bar.low - expectedPrice);
          if (dist <= 0.18 * atr && bar.close >= expectedPrice - 0.08 * atr) {
            if (k - lastTouchIdx >= 3) {
              touches.push({ barIndex: bar.barIndex, listIdx: k, price: bar.low, time: bar.time });
              lastTouchIdx = k;
              score += 35;
            }
          }
        }

        if (violations > 1) continue;
        if (touches.length < 2) continue;
        if (!isResp && touches.length < 3) score -= 30;

        if (lastTouchIdx >= barsList.length * 0.6) score += 20;

        if (score > maxSupScore) {
          maxSupScore = score;
          bestSupport = {
            type: 'support',
            p1,
            p2,
            m,
            score,
            touches,
            startIndex: p1.barIndex,
            startListIdx: p1.listIdx,
            startPrice: p1.low,
            endIndex: lastIndex,
            currentLinePrice: p1.low + m * (barsList.length - 1 - p1.listIdx),
            projectedPrice: p1.low + m * (barsList.length + 3 - p1.listIdx)
          };
        }
      }
    }

    // 6. Pattern Classification
    let pattern = null;
    if (bestResistance && bestSupport) {
      const mr = bestResistance.m;
      const ms = bestSupport.m;
      const slopeDiff = Math.abs(mr - ms);
      const avgSlopeMagnitude = (Math.abs(mr) + Math.abs(ms)) / 2 || 1;

      if (mr > 0 && ms > 0 && slopeDiff <= 0.35 * avgSlopeMagnitude) {
        pattern = 'Ascending Channel';
      } else if (mr < 0 && ms < 0 && slopeDiff <= 0.35 * avgSlopeMagnitude) {
        pattern = 'Descending Channel';
      } else if (mr < 0 && ms > 0) {
        pattern = 'Symmetrical Triangle';
      } else if (Math.abs(mr) < 0.03 * atr && ms > 0) {
        pattern = 'Ascending Triangle';
      } else if (mr < 0 && Math.abs(ms) < 0.03 * atr) {
        pattern = 'Descending Triangle';
      } else if (mr < 0 && ms < 0 && mr < ms) {
        pattern = 'Falling Wedge';
      } else if (mr > 0 && ms > 0 && ms > mr) {
        pattern = 'Rising Wedge';
      }
    }

    // 7. OI Confluence Detection
    const confluencePoints = [];
    if (trendlineSettings.showConfluence && oiData) {
      const oiLevels = [
        { label: 'R3', price: Number(oiData.r3), color: '#ef5350' },
        { label: 'R2', price: Number(oiData.r2), color: '#ef5350' },
        { label: 'R1', price: Number(oiData.r1), color: '#ff7043' },
        { label: 'ATM', price: Number(oiData.excludedAtm || oiData.atmStrike), color: '#787b86' },
        { label: 'S1', price: Number(oiData.s1), color: '#26a69a' },
        { label: 'S2', price: Number(oiData.s2), color: '#26a69a' },
        { label: 'S3', price: Number(oiData.s3), color: '#66bb6a' }
      ].filter((l) => l.price && !isNaN(l.price));

      const activeLines = [bestResistance, bestSupport].filter(Boolean);

      for (const line of activeLines) {
        for (let offset = -2; offset <= 5; offset++) {
          const testBarIdx = lastIndex + offset;
          const listOffset = (barsList.length - 1) + offset;
          const predictedPrice = line.startPrice + line.m * (listOffset - line.startListIdx);

          for (const lvl of oiLevels) {
            if (Math.abs(predictedPrice - lvl.price) <= 0.25 * atr) {
              confluencePoints.push({
                barIndex: testBarIdx,
                price: lvl.price,
                label: lvl.label,
                trendlineType: line.type,
                color: lvl.color
              });
              break;
            }
          }
        }
      }
    }

    return {
      bestResistance: maxResScore >= 40 ? bestResistance : null,
      bestSupport: maxSupScore >= 40 ? bestSupport : null,
      pattern,
      confluencePoints,
      atr,
      lastIndex,
      barsCount: barsList.length
    };
  }

  // --- 60 FPS VECTOR CANVAS RENDERER FOR TRENDLINES & PATTERNS ---
  function drawTrendlinesCanvas(ctx, tlResult, w, h, timeScale, priceToY) {
    if (!tlResult) return;
    const { bestResistance, bestSupport, pattern, confluencePoints } = tlResult;

    // 1. Draw Support Trendline (Teal)
    let supCoords = null;
    if (bestSupport) {
      const x1 = timeScale.indexToCoordinate(bestSupport.startIndex);
      const y1 = priceToY(bestSupport.startPrice);
      const x2 = timeScale.indexToCoordinate(bestSupport.endIndex);
      const y2 = priceToY(bestSupport.currentLinePrice);

      if (x1 != null && y1 != null && x2 != null && y2 != null) {
        supCoords = { x1, y1, x2, y2 };

        // Solid line between swing pivots & current candle
        ctx.beginPath();
        ctx.strokeStyle = '#26a69a';
        ctx.lineWidth = 1.8;
        ctx.setLineDash([]);
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        // Forward projection dashed ray (+4 candles forward)
        const xProj = timeScale.indexToCoordinate(bestSupport.endIndex + 4);
        const yProj = priceToY(bestSupport.projectedPrice);
        if (xProj != null && yProj != null) {
          ctx.beginPath();
          ctx.setLineDash([4, 4]);
          ctx.moveTo(x2, y2);
          ctx.lineTo(xProj, yProj);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // Draw touch indicator circles on verified pivot touches
        for (const t of bestSupport.touches) {
          const tx = timeScale.indexToCoordinate(t.barIndex);
          const ty = priceToY(t.price);
          if (tx != null && ty != null && tx >= 0 && tx <= w && ty >= 0 && ty <= h) {
            ctx.beginPath();
            ctx.arc(tx, ty, 4, 0, Math.PI * 2);
            ctx.fillStyle = '#26a69a';
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.2;
            ctx.stroke();
          }
        }

        // Pill badge at the line tip
        ctx.font = '600 10.5px -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif';
        const supText = `SUP TL (${bestSupport.touches.length}T)`;
        const bw = ctx.measureText(supText).width + 12;
        const bx = Math.min(x2 + 4, w - bw - 4);
        ctx.fillStyle = '#26a69a';
        ctx.fillRect(bx, y2 - 9, bw, 18);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(supText, bx + 6, y2 + 4);
      }
    }

    // 2. Draw Resistance Trendline (Coral Red)
    let resCoords = null;
    if (bestResistance) {
      const x1 = timeScale.indexToCoordinate(bestResistance.startIndex);
      const y1 = priceToY(bestResistance.startPrice);
      const x2 = timeScale.indexToCoordinate(bestResistance.endIndex);
      const y2 = priceToY(bestResistance.currentLinePrice);

      if (x1 != null && y1 != null && x2 != null && y2 != null) {
        resCoords = { x1, y1, x2, y2 };

        ctx.beginPath();
        ctx.strokeStyle = '#ff7043';
        ctx.lineWidth = 1.8;
        ctx.setLineDash([]);
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        const xProj = timeScale.indexToCoordinate(bestResistance.endIndex + 4);
        const yProj = priceToY(bestResistance.projectedPrice);
        if (xProj != null && yProj != null) {
          ctx.beginPath();
          ctx.setLineDash([4, 4]);
          ctx.moveTo(x2, y2);
          ctx.lineTo(xProj, yProj);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        for (const t of bestResistance.touches) {
          const tx = timeScale.indexToCoordinate(t.barIndex);
          const ty = priceToY(t.price);
          if (tx != null && ty != null && tx >= 0 && tx <= w && ty >= 0 && ty <= h) {
            ctx.beginPath();
            ctx.arc(tx, ty, 4, 0, Math.PI * 2);
            ctx.fillStyle = '#ff7043';
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.2;
            ctx.stroke();
          }
        }

        ctx.font = '600 10.5px -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif';
        const resText = `RES TL (${bestResistance.touches.length}T)`;
        const bw = ctx.measureText(resText).width + 12;
        const bx = Math.min(x2 + 4, w - bw - 4);
        ctx.fillStyle = '#ff7043';
        ctx.fillRect(bx, y2 - 9, bw, 18);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(resText, bx + 6, y2 + 4);
      }
    }

    // 3. Pattern Shading & Badge (Channels, Triangles, Wedges)
    if (pattern && trendlineSettings.showChannels && supCoords && resCoords) {
      ctx.beginPath();
      ctx.moveTo(supCoords.x1, supCoords.y1);
      ctx.lineTo(supCoords.x2, supCoords.y2);
      ctx.lineTo(resCoords.x2, resCoords.y2);
      ctx.lineTo(resCoords.x1, resCoords.y1);
      ctx.closePath();
      ctx.fillStyle = 'rgba(41, 98, 255, 0.04)';
      ctx.fill();

      const midX = (Math.max(supCoords.x1, resCoords.x1) + Math.min(supCoords.x2, resCoords.x2)) / 2;
      const midY = (supCoords.y2 + resCoords.y2) / 2;
      if (midX > 50 && midX < w - 100 && midY > 30 && midY < h - 30) {
        ctx.font = '700 11px -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif';
        const patText = `📐 ${pattern.toUpperCase()}`;
        const pw = ctx.measureText(patText).width + 16;
        ctx.fillStyle = 'rgba(19, 23, 34, 0.9)';
        ctx.fillRect(midX - pw / 2, midY - 11, pw, 22);
        ctx.strokeStyle = '#2962ff';
        ctx.lineWidth = 1.2;
        ctx.strokeRect(midX - pw / 2, midY - 11, pw, 22);
        ctx.fillStyle = '#29b6f6';
        ctx.fillText(patText, midX - pw / 2 + 8, midY + 4);
      }
    }

    // 4. Confluence Badges (Trendline + OI S&R Intersections)
    if (confluencePoints && confluencePoints.length > 0 && trendlineSettings.showConfluence) {
      for (const conf of confluencePoints) {
        const cx = timeScale.indexToCoordinate(conf.barIndex);
        const cy = priceToY(conf.price);
        if (cx != null && cy != null && cx >= 0 && cx <= w && cy >= 0 && cy <= h) {
          ctx.beginPath();
          ctx.arc(cx, cy, 6, 0, Math.PI * 2);
          ctx.strokeStyle = '#ffeb3b';
          ctx.lineWidth = 2;
          ctx.stroke();

          ctx.font = '700 10.5px -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif';
          const confText = `⚡ CONFLUENCE: ${conf.trendlineType === 'resistance' ? 'RES' : 'SUP'} + ${conf.label} (${conf.price})`;
          const cw = ctx.measureText(confText).width + 16;
          const cbx = Math.min(cx + 8, w - cw - 6);
          const cby = Math.max(16, Math.min(cy - 10, h - 24));

          ctx.fillStyle = 'rgba(19, 23, 34, 0.95)';
          ctx.fillRect(cbx, cby, cw, 20);
          ctx.strokeStyle = '#ffeb3b';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(cbx, cby, cw, 20);
          ctx.fillStyle = '#ffeb3b';
          ctx.fillText(confText, cbx + 8, cby + 14);
        }
      }
    }
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

  function drawLevel(y, price, label, oiCount, color, w, h, isAtm = false, lineStartX = 0, lineEndX = w) {
    if (typeof y !== 'number' || isNaN(y)) return;

    const lineStyle = displaySettings.lineStyle || 'solid';
    const labelPos = displaySettings.labelPosition || 'right';
    const lineScope = displaySettings.lineScope || 'candles';

    // Format OI badge text (including ATM reference line)
    let oiLabel = '';
    if (typeof oiCount === 'string' && oiCount.trim()) {
      oiLabel = ` (${oiCount.trim()})`;
    } else if (oiCount !== null && oiCount !== undefined && oiCount !== '' && !isNaN(oiCount)) {
      oiLabel = formatLevelOI(oiCount);
    }
    const fullBadgeText = `${label} - ${price}${oiLabel}`;
    ctx.font = '600 11px -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif';
    const bw = ctx.measureText(fullBadgeText).width + 16;

    // Off-screen ABOVE current zoom
    if (y < 0) {
      ctx.font = '500 10.5px -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif';
      const txt = `^ ${label}: ${price}`;
      const offBw = ctx.measureText(txt).width + 14;
      const bx = labelPos === 'left' ? 10 : (w - offBw - 10);
      ctx.fillStyle = color;
      ctx.fillRect(bx, 8, offBw, 18);
      ctx.fillStyle = '#fff';
      ctx.fillText(txt, bx + 7, 20);
      return;
    }

    // Off-screen BELOW current zoom
    if (y > h) {
      ctx.font = '500 10.5px -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif';
      const txt = `v ${label}: ${price}`;
      const offBw = ctx.measureText(txt).width + 14;
      const bx = labelPos === 'left' ? 10 : (w - offBw - 10);
      ctx.fillStyle = color;
      ctx.fillRect(bx, h - 26, offBw, 18);
      ctx.fillStyle = '#fff';
      ctx.fillText(txt, bx + 7, h - 13);
      return;
    }

    // Determine badge positioning and line end coordinate
    let badgeX;
    let actualLineEndX = lineEndX;

    if (labelPos === 'right') {
      if (lineScope === 'candles' && lineEndX < w - 16) {
        // Stop line at end of session and attach badge directly to the line end
        badgeX = lineEndX + 4;
        if (badgeX + bw > w - 4) {
          badgeX = w - bw - 4;
          actualLineEndX = Math.min(lineEndX, badgeX);
        } else {
          actualLineEndX = badgeX;
        }
      } else {
        // Line extends to right edge; badge is flush on right
        badgeX = w - bw - 4;
      }
    } else {
      // Left-side badge
      badgeX = Math.max(10, lineStartX);
    }

    // Horizontal line: solid (or dashed if configured / ATM)
    ctx.beginPath();
    if (lineStyle === 'dashed' || (isAtm && lineStyle !== 'solid')) {
      ctx.setLineDash(isAtm ? [3, 4] : [6, 4]);
    } else {
      ctx.setLineDash([]); // SOLID LINE (default)
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = isAtm ? 1.4 : 1.8;

    // Draw line from lineStartX to actualLineEndX
    ctx.moveTo(lineStartX, y);
    ctx.lineTo(actualLineEndX, y);
    ctx.stroke();

    // Reset dash for badge rendering
    ctx.setLineDash([]);

    if (labelPos === 'right') {
      ctx.fillStyle = color;
      ctx.fillRect(badgeX, y - 9, bw, 19);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(fullBadgeText, badgeX + 8, y + 4.5);
    } else {
      // Left-side badge
      ctx.fillStyle = color;
      ctx.fillRect(badgeX, y - 18, bw, 18);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(fullBadgeText, badgeX + 7, y - 5);

      // Price pill at right end of the line
      const rightText = String(price);
      const rw = ctx.measureText(rightText).width + 14;
      let rx = (lineScope === 'candles' && lineEndX < w - 16) ? lineEndX + 4 : (w - rw);
      if (rx + rw > w - 4) rx = w - rw - 4;
      ctx.fillStyle = color;
      ctx.fillRect(rx, y - 9, rw, 18);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(rightText, rx + 7, y + 4);
    }
  }

  function render() {
    requestAnimationFrame(render);

    const target = findMainChartCanvas();
    if (!target || (!isVisible && !trendlinesVisible)) {
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

    const priceToY = getExactPriceToY();
    const tvCtx = getTradingViewContext();

    // 1. Render Algorithmic Trendlines, Channels & Confluence if enabled
    if (trendlinesVisible && tvCtx && priceToY) {
      const now = Date.now();
      if (!cachedTrendlineResult || (now - lastTrendlineCalcTime > 2500) || (tvCtx.lastIndex !== lastTrendlineBarIndex)) {
        cachedTrendlineResult = computeTrendlines(tvCtx);
        lastTrendlineCalcTime = now;
        lastTrendlineBarIndex = tvCtx.lastIndex;
      }
      if (cachedTrendlineResult) {
        drawTrendlinesCanvas(ctx, cachedTrendlineResult, overlay.width, overlay.height, tvCtx.timeScale, priceToY);
      }
    }

    // 2. Render OI S&R Levels & Status Pill if enabled
    if (isVisible) {
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

      if (oiData && priceToY) {
        // Determine line horizontal boundaries (startX to endX)
        let lineStartX = 0;
        let lineEndX = overlay.width;

        if (displaySettings.lineScope === 'candles' || displaySettings.lineScope === 'today') {
          const range = getExactDayRange();
          if (range) {
            // If the day's session is completely off-screen, skip rendering levels
            if (range.startX >= overlay.width || range.endX <= 0) return;

            lineStartX = Math.max(0, range.startX);
            if (displaySettings.lineScope === 'candles') {
              lineEndX = Math.min(overlay.width, range.endX);
            }
          }
        }

        // Directly plot the 3 Resistance and 3 Support levels
        const levels = [
          { price: oiData.r3, oi: oiData.topCalls?.[2]?.scoreFormatted || oiData.topCalls?.[2]?.oi, label: 'R3', color: '#ef5350' },
          { price: oiData.r2, oi: oiData.topCalls?.[1]?.scoreFormatted || oiData.topCalls?.[1]?.oi, label: 'R2', color: '#ef5350' },
          { price: oiData.r1, oi: oiData.topCalls?.[0]?.scoreFormatted || oiData.topCalls?.[0]?.oi, label: 'R1', color: '#ff7043' },
          { price: oiData.s1, oi: oiData.topPuts?.[0]?.scoreFormatted  || oiData.topPuts?.[0]?.oi,  label: 'S1', color: '#26a69a' },
          { price: oiData.s2, oi: oiData.topPuts?.[1]?.scoreFormatted  || oiData.topPuts?.[1]?.oi,  label: 'S2', color: '#26a69a' },
          { price: oiData.s3, oi: oiData.topPuts?.[2]?.scoreFormatted  || oiData.topPuts?.[2]?.oi,  label: 'S3', color: '#66bb6a' }
        ];

        // Only for pre-market open, plot the exact unrounded price.
        // For other options (prev_open, today_open, spot), use the rounded strike (how it was earlier).
        const isPreOpen = oiData.refPriceSource === 'pre_open';
        const atmLevelPrice = isPreOpen
          ? (Number(oiData.refPrice) || Number(oiData.excludedAtm || oiData.atmStrike))
          : Number(oiData.excludedAtm || oiData.atmStrike || (oiData.refPrice ? Math.round(Number(oiData.refPrice) / 10) * 10 : null));

        if (atmLevelPrice && !isNaN(atmLevelPrice)) {
          const atmOiText = oiData.atmOi
            ? (oiData.basis === 'change' && !oiData.atmOi.startsWith('Δ') ? `Δ ${oiData.atmOi}` : oiData.atmOi)
            : '';
          levels.push({
            price: atmLevelPrice,
            oi: atmOiText,
            label: 'ATM REF',
            color: '#787b86',
            isAtm: true
          });
        }

        for (const lvl of levels) {
          const price = Number(lvl.price);
          if (price && !isNaN(price)) {
            const y = priceToY(price);
            drawLevel(y, price, lvl.label, lvl.oi, lvl.color, overlay.width, overlay.height, !!lvl.isAtm, lineStartX, lineEndX);
          }
        }
      }
    }
  }

  render();
})();
