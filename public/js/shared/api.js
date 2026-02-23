// api.js: 封裝所有與後端 API 的通訊
import { dom } from './dom.js';
import { displayError } from '../backtester/backtester_ui.js';

async function fetchApi(url, options) {
    const response = await fetch(url, options);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP 錯誤: ${response.status}`);
    return result;
}
function buildApiUrl(path) {
    const baseUrl = (window.__API_BASE_URL__ || '').replace(/\/$/, '');
    return baseUrl ? `${baseUrl}${path}` : path;
}

export async function fetchAvailableTickers() {
    try { return await fetchApi(buildApiUrl('/api/all-tickers')); } catch (error) { console.error("獲取股票列表失敗:", error); return []; }
}
export async function runBacktest(payload) { return await fetchApi(buildApiUrl('/api/backtest'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }
export async function runScan(payload) { return await fetchApi(buildApiUrl('/api/scan'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }
export async function runScreener(payload) {
    try { return await fetchApi(buildApiUrl('/api/screener'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }
    catch (error) { displayError(dom.screenerErrorContainer, error.message); return null; }
}
