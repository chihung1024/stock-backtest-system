import logging
import math
import os
import re
from collections.abc import Iterable

import numpy as np
import pandas as pd
import requests
import yfinance as yf
from cachetools import TTLCache, cached
from flask import Flask, jsonify, request

app = Flask(__name__)
logger = logging.getLogger(__name__)

TRADING_DAYS_PER_YEAR = 252
DAYS_PER_YEAR = 365.25
EPSILON = 1e-9
MAX_PORTFOLIOS = 5
MAX_ASSETS_PER_PORTFOLIO = 50
MAX_SCAN_TICKERS = 100
MIN_YEAR = 1980
TICKER_PATTERN = re.compile(r"^[A-Z0-9.^=_-]{1,20}$")
ALLOWED_REBALANCING_PERIODS = {"never", "annually", "quarterly", "monthly"}
SCREENER_NUMERIC_FIELDS = {
    "marketCap",
    "trailingPE",
    "dividendYield",
    "returnOnEquity",
    "revenueGrowth",
    "earningsGrowth",
}

try:
    RISK_FREE_RATE = float(os.environ.get("RISK_FREE_RATE", "0"))
except ValueError:
    RISK_FREE_RATE = 0.0

GIST_RAW_URL = os.environ.get("GIST_RAW_URL")
cache = TTLCache(maxsize=128, ttl=600)


class ValidationError(ValueError):
    """Raised when an API request does not satisfy the public contract."""


def error_response(message, status=400):
    return jsonify({"error": message}), status


@app.after_request
def add_api_headers(response):
    response.headers.setdefault("Cache-Control", "no-store")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    return response


def require_json_object():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ValidationError("請提供有效的 JSON 物件。")
    return data


def normalize_ticker(value):
    ticker = str(value or "").strip().upper()
    if not TICKER_PATTERN.fullmatch(ticker):
        raise ValidationError(f"無效的股票代碼：{ticker or '(空白)'}")
    return ticker


def deduplicate(values: Iterable[str]):
    return list(dict.fromkeys(values))


