/* functions/_lib/fetchPrices.js
   ───────────────────────────────────────────────────────────────
   1. 優先用 Yahoo Finance 下載「調整後收盤價」(Adj Close)
      ‑ 已回溯計入股息與拆分 → 總報酬序列
   2. 若 yfinance API 失敗或回傳筆數 < 50
      → 再退回 Stooq (僅拆分調整，不含股息)
   3. 回傳統一格式：[{ date:'YYYY-MM-DD', close:123.45 }, ...]
*/

//////////////////// 共用工具 ////////////////////
const csv = t => t.trim().split('\n').slice(1).map(l => l.split(','));
const toEpoch = d => Math.floor(new Date(d + 'T00:00:00Z').getTime() / 1000);

//////////////////// 1️⃣  Yahoo Finance (Adj Close) ////////////////////
async function yahooAdj(tk, start, end) {
  const url =
    `https://query1.finance.yahoo.com/v7/finance/download/${tk}` +
    `?period1=${toEpoch(start)}&period2=${toEpoch(end) + 86400}` +
    `&interval=1d&events=history&includeAdjustedClose=true`;

  const r = await fetch(url);
  if (!r.ok) throw new Error('yahoo fetch');

  return csv(await r.text())
    .map(([d,,,, c,, a]) => ({ date: d, close: +(a || c) }))
    .filter(o => !isNaN(o.close));
}

//////////////////// 2️⃣  Stooq (Close) ////////////////////
async function stooq(tk) {
  const url = `https://stooq.com/q/d/l/?s=${tk.toLowerCase()}.us&i=d`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('stooq fetch');

  return csv(await r.text())
    .map(([d,,,, c]) => ({ date: d, close: +c }))
    .filter(o => !isNaN(o.close));
}

//////////////////// 對外主函式 ////////////////////
export async function fetchPrices(tickers, start, end) {
  const out = {};

  for (const tk of tickers) {
    try {
      /* 優先 yfinance */
      const rows = await yahooAdj(tk, start, end);
      if (rows.length < 50) throw new Error('yahoo too short');
      out[tk] = rows;
    } catch {
      /* 退回 Stooq（若仍失敗就讓外層報錯） */
      const rows = await stooq(tk);
      out[tk] = rows.filter(r => r.date >= start && r.date <= end);
    }
  }
  return out;
}
