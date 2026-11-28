"""Unit tests for the Quality entry-rule inputs (backend/quality.py).

Run from backend/:  python -m pytest test_quality.py
"""

import math

from datetime import date, timedelta

from quality import (
    AUDIT_HIGH_WINDOW_TRADING_DAYS,
    Z_SCORE_WINDOW_TRADING_DAYS,
    compute_close_drawdown,
    compute_earnings_audit,
    compute_max_close_since,
    compute_entry_rule_fundamentals,
    compute_price_statistics,
)

# FMP /stable/ratios annual rows for ZTS (fiscal 2021-2025), fields used only.
ZTS_ANNUAL_RATIOS = [
    {"date": "2025-12-31", "priceToEarningsRatio": 20.8657, "capexPerShare": 1.4004054636108811,
     "revenuePerShare": 21.348854305964917, "operatingCashFlowPerShare": 6.5487559844218985},
    {"date": "2024-12-31", "priceToEarningsRatio": 29.7861, "capexPerShare": 1.4420959929546455,
     "revenuePerShare": 20.378687802730074, "operatingCashFlowPerShare": 6.501541171290181},
    {"date": "2023-12-31", "priceToEarningsRatio": 38.8524, "capexPerShare": 1.5872602846660249,
     "revenuePerShare": 18.526710207905076, "operatingCashFlowPerShare": 5.102217827621798},
    {"date": "2022-12-31", "priceToEarningsRatio": 32.4945, "capexPerShare": 1.2497574063055166,
     "revenuePerShare": 17.232149902642618, "operatingCashFlowPerShare": 4.077706759140184},
    {"date": "2021-12-31", "priceToEarningsRatio": 56.8834, "capexPerShare": 1.0055908320473577,
     "revenuePerShare": 16.393027903564473, "operatingCashFlowPerShare": 4.665351176773171},
]


def test_zts_capital_light_matches_analyst_figures():
    result = compute_entry_rule_fundamentals(ZTS_ANNUAL_RATIOS)
    assert round(result.capex_to_revenue_3y, 1) == 7.4
    assert round(result.capex_to_ocf_3y, 1) == 24.9


def test_zts_five_year_average_pe():
    result = compute_entry_rule_fundamentals(ZTS_ANNUAL_RATIOS)
    expected = (20.8657 + 29.7861 + 38.8524 + 32.4945 + 56.8834) / 5
    assert math.isclose(result.pe_5y_avg, expected, rel_tol=1e-9)


def test_loss_years_are_excluded_from_average_pe():
    rows = [{"priceToEarningsRatio": 20.0}, {"priceToEarningsRatio": -15.0}, {"priceToEarningsRatio": 30.0}]
    assert compute_entry_rule_fundamentals(rows).pe_5y_avg == 25.0


def test_partial_capex_window_is_unknown_not_partial():
    result = compute_entry_rule_fundamentals(ZTS_ANNUAL_RATIOS[:2])
    assert result.capex_to_revenue_3y is None
    assert result.capex_to_ocf_3y is None


def test_no_rows_means_every_input_unknown():
    result = compute_entry_rule_fundamentals([])
    assert result.pe_5y_avg is None
    assert result.capex_to_revenue_3y is None
    assert result.capex_to_ocf_3y is None


def test_z_score_uses_only_the_last_504_trading_days():
    # 100 early closes at 1000 must not move the Z-Score of the 504-day window.
    window = [float(100 + (i % 10)) for i in range(Z_SCORE_WINDOW_TRADING_DAYS)]
    with_old_history = [1000.0] * 100 + window
    assert compute_price_statistics(with_old_history) == compute_price_statistics(window)


def _dated(values):
    start = date(2025, 1, 1)
    return [(start + timedelta(days=i), v) for i, v in enumerate(values)]


def test_close_drawdown_uses_the_last_close_against_the_52w_close_high():
    result = compute_close_drawdown(_dated([100.0, 120.0, 102.0]))
    assert result.high_52w_close == 120.0
    assert result.close == 102.0
    assert round(result.drawdown_pct, 2) == -15.0


def test_close_drawdown_ignores_highs_older_than_252_sessions():
    values = [500.0] + [100.0] * AUDIT_HIGH_WINDOW_TRADING_DAYS
    assert compute_close_drawdown(_dated(values)).drawdown_pct == 0.0


def test_close_drawdown_without_history_is_unknown():
    assert compute_close_drawdown([]) is None


def test_max_close_since_first_buy():
    closes = _dated([100.0, 140.0, 120.0, 130.0])  # 2025-01-01 .. 2025-01-04
    assert compute_max_close_since(closes, date(2025, 1, 3)) == 130.0
    assert compute_max_close_since(closes, date(2025, 1, 1)) == 140.0
    assert compute_max_close_since(closes, date(2025, 2, 1)) is None


def test_earnings_audit_is_due_on_the_third_session_after_the_report():
    # FICO reported 2026-11-04 (after the close); sessions 11-05, 11-06, 11-09.
    reports = [(date(2027, 1, 27), False), (date(2026, 11, 4), True), (date(2026, 7, 29), True)]
    closes = [(date(2026, 11, 4), 1.0), (date(2026, 11, 5), 1.0), (date(2026, 11, 6), 1.0)]
    state = compute_earnings_audit(reports, closes, date(2026, 11, 7))
    assert state.last_report_date == date(2026, 11, 4)
    assert state.due_close_date is None
    state = compute_earnings_audit(reports, closes + [(date(2026, 11, 9), 1.0)], date(2026, 11, 10))
    assert state.due_close_date == date(2026, 11, 9)


def test_no_past_report_means_no_earnings_audit():
    assert compute_earnings_audit([(date(2027, 1, 27), False)], [], date(2026, 11, 28)) is None
