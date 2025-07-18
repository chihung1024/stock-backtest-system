# worker/main.py  –  Cloudflare Workers (Python Runtime)
import json, math, datetime, asyncio
import pandas as pd
import yfinance as yf
import backtrader as bt

def calc_metrics(equity: pd.Series):
    if equity.size < 2:
        return {"cagr":0,"volatility":0,"mdd":0,
                "sharpe_ratio":0,"sortino_ratio":0,"beta":None,"alpha":None}

    years = (equity.index[-1] - equity.index[0]).days / 365.25
    cagr  = (equity.iloc[-1] / equity.iloc[0]) ** (1/years) - 1

    # 最大回撤
    roll_max = equity.cummax()
    dd = equity / roll_max - 1
    mdd = dd.min()

    daily_ret = equity.pct_change().dropna()
    vol = daily_ret.std() * math.sqrt(252)
    sharpe = (cagr) / vol if vol else 0
    downside = daily_ret[daily_ret<0]
    sortino = (cagr) / (downside.std()*math.sqrt(252)) if downside.std() else 0

    return dict(cagr=cagr, volatility=vol, mdd=mdd,
                sharpe_ratio=sharpe, sortino_ratio=sortino,
                beta=None, alpha=None)

async def fetch_portfolio_history(tickers, weights, start, end):
    dfs = []
    for t in tickers:
        df = yf.download(t, start=start, end=end, auto_adjust=True, progress=False)[['Close']]
        df.rename(columns={'Close': t}, inplace=True)
        dfs.append(df)
    prices = pd.concat(dfs, axis=1).dropna()
    w = pd.Series(weights, index=tickers)/100
    equity = (prices * w).sum(axis=1)
    return equity

async def handle_backtest(event):
    body = await event.request.json()

    start = f"{body['startYear']}-{body['startMonth']:02d}-01"
    end   = f"{body['endYear']}-{body['endMonth']:02d}-28"
    init  = body.get('initialAmount', 10000)

    portfolios = body['portfolios']
    out = []
    for p in portfolios:
        equity = await fetch_portfolio_history(
            p['tickers'],
            p.get('weights',[100/len(p['tickers'])]*len(p['tickers'])),
            start, end
        )
        equity = equity / equity.iloc[0] * init             # 讓首日 = initialAmount
        metrics = calc_metrics(equity)
        out.append({
            "name": p['name'],
            **metrics,
            "portfolioHistory":[{"date":d.strftime('%Y-%m-%d'),"value":float(v)}
                                for d,v in equity.items()]
        })

    return event.response.json({
        "data": out,
        "benchmark": None,        # 省略 benchmark；同樣可用 fetch_portfolio_history 再算
        "warning": None
    })

async def on_request(event):
    path = event.request.path
    if path == "/backtest":
        return await handle_backtest(event)
    return event.response.json({"msg":"unknown route"}, status=404)
