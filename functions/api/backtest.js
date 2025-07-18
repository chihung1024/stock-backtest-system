// functions/api/backtest.js
// ─────────────────────────────────────────────────────────────
// POST /api/backtest
// 1) 下載歷史價格
// 2) 以初始金額 + 再平衡週期模擬每個投資組合
// 3) 若有基準，所有投組都用同一基準計算 β / α
// ─────────────────────────────────────────────────────────────

import { fetchPrices }       from '../_lib/fetchPrices.js';
import { calcMetrics }       from '../_lib/metrics.js';
import { simulatePortfolio } from '../_lib/portfolio.js';

export const onRequestPost = async ({ request }) => {
  try {
    /* ---------- 讀取參數 ---------- */
    const p = await request.json();
    const start = `${p.startYear}-${String(p.startMonth).padStart(2, '0')}-01`;
    const end   = `${p.endYear}-${String(p.endMonth).padStart(2, '0')}-28`;
    const portfolios = p.portfolios || [];
    const initialAmount = Number(p.initialAmount) || 10000;

    /* ---------- 收集全部股票代碼 ---------- */
    const all = new Set();
    portfolios.forEach(pt => pt.tickers.forEach(tk => all.add(tk)));
    if (p.benchmark) all.add(p.benchmark);
    if (all.size === 0) {
      return json({ error: '請至少設定一項資產。' }, 400);
    }

    /* ---------- 下載價格 ---------- */
    const priceMap = await fetchPrices([...all], start, end);

    /* 共同交易日 */
    const baseDates = priceMap[[...all][0]].map(r => r.date);
    const commonDates = baseDates.filter(d =>
      [...all].every(tk => priceMap[tk].some(r => r.date === d))
    );
    if (commonDates.length < 50) {
      return json({ error: '共同交易日不足，無法回測' }, 400);
    }

    /* ---------- (可選) 先算 benchmark ---------- */
    let benchEquity = null, benchmark = null;
    if (p.benchmark) {
      benchEquity = simulatePortfolio(
        commonDates,
        priceMap,
        [p.benchmark],
        [100],
        initialAmount,
        'never'
      );
      const m = calcMetrics(commonDates, benchEquity);
      benchmark = {
        name: p.benchmark,
        ...m,
        beta: 1.0,
        alpha: 0.0,
        portfolioHistory: commonDates.map((d, i) => ({ date: d, value: benchEquity[i] }))
      };
    }

    /* ---------- 計算每個投組 ---------- */
    const results = [];
    for (const pt of portfolios) {
      const equity = simulatePortfolio(
        commonDates,
        priceMap,
        pt.tickers,
        pt.weights,
        initialAmount,
        pt.rebalancingPeriod || 'never'
      );

      /* 把 benchmark 序列帶進去，才能算 β / α */
      const metrics = benchEquity
        ? calcMetrics(commonDates, equity, commonDates, benchEquity)
        : calcMetrics(commonDates, equity);

      results.push({
        name: pt.name,
        ...metrics,
        portfolioHistory: commonDates.map((d, i) => ({ date: d, value: equity[i] }))
      });
    }

    return json({ data: results, benchmark });
  } catch (err) {
    return json({ error: err.message || 'Unhandled error' }, 500);
  }
};

/* ---------- 小工具 ---------- */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
