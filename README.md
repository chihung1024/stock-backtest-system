# stock-backtester

## Frontend deployment (Cloudflare Pages)

前端靜態檔案已改為放在 `public/` 並部署到 **Cloudflare Pages**。

### 1) 建立 Cloudflare Pages 專案
- Framework preset: `None`
- Build command: 留空
- Build output directory: `public`

### 2) 設定 GitHub Secrets（供 workflow 使用）
在 repository secrets 加入：
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_PAGES_PROJECT`（Cloudflare Pages 專案名稱）

### 3) API 網域設定（前後端分離）
前端改為可透過 `window.__API_BASE_URL__` 指定後端 API 網域。
- 預設：空字串（同網域，呼叫 `/api/...`）
- 若前端在 Cloudflare、後端在其他網域（如 Vercel/Workers），請在 `public/backtest.html` 內設定：

```html
<script>
  window.__API_BASE_URL__ = 'https://your-api-domain.example.com';
</script>
```

> 程式會自動組合為 `https://your-api-domain.example.com/api/...`。
