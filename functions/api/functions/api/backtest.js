// functions/api/backtest.js
import { fetchPrices } from '../_lib/fetchPrices.js';
import { calcMetrics } from '../_lib/metrics.js';

/* 把 ["2020-01-02", ...] 轉成 { "2020-01-02": idx, ... } 方便交集 */
function indexByDate(arr) {
  const map = new Map();
  arr.forEach((d, i) => map.set(d, i));
  return map;
}

/* 將多檔股票閉合到共同日期，計算等權組合淨值 */
function buildEquity(commonDates, priceMap, tickers, weightsPct) {
  const w = weightsPct.length ? weightsPct : Array(tickers.length).fill(100 / tickers.length);
  const equity = [];
  commonDates.forEach(date => {
    let v = 0;
    for (let i = 0; i < tickers.length; i++) {
      const tk = tickers[i];
      const row = priceMap[tk].find(r => r.date === date);
      v += row.close * (w[i] / 100);
    }
    equity.push(v);
  });
  return equity;
}

/* Cloudflare Pages Function 入口 */
export const onRequestPost = async ({ request }) => {
  try {
    const p = await request.json();

    /* 1. 解析日期 ---------------------------------------------------------------- */
    const start = `${p.startYear}-${String(p.startMonth).padStart(2, '0')}-01`;
    const end   = `${p.endYear}-${String(p.endMonth).padStart(2, '0')}-28`;

    /* 2. 彙整所有需要的股票代碼 --------------------------------------------------- */
    const portfolios = p.portfolios || [];
    const allSet = new Set();
    portfolios.forEach(pt => pt.tickers.forEach(tk => allSet.add(tk)));
    if (p.benchmark) allSet.add(p.benchmark);
    const allTickers = Array.from(allSet);

    if (allTickers.length === 0)
      return json({ error: '請至少設定一檔股票' }, 400);

    /* 3. 抓歷史價格 --------------------------------------------------------------- */
    const priceMap = await fetchPrices(allTickers, start, end);

    /* 找「共同日期」：先用第一支股票當基準，再過濾所有股票都存在的日期 */
    const baseDates = priceMap[allTickers[0]].map(r => r.date);
    const baseIdx   = indexByDate(baseDates);
    const commonDates = baseDates.filter(d =>
      allTickers.every(tk => priceMap[tk].some(r => r.date === d))
    );
    if (commonDates.length < 50)  // 太少天，回傳錯誤
      return json({ error: '共同交易日不足，無法回測' }, 400);

    /* 4. 計算每個投組績效 --------------------------------------------------------- */
    const results = [];
    for (const pt of portfolios) {
      const equity = buildEquity(commonDates, priceMap, pt.tickers, pt.weights);
      const m = calcMetrics(commonDates, equity);      // 共用指標函式[13]
      results.push({
        name: pt.name,
        ...m,
        portfolioHistory: commonDates.map((d, i) => ({ date: d, value: equity[i] }))
      });
    }

    /* 5. benchmark (若有) --------------------------------------------------------- */
    let benchmark = null;
    if (p.benchmark) {
      const rows = priceMap[p.benchmark]
        .filter(r => commonDates.includes(r.date))
        .map(r => r.close);
      const m = calcMetrics(commonDates, rows);
      benchmark = {
        name: p.benchmark,
        ...m,
        portfolioHistory: commonDates.map((d, i) => ({ date: d, value: rows[i] }))
      };
      benchmark.beta  = 1.0;   // 固定 β = 1
      benchmark.alpha = 0.00;
    }

    /* 6. 一併回傳 --------------------------------------------------------------- */
    return json({ data: results, benchmark });
  } catch (err) {
    return json({ error: err.message || 'Unhandled error' }, 500);
  }
};

/* 小工具：快速回傳 JSON Response */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
