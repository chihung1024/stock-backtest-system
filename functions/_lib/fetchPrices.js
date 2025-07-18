/*  先 CSV ✓   若 CSV 有 null / 4xx → 換 JSON Chart ✓
    完全模仿 yfinance.download(auto_adjust=True) 行為             */
const toEpoch = d => Math.floor(new Date(d + 'T00:00:00Z').getTime()/1000);

/* ---------- 公用：CSV 轉陣列 ---------- */
const csvRows = txt => txt.trim().split('\n').slice(1).map(l=>l.split(','));

/* ---------- 1) Yahoo CSV (最快) ---------- */
async function yahooCsv(tk, s, e) {
  const url = `https://query1.finance.yahoo.com/v7/finance/download/${encodeURIComponent(tk)}` +
              `?period1=${toEpoch(s)}&period2=${toEpoch(e)+86400}` +
              `&interval=1d&events=history&includeAdjustedClose=true`;
  const r = await fetch(url);
  if (!r.ok) throw 'csv404';
  const rows = csvRows(await r.text());
  if (!rows.length) throw 'csvEmpty';
  return rows.map(([d,,,,c,,a]) => ({ date:d, val:a==='null'?null:+a||+c }));
}

/* ---------- 2) Yahoo JSON Chart (備援) ---------- */
async function yahooChart(tk, s, e) {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(tk)}` +
              `?period1=${toEpoch(s)}&period2=${toEpoch(e)+86400}` +
              `&interval=1d&events=div,splits&includeAdjustedClose=true`;
  const r = await fetch(url);
  if (!r.ok) throw 'chart404';
  const js = await r.json();
  const ts = js.chart.result?.[0]?.timestamp;
  const adj = js.chart.result?.[0]?.indicators?.adjclose?.[0]?.adjclose;
  if (!ts || !adj) throw 'chartEmpty';
  return ts.map((t,i)=>({
    date: new Date(t*1000).toISOString().slice(0,10),
    val : adj[i] ?? null
  }));
}

/* ---------- 3) Stooq (最後保底) ---------- */
async function stooq(tk, s, e) {
  const url=`https://stooq.com/q/d/l/?s=${tk.toLowerCase()}.us&i=d`;
  const r = await fetch(url);
  if (!r.ok) return [];
  return csvRows(await r.text())
    .map(([d,,,,c])=>({date:d, val:+c}))
    .filter(o=>!isNaN(o.val) && o.date>=s && o.date<=e);
}

/* ---------- 修補 null：先 forward，再 backward fill ---------- */
function fill(arr){
  let last=null;
  for(const o of arr){ if(o.val!=null){ last=o.val; continue; } if(last!=null) o.val=last; }
  for(let i=arr.length-1, nxt=null;i>=0;i--){
    if(arr[i].val!=null){ nxt=arr[i].val; continue; }
    if(nxt!=null) arr[i].val=nxt;
  }
  return arr.filter(o=>o.val!=null).map(o=>({date:o.date, close:o.val}));
}

/* ---------- 對外 ---------- */
export async function fetchPrices(list,start,end){
  const out={};
  for(const tk of list){
    let rows=[];
    try{ rows=await yahooCsv(tk,start,end); }
    catch{ try{ rows=await yahooChart(tk,start,end);} catch{} }
    if(!rows.length) rows=await stooq(tk,start,end);
    out[tk]=fill(rows);
  }
  return out;
}
