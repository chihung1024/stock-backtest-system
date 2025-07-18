// functions/api/scan.js
import { fetchPrices } from '../_lib/fetchPrices.js';
import { calcMetrics } from '../_lib/metrics.js';

function monthEnd(year, month) {
  return new Date(year, Number(month), 0).toISOString().slice(0, 10);
}
function normalize(list) {
  return [...new Set(list.map(t=>t.trim().toUpperCase()).filter(Boolean))];
}

export const onRequestPost = async ({ request }) => {
  try {
    const p = await request.json();
    const tickers   = normalize(p.tickers || []);
    const benchmark = (p.benchmark || '').trim().toUpperCase() || null;
    if (!tickers.length) return json({ error:'股票代碼列表不可為空。'},400);

    const start = `${p.startYear}-${String(p.startMonth).padStart(2,'0')}-01`;
    const end   = monthEnd(p.endYear, p.endMonth);

    const all = benchmark ? [...tickers, benchmark] : tickers;
    const priceMap = await fetchPrices(all, start, end);

    const baseDates = priceMap[tickers[0]].map(r=>r.date);
    const common = baseDates.filter(d =>
      tickers.every(tk=>priceMap[tk].some(r=>r.date===d))
    );
    if (common.length < 50)
      return json({ error:'共同交易日不足，無法計算'},400);

    let benchSeries = null;
    if (benchmark) {
      benchSeries = priceMap[benchmark]
        .filter(r=>common.includes(r.date))
        .map(r=>r.close);
    }

    const out = [];
    for (const tk of tickers) {
      const series = priceMap[tk]
        .filter(r=>common.includes(r.date))
        .map(r=>r.close);

      const m = benchSeries
        ? calcMetrics(common, series, common, benchSeries)
        : calcMetrics(common, series);

      out.push({ ticker: tk, ...m });
    }

    return json(out);
  } catch (err) {
    return json({ error: err.message || 'Unhandled error' }, 500);
  }
};

function json(obj, status=200){
  return new Response(JSON.stringify(obj),{
    status,
    headers:{'content-type':'application/json'}
  });
}
