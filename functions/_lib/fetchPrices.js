/* functions/_lib/fetchPrices.js
   -------------------------------------------------------------
   · 先抓 Yahoo Adjusted Close（含股息再投入）
   · 若 Yahoo 回傳「完全空」或「全部收盤價 ≤ 0」→ 視為無效，再退回 Stooq
   · Stooq 成功就用 Close（僅拆分調整，不含股息）
   · 回傳格式統一：[{ date:'YYYY-MM-DD', close:123.45 }, ...]
*/

//////////////////// 共用工具 ////////////////////
const csv     = t => t.trim().split('\n').slice(1).map(l => l.split(','));
const toEpoch = d => Math.floor(new Date(d + 'T00:00:00Z').getTime() / 1000);

//////////////////// 1️⃣  Yahoo Finance (Adj Close) ////////////////////
async function yahooAdj(tk, start, end) {
  const url = `https://query1.finance.yahoo.com/v7/finance/download/${tk}` +
              `?period1=${toEpoch(start)}&period2=${toEpoch(end) + 86400}` +
              `&interval=1d&events=history&includeAdjustedClose=true`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('yahoo fetch');

  return csv(await r.text())
    .map(([d,,,, c,, a]) => ({ date: d, close: +(a || c) }))
    .filter(o => !isNaN(o.close));
}

//////////////////// 2️⃣  Stooq (Close) ////////////////////
async function stooq(tk, start, end) {
  const url = `https://stooq.com/q/d/l/?s=${tk.toLowerCase()}.us&i=d`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('stooq fetch');

  return csv(await r.text())
    .map(([d,,,, c]) => ({ date: d, close: +c }))
    .filter(o => !isNaN(o.close) && o.date >= start && o.date <= end);
}

//////////////////// 對外主函式 ////////////////////
export async function fetchPrices(tickers, start, end) {
  const out = {};

  for (const tk of tickers) {
    try {
      // --- 優先嘗試 Yahoo ---
      const rows = await yahooAdj(tk, start, end);

      // 若完全沒有有效價格 (空陣列 或 全部 ≤ 0) 視為失敗
      const hasPositive = rows.some(r => r.close > 0);
      if (!hasPositive) throw new Error('yahoo invalid');

      out[tk] = rows;
    } catch {
      // --- 退回 Stooq ---
      out[tk] = await stooq(tk, start, end);
    }
  }
  return out;
}
