# Stock Backtest System

美股投資組合回測、個股績效掃描與基本面預篩選工具。

## 目前架構

- Frontend：`public/backtest.html`，由 Vercel static hosting 提供。
- Backend：`api/index.py`，Flask serverless API。
- Market data：透過 `yfinance` 即時取得調整後收盤價。
- Screener data：透過 `GIST_RAW_URL` 指向預處理 JSON。

## 本機測試

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt -r requirements-dev.txt
pytest -q
ruff check api tests
```

## 環境變數

- `GIST_RAW_URL`：預處理股票清單 JSON 的 raw URL，screener 與 autocomplete 需要。
- `RISK_FREE_RATE`：年化無風險利率，小數格式；未設定時為 `0`。

請勿將 secret 提交至 repository，應使用 Vercel Environment Variables 或 GitHub Actions Secrets。

## API

- `POST /api/backtest`
- `POST /api/scan`
- `POST /api/screener`
- `GET /api/all-tickers`
- `GET /api/health`

## Cloudflare 遷移

建議先將前端遷移至 Cloudflare Workers Static Assets，並以 Worker 反向代理現有 Vercel API；資料擷取與後端運算再分階段改為 R2 pipeline 與 Cloudflare Container／Worker。

完整審查、風險與遷移步驟請見 [`docs/REVIEW_AND_MIGRATION.md`](docs/REVIEW_AND_MIGRATION.md)。

## 重要限制

目前資料來源適合研究與教育用途。回測未完整納入稅務、滑價、交易成本、匯率、下市標的與歷史指數成分變動，不應視為投資建議或未來績效保證。
