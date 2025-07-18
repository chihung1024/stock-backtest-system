// functions/api/scan.js
import { fetchPrices }   from '../_lib/fetchPrices.js';
import { calcMetrics }   from '../_lib/metrics.js';

/* 將陣列去空白 → 去重 → 全轉大寫 */
function normalizeTickers(list) {
  return [...new Set(list.map(t => t.trim().toUpperCase()).filter(Boolean))];
}

export const onRequestPost = async ({ request }) => {
  try {
    const p = await request.json();

    const tickers   = normalizeTickers(p.tickers || []);
    const benchmark = (p.benchmark || '').trim().toUpperCase() || null;

    if (tickers.length === 0)
      return json({ error: '股票代碼列表不可為空。' }, 400);

    /* 時間範圍 */
    const start = `${p.startYear}-${String(p.startMonth).padStart(2, '0')}-01`;
    const end   = `${p.endYear}-${String(p.endMonth).padStart(2, '0')}-28`;

    /* 下載所需價格 */
    const all = benchmark ? [...tickers, benchmark] : tickers;
    const priceMap = await fetchPrices(all, start, end);

    /* 製作共同日期（用第一支股票當 base） */
    const baseDates = priceMap[tickers[0]].map(r => r.date);
    const common = baseDates.filter(d =>
      tickers.every(tk => priceMap[tk].some(r => r.date === d))
    );
    if (common.length < 50)
      return json({ error: '共同交易日不足，無法計算' }, 400);

    /* 若有基準，先組成其報酬序列，以便算 β / α */
    let benchHist = null;
    if (benchmark) {
      const rows = priceMap[benchmark]
        .filter(r => common.includes(r.date))
        .map((r, i) => ({ date: r.date, value: r.close }));
      benchHist = rows;
    }

    /* 逐檔計算 */
    const out = [];
    for (const tk of tickers) {
      const rows = priceMap[tk]
        .filter(r => common.includes(r.date))
        .map((r, i) => ({ date: r.date, value: r.close }));

      const metrics = benchHist
        ? calcMetrics(common, rows.map(r => r.value), common, benchHist.map(r => r.value))
        : calcMetrics(common, rows.map(r => r.value));

      out.push({ ticker: tk, ...metrics });
    }

    return json(out);
  } catch (err) {
    return json({ error: err.message || 'Unhandled error' }, 500);
  }
};

/* Helper: 回傳 JSON */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
