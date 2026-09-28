"""stock_counts_by_type 口径测试（假游标，不连数据库）。

验证批量在库数与 stock_count_until（_in_stock_rows）口径一致：
- 只统计最新流转为「入库」的资产；
- 笔记本电脑 / 显示器应用新机编码阈值；
- 台式主机 / 笔记本电脑按规格 Mac 拆分（缺规格视为非 Mac）；
- MySQL < 8.0（无窗口函数）回退路径与窗口函数路径结果一致。
"""

from datetime import datetime

from mysql.connector import Error as MySQLError

from app import ledger


class FakeCursor:
    """按 execute 顺序弹出预置结果的假游标（dictionary=True 语义）。"""

    def __init__(self, results=None, fail_first=0):
        self.results = list(results or [])
        self.fail_first = fail_first
        self.executed = []

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        if self.fail_first > 0:
            self.fail_first -= 1
            raise MySQLError(msg='窗口函数不可用（模拟 MySQL 5.7）')

    def fetchall(self):
        return self.results.pop(0) if self.results else []

    def fetchone(self):
        return self.results.pop(0) if self.results else None


NOW = datetime(2026, 9, 23, 12, 0, 0)

# 窗口函数路径只需「每 (type, number) 最新一行」结果
WINDOW_ROWS = [
    {'type': '台式主机', 'number': 'ZL2600001', 'tag': '入库'},
    {'type': '台式主机', 'number': 'ZL2600002', 'tag': '入库'},
    {'type': '台式主机', 'number': 'ZL2600003', 'tag': '领用'},   # 非在库
    {'type': '显示器', 'number': 'DZ2509001', 'tag': '入库'},     # >= 阈值，计入
    {'type': '显示器', 'number': 'DZ2301001', 'tag': '入库'},     # < 阈值，剔除
    {'type': '硬盘', 'number': 'DK2600001', 'tag': '入库'},
]
SPECS = [
    {'number': 'ZL2600001', 'spec': 'Apple Mac mini M4'},
    {'number': 'ZL2600002', 'spec': '联想 ThinkCentre M760'},
]

EXPECTED = {
    ('台式主机', True): 1,     # Mac mini
    ('台式主机', False): 1,    # 普通台式机
    ('显示器', None): 1,       # 阈值过滤后剩 1
    ('硬盘', None): 1,
}


def test_window_function_path():
    cursor = FakeCursor(results=[WINDOW_ROWS, SPECS])
    counts = ledger.stock_counts_by_type(cursor, ['台式主机', '显示器', '硬盘'], NOW)
    assert counts == EXPECTED
    # 第一条 SQL 用了窗口函数
    assert 'ROW_NUMBER() OVER' in cursor.executed[0][0]
    # Mac 规格查询按 Mac 拆分类型过滤
    spec_sql, spec_params = cursor.executed[1]
    assert 'device_list' in spec_sql
    assert tuple(spec_params) == ('台式主机',)


def test_missing_spec_counts_as_non_mac():
    rows = [{'type': '台式主机', 'number': 'ZL2600009', 'tag': '入库'}]
    cursor = FakeCursor(results=[rows, [{'number': 'ZL2600009', 'spec': None}]])
    counts = ledger.stock_counts_by_type(cursor, ['台式主机'], NOW)
    assert counts == {('台式主机', True): 0, ('台式主机', False): 1}


def test_empty_types_short_circuit():
    cursor = FakeCursor()
    assert ledger.stock_counts_by_type(cursor, [], NOW) == {}
    assert cursor.executed == []


def test_fallback_path_matches_window_path():
    """窗口函数不可用时回退逐类型归并，口径一致。"""
    t1 = datetime(2026, 1, 10)
    t2 = datetime(2026, 2, 15)
    # 回退路径按 sorted(types) 逐类型查询全量历史
    zc_history = [
        {'type': '台式主机', 'number': 'ZL2600001', 'datetime': t1, 'tag': '领用'},
        {'type': '台式主机', 'number': 'ZL2600001', 'datetime': t2, 'tag': '入库'},  # 最新 → 在库
        {'type': '台式主机', 'number': 'ZL2600002', 'datetime': t1, 'tag': '入库'},
    ]
    dq_history = [
        {'type': '显示器', 'number': 'DZ2509001', 'datetime': t1, 'tag': '入库'},
        {'type': '显示器', 'number': 'DZ2301001', 'datetime': t1, 'tag': '入库'},
    ]
    dp_history = [{'type': '硬盘', 'number': 'DK2600001', 'datetime': t1, 'tag': '入库'}]
    cursor = FakeCursor(
        results=[zc_history, dq_history, dp_history, SPECS],
        fail_first=1,  # 第一次（窗口函数查询）抛错触发回退
    )
    counts = ledger.stock_counts_by_type(cursor, ['台式主机', '显示器', '硬盘'], NOW)
    assert counts == EXPECTED
