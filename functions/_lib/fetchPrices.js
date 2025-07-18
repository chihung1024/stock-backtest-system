/* functions/_lib/fetchPrices.js
   1️⃣ 先抓 Stooq（已含拆分調整）
   2️⃣ 再抓 Yahoo「Dividends」CSV，把現金股息轉成再投入股數
   3️⃣ 若 Stooq 整檔失敗 → 改抓 Yahoo Adj Close 作為備援

   回傳格式：[{ date:'yyyy-mm-dd', close:123.45 }, …] ＝「已含股息再投入」的總報酬價
*/

/* ---------- 共用工具 ---------- */
function toEpoch(d) { return Math.floor(new Date(d + 'T00:00:00Z').getTime() / 1000); }
const parseCSV = txt => txt.trim().split('\n').slice(1).map(l => l.split(','));

/* ---------- 下載 Stooq 收盤價 ---------- */
async function fetchStooq(tk) {
  const url = `https://stooq.com/q/d/l/?s=${tk.toLowerCase()}.us&i=d`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('stooq fetch');
  return parseCSV(await res.text())
    .map(([d,,,,c]) => ({ date:d, close:+c }))
    .filter(r => !isNaN(r.close));
}

/* ---------- 下載 Yahoo 股息事件 ---------- */
async function fetchYahooDivs(tk, start, end) {
  const p1 = toEpoch(start), p2 = toEpoch(end) + 86400;
  const url = `https://query1.finance.yahoo.com/v7/finance/download/${tk}` +
              `?period1=${p1}&period2=${p2}&interval=1d&events=div`;
  const res = await fetch(url);
  if (!res.ok) return [];                 // 沒配息也屬正常
  return parseCSV(await res.text())
    .map(([d,val]) => ({ date:d, cash:+val }))
    .filter(r => !isNaN(r.cash));
}

/* ---------- 把 Stooq Close → 含息總報酬 ---------- */
function applyDividends(rows, divs) {
  if (!rows.length) return rows;
  const divMap = new Map(divs.map(d => [d.date, d.cash]));
  let shares = 1;                                   // 一開始 1 股
  let equity = rows[0].close;                       // 初始權益
  const out = [{ date: rows[0].date, close: equity }];

  for (let i = 1; i < rows.length; i++) {
    const { date, close } = rows[i];
    if (divMap.has(date)) shares += divMap.get(date) / close;   // DRIP
    equity = shares * close;
    out.push({ date, close:+equity.toFixed(6) });
  }
  return out;
}

/* ---------- Yahoo Adj Close 備援 ---------- */
async function fetchYahooAdj(tk, start, end) {
  const p1 = toEpoch(start), p2 = toEpoch(end) + 86400;
  const url = `https://query1.finance.yahoo.com/v7/finance/download/${tk}` +
              `?period1=${p1}&period2=${p2}` +
              `&interval=1d&events=history&includeAdjustedClose=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('yahoo adj fetch');
  return parseCSV(await res.text())
    .map(([d,,,,c,,a]) => ({ date:d, close:+(a||c) }))
    .filter(r => !isNaN(r.close));
}

/* ---------- 對外主函式 ---------- */
export async function fetchPrices(tickers, start, end) {
  const out = {};
  for (const tk of tickers) {
    try {
      // ① Stooq 收盤價 + Yahoo 股息
      const base = await fetchStooq(tk);
      const divs = await fetchYahooDivs(tk, start, end);
      out[tk] = applyDividends(
        base.filter(r => r.date >= start && r.date <= end),
        divs
      );
    } catch {
      // ② 完全失敗 → Yahoo Adj Close
      out[tk] = await fetchYahooAdj(tk, start, end);
    }
  }
  return out;
}
