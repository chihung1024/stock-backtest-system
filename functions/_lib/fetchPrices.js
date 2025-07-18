/* functions/_lib/fetchPrices.js
   1️⃣ 先抓 Stooq Close
   2️⃣ 補抓 Yahoo Dividends / Splits → 把 Close 轉成「含股息總報酬價」
   3️⃣ Stooq 失敗才整包改用 Yahoo Adj Close

   回傳統一格式：
     [{ date:'yyyy-mm-dd', close:123.45 }, …]
*/

//////////////////// 共用小工具 ////////////////////
function toEpoch(dateStr) {
  return Math.floor(new Date(dateStr + 'T00:00:00Z').getTime() / 1000);
}
function csv(text) {
  const [header, ...rows] = text.trim().split('\n');
  return rows.map(r => r.split(','));
}

//////////////////// Stooq 價格 ////////////////////
async function fetchStooq(tk) {
  const url = `https://stooq.com/q/d/l/?s=${tk.toLowerCase()}.us&i=d`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('stooq fetch');
  return csv(await res.text())
    .map(([d,,,, c]) => ({ date: d, close: +c }))
    .filter(r => !isNaN(r.close));
}

//////////////////// Yahoo 事件 ////////////////////
async function fetchYahooEvents(tk, start, end, type) {
  const p1 = toEpoch(start), p2 = toEpoch(end) + 86400;
  const url = `https://query1.finance.yahoo.com/v7/finance/download/${tk}` +
              `?period1=${p1}&period2=${p2}&interval=1d&events=${type}`;
  const res = await fetch(url);
  if (!res.ok) return [];                       // 無資料也算成功
  return csv(await res.text()).map(r => ({
    date: r[0],
    value: +r[1]
  }));
}

//////////////////// 把 Stooq Close → 含息總報酬 ////////////////////
function applyEvents(rows, divs, splits) {
  if (!rows.length) return rows;
  let shares = 1;                               // 初始 1 股
  let equity = rows[0].close;                   // 初始投資 = 1 股 * 首日價
  const out = [{ date: rows[0].date, close: equity }];

  const divMap   = new Map(divs.map(d => [d.date, d.value]));
  const splitMap = new Map(splits.map(s => [s.date, s.value])); // value 形如 2/1

  for (let i = 1; i < rows.length; i++) {
    const { date, close } = rows[i];

    // 若當天有拆分：shares *= (後 / 前)
    if (splitMap.has(date)) {
      const [num, den] = splitMap.get(date).split(':').map(Number);
      shares *= num / den;
    }

    // 股息 ⇒ 新增 shares = 現金 / 收盤價
    if (divMap.has(date)) shares += divMap.get(date) / close;

    equity = shares * close;
    out.push({ date, close: +equity.toFixed(6) });
  }
  return out;
}

//////////////////// Yahoo Adj Close 備援 ////////////////////
async function fetchYahooAdj(tk, start, end) {
  const p1 = toEpoch(start), p2 = toEpoch(end) + 86400;
  const url = `https://query1.finance.yahoo.com/v7/finance/download/${tk}` +
              `?period1=${p1}&period2=${p2}` +
              `&interval=1d&events=history&includeAdjustedClose=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('yahoo fetch');
  return csv(await res.text())
    .map(([d,,,, c,, a]) => ({ date: d, close: +(a || c) }))
    .filter(r => !isNaN(r.close));
}

//////////////////// 對外主函式 ////////////////////
export async function fetchPrices(tickers, start, end) {
  const out = {};
  for (const tk of tickers) {
    try {
      const base  = await fetchStooq(tk);
      const divs  = await fetchYahooEvents(tk, start, end, 'div');
      const splits= await fetchYahooEvents(tk, start, end, 'split');
      out[tk] = applyEvents(
        base.filter(r => r.date >= start && r.date <= end),
        divs,
        splits
      );
    } catch {
      // Stooq totally failed ⇒ Yahoo Adj Close
      out[tk] = await fetchYahooAdj(tk, start, end);
    }
  }
  return out;
}
