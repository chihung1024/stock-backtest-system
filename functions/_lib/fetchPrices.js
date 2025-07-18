/* functions/_lib/fetchPrices.js
   用 Stooq 開放 CSV 抓每日收盤價，免 API Key。
   URL 格式：
   https://stooq.com/q/d/l/?s=aapl.us&i=d
*/
function parseCSV(text) {
  const lines = text.trim().split('\n');
  lines.shift();                     // 去掉標題列
  return lines.map(l => {
    const [date, , , , close] = l.split(',');
    return { date, close: parseFloat(close) };
  }).filter(r => !isNaN(r.close));
}

/* 下載單一股票 */
async function fetchOne(ticker) {
  const url = `https://stooq.com/q/d/l/?s=${ticker.toLowerCase()}.us&i=d`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`下載 ${ticker} 失敗`);
  return parseCSV(await resp.text());
}

/* 同步抓多檔，傳回 { AAPL: [...], MSFT: [...] } */
export async function fetchPrices(tickers, start, end) {
  const out = {};
  for (const tk of tickers) {
    const rows = await fetchOne(tk);
    out[tk] = rows.filter(r => r.date >= start && r.date <= end);
  }
  return out;
}
