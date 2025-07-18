// functions/_lib/portfolio.js
// -------------------------------------------------------------
// 依「初始金額 × 權重 × 再平衡週期」模擬投組，每日回傳淨值（總報酬價）
// -------------------------------------------------------------

export function simulatePortfolio(
  commonDates,
  priceMap,
  tickers,
  weightsPct,
  initialAmount = 10000,
  rebalance = 'never'           // 'never' | 'annually' | 'quarterly' | 'monthly'
) {
  // 1. 權重：若未給，預設等權
  const n = tickers.length;
  const weights = (weightsPct && weightsPct.length === n
      ? weightsPct
      : Array(n).fill(100 / n)
    ).map(w => w / 100);

  // 2. 取出對齊後的價格序列
  const priceSeries = tickers.map(tk =>
    commonDates.map(d => {
      const row = priceMap[tk].find(r => r.date === d);
      if (!row) throw new Error(`缺少 ${tk} 在 ${d} 的價格資料`);
      return row.close;
    })
  );

  // 3. 第一天按權重買進 → shares[]
  const shares = priceSeries.map((prices, i) =>
    (initialAmount * weights[i]) / prices[0]
  );

  const equity = [];
  let nextIdx = getNextRebalIdx(0, rebalance, commonDates);

  // 4. 逐日累積 & 再平衡
  for (let day = 0; day < commonDates.length; day++) {
    let val = 0;
    for (let i = 0; i < n; i++) val += shares[i] * priceSeries[i][day];
    equity.push(val);

    if (day === nextIdx) {
      for (let i = 0; i < n; i++) {
        shares[i] = (val * weights[i]) / priceSeries[i][day];
      }
      nextIdx = getNextRebalIdx(day, rebalance, commonDates);
    }
  }
  return equity;
}

/* -------------------------------------------------------------
   工具：依週期找下一次再平衡的索引
------------------------------------------------------------- */
function getNextRebalIdx(currentIdx, period, dates) {
  if (period === 'never') return Infinity;
  const cur = new Date(dates[currentIdx]);
  for (let i = currentIdx + 1; i < dates.length; i++) {
    const d = new Date(dates[i]);
    if (period === 'annually'  && d.getFullYear() !== cur.getFullYear())             return i;
    if (period === 'quarterly' && quarter(d)      !== quarter(cur))                  return i;
    if (period === 'monthly'   && (d.getFullYear() !== cur.getFullYear() ||
                                   d.getMonth()    !== cur.getMonth()))              return i;
  }
  return Infinity; // 之後不再平衡
}

function quarter(dt) {
  return Math.floor(dt.getMonth() / 3); // 0,1,2,3
}
