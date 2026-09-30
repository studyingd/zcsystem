# -*- coding: utf-8 -*-
"""单据页预算口径回归测试（FakeCursor 纯内存，不依赖数据库）。

口径约定（与「预算设置」页一致）：
  单据预算已用 = 截至本单（含本单）的预算内单据累计 + budgets.used_adjust 手动修正量
  预算设置已用 = 全年预算内单据自动统计 + 手动修正量
因此「某类型最新一单」在两页的 used / left 必须相等；早于最新一单的单据行
只累计到自身（历史快照），但仍叠加修正量。
"""

from datetime import date
from decimal import Decimal

from app import order as order_mod


class FakeCursor:
    """按 execute 顺序弹出预置结果的假游标（dictionary=True 语义）。"""

    def __init__(self, results=None):
        self.results = list(results or [])
        self.executed = []

    def execute(self, sql, params=None):
        self.executed.append((sql, params))

    def fetchall(self):
        return self.results.pop(0) if self.results else []

    def fetchone(self):
        return self.results.pop(0) if self.results else None


# 与生产数据同形：总额 331250 / 自动 26400 / 修正 262640
SERIES_ROWS = [
    {'id': 1, 'device_type': '显示器', 'y': 2026,
     'order_date': date(2026, 3, 1), 'amount': Decimal('10000.00')},
    {'id': 2, 'device_type': '显示器', 'y': 2026,
     'order_date': date(2026, 9, 20), 'amount': Decimal('26400.00')},
]
ADJUST_ROWS = [
    {'budget_year': 2026, 'device_type': '显示器', 'used_adjust': Decimal('262640.00')},
    {'budget_year': 2026, 'device_type': '笔记本电脑', 'used_adjust': Decimal('592542.60')},
]
TOTALS = {'显示器': 331250.0}


def _used_at(order_date, order_id):
    cur = FakeCursor([list(SERIES_ROWS)])
    series = order_mod._budget_used_series(cur, [2026])
    cur2 = FakeCursor([list(ADJUST_ROWS)])
    adjusts = order_mod._budget_adjustments(cur2, [2026])
    used = order_mod._budget_used_at(series, '显示器', 2026, order_date, order_id)
    return used + adjusts.get(2026, {}).get('显示器', 0.0)


def test_budget_adjustments_grouping():
    cur = FakeCursor([list(ADJUST_ROWS)])
    adjusts = order_mod._budget_adjustments(cur, [2026])
    assert adjusts == {2026: {'显示器': 262640.0, '笔记本电脑': 592542.6}}
    # SQL 过滤条件：只取 used_adjust 非 NULL 的行
    sql, params = cur.executed[0]
    assert 'used_adjust IS NOT NULL' in sql
    assert params == (2026,)


def test_budget_adjustments_empty_years():
    cur = FakeCursor()
    assert order_mod._budget_adjustments(cur, []) == {}
    assert cur.executed == []


def test_latest_order_matches_budgets_page():
    """最新一单（9-20）的 used/left 应与预算设置页（自动 36400 + 修正 262640）一致。"""
    used = _used_at(date(2026, 9, 20), 2)
    view = order_mod._budget_view('显示器', 2026, TOTALS, used)
    assert used == 299040.0                      # 10000 + 26400 + 262640
    assert view['used'] == 299040.0
    assert view['left'] == round(331250.0 - 299040.0, 2)   # 32210.0
    assert view['configured'] is True


def test_earlier_order_is_snapshot_plus_adjust():
    """早先单据（3-01）只累计到自身（10000），但仍叠加修正量。"""
    used = _used_at(date(2026, 3, 1), 1)
    view = order_mod._budget_view('显示器', 2026, TOTALS, used)
    assert used == 272640.0                      # 10000 + 262640
    assert view['left'] == round(331250.0 - 272640.0, 2)


def test_no_adjustment_keeps_old_behavior():
    """无修正量时退回纯「截至本单累计」，历史行为不变。"""
    cur = FakeCursor([list(SERIES_ROWS)])
    series = order_mod._budget_used_series(cur, [2026])
    used = order_mod._budget_used_at(series, '显示器', 2026, date(2026, 9, 20), 2) \
        + order_mod._budget_adjustments(FakeCursor([]), [2026]).get(2026, {}).get('显示器', 0.0)
    assert used == 36400.0


def test_percent_capped_at_100():
    used = _used_at(date(2026, 9, 20), 2) + 50000  # 远超预算
    view = order_mod._budget_view('显示器', 2026, TOTALS, used)
    assert view['percent'] == 100.0
    assert view['left'] < 0
