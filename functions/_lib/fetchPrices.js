/* functions/_lib/fetchPrices.js
   1. 優先 Yahoo Adjusted Close
      ‑ 把 "null" 視為缺值但 **不會濾掉整列**，用前一筆價 forward-fill
      ‑ URL 先 encodeURIComponent()，確保 0050.TW、^TWII 等可下載
   2. 如果整份 CSV 解析後還是 0 行 → 再退回 Stooq
*/

const toEpoch = d => Math.floor(new Date(d + "T00:00:00Z").getTime() / 1000);
const csvRows = t => t.trim().split("\n").slice(1).map(l => l.split(","));  // skip header

/* ---------- Yahoo (Adj Close) ---------- */
async function yahooAdj(tk, from, to) {
  const url =
    `https://query1.finance.yahoo.com/v7/finance/download/` +
    `${encodeURIComponent(tk)}` +                         // ① URL-encode
    `?period1=${toEpoch(from)}&period2=${toEpoch(to) + 86400}` +
    `&interval=1d&events=history&includeAdjustedClose=true`;

  const r = await fetch(url);
  if (!r.ok) throw new Error("yahoo fetch");

  const rows = csvRows(await r.text());
  if (!rows.length) return [];

  /* ② 把 null 先標記為 undefined，稍後 forward-fill */
  const out = rows.map(([d,,,,close,,adj]) => {
    let v = adj === "null" ? NaN : +adj;
    if (!isFinite(v)) v = close === "null" ? NaN : +close;
    return { date: d, close: v };
  });

  /* ③ forward-fill 第一筆之後的 NaN */
  let last = null;
  for (const r of out) {
    if (isFinite(r.close)) last = r.close;
    else if (last !== null) r.close = last;
  }
  return out.filter(r => isFinite(r.close));            // 最前面的 NaN 仍濾掉
}

/* ---------- Stooq (備援) ---------- */
async function stooq(tk, from, to) {
  const url = `https://stooq.com/q/d/l/?s=${tk.toLowerCase()}.us&i=d`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("stooq");

  return csvRows(await r.text())
    .map(([d,,,,c]) => ({ date: d, close: +c }))
    .filter(r => !isNaN(r.close) && r.date >= from && r.date <= to);
}

/* ---------- 對外主函式 ---------- */
export async function fetchPrices(list, start, end) {
  const out = {};
  for (const tk of list) {
    try {
      const rows = await yahooAdj(tk, start, end);
      if (rows.length) { out[tk] = rows; continue; }
      throw "empty";
    } catch {
      out[tk] = await stooq(tk, start, end);             // 若仍抓不到就保持空陣列
    }
  }
  return out;
}
