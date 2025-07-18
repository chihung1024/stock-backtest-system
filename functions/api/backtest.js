// functions/api/backtest.js
// -------------------------------------------------------------
// 只做 Proxy：把 Cloudflare Pages 端點  /api/backtest
// 轉送到 Python Worker  (https://backtest-worker.<帳號>.workers.dev/backtest)
// -------------------------------------------------------------

// ① 先把下面子網域換成你真正 Worker 的 URL
const WORKER_URL = 'https://backtest-worker.chired.workers.dev/backtest';

export const onRequest = async ({ request }) => {
  // 將使用者的原始請求「複製」一份，目的地改成 Worker_URL
  const forward = new Request(WORKER_URL, {
    method:  request.method,
    headers: request.headers,
    body:    request.body,        // POST JSON 直接帶過去
    redirect: 'follow'
  });

  // 把 Worker 的回應直接回傳給瀏覽器
  return fetch(forward);
};
