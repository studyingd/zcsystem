"""ledger 口径的单元测试（纯逻辑 + 假游标，不连数据库）。

覆盖：编码前缀 / 初始状态 / 年月码解析 / 取号规则（含并发上限与续号）/
批量写入台账 / inventory 归并（latest + receive、按编号过滤）/
卡片状态派生。这些函数是三个业务模块共用的「唯一口径」，回归价值最高。
"""

from datetime import date, datetime

import pytest

from app import ledger


class FakeCursor:
    """按 execute 顺序弹出预置结果的假游标（dictionary=True 语义）。"""

    def __init__(self, results=None, lastrowids=None):
        self.results = list(results or [])
        self.lastrowids = list(lastrowids or [])
        self.executed = []
        self.lastrowid = None

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        if self.lastrowids:
            self.lastrowid = self.lastrowids.pop(0)

    def executemany(self, sql, rows):
        self.executed.append((sql, rows))

    def fetchone(self):
        return self.results.pop(0) if self.results else None

    def fetchall(self):
        return self.results.pop(0) if self.results else []


# ---------- 口径常量派生 ----------

def test_asset_prefix():
    assert ledger.asset_prefix(ledger.RENTAL_DESKTOP_TYPE) == 'ZL'
    assert ledger.asset_prefix('笔记本电脑') == 'DZ'
    assert ledger.asset_prefix('显示器') == 'DZ'


def test_initial_status():
    assert ledger.initial_status(ledger.RENTAL_DESKTOP_TYPE) == ledger.INITIAL_STATUS_RENTAL
    assert ledger.initial_status('台式主机') == ledger.INITIAL_STATUS_DEFAULT


def test_year_code():
    assert ledger.year_code(2026) == '26'
    assert ledger.year_code('2024') == '24'


def test_yymm_of():
    assert ledger.yymm_of(date(2026, 9, 7)) == '2609'
    assert ledger.yymm_of(datetime(2026, 1, 2, 3, 4)) == '2601'
    assert ledger.yymm_of('2026-09') == '2609'
    assert ledger.yymm_of('') == ''


def test_date_str():
    assert ledger.date_str(date(2026, 9, 7)) == '2026-09-07'
    assert ledger.date_str(None) == ''
    assert ledger.date_str('2026-09-07') == '2026-09-07'


def test_yymm_from_month():
    assert ledger.yymm_from_month('2026-09') == '2609'
    assert ledger.yymm_from_month(date(2026, 9, 7)) == '2609'
    # 空值回退当前月
    now = datetime.now().strftime('%y%m')
    assert ledger.yymm_from_month('') == now
    assert ledger.yymm_from_month(None) == now
    with pytest.raises(ValueError):
        ledger.yymm_from_month('26-09')


# ---------- 取号规则 ----------

def test_next_asset_numbers_starts_at_001():
    cursor = FakeCursor()  # fetchone -> None：该月还没有任何编码
    assert ledger.next_asset_numbers(cursor, '笔记本电脑', '2609', 3) == [
        'DZ2609001', 'DZ2609002', 'DZ2609003',
    ]


def test_next_asset_numbers_continues_max():
    cursor = FakeCursor(results=[{'number': 'DZ2609005'}])
    assert ledger.next_asset_numbers(cursor, '台式主机', '2609', 2) == [
        'DZ2609006', 'DZ2609007',
    ]


def test_next_asset_numbers_rental_prefix():
    cursor = FakeCursor(results=[{'number': 'ZL2609010'}])
    assert ledger.next_asset_numbers(cursor, ledger.RENTAL_DESKTOP_TYPE, '2609', 1) == ['ZL2609011']


def test_next_asset_numbers_zero_quantity():
    cursor = FakeCursor()
    assert ledger.next_asset_numbers(cursor, '显示器', '2609', 0) == []
    assert cursor.executed == []


def test_next_asset_numbers_monthly_cap():
    cursor = FakeCursor(results=[{'number': 'DZ2609998'}])
    with pytest.raises(ValueError, match='序号不足'):
        ledger.next_asset_numbers(cursor, '显示器', '2609', 3)  # 998+3 > 999


# ---------- 批量写入台账 ----------

