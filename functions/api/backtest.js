// functions/api/backtest.js
import { fetchPrices }       from '../_lib/fetchPrices.js';
import { calcMetrics }       from '../_lib/metrics.js';
import { simulatePortfolio } from '../_lib/portfolio.js';

/* 工具：yyyy-mm 最後一日字串 */
const monthEnd = (y, m) =>
  new Date(y, Number(m), 0).toISOString().slice(0, 10);

/* 取得各標的第一筆有效價格日期 */
function firstValidDates(priceMap) {
  const out = {};
  for (const [tk, rows] of Object.entries(priceMap)) {
    const r = rows.find(r => r.close > 0);
    if (r) out[tk] = r.date;
  }
  return out;
}

/* 把所有標的日期交集取「最早共同可用日」之後 */
function buildCommonDates(priceMap, tickers) {
  const sets = tickers.map(tk => new Set(priceMap[tk].map(r => r.date)));
  const all  = [...sets.reduce((a, s) => new Set([...a].filter(x => s.has(x))))];
  return all.sort();               // 升序字串
}

export const onRequestPost = async ({ request }) => {
  try {
    /* -------- 1. 解析前端參數 -------- */
    const p = await request.json();
    const start = `${p.startYear}-${p.startMonth.toString().padStart(2,'0')}-01`;
    const end   = monthEnd(p.endYear, p.endMonth);
    const init  = Number(p.initialAmount) || 10000;

    /* -------- 2. 收集所有需要下載的代碼 -------- */
    const allTickers = new Set(
      p.portfolios.flatMap(pt => pt.tickers)
    );
    if (p.benchmark) allTickers.add(p.benchmark);
    if (!allTickers.size)
      return json({ error: '請至少在一個投資組合中設定一項資產。' }, 400);

    /* -------- 3. 下載價格 -------- */
    const priceMap = await fetchPrices([...allTickers], start, end);

    /* -------- 4. 檢查起始日差異，組警示文字 -------- */
    const firstDates = firstValidDates(priceMap);
    const requested  = new Date(start);
    const affected   = Object.entries(firstDates)
      .filter(([ , d ]) => new Date(d) > requested);
    let warningMsg = null;
    if (affected.length) {
      warningMsg = '部分資產的數據起始日晚於您的選擇。回測已自動調整至最早的共同可用日期。週期受影響的資產：' +
        affected.map(([tk, d]) => `${tk} (從 ${d} 開始)`).join('、');
    }

    /* -------- 5. 找共同交易日 -------- */
    const tickersArr = [...allTickers];
    const commonDates = buildCommonDates(priceMap, tickersArr);
    if (commonDates.length < 20)
      return json({ error: '在指定的時間範圍內，找不到所有股票的共同交易日。' }, 400);

    /* -------- 6. 如果有 Benchmark 先算 -------- */
    let benchHist = null, benchmark = null;
    if (p.benchmark) {
      benchHist = simulatePortfolio(
        commonDates, priceMap, [p.benchmark], [100], init, 'never'
      );
      const bm = calcMetrics(commonDates, benchHist);
      benchmark = {
        name: p.benchmark,
        ...bm,
        beta: 1, alpha: 0,
        portfolioHistory: commonDates.map((d,i)=>({ date:d, value:benchHist[i] }))
      };
    }

    /* -------- 7. 每個投組模擬回測 -------- */
    const results = [];
    for (const cfg of p.portfolios) {
      const equity = simulatePortfolio(
        commonDates, priceMap,
        cfg.tickers, cfg.weights,
        init, cfg.rebalancingPeriod || 'never'
      );
      const met = benchHist
        ? calcMetrics(commonDates, equity, commonDates, benchHist)
        : calcMetrics(commonDates, equity);

      results.push({
        name: cfg.name,
        ...met,
        portfolioHistory: commonDates.map((d,i)=>({ date:d, value:equity[i] }))
      });
    }

    return json({ data: results, benchmark, warning: warningMsg });
  } catch (err) {
    console.error(err);
    return json({ error: '伺服器發生未預期的錯誤' }, 500);
  }
};

/* 快速回傳 JSON */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