def parse_period(data):
    try:
        start_year = int(data["startYear"])
        start_month = int(data["startMonth"])
        end_year = int(data["endYear"])
        end_month = int(data["endMonth"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValidationError("起訖年月格式不正確。") from exc

    current_year = pd.Timestamp.utcnow().year
    if not (MIN_YEAR <= start_year <= current_year and MIN_YEAR <= end_year <= current_year):
        raise ValidationError(f"年份必須介於 {MIN_YEAR} 與 {current_year} 之間。")
    if not (1 <= start_month <= 12 and 1 <= end_month <= 12):
        raise ValidationError("月份必須介於 1 與 12 之間。")

    start_date = pd.Timestamp(start_year, start_month, 1)
    end_exclusive = pd.Timestamp(end_year, end_month, 1) + pd.offsets.MonthBegin(1)
    if start_date >= end_exclusive:
        raise ValidationError("結束年月必須晚於起始年月。")
    return start_date, end_exclusive


def validate_initial_amount(value):
    try:
        amount = float(value)
    except (TypeError, ValueError) as exc:
        raise ValidationError("初始投資金額格式不正確。") from exc
    if not math.isfinite(amount) or amount <= 0 or amount > 1e12:
        raise ValidationError("初始投資金額必須大於 0 且不超過 1 兆美元。")
    return amount


def validate_portfolios(raw_portfolios, default_rebalancing_period):
    if not isinstance(raw_portfolios, list) or not raw_portfolios:
        raise ValidationError("請至少設定一個投資組合。")
    if len(raw_portfolios) > MAX_PORTFOLIOS:
        raise ValidationError(f"最多只能比較 {MAX_PORTFOLIOS} 組投資組合。")

    validated = []
    names = set()
    for index, raw in enumerate(raw_portfolios, start=1):
        if not isinstance(raw, dict):
            raise ValidationError(f"第 {index} 個投資組合格式不正確。")

        name = str(raw.get("name") or f"投組 {index}").strip()[:80]
        if not name or name in names:
            raise ValidationError("投資組合名稱不可空白或重複。")
        names.add(name)

        raw_tickers = raw.get("tickers")
        raw_weights = raw.get("weights")
        if not isinstance(raw_tickers, list) or not isinstance(raw_weights, list):
            raise ValidationError(f'投資組合「{name}」缺少股票代碼或權重。')
        if not raw_tickers or len(raw_tickers) != len(raw_weights):
            raise ValidationError(f'投資組合「{name}」的股票代碼與權重數量不一致。')
        if len(raw_tickers) > MAX_ASSETS_PER_PORTFOLIO:
            raise ValidationError(f'投資組合「{name}」最多可包含 {MAX_ASSETS_PER_PORTFOLIO} 項資產。')

        tickers = [normalize_ticker(ticker) for ticker in raw_tickers]
        if len(set(tickers)) != len(tickers):
            raise ValidationError(f'投資組合「{name}」包含重複股票代碼。')

        try:
            weights = [float(weight) for weight in raw_weights]
        except (TypeError, ValueError) as exc:
            raise ValidationError(f'投資組合「{name}」包含無效權重。') from exc
        if any(not math.isfinite(weight) or weight <= 0 or weight > 100 for weight in weights):
            raise ValidationError(f'投資組合「{name}」的每項權重必須介於 0 與 100 之間。')
        if abs(sum(weights) - 100.0) > 0.01:
            raise ValidationError(f'投資組合「{name}」的總權重必須為 100%。')

        period = raw.get("rebalancingPeriod", default_rebalancing_period)
        if period not in ALLOWED_REBALANCING_PERIODS:
            raise ValidationError(f'投資組合「{name}」的再平衡週期無效。')

        validated.append(
            {
                "name": name,
                "tickers": tickers,
                "weights": weights,
                "rebalancingPeriod": period,
            }
        )
    return validated


def calculate_metrics(portfolio_history, benchmark_history=None, risk_free_rate=RISK_FREE_RATE):
    values = portfolio_history["value"].dropna().astype(float).copy()
    empty_result = {
        "cagr": 0.0,
        "mdd": 0.0,
        "volatility": 0.0,
        "sharpe_ratio": 0.0,
        "sortino_ratio": 0.0,
        "beta": None,
        "alpha": None,
    }
    if len(values) < 2 or values.iloc[0] <= EPSILON:
        return empty_result

    years = (values.index[-1] - values.index[0]).days / DAYS_PER_YEAR
    cagr = (values.iloc[-1] / values.iloc[0]) ** (1 / years) - 1 if years > 0 else 0.0
    drawdown = values / values.cummax() - 1
    mdd = float(drawdown.min())
    daily_returns = values.pct_change().dropna()
    if len(daily_returns) < 2:
        return {**empty_result, "cagr": float(cagr), "mdd": mdd}

    daily_risk_free_rate = (1 + risk_free_rate) ** (1 / TRADING_DAYS_PER_YEAR) - 1
    excess_returns = daily_returns - daily_risk_free_rate
    annual_std = float(daily_returns.std(ddof=1) * np.sqrt(TRADING_DAYS_PER_YEAR))
    annualized_excess_return = float(excess_returns.mean() * TRADING_DAYS_PER_YEAR)
    sharpe_ratio = annualized_excess_return / annual_std if annual_std > EPSILON else 0.0
    downside_deviation = float(
        np.sqrt(np.square(np.minimum(excess_returns, 0)).mean()) * np.sqrt(TRADING_DAYS_PER_YEAR)
    )
    sortino_ratio = annualized_excess_return / downside_deviation if downside_deviation > EPSILON else 0.0

    beta = None
    alpha = None
    if benchmark_history is not None and not benchmark_history.empty:
        benchmark_returns = benchmark_history["value"].dropna().astype(float).pct_change().dropna()
        aligned = pd.concat([daily_returns, benchmark_returns], axis=1, join="inner").dropna()
        aligned.columns = ["portfolio", "benchmark"]
        if len(aligned) > 1:
            benchmark_variance = float(aligned["benchmark"].var(ddof=1))
            if benchmark_variance > EPSILON:
                beta = float(aligned["portfolio"].cov(aligned["benchmark"]) / benchmark_variance)
                portfolio_mean = float(aligned["portfolio"].mean())
                benchmark_mean = float(aligned["benchmark"].mean())
                alpha = float(
                    (portfolio_mean - (daily_risk_free_rate + beta * (benchmark_mean - daily_risk_free_rate)))
                    * TRADING_DAYS_PER_YEAR
                )

    def finite_or_default(value, default):
        return float(value) if value is not None and np.isfinite(value) else default

    return {
        "cagr": finite_or_default(cagr, 0.0),
        "mdd": finite_or_default(mdd, 0.0),
        "volatility": finite_or_default(annual_std, 0.0),
        "sharpe_ratio": finite_or_default(sharpe_ratio, 0.0),
        "sortino_ratio": finite_or_default(sortino_ratio, 0.0),
        "beta": finite_or_default(beta, None),
        "alpha": finite_or_default(alpha, None),
    }


def get_rebalancing_dates(df_prices, period):
    if period == "never":
        return set()
    periods = {
        "annually": df_prices.index.to_period("Y"),
        "quarterly": df_prices.index.to_period("Q"),
        "monthly": df_prices.index.to_period("M"),
    }
    period_index = periods.get(period)
    if period_index is None:
        return set()
    first_dates = df_prices.groupby(period_index).head(1).index
    return set(first_dates[1:])


def run_simulation(portfolio_config, price_data, initial_amount, benchmark_history=None):
    tickers = portfolio_config["tickers"]
    weights = np.asarray(portfolio_config["weights"], dtype=float) / 100.0
    df_prices = price_data[tickers].dropna().astype(float).copy()
    if df_prices.empty:
        return None

    portfolio_history = pd.Series(index=df_prices.index, dtype=float, name="value")
    rebalancing_dates = get_rebalancing_dates(df_prices, portfolio_config["rebalancingPeriod"])
    shares = (initial_amount * weights) / df_prices.iloc[0]
    portfolio_history.iloc[0] = initial_amount

    for position in range(1, len(df_prices)):
        current_date = df_prices.index[position]
        current_prices = df_prices.iloc[position]
        current_value = float((shares * current_prices).sum())
        portfolio_history.iloc[position] = current_value
        if current_date in rebalancing_dates:
            shares = (current_value * weights) / current_prices

    history_frame = portfolio_history.dropna().to_frame("value")
    metrics = calculate_metrics(history_frame, benchmark_history)
    return {
        "name": portfolio_config["name"],
        **metrics,
        "portfolioHistory": [
            {"date": date.strftime("%Y-%m-%d"), "value": float(value)}
            for date, value in history_frame["value"].items()
        ],
    }


def validate_data_completeness(df_prices_raw, tickers, requested_start_date):
    problematic_tickers = []
    for ticker in tickers:
        if ticker not in df_prices_raw.columns:
            continue
        first_valid_date = df_prices_raw[ticker].first_valid_index()
        if first_valid_date is not None and first_valid_date > requested_start_date + pd.offsets.BDay(5):
            problematic_tickers.append({"ticker": ticker, "start_date": first_valid_date.strftime("%Y-%m-%d")})
    return problematic_tickers


@cached(cache)
def download_data_silently(tickers, start_date, end_date):
    chunks = [tickers[index : index + 15] for index in range(0, len(tickers), 15)]
    data_frames = []
    for chunk in chunks:
        downloaded = yf.download(
            list(chunk),
            start=start_date,
            end=end_date,
            auto_adjust=True,
            progress=False,
            threads=True,
        )
        if downloaded.empty:
            continue
        close_prices = downloaded["Close"]
        if isinstance(close_prices, pd.Series):
            close_prices = close_prices.to_frame(name=chunk[0])
        data_frames.append(close_prices)
    if not data_frames:
        return pd.DataFrame(columns=list(tickers))
    return pd.concat(data_frames, axis=1)


def normalized_benchmark_history(prices, initial_amount):
    prices = prices.dropna().astype(float)
    if prices.empty:
        return None
    return (prices / prices.iloc[0] * initial_amount).to_frame("value")


@app.route("/api/backtest", methods=["POST"])
def backtest_handler():
    try:
        data = require_json_object()
        start_date, end_exclusive = parse_period(data)
        initial_amount = validate_initial_amount(data.get("initialAmount"))
        default_period = data.get("rebalancingPeriod", "never")
        if default_period not in ALLOWED_REBALANCING_PERIODS:
            raise ValidationError("再平衡週期無效。")
        portfolios = validate_portfolios(data.get("portfolios"), default_period)
        benchmark_ticker = normalize_ticker(data["benchmark"]) if data.get("benchmark") else None

        portfolio_tickers = deduplicate(
            ticker for portfolio in portfolios for ticker in portfolio["tickers"]
        )
        download_tickers = tuple(sorted(set(portfolio_tickers + ([benchmark_ticker] if benchmark_ticker else []))))
        prices_raw = download_data_silently(
            download_tickers,
            start_date.strftime("%Y-%m-%d"),
            end_exclusive.strftime("%Y-%m-%d"),
        )

        failed_tickers = [
            ticker
            for ticker in download_tickers
            if ticker not in prices_raw.columns or prices_raw[ticker].isna().all()
        ]
        if failed_tickers:
            raise ValidationError(f"無法獲取以下股票代碼的數據: {', '.join(failed_tickers)}")

        problematic = validate_data_completeness(prices_raw, portfolio_tickers, start_date)
        warning_message = None
        if problematic:
            details = ", ".join(f"{item['ticker']} (從 {item['start_date']} 開始)" for item in problematic)
            warning_message = f"部分資產資料起始日晚於選擇日期；各投資組合使用其共同可用交易日。受影響資產：{details}"

        benchmark_history = None
        benchmark_result = None
        if benchmark_ticker:
            benchmark_history = normalized_benchmark_history(prices_raw[benchmark_ticker], initial_amount)
            if benchmark_history is not None:
                benchmark_metrics = calculate_metrics(benchmark_history)
                benchmark_result = {
                    "name": benchmark_ticker,
                    **benchmark_metrics,
                    "beta": 1.0,
                    "alpha": 0.0,
                    "portfolioHistory": [
                        {"date": date.strftime("%Y-%m-%d"), "value": float(value)}
                        for date, value in benchmark_history["value"].items()
                    ],
                }

        results = []
        for portfolio in portfolios:
            result = run_simulation(portfolio, prices_raw, initial_amount, benchmark_history)
            if result:
                results.append(result)
        if not results:
            raise ValidationError("沒有足夠的共同交易日來進行回測。")

        return jsonify({"data": results, "benchmark": benchmark_result, "warning": warning_message})
    except ValidationError as exc:
        return error_response(str(exc), 400)
    except Exception:
        logger.exception("Unexpected error in backtest endpoint")
        return error_response("伺服器發生未預期的錯誤。", 500)


@app.route("/api/scan", methods=["POST"])
def scan_handler():
    try:
        data = require_json_object()
        start_date, end_exclusive = parse_period(data)
        raw_tickers = data.get("tickers")
        if not isinstance(raw_tickers, list) or not raw_tickers:
            raise ValidationError("股票代碼列表不可為空。")
        tickers = deduplicate(normalize_ticker(ticker) for ticker in raw_tickers)
        if len(tickers) > MAX_SCAN_TICKERS:
            raise ValidationError(f"單次最多掃描 {MAX_SCAN_TICKERS} 檔標的。")
        benchmark_ticker = normalize_ticker(data["benchmark"]) if data.get("benchmark") else None
        download_tickers = tuple(sorted(set(tickers + ([benchmark_ticker] if benchmark_ticker else []))))
        prices_raw = download_data_silently(
            download_tickers,
            start_date.strftime("%Y-%m-%d"),
            end_exclusive.strftime("%Y-%m-%d"),
        )

        benchmark_history = None
        if benchmark_ticker and benchmark_ticker in prices_raw.columns:
            benchmark_prices = prices_raw[benchmark_ticker].dropna()
            if not benchmark_prices.empty:
                benchmark_history = benchmark_prices.to_frame("value")

        results = []
        for ticker in tickers:
            if ticker not in prices_raw.columns or prices_raw[ticker].dropna().empty:
                results.append({"ticker": ticker, "error": "指定範圍內無數據"})
                continue
            prices = prices_raw[ticker].dropna()
            note = None
            problematic = validate_data_completeness(prices_raw, [ticker], start_date)
            if problematic:
                note = f"(從 {problematic[0]['start_date']} 開始)"
            metrics = calculate_metrics(prices.to_frame("value"), benchmark_history)
            results.append({"ticker": ticker, **metrics, "note": note})
        return jsonify(results)
    except ValidationError as exc:
        return error_response(str(exc), 400)
    except Exception:
        logger.exception("Unexpected error in scan endpoint")
        return error_response("伺服器發生未預期的錯誤。", 500)


@cached(cache)
def get_preprocessed_data():
    if not GIST_RAW_URL:
        raise RuntimeError("GIST_RAW_URL 環境變數未設定。")
    response = requests.get(GIST_RAW_URL, timeout=10)
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, list):
        raise RuntimeError("預處理股票資料格式不正確。")
    return payload


def stock_matches_filters(stock, filters):
    for field, limits in filters.items():
        if field not in SCREENER_NUMERIC_FIELDS or not isinstance(limits, dict):
            continue
        value = stock.get(field)
        if value is None:
            return False
        try:
            numeric_value = float(value)
            minimum = float(limits["min"]) if "min" in limits else None
            maximum = float(limits["max"]) if "max" in limits else None
        except (TypeError, ValueError):
            return False
        if minimum is not None and numeric_value < minimum:
            return False
        if maximum is not None and numeric_value > maximum:
            return False
    return True


@app.route("/api/screener", methods=["POST"])
def screener_handler():
    try:
        data = require_json_object()
        index_name = data.get("index", "sp500")
        sector = data.get("sector", "any")
        filters = data.get("filters") if isinstance(data.get("filters"), dict) else {}
        if "minMarketCap" in data and "marketCap" not in filters:
            filters = {**filters, "marketCap": {"min": data.get("minMarketCap", 0)}}

        all_stocks = get_preprocessed_data()
        membership_fields = {
            "sp500": "in_sp500",
            "nasdaq100": "in_nasdaq100",
            "russell3000": "in_russell3000",
        }
        membership_field = membership_fields.get(index_name)
        base_pool = [stock for stock in all_stocks if not membership_field or stock.get(membership_field)]

        filtered = []
        for stock in base_pool:
            if sector != "any" and stock.get("sector") != sector:
                continue
            if not stock_matches_filters(stock, filters):
                continue
            try:
                filtered.append(normalize_ticker(stock.get("ticker")))
            except ValidationError:
                continue
        return jsonify(sorted(set(filtered)))
    except ValidationError as exc:
        return error_response(str(exc), 400)
    except RuntimeError as exc:
        logger.error("Screener configuration error: %s", exc)
        return error_response("篩選器資料來源尚未正確設定。", 503)
    except Exception:
        logger.exception("Unexpected error in screener endpoint")
        return error_response("篩選器發生未預期的錯誤。", 500)


@app.route("/api/all-tickers", methods=["GET"])
def all_tickers_handler():
    try:
        tickers = []
        for stock in get_preprocessed_data():
            try:
                tickers.append(normalize_ticker(stock.get("ticker")))
            except ValidationError:
                continue
        return jsonify(sorted(set(tickers)))
    except RuntimeError as exc:
        logger.error("Ticker source configuration error: %s", exc)
        return error_response("股票清單資料來源尚未正確設定。", 503)
    except Exception:
        logger.exception("Unexpected error in all-tickers endpoint")
        return error_response("股票清單暫時無法取得。", 500)


@app.route("/api/health", methods=["GET"])
def health_handler():
    return jsonify({"status": "ok", "service": "stock-backtest-api"})
