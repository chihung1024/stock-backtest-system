// functions/api/backtest.js
// -------------------------------------------------------------
// 1) 下載價格（yfinance→Stooq 策略在 _lib/fetchPrices.js 內）
// 2) 自動將回測起點推到「所有標的都有資料」的最早日期
// 3) 如某標的啟用日比使用者要求的月份首日晚 >5 個營業日，就列入 warning
// -------------------------------------------------------------

import { fetchPrices }       from '../_lib/fetchPrices.js';
import { calcMetrics }       from '../_lib/metrics.js';
import { simulatePortfolio } from '../_lib/portfolio.js';

/* yyyy, m → 月底 (YYYY-MM-DD) */
const monthEnd = (y, m) => new Date(y, Number(m), 0).toISOString().slice(0, 10);

/* 把 YYYY-MM-DD 轉 JS Date（UTC 00:00） */
const toDate = d => new Date(`${d}T00:00:00Z`);

/* 回傳日期字串陣列（共同交易日） */
function intersectDates(priceMap, tickers, from, to) {
  let common = null;
  for (const tk of tickers) {
    const set = new Set(
      priceMap[tk].filter(r => r.date >= from && r.date <= to).map(r => r.date)
    );
    common = common ? new Set([...common].filter(d => set.has(d))) : set;
  }
  return [...common].sort();          // 升序
}

/* 估算「兩個日期之間的營業日差」(把週六日排除即可) */
function businessDayDiff(a, b) {
  let diff = 0, cur = new Date(a);
  while (cur < b) {
    const wd = cur.getUTCDay();
    if (wd !== 0 && wd !== 6) diff += 1;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return diff;
}

export const onRequestPost = async ({ request }) => {
  try {
    /* ========== 1. 解析參數 ========== */
    const p       = await request.json();
    const startRq = `${p.startYear}-${p.startMonth.toString().padStart(2,'0')}-01`;
    const endRq   = monthEnd(p.endYear, p.endMonth);
    const initial = Number(p.initialAmount) || 10000;

    const tickers = new Set(p.portfolios.flatMap(pt => pt.tickers));
    if (p.benchmark) tickers.add(p.benchmark);
    if (!tickers.size)
      return json({ error: '請至少在一個投資組合中設定一項資產。' }, 400);

    /* ========== 2. 下載價格 ========== */
    const priceMap = await fetchPrices([...tickers], startRq, endRq);

    /* ========== 3. 找每檔「最早可用日」 & 警示判斷 ========== */
    const firstDates = {};
    for (const tk of tickers) {
      const firstRow = priceMap[tk].find(r => r.date >= startRq);
      if (firstRow) firstDates[tk] = firstRow.date;
    }

    const commonStart = Object.values(firstDates).sort().pop(); // 取「最晚」那個
    const commonDates = intersectDates(priceMap, [...tickers], commonStart, endRq);
    if (!commonDates.length)
      return json({ error: '在指定的時間範圍內，找不到所有股票的共同交易日。' }, 400);

    /* 只列出「比起始月首日晚 5 個營業日以上」的標的 */
    const warnList = Object.entries(firstDates)
      .filter(([ , d ]) => businessDayDiff(toDate(startRq), toDate(d)) > 5)
      .map(([ tk, d ]) => `${tk} (從 ${d} 開始)`);

    const warning = warnList.length
      ? `部分資產的數據起始日晚於您的選擇，已自動調整至共同可用日期。受影響資產：${warnList.join('、')}`
      : null;

    /* ========== 4. 基準 (optional) ========== */
    let benchSeries = null, benchmark = null;
    if (p.benchmark) {
      benchSeries = simulatePortfolio(
        commonDates, priceMap,
        [p.benchmark], [100],
        initial, 'never'
      );
      benchmark = {
        name: p.benchmark,
        ...calcMetrics(commonDates, benchSeries),
        beta: 1, alpha: 0,
        portfolioHistory: commonDates.map((d,i)=>({ date:d, value:benchSeries[i] }))
      };
    }

    /* ========== 5. 各投組回測 ========== */
    const results = [];
    for (const cfg of p.portfolios) {
      const eq = simulatePortfolio(
        commonDates, priceMap,
        cfg.tickers, cfg.weights,
        initial, cfg.rebalancingPeriod || 'never'
      );
      const met = benchSeries
        ? calcMetrics(commonDates, eq, commonDates, benchSeries)
        : calcMetrics(commonDates, eq);
      results.push({
        name: cfg.name,
        ...met,
        portfolioHistory: commonDates.map((d,i)=>({ date:d, value:eq[i] }))
      });
    }

    return json({ data: results, benchmark, warning });
  } catch (err) {
    console.error(err);
    return json({ error: '伺服器發生未預期的錯誤。' }, 500);
  }
};

/* 統一 JSON Response */
function json(obj, status=200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
