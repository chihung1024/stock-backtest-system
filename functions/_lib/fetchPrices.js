/* functions/_lib/fetchPrices.js
   先嘗試 Stooq；若失敗或資料為空，改抓 Yahoo Finance。
   兩者皆回傳格式：
     [{ date: '2020-01-02', close: 300.12 }, ...]
*/
function parseStooqCSV(text) {
  const lines = text.trim().split('\n');
  lines.shift();                       // 去掉欄名
  return lines
    .map(l => {
      const [date, , , , close] = l.split(',');
      const v = parseFloat(close);
      return isNaN(v) ? null : { date, close: v };
    })
    .filter(Boolean);
}

async function fetchFromStooq(ticker) {
  const url = `https://stooq.com/q/d/l/?s=${ticker.toLowerCase()}.us&i=d`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('stooq fetch error');
  const rows = parseStooqCSV(await resp.text());
  if (!rows.length) throw new Error('stooq empty');
  return rows;
}

/* -------- Yahoo Finance 備援 -------- */
function toEpoch(dateStr) {
  return Math.floor(new Date(dateStr + 'T00:00:00Z').getTime() / 1000);
}
function parseYFCsv(text) {
  const lines = text.trim().split('\n');
  lines.shift();
  return lines
    .map(l => {
      const [date,,,, close,, adj] = l.split(',');
      const v = parseFloat(adj || close);
      return isNaN(v) ? null : { date, close: v };
    })
    .filter(Boolean);
}
async function fetchFromYahoo(ticker, start, end) {
  const p1 = toEpoch(start);
  const p2 = toEpoch(end) + 86400;     // 讓結束日包含當天
  const url = `https://query1.finance.yahoo.com/v7/finance/download/${ticker}` +
              `?period1=${p1}&period2=${p2}` +
              `&interval=1d&events=history&includeAdjustedClose=true`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('yahoo fetch error');
  const rows = parseYFCsv(await resp.text());
  if (!rows.length) throw new Error('yahoo empty');
  return rows;
}

/* -------- 對外主函式 -------- */
export async function fetchPrices(tickers, start, end) {
  const out = {};
  for (const tk of tickers) {
    try {
      // 1️⃣ 嘗試 Stooq
      const rows = await fetchFromStooq(tk);
      out[tk] = rows.filter(r => r.date >= start && r.date <= end);
    } catch {
      // 2️⃣ 失敗改用 Yahoo Finance
      const rows = await fetchFromYahoo(tk, start, end);
      out[tk] = rows;
    }
  }
  return out;
}
