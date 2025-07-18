import { fetchPrices }       from '../_lib/fetchPrices.js';
import { simulatePortfolio } from '../_lib/portfolio.js';
import { calcMetrics }       from '../_lib/metrics.js';

function monthEnd(y,m){ return new Date(y,Number(m),0).toISOString().slice(0,10); }

/* 新：傳回所有日期 union，再 forward-fill 欠缺值；保證有資料 */
function buildCommonDates(priceMap,tickers){
  // 1. 取所有日期 union
  const set=new Set();
  tickers.forEach(tk=>priceMap[tk].forEach(r=>set.add(r.date)));
  const dates=Array.from(set).sort();
  // 2. 如果某支股票缺某天 → 用前一天價 (no gap)
  tickers.forEach(tk=>{
    const m=new Map(priceMap[tk].map(r=>[r.date,r.close]));
    let last=null;
    priceMap[tk]=dates.map(d=>{
      if(m.has(d)) last=m.get(d);
      return {date:d,close:last};
    }).filter(r=>last!==null); // 前段若全部缺就會被剔除
  });
  return dates.filter(d => tickers.every(tk => priceMap[tk]
                      .some(r=>r.date===d && r.close!==null)));
}

export const onRequestPost = async ({request})=>{
  try{
    const p=await request.json();
    const start=`${p.startYear}-${String(p.startMonth).padStart(2,'0')}-01`;
    const end  =monthEnd(p.endYear,p.endMonth);

    const portfolios=p.portfolios||[];
    const tickAll=new Set(portfolios.flatMap(pt=>pt.tickers));
    if(p.benchmark) tickAll.add(p.benchmark);
    if(!tickAll.size) return json({error:'請至少設定資產'},400);

    const priceMap=await fetchPrices([...tickAll],start,end);
    const dates=buildCommonDates(priceMap,[...tickAll]);

    if(dates.length<20) return json({error:'共同交易日過少'},400);

    const initAmt=+p.initialAmount||10000;
    /* --- benchmark (optional) --- */
    let benchEq=null, benchmark=null;
    if(p.benchmark){
      benchEq=simulatePortfolio(dates,priceMap,[p.benchmark],[100],initAmt,'never');
      const bm=calcMetrics(dates,benchEq);
      benchmark={name:p.benchmark,...bm,beta:1,alpha:0,
        portfolioHistory:dates.map((d,i)=>({date:d,value:benchEq[i]}))};
    }

    const res=[];
    for(const pt of portfolios){
      const eq=simulatePortfolio(dates,priceMap,pt.tickers,pt.weights,initAmt,pt.rebalancingPeriod||'never');
      const m=benchEq?calcMetrics(dates,eq,dates,benchEq):calcMetrics(dates,eq);
      res.push({name:pt.name,...m,
        portfolioHistory:dates.map((d,i)=>({date:d,value:eq[i]}))});
    }
    return json({data:res,benchmark});
  }catch(e){
    return json({error:e.message||'unknown'},500);
  }
};

const json=(o,s=200)=>new Response(JSON.stringify(o),{status:s,headers:{'content-type':'application/json'}});
