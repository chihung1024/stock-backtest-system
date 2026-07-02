import numpy as np
import pandas as pd
import pytest

from api import index as api


@pytest.fixture()
def client():
    api.app.config.update(TESTING=True)
    return api.app.test_client()


def business_prices(columns=("AAA", "SPY"), periods=260):
    dates = pd.bdate_range("2023-01-02", periods=periods)
    data = {}
    base_returns = 0.0005 + 0.0002 * np.sin(np.arange(periods) / 7)
    for position, ticker in enumerate(columns):
        returns = base_returns + position * 0.0001
        data[ticker] = 100 * np.cumprod(1 + returns)
    return pd.DataFrame(data, index=dates)


def test_health_does_not_expose_environment(client, monkeypatch):
    monkeypatch.setenv("SUPER_SECRET", "do-not-leak")
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.get_json() == {"service": "stock-backtest-api", "status": "ok"}
    assert b"SUPER_SECRET" not in response.data
    assert client.get("/api/debug").status_code == 404


def test_calculate_metrics_does_not_mutate_input_and_self_beta_is_one():
    history = business_prices(("AAA",), 260).rename(columns={"AAA": "value"})
    original_columns = history.columns.tolist()
    metrics = api.calculate_metrics(history, history)
    assert history.columns.tolist() == original_columns
    assert metrics["cagr"] > 0
    assert metrics["mdd"] <= 0
    assert metrics["beta"] == pytest.approx(1.0, abs=1e-10)
    assert metrics["alpha"] == pytest.approx(0.0, abs=1e-10)


def test_backtest_rejects_invalid_weights_without_downloading(client, monkeypatch):
    def should_not_run(*args, **kwargs):
        raise AssertionError("market data should not be requested")

    monkeypatch.setattr(api, "download_data_silently", should_not_run)
    response = client.post(
        "/api/backtest",
        json={
            "initialAmount": 10000,
            "startYear": 2023,
            "startMonth": 1,
            "endYear": 2023,
            "endMonth": 12,
            "rebalancingPeriod": "annually",
            "benchmark": "SPY",
            "portfolios": [
                {
                    "name": "Invalid",
                    "tickers": ["AAA", "BBB"],
                    "weights": [60, 30],
                    "rebalancingPeriod": "annually",
                }
            ],
        },
    )
    assert response.status_code == 400
    assert "100%" in response.get_json()["error"]


def test_backtest_returns_explicit_benchmark_beta_and_alpha(client, monkeypatch):
    prices = business_prices(("AAA", "SPY"), 260)
    monkeypatch.setattr(api, "download_data_silently", lambda *args, **kwargs: prices)
    response = client.post(
        "/api/backtest",
        json={
            "initialAmount": 10000,
            "startYear": 2023,
            "startMonth": 1,
            "endYear": 2023,
            "endMonth": 12,
            "rebalancingPeriod": "never",
            "benchmark": "SPY",
            "portfolios": [
                {
                    "name": "Portfolio",
                    "tickers": ["AAA"],
                    "weights": [100],
                    "rebalancingPeriod": "never",
                }
            ],
        },
    )
    assert response.status_code == 200
    benchmark = response.get_json()["benchmark"]
    assert benchmark["beta"] == 1.0
    assert benchmark["alpha"] == 0.0


def test_screener_supports_modular_frontend_filters(client, monkeypatch):
    stocks = [
        {
            "ticker": "AAA",
            "in_sp500": True,
            "sector": "Technology",
            "marketCap": 500e9,
            "trailingPE": 20,
        },
        {
            "ticker": "BBB",
            "in_sp500": True,
            "sector": "Technology",
            "marketCap": 50e9,
            "trailingPE": 60,
        },
    ]
    monkeypatch.setattr(api, "get_preprocessed_data", lambda: stocks)
    response = client.post(
        "/api/screener",
        json={
            "index": "sp500",
            "sector": "Technology",
            "filters": {"marketCap": {"min": 100e9}, "trailingPE": {"max": 30}},
        },
    )
    assert response.status_code == 200
    assert response.get_json() == ["AAA"]


def test_all_tickers_is_available_for_autocomplete(client, monkeypatch):
    monkeypatch.setattr(
        api,
        "get_preprocessed_data",
        lambda: [{"ticker": "MSFT"}, {"ticker": "AAPL"}, {"ticker": "MSFT"}],
    )
    response = client.get("/api/all-tickers")
    assert response.status_code == 200
    assert response.get_json() == ["AAPL", "MSFT"]
