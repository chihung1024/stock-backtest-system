/* functions/_lib/metrics.js
   專門計算 CAGR、MDD、Volatility、Sharpe、Sortino、Beta、Alpha
   （Beta / Alpha 需要另外傳入 benchmarkReturns 才會算）
*/
const TRADING_DAYS_PER_YEAR = 252;
const DAYS_PER_YEAR = 365.25;
const EPSILON = 1e-9;

/* 把價格序列轉成日報酬 (%) 陣列 */
function dailyReturns(prices) {
  const out = [];
  for (let i = 1; i < prices.length; i++) {
    const ret = (prices[i] - prices[i - 1]) / (prices[i - 1] + EPSILON);
    out.push(ret);
  }
  return out;
}

/* 主要出口函式 --------------------------------------------------------- */
export function calcMetrics(dates, prices, benchmarkDates = null, benchmarkPrices = null, riskFreeRate = 0) {
  if (!prices || prices.length < 2) {
    return blank();
  }

  const startDate = new Date(dates[0]);
  const endDate   = new Date(dates[dates.length - 1]);
  const years = (endDate - startDate) / (1000 * 60 * 60 * 24 * DAYS_PER_YEAR);

  const startVal = prices[0];
  const endVal   = prices[prices.length - 1];
  if (startVal < EPSILON) return blank();

  const cagr = Math.pow(endVal / startVal, 1 / years) - 1;

  /* 最大回撤 (MDD) ---------------------------------------------------- */
  let peak = prices[0], mdd = 0;
  for (const p of prices) {
    if (p > peak) peak = p;
    const dd = (p - peak) / (peak + EPSILON);
    if (dd < mdd) mdd = dd;
  }

  /* 年化波動率 & Sharpe & Sortino ------------------------------------- */
  const rets = dailyReturns(prices);
  if (rets.length < 2) return { ...blank(), cagr, mdd };

  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const std  = Math.sqrt(rets.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / (rets.length - 1));
  const annualVol = std * Math.sqrt(TRADING_DAYS_PER_YEAR);
  const excessReturn = cagr - riskFreeRate;
  const sharpe = excessReturn / (annualVol + EPSILON);

  /* Sortino (只算下跌波動) */
  const rfDaily = Math.pow(1 + riskFreeRate, 1 / TRADING_DAYS_PER_YEAR) - 1;
  const downside = rets
    .map(r => r - rfDaily)
    .filter(r => r < 0);
  const downsideStd = downside.length
    ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / downside.length) *
      Math.sqrt(TRADING_DAYS_PER_YEAR)
    : 0;
  const sortino = downsideStd > EPSILON ? excessReturn / downsideStd : 0;

  /* Beta / Alpha ------------------------------------------------------- */
  let beta = null, alpha = null;
  if (benchmarkPrices && benchmarkPrices.length === prices.length) {
    const br = dailyReturns(benchmarkPrices);
    // 讓兩組回報對齊日期
    const n = Math.min(rets.length, br.length);
    const pr = rets.slice(-n);
    const qr = br.slice(-n);
    const meanP = pr.reduce((a, b) => a + b, 0) / n;
    const meanB = qr.reduce((a, b) => a + b, 0) / n;
    let cov = 0, varB = 0;
    for (let i = 0; i < n; i++) {
      cov  += (pr[i] - meanP) * (qr[i] - meanB);
      varB += Math.pow(qr[i] - meanB, 2);
    }
    cov  /= n - 1;
    varB /= n - 1;
    if (varB > EPSILON) {
      beta = cov / varB;
      /* Alpha = 真實年化 - (無風險 + β * (基準年化 - 無風險)) */
      const benchStart = benchmarkPrices[0];
      const benchEnd   = benchmarkPrices[benchmarkPrices.length - 1];
      const benchCAGR  = Math.pow(benchEnd / benchStart, 1 / years) - 1;
      const expected   = riskFreeRate + beta * (benchCAGR - riskFreeRate);
      alpha = cagr - expected;
    }
  }

  return {
    cagr, mdd, volatility: annualVol, sharpe_ratio: sharpe,
    sortino_ratio: sortino, beta, alpha
  };
}

/* 回傳全 0 / null 的空結果，用於邊界條件 */
function blank() {
  return {
    cagr: 0, mdd: 0, volatility: 0,
    sharpe_ratio: 0, sortino_ratio: 0,
    beta: null, alpha: null
  };
}
