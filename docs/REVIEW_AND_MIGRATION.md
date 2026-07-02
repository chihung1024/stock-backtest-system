# 專案審查與 Cloudflare 遷移計畫

## 結論

建議採用分階段遷移，不要直接把現有 Flask + pandas + yfinance 程式原樣改成一般 Cloudflare Python Worker。

1. 先在現有 Vercel 後端修正安全性、輸入驗證、公式與測試。
2. 前端搬到 Cloudflare Workers Static Assets，並由同一個 Worker 將 `/api/*` 反向代理至 Vercel，避免跨網域 CORS 與一次性大爆改。
3. 將行情擷取從使用者請求中拆出，定期寫入 R2；中長期後端可改為 Cloudflare Container，或將純回測核心重寫成 Worker。
4. 長時間的全市場掃描改成非同步工作，以 Queue / Workflow 執行並回報進度。

## 立即風險

- `/api/debug` 與 Flask `/` 會回傳所有環境變數，必須移除並輪替可能暴露的 secret。
- API 未限制股票數量、日期、金額或投資組合結構，容易造成資源濫用與非預期 500。
- 500 回應包含原始例外文字，會洩漏內部實作。
- `requests.get()` 沒有 timeout。
- 執行期依賴未鎖定，CI 與自動測試不存在。

## 正確性問題

- Sharpe / Sortino 以 CAGR 除以波動率，不是標準日報酬超額收益公式。
- benchmark 的 `beta=1`、`alpha=0` 會被後續 `update()` 覆寫成 `None`。
- yfinance 的 `end` 為不含該日；原本傳月底日期可能漏掉月底交易日。
- 模組化前端送出 `filters`，後端只讀 `minMarketCap`，多項篩選條件實際沒有生效。
- 模組化前端呼叫 `/api/all-tickers`，後端原本沒有該 endpoint。
- 舊 `worker/main.py` 使用加權原始股價計算組合，實際初始權重會受各股票價格影響，並且沒有真正實作再平衡、benchmark、scan 或 screener。

## Cloudflare 目標架構

```text
Browser
  -> Cloudflare Worker + Static Assets
       -> /api/* edge validation / rate limit / cache
            -> Phase 1: Vercel Flask API
            -> Phase 2: Cloudflare Container API
       -> R2 market data snapshots
       -> D1 universe / metadata
       -> Queue or Workflow for long scans
```

### 為何不直接使用現有 Python Worker

現有後端依賴 pandas、numpy、yfinance 與同步 HTTP 行為。Python Workers 雖然已支援更多 PyPI / Pyodide 套件，但 HTTP client 必須能非同步運作；yfinance 的完整執行路徑不適合作為此專案的低風險直接移植方案。一般 Worker 也有 128 MB 記憶體限制，對多股票 DataFrame 與大範圍掃描不理想。

Cloudflare Containers 可使用 Dockerfile、完整 Linux runtime、較大的記憶體與磁碟，適合保留 Flask / pandas；代價是 Workers Paid plan、容器冷啟動與額外用量成本。

## 測試現代化

- 單元測試：使用合成價格資料，不讓 CI 依賴 Yahoo 網路。
- Property-based testing：權重守恆、再平衡前後總資產不變、固定價格報酬為零、benchmark 對自身 beta 為 1。
- Differential testing：與一份簡單 NumPy 參考模型或成熟回測套件比較。
- Contract testing：以 JSON Schema / OpenAPI 固定前後端 payload。
- Playwright E2E：mock API，測試建立投組、錯誤狀態、排序、行動版與下載。
- Accessibility：axe-core；visual regression：Playwright screenshot。
- Mutation testing：確定測試真的能抓到公式錯誤。
- AI 可協助產生測試案例、探索 UI 與分類失敗，但 expected values 必須由確定性公式或 golden fixtures 產生，不由 LLM 猜測。

## 使用者體驗優先項目

1. 即時權重驗證與一鍵正規化至 100%。
2. 股票代碼 autocomplete 顯示公司名稱、交易所與資料可用起日。
3. 顯示資料更新時間、資料來源、股息、交易成本與再平衡假設。
4. 不要靜默丟棄缺失日期；逐檔說明對比較期間的影響。
5. 結果增加 drawdown 圖、rolling return、月報酬 heatmap 與 benchmark 差異。
6. 儲存 / 載入 preset、匯出 CSV/JSON、分享唯讀設定連結。
7. 大型掃描顯示進度、允許取消並保存結果。
8. AI 摘要只能解釋已計算的指標與風險，不應取代回測引擎或暗示投資保證。

## 後續 PR 建議

- PR 1：安全性、驗證、公式與基礎 CI（本 PR）。
- PR 2：移除重複前端實作，改為單一 Vite/TypeScript 入口及 API schema。
- PR 3：Cloudflare Worker Static Assets + Vercel API proxy，加入 preview deployment。
- PR 4：行情擷取 pipeline、R2 儲存與結果 cache。
- PR 5：Container 或純 Worker 回測引擎，經 differential tests 驗證後切流。
