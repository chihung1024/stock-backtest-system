// functions/api/backtest.js
// ───────────────────────────────────────────────────────────────
// Cloudflare Pages Function：POST /api/backtest
// 1. 下載所需股票歷史價格
// 2. 依初始金額＋權重＋再平衡週期模擬投組淨值
// 3. 回傳績效指標與每日淨值序列
// ───────────────────────────────────────────────────────────────

import { fetchPrices }      from '../_lib/fetchPrices.js';
import { calcMetrics }      from '../_lib/metrics.js';
import { simulatePortfolio } from '../_lib/portfolio.js';

export const onRequestPost = async ({ request }) => {
  try {
    // ---------- 解析前端送來的 JSON ----------
    const p = await request.json();

    const start = `${p.startYear}-${String(p.startMonth).padStart(2, '0')}-01`;
    const end   = `${p.endYear}-${String(p.endMonth).padStart(2, '0')}-28`;

    const portfolios = p.portfolios || [];

    // 收集所有要抓價的股票代碼（包含 benchmark）
    const allTickers = new Set();
    portfolios.forEach(pt => pt.tickers.forEach(tk => allTickers.add(tk)));
    if (p.benchmark) allTickers.add(p.benchmark);

    if (allTickers.size === 0)
      return json({ error: '請至少在一個投資組合中設定一項資產。' }, 400);

    // ---------- 抓歷史價格 ----------
    const priceMap = await fetchPrices([...allTickers], start, end);

    // 找共同交易日 (用第一支股票日期當基地，過濾所有股票都存在的日期)
    const baseDates   = priceMap[[...allTickers][0]].map(r => r.date);
    const commonDates = baseDates.filter(d =>
      [...allTickers].every(tk => priceMap[tk].some(r => r.date === d))
    );

    if (commonDates.length < 50)
      return json({ error: '共同交易日不足，無法回測' }, 400);

    // ---------- 計算各投組 ----------
    const initialAmount = Number(p.initialAmount) || 10000;
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

      const metrics = calcMetrics(commonDates, equity);

      results.push({
        name: pt.name,
        ...metrics,
        portfolioHistory: commonDates.map((d, i) => ({ date: d, value: equity[i] }))
      });
    }

/* 5. benchmark (若有) --------------------------------------------------- */
  let benchmark = null;
  if (p.benchmark) {
    // 用 portfolio 模擬器，起點同 initialAmount，週期固定 never
    const benchEquity = simulatePortfolio(
      commonDates,
      priceMap,
      [p.benchmark],   // 只放一支
      [100],           // 100% 權重
      initialAmount,
      'never'
    );

  const metrics = calcMetrics(commonDates, benchEquity);

  benchmark = {
    name: p.benchmark,
    ...metrics,
    beta: 1.0,
    alpha: 0.0,
    portfolioHistory: commonDates.map((d, i) => ({
      date: d,
      value: benchEquity[i]
    }))
  };
}

    return json({ data: results, benchmark });
  } catch (err) {
    return json({ error: err.message || 'Unhandled error' }, 500);
  }
};

// ---------- 小工具：回傳 JSON Response ----------
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
