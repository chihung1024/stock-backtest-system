/* 先規則判斷：只要代碼含 “.” 而且不是 .US，就直接用 Yahoo
   其餘 → Stooq，若筆數 <50 或拋錯，再退回 Yahoo */
function isNonUsTicker(tk){ return /\./.test(tk) && !/\.US$/i.test(tk); }

const csv = t => t.trim().split('\n').slice(1).map(l=>l.split(','));
const toEpoch = d => Math.floor(new Date(d+'T00:00:00Z').getTime()/1000);

/* ---------- Yahoo Adj Close ---------- */
async function yahooAdj(tk,start,end){
  const url = `https://query1.finance.yahoo.com/v7/finance/download/${tk}`+
              `?period1=${toEpoch(start)}&period2=${toEpoch(end)+86400}`+
              `&interval=1d&events=history&includeAdjustedClose=true`;
  const r = await fetch(url); if(!r.ok) throw 0;
  return csv(await r.text()).map(([d,,,,c,,a])=>({date:d,close:+(a||c)}))
                           .filter(r=>!isNaN(r.close));
}

/* ---------- Yahoo Div 現金 → 股息再投入 ---------- */
async function yahooDiv(tk,start,end){
  const url=`https://query1.finance.yahoo.com/v7/finance/download/${tk}`+
            `?period1=${toEpoch(start)}&period2=${toEpoch(end)+86400}`+
            `&interval=1d&events=div`;
  const r=await fetch(url); if(!r.ok) return [];
  return csv(await r.text()).map(([d,val])=>({date:d,cash:+val}))
                            .filter(r=>!isNaN(r.cash));
}

/* ---------- Stooq Close (已含拆分) ---------- */
async function stooq(tk){
  const url=`https://stooq.com/q/d/l/?s=${tk.toLowerCase()}.us&i=d`;
  const r=await fetch(url); if(!r.ok) throw 0;
  return csv(await r.text()).map(([d,,,,c])=>({date:d,close:+c}))
                            .filter(r=>!isNaN(r.close));
}

/* 把股息換股：shares += cash/close → equity=shares*close */
function addDiv(rows,divs){
  if(!rows.length) return rows;
  const m=new Map(divs.map(d=>[d.date,d.cash]));
  let sh=1, out=[{date:rows[0].date,close:rows[0].close}];
  for(let i=1;i<rows.length;i++){
    const {date,close}=rows[i];
    if(m.has(date)) sh+=m.get(date)/close;
    out.push({date,close:+(sh*close).toFixed(6)});
  } return out;
}

/* ---------- 主匯出 ---------- */
export async function fetchPrices(list,start,end){
  const out={};
  for(const tk of list){
    try{
      let rows;
      if(isNonUsTicker(tk)){ // 直接 Yahoo
        rows=await yahooAdj(tk,start,end);
      }else{
        rows=await stooq(tk);
        if(rows.length<50) throw 0;           // 筆數過少 → 視同失敗
        const divs=await yahooDiv(tk,start,end);
        rows=addDiv(rows,divs);
      }
      out[tk]=rows.filter(r=>r.date>=start&&r.date<=end);
    }catch{ // 完全失敗 → Yahoo Adj
      out[tk]=await yahooAdj(tk,start,end);
    }
  }
  return out;
}
