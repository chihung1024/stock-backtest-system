/* functions/_lib/portfolio.js
   依初始金額 + 權重 + 再平衡週期，回傳每日期末「投組總值」陣列
*/
export { simulatePortfolio };          // 讓其他檔可直接 import
import { TRADING_DAYS_PER_YEAR } from './metrics.js';   // 直接複用常數

export function simulatePortfolio(commonDates, priceMap, tickers, weightsPct,
                                  initialAmount = 10000, rebalance = 'never') {

  const w = weightsPct.length
    ? weightsPct
    : Array(tickers.length).fill(100 / tickers.length);          // 等權

  // --- 1. 把百分比轉成 0~1 -------------------------------------------------
  const weights = w.map(v => v / 100);

  // --- 2. 預先取出各股票的價格序列 (與日期對齊) ----------------------------
  const priceSeries = tickers.map(tk =>
    commonDates.map(d => priceMap[tk].find(r => r.date === d).close)
  );

  // --- 3. 計算第一次買進的「股數」 -----------------------------------------
  const shares = priceSeries.map((prices, i) =>
    (initialAmount * weights[i]) / prices[0]
  );

  const equity = [];
  let nextRebalanceIdx = getNextRebalIdx(0, rebalance, commonDates);

  for (let day = 0; day < commonDates.length; day++) {
    // 計算今日總值
    let val = 0;
    for (let i = 0; i < shares.length; i++) val += shares[i] * priceSeries[i][day];
    equity.push(val);

    // 到了再平衡日 → 依目前市值重新計算 shares
    if (day === nextRebalanceIdx) {
      for (let i = 0; i < shares.length; i++) {
        shares[i] = (val * weights[i]) / priceSeries[i][day];
      }
      nextRebalanceIdx = getNextRebalIdx(day, rebalance, commonDates);
    }
  }
  return equity;
}

/* 根據週期 ('never' | 'annually' | 'quarterly' | 'monthly') 找下一個 rebalancing index */
function getNextRebalIdx(currentIdx, period, dates) {
  if (period === 'never') return Infinity;
  const cur = new Date(dates[currentIdx]);
  for (let i = currentIdx + 1; i < dates.length; i++) {
    const d = new Date(dates[i]);
    if (period === 'annually'  && d.getFullYear() !== cur.getFullYear())  return i;
    if (period === 'quarterly' && quarter(d) !== quarter(cur))            return i;
    if (period === 'monthly'   && (d.getFullYear() !== cur.getFullYear() ||
                                   d.getMonth()    !== cur.getMonth()))   return i;
  }
  return Infinity;
}
function quarter(dt) { return Math.floor(dt.getMonth() / 3); }