def test_insert_ledger_assets_uses_autoincrement_ids():
    cursor = FakeCursor(lastrowids=[101, 102])
    assets = [
        {'number': 'DZ2609001', 'type': '显示器', 'spec': 'AOC', 'department': 'IT', 'name': '张三'},
        {'number': 'DZ2609002', 'type': ledger.RENTAL_DESKTOP_TYPE, 'department': 'IT', 'name': '李四'},
    ]
    numbers = ledger.insert_ledger_assets(cursor, assets, date(2026, 9, 7))

    assert numbers == ['DZ2609001', 'DZ2609002']
    device_sql, device_rows = cursor.executed[0]
    assert 'INSERT INTO device_list' in device_sql
    assert len(device_rows) == 2
    # inventory 逐行插入（id 交给 AUTO_INCREMENT），不再应用层取号
    inv_stmts = [sql for sql, _ in cursor.executed[1:] if 'INSERT INTO inventory' in sql]
    assert len(inv_stmts) == 2
    assert all('VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)' in sql for sql in inv_stmts)
    # 租聘机初始状态为「租聘」，普通资产为「入库」
    statuses = [params[5] for _, params in cursor.executed[1:]]
    assert statuses == [ledger.INITIAL_STATUS_DEFAULT, ledger.INITIAL_STATUS_RENTAL]


def test_insert_ledger_assets_empty():
    cursor = FakeCursor()
    assert ledger.insert_ledger_assets(cursor, [], date.today()) == []
    assert cursor.executed == []


# ---------- inventory 归并 ----------

def _inv_row(number, day, tag, **extra):
    row = {'number': number, 'department': 'D', 'site': 'S', 'type': 'T',
           'datetime': date(2026, 9, day), 'status': '已录入', 'tag': tag, 'notice': ''}
    row.update(extra)
    return row


def test_inventory_index_latest_and_receive():
    rows = [
        _inv_row('A', 1, '入库'),
        _inv_row('A', 5, '领用'),
        _inv_row('A', 3, '入职'),
        _inv_row('B', 2, '入库'),
    ]
    cursor = FakeCursor(results=[rows])
    latest, receive = ledger.inventory_index(cursor)
    assert latest['A']['tag'] == '领用'
    assert latest['A']['datetime'] == date(2026, 9, 5)
    assert latest['B']['tag'] == '入库'
    assert receive['A'] == date(2026, 9, 5)   # 领用/入职中最近一次
    assert 'B' not in receive


def test_inventory_index_filters_by_numbers():
    cursor = FakeCursor(results=[[]])
    latest, receive = ledger.inventory_index(cursor, ['A', 'B'])
    assert (latest, receive) == ({}, {})
    sql, params = cursor.executed[0]
    assert 'WHERE number IN (%s,%s)' in sql
    assert params == ('A', 'B')


def test_inventory_index_empty_numbers_short_circuits():
    cursor = FakeCursor()
    assert ledger.inventory_index(cursor, []) == ({}, {})
    assert cursor.executed == []


def test_latest_inventory_rows_picks_last():
    rows = [
        _inv_row('A', 1, '入库'),
        _inv_row('A', 9, '更换'),
        _inv_row('B', 4, '领用'),
    ]
    cursor = FakeCursor(results=[rows])
    latest = ledger.latest_inventory_rows(cursor, ['A', 'B'])
    assert latest['A']['tag'] == '更换'
    assert latest['B']['tag'] == '领用'


# ---------- 卡片状态派生 ----------

def _device(name='张三', department='SCM', **extra):
    dev = {'number': 'DZ2609001', 'spec': 'ThinkPad', 'sn': 'SN1',
           'department': department, 'name': name,
           'cpu': '', 'mem': '', 'disk': '', 'gpu': ''}
    dev.update(extra)
    return dev


def test_card_state_unassigned():
    assert ledger.card_state(_device(name='', department=''), None, None) == ledger.CARD_UNASSIGNED


def test_card_state_custodian_in_stock():
    device = _device(name=ledger.STOCK_CUSTODIAN_NAME, department=ledger.STOCK_CUSTODIAN_DEPT)
    assert ledger.card_state(device, None, None) == ledger.CARD_IN_STOCK


def test_card_state_issued_when_received():
    assert ledger.card_state(_device(), date(2026, 9, 1), None) == ledger.CARD_ISSUED


def test_card_state_stock_tag_without_receive():
    inv = _inv_row('DZ2609001', 1, '入库')
    assert ledger.card_state(_device(), None, inv) == ledger.CARD_IN_STOCK


def test_live_card_fields_fallback_stock_in_date():
    inv = _inv_row('DZ2609001', 3, '入库')
    live = ledger.live_card_fields(_device(), None, inv)
    # 从未领用时，领取时间回退为最近一次入库流转日期
    assert live['receive_date'] == '2026-09-03'
    assert live['card_status'] == ledger.CARD_IN_STOCK
    assert live['owner'] == '张三'


def test_live_card_fields_receive_date_priority():
    inv = _inv_row('DZ2609001', 3, '入库')
    live = ledger.live_card_fields(_device(), date(2026, 9, 8), inv)
    assert live['receive_date'] == '2026-09-08'
    assert live['card_status'] == ledger.CARD_ISSUED
