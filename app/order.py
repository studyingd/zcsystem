"""资产申请"单据视图"后端。

单据（purchase_orders）-> 下推 -> 资产卡片（asset_cards）。
金额/预算相关数据仓库原本没有，由 budgets 表按"年度 + 设备类型"配置；
"今年已采购数量""部门使用情况"为截至单据日期的台账口径，"剩余库存"为当前在库数，
"申请数量"实时取自飞书多维表当前未发放申请（见 app/feishu.py）。
"""

import logging
import re
from bisect import bisect_right
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

from flask import Blueprint, jsonify, request, send_file, session
from mysql.connector import Error

from .common import denied as _denied
from .common import login_required_page as _login_required_page
from .common import with_db as _with_db
from .config import get_db_connection as _get_db_connection
from .feishu import FeishuError, apply_detail, cache_snapshot, current_apply_totals
from .ledger import (
    CARD_IN_STOCK,
    CARD_STATUSES,
    CARD_UNASSIGNED,
    DEVICE_FIELDS,
    DUP_RETRY,
    ER_DUP_ENTRY,
    INITIAL_STATUS_DEFAULT,
    MAC_SPLIT_TYPES,
    METRIC_TAGS,
    STOCK_CUSTODIAN_DEPT,
    STOCK_CUSTODIAN_NAME,
    STOCK_TAGS,
    dept_usage_matrix,
    fetch_devices,
    insert_ledger_assets,
    is_mac_spec,
    live_card_fields,
    next_asset_numbers,
    requires_config,
)
from .ledger import (
    inventory_index as _inventory_index,
)
from .ledger import (
    purchased_count_until as _purchased_count_until,
)
from .ledger import (
    stock_count_until as _stock_count_until,
)
from .ledger import (
    stock_counts_by_type as _stock_counts_by_type,
)
from .ledger import (
    stock_detail_until as _stock_detail_until,
)
from .ledger import (
    year_code as _year_code,
)
from .ledger import (
    yymm_of as _yymm_of,
)
from .utils import rows_to_xlsx

order_bp = Blueprint('order', __name__)
logger = logging.getLogger(__name__)

ORDER_NO_PREFIX = 'PO'
# 资产编码统一格式：两位前缀（DZ/ZL）+ 年月码 yyMM + 3 位流水，如 DZ2609001
_ASSET_NUMBER_RE = re.compile(r'[A-Z]{2}\d{7}')
# ---------- 通用工具 ----------
def _current_user():
    if not session.get('logged_in'):
        return None
    return session.get('username') or ''


def _money(value):
    if value is None or value == '':
        return 0.0
    return float(Decimal(str(value)).quantize(Decimal('0.01')))


def _parse_money(text, field):
    if text is None or str(text).strip() == '':
        return Decimal('0.00')
    try:
        value = Decimal(str(text).strip()).quantize(Decimal('0.01'))
    except (InvalidOperation, ValueError):
        raise ValueError(f'{field}格式不正确') from None
    if value < 0:
        raise ValueError(f'{field}不能为负数')
    return value


def _date_str(value):
    if hasattr(value, 'strftime'):
        return value.strftime('%Y-%m-%d')
    return value or ''


def _datetime_str(value):
    if hasattr(value, 'strftime'):
        return value.strftime('%Y-%m-%d %H:%M')
    return value or ''


def _parse_date(text):
    try:
        return datetime.strptime(str(text).strip(), '%Y-%m-%d').date()
    except (ValueError, TypeError):
        raise ValueError('日期格式应为 YYYY-MM-DD') from None


def _budget_totals(cursor, year):
    cursor.execute(
        "SELECT device_type, budget_amount FROM budgets WHERE budget_year=%s", (year,)
    )
    totals = {r['device_type']: _money(r['budget_amount']) for r in cursor.fetchall()}
    cursor.execute(
        "SELECT device_type, SUM(amount) AS used FROM purchase_orders "
        "WHERE in_budget=1 AND YEAR(order_date)=%s GROUP BY device_type",
        (year,)
    )
    used = {r['device_type']: _money(r['used']) for r in cursor.fetchall()}
    return totals, used


def _budget_view(device_type, year, totals, used):
    # used 可以是「各类型已用」字典（预算总览），也可以是单个金额（单据口径）
    total = totals.get(device_type)
    spent = round(used.get(device_type, 0.0) if isinstance(used, dict) else used, 2)
    if total is None:
        return {'year': int(year), 'device_type': device_type, 'configured': False,
                'total': 0.0, 'used': spent, 'left': 0.0, 'percent': 0.0}
    left = round(total - spent, 2)
    percent = round(spent / total * 100, 1) if total else 0.0
    return {'year': int(year), 'device_type': device_type, 'configured': True,
            'total': total, 'used': spent, 'left': left,
            'percent': min(percent, 100.0) if total else 0.0}


def _parse_until(raw):
    """下钻口径参数：'YYMM'，非法则返回 None（表示整年）。"""
    raw = (raw or '').strip()
    return raw if raw.isdigit() and len(raw) == 4 else None


def _until_label(until):
    return f'（截至 20{until[:2]}-{until[2:]}）' if until else ''


def _budget_used_series(cursor, years):
    """一次性拉取各年度「预算内」单据，按 (年度, 类型) 预算好前缀累计金额。

    返回 {(year, device_type): (keys, sums)}，keys 为升序的 (order_date, id)，
    sums[i] 为截至 keys[i]（含）的累计金额。配合 :func:`_budget_used_at`
    用二分查找定位，避免列表页每行单据各查一次 SUM（N+1）。
    """
    if not years:
        return {}
    placeholders = ','.join(['%s'] * len(years))
    cursor.execute(
        f"SELECT id, device_type, YEAR(order_date) AS y, order_date, amount "
        f"FROM purchase_orders WHERE in_budget=1 AND YEAR(order_date) IN ({placeholders}) "
        f"ORDER BY order_date, id",
        tuple(years)
    )
    series = {}
    running = {}
    for r in cursor.fetchall():
        key = (int(r['y']), r['device_type'])
        running[key] = round(running.get(key, 0.0) + _money(r['amount']), 2)
        keys, sums = series.setdefault(key, ([], []))
        keys.append((r['order_date'], r['id']))
        sums.append(running[key])
    return series


def _budget_used_at(series, device_type, year, order_date, order_id):
    """截至本单据（含本单）：同类型同年度「预算内」单据的金额累计。"""
    entry = series.get((int(year), device_type))
    if not entry:
        return 0.0
    keys, sums = entry
    idx = bisect_right(keys, (order_date, order_id))
    return sums[idx - 1] if idx else 0.0


def _card_counts(cursor, order_ids):
    if not order_ids:
        return {}
    placeholders = ','.join(['%s'] * len(order_ids))
    cursor.execute(
        f"SELECT order_id, COUNT(*) AS cnt FROM asset_cards WHERE order_id IN ({placeholders}) "
        f"GROUP BY order_id",
        tuple(order_ids)
    )
    return {r['order_id']: int(r['cnt']) for r in cursor.fetchall()}


def _next_order_no(cursor, order_date):
    prefix = f"{ORDER_NO_PREFIX}{order_date.strftime('%y%m')}"
    cursor.execute(
        "SELECT order_no FROM purchase_orders WHERE order_no LIKE %s ORDER BY order_no DESC LIMIT 1",
        (prefix + '%',)
    )
    row = cursor.fetchone()
    seq = 1
    if row:
        tail = row['order_no'][len(prefix):]
        seq = int(tail) + 1 if tail.isdigit() else 1
    return f"{prefix}{seq:03d}"


def _serialize_order(row, extra=None):
    data = {
        'id': row['id'],
        'order_no': row['order_no'],
        'order_date': _date_str(row['order_date']),
        'year': row['order_date'].year if hasattr(row['order_date'], 'year') else None,
        'device_type': row['device_type'],
        'spec': row['spec'] or '',
        'cpu': row.get('cpu') or '',
        'mem': row.get('mem') or '',
        'disk': row.get('disk') or '',
        'gpu': row.get('gpu') or '',
        'quantity': int(row['quantity']),
        'unit_price': _money(row['unit_price']),
        'amount': _money(row['amount']),
        'in_budget': bool(row['in_budget']),
        'supplier': row['supplier'] or '',
        'remark': row['remark'] or '',
        'pushed': bool(row['pushed']),
        'reviewed': bool(row['reviewed']),
        'push_month': row['push_month'] or '',
        'pushed_at': _datetime_str(row['pushed_at']),
        'created_by': row['created_by'] or '',
        'created_at': _datetime_str(row['created_at']),
    }
    if extra:
        data.update(extra)
    return data


def _serialize_card(row):
    return {
        'id': row['id'],
        'card_no': row['card_no'],
        'order_no': row['order_no'],
        'card_month': row['card_month'],
        'asset_number': row['asset_number'] or '',
        'device_type': row['device_type'] or '',
        'spec': row['spec'] or '',
        'sn': row['sn'] or '',
        'owner': row['owner'] or '',
        'department': row['department'] or '',
        'receive_date': _date_str(row['receive_date']),
        'card_status': row['card_status'] or CARD_UNASSIGNED,
    }


def _register_push_assets(cursor, order, quantity, push_date):
    """下推即采购入库：生成全新台账编码并写入 device_list + inventory。

    编码规则与批量写入统一由 :mod:`app.ledger` 提供（与「资产登记」共用同一
    套取号 / 写入逻辑）：前缀（租赁台式主机为 ZL，其余 DZ）+ 单据日期年月码
    + 3 位流水（接续该批次已有最大序号），因此 9 月的单据必然生成 DZ2609xxx。
    新资产统一挂在库存托管人（IT/余嘉雄）名下，流转标签「入库」、日期为下推当日。
    """
    if quantity <= 0:
        return []
    numbers = next_asset_numbers(cursor, order['device_type'], _yymm_of(order['order_date']), quantity)
    assets = [{
        'number': number,
        'type': order['device_type'],
        'spec': order['spec'] or '',
        'department': STOCK_CUSTODIAN_DEPT,
        'name': STOCK_CUSTODIAN_NAME,
        # 单据上的硬件配置一并写入台账，资产登记 / 变更页可直接看到
        'cpu': order.get('cpu') or '',
        'mem': order.get('mem') or '',
        'disk': order.get('disk') or '',
        'gpu': order.get('gpu') or '',
        # 下推入库统一记为「入库」状态（含租赁机），与卡片状态口径一致
        'status': INITIAL_STATUS_DEFAULT,
    } for number in numbers]
    return insert_ledger_assets(cursor, assets, push_date)


# ---------- 元数据 ----------
@order_bp.route('/api/orders/meta')
@_with_db
def orders_meta(conn, cursor):
    cursor.execute("SELECT type AS device_type, COUNT(*) AS cnt FROM device_list GROUP BY type ORDER BY cnt DESC")
    types = [r['device_type'] for r in cursor.fetchall() if r['device_type']]
    cursor.execute("SELECT DISTINCT device_type FROM purchase_orders")
    for row in cursor.fetchall():
        if row['device_type'] and row['device_type'] not in types:
            types.append(row['device_type'])

    # 筛选用：只列出真实存在单据的类型（按单据量降序），避免出现一堆"选了也无结果"的台账类型
    cursor.execute(
        "SELECT device_type, COUNT(*) AS cnt FROM purchase_orders "
        "GROUP BY device_type ORDER BY cnt DESC, device_type"
    )
    order_types = [r['device_type'] for r in cursor.fetchall() if r['device_type']]

    cursor.execute("SELECT DISTINCT YEAR(order_date) AS y FROM purchase_orders")
    years = {int(r['y']) for r in cursor.fetchall() if r['y']}
    cursor.execute("SELECT DISTINCT SUBSTRING(number, 3, 2) AS yy FROM device_list")
    for row in cursor.fetchall():
        if row['yy'] and row['yy'].isdigit():
            years.add(2000 + int(row['yy']))
    current_year = datetime.now().year
    years.add(current_year)

    return jsonify({
        'status': 'success',
        'device_types': types,
        'order_types': order_types,
        'years': sorted(years, reverse=True),
        'current_year': current_year,
        'current_month': datetime.now().strftime('%Y-%m'),
        'card_statuses': list(CARD_STATUSES),
        'custodian': {'department': STOCK_CUSTODIAN_DEPT, 'name': STOCK_CUSTODIAN_NAME},
        'stock_tags': list(STOCK_TAGS),
        'metric_tags': list(METRIC_TAGS),
        'logged_in': _current_user() is not None,
    })


# ---------- 申请数量下钻（飞书多维表实时明细） ----------
@order_bp.route('/api/orders/<int:order_id>/apply_detail')
@_with_db
def order_apply_detail(conn, cursor, order_id):
    """申请数量下钻：该单据类型当前「未发放」的飞书申请明细（与列表实时口径一致）。"""
    cursor.execute("SELECT order_no, device_type FROM purchase_orders WHERE id=%s", (order_id,))
    order = cursor.fetchone()
    if not order:
        return jsonify({'status': 'error', 'message': '单据不存在'}), 404
    try:
        items = apply_detail(order['device_type'])
    except FeishuError as exc:
        return jsonify({'status': 'error', 'message': f'飞书接口暂不可用：{exc}'}), 502
    return jsonify({
        'status': 'success',
        'order_no': order['order_no'],
        'device_type': order['device_type'],
        'total': sum(i['qty'] for i in items),
        'items': items,
    })


@order_bp.route('/api/orders/<int:order_id>/stock_detail')
@_with_db
def order_stock_detail(conn, cursor, order_id):
    """剩余库存下钻：该单据类型当前在库资产明细（与列表实时口径一致）。

    台式主机 / 笔记本电脑按本单规格是否含 mac 取对应池（Mac 机 / 普通机），
    与列表展示的 stock_count 同一函数计算，数字必然一致。
    """
    cursor.execute("SELECT order_no, device_type, spec FROM purchase_orders WHERE id=%s", (order_id,))
    order = cursor.fetchone()
    if not order:
        return jsonify({'status': 'error', 'message': '单据不存在'}), 404
    dtype = order['device_type']
    mac_pool = is_mac_spec(order.get('spec')) if dtype in MAC_SPLIT_TYPES else None
    items = _stock_detail_until(cursor, dtype, datetime.now(), mac=mac_pool)
    return jsonify({
        'status': 'success',
        'order_no': order['order_no'],
        'device_type': dtype,
        'is_mac': bool(mac_pool),
        'total': len(items),
        'items': items,
    })


# ---------- 单据列表 ----------
def _order_where(args):
    """单据列表与导出共用的筛选条件，返回 (where_sql, params)。"""
    year = args.get('year', '').strip()
    device_type = args.get('device_type', '').strip()
    in_budget = args.get('in_budget', '').strip()
    pushed = args.get('pushed', '').strip()
    reviewed = args.get('reviewed', '').strip()
    keyword = args.get('keyword', '').strip()

    where, params = [], []
    if year.isdigit():
        where.append("YEAR(order_date)=%s")
        params.append(int(year))
    if device_type:
        where.append("device_type=%s")
        params.append(device_type)
    if in_budget in ('0', '1'):
        where.append("in_budget=%s")
        params.append(int(in_budget))
    if pushed in ('0', '1'):
        where.append("pushed=%s")
        params.append(int(pushed))
    if reviewed in ('0', '1'):
        where.append("reviewed=%s")
        params.append(int(reviewed))
    if keyword:
        where.append("(order_no LIKE %s OR spec LIKE %s OR supplier LIKE %s OR remark LIKE %s)")
        params.extend([f'%{keyword}%'] * 4)

    return (' WHERE ' + ' AND '.join(where)) if where else '', params


@order_bp.route('/api/orders')
@_with_db
def list_orders(conn, cursor):
    where_sql, params = _order_where(request.args)
    cursor.execute(
        f"SELECT * FROM purchase_orders{where_sql} ORDER BY order_date DESC, order_no DESC",
        tuple(params)
    )
    rows = cursor.fetchall()

    # 申请数量：实时取自飞书多维表当前未发放总量（失败不影响列表，前端显示"-"）
    try:
        apply_totals = current_apply_totals()
    except FeishuError as exc:
        apply_totals = None
        logger.warning('飞书申请数量实时取值失败：%s', exc)
    # 飞书数据仍在后台加载时，前端会在几秒后自动重试（见 dashboard_orders.js）
    apply_loading = apply_totals is None and cache_snapshot()[1]
    now = datetime.now()

    purchased_cache, budget_cache = {}, {}
    card_counts = _card_counts(cursor, [r['id'] for r in rows])
    # 在库数一次窗口查询批量算齐（旧实现每个 (类型, Mac池) 都全量拉流转历史归并）
    stock_counts = _stock_counts_by_type(cursor, {r['device_type'] for r in rows}, now)
    # 预算已用改为批量预算前缀和，避免每行单据各查一次 SUM
    # 预算已用改为批量预算前缀和，避免每行单据各查一次 SUM
    budget_series = _budget_used_series(
        cursor,
        sorted({r['order_date'].year for r in rows if hasattr(r['order_date'], 'year')})
    )

    orders = []
    for row in rows:
        order_year = row['order_date'].year if hasattr(row['order_date'], 'year') else datetime.now().year
        dtype = row['device_type']
        order_date = row['order_date']
        yymm = _yymm_of(order_date)
        # 剩余库存为实时值（批量窗口查询，同类型共用）；预算剩余 / 今年已采购仍为「截至单据日期」的口径
        # 台式主机/笔记本：规格含 mac 的 Mac 机与普通机分开计库存，按单据规格判定取哪一池
        mac_pool = is_mac_spec(row.get('spec')) if dtype in MAC_SPLIT_TYPES else None
        if (dtype, yymm) not in purchased_cache:
            purchased_cache[(dtype, yymm)] = _purchased_count_until(cursor, dtype, order_year, yymm)
        if order_year not in budget_cache:
            budget_cache[order_year] = _budget_totals(cursor, order_year)[0]
        totals = budget_cache[order_year]
        orders.append(_serialize_order(row, {
            'card_count': card_counts.get(row['id'], 0),
            'stock_count': stock_counts[(dtype, mac_pool)],
            'apply_quantity': (apply_totals.get(dtype) if apply_totals is not None else None),
            'purchased_this_year': purchased_cache[(dtype, yymm)],
            'budget': _budget_view(dtype, order_year, totals,
                                   _budget_used_at(budget_series, dtype, order_year, order_date, row['id'])),
        }))

    summary = {
        'order_count': len(orders),
        'quantity': sum(o['quantity'] for o in orders),
        'amount': round(sum(o['amount'] for o in orders), 2),
        'in_budget_amount': round(sum(o['amount'] for o in orders if o['in_budget']), 2),
        'out_budget_amount': round(sum(o['amount'] for o in orders if not o['in_budget']), 2),
        'pushed_count': sum(1 for o in orders if o['pushed']),
        'card_count': sum(o['card_count'] for o in orders),
    }
    return jsonify({'status': 'success', 'orders': orders, 'summary': summary,
                    'apply_loading': apply_loading})


# ---------- 单据详情（含资产卡片） ----------
def _enrich_cards(cursor, cards):
    """已绑定台账的卡片：规格/SN/所属人/所属部门/领取时间/状态实时取自台账。

    台账（device_list + inventory）是唯一事实来源，卡片上的这些字段只是派生值，
    读取时统一刷新，因此资产变更后的信息无需任何手动同步即可在看板看到。
    """
    numbers = [c['asset_number'] for c in cards if c['asset_number']]
    if not numbers:
        return cards
    devices = fetch_devices(cursor, numbers)
    inv_latest, inv_receive = _inventory_index(cursor, numbers)
    for card in cards:
        device = devices.get(card['asset_number'])
        if not device:
            continue
        card.update(live_card_fields(
            device,
            inv_receive.get(card['asset_number']),
            inv_latest.get(card['asset_number']),
        ))
        # 台账状态 / 流转标签一并下发：单据详情里资产编码的状态徽章
        # 与「资产变更」页用同一口径（statusBadgeHtml(inv_status)）
        inv = inv_latest.get(card['asset_number']) or {}
        card['inv_status'] = inv.get('status') or ''
        card['inv_tag'] = inv.get('tag') or ''
    return cards


@order_bp.route('/api/orders/<int:order_id>')
@_with_db
def order_detail(conn, cursor, order_id):
    cursor.execute("SELECT * FROM purchase_orders WHERE id=%s", (order_id,))
    row = cursor.fetchone()
    if not row:
        return jsonify({'status': 'error', 'message': '单据不存在'}), 404

    order_year = row['order_date'].year
    dtype = row['device_type']
    totals = _budget_totals(cursor, order_year)[0]
    cursor.execute(
        "SELECT * FROM asset_cards WHERE order_id=%s ORDER BY card_no", (order_id,)
    )
    cards = _enrich_cards(cursor, [_serialize_card(r) for r in cursor.fetchall()])

    try:
        apply_totals = current_apply_totals()
    except FeishuError as exc:
        apply_totals = None
        logger.warning('飞书申请数量实时取值失败：%s', exc)
    apply_loading = apply_totals is None and cache_snapshot()[1]

    # 台式主机/笔记本：规格含 mac 的 Mac 机与普通机分开计库存，按本单规格判定取哪一池
    mac_pool = is_mac_spec(row.get('spec')) if dtype in MAC_SPLIT_TYPES else None
    data = _serialize_order(row, {
        'card_count': len(cards),
        'stock_count': _stock_count_until(cursor, dtype, datetime.now(), mac=mac_pool),
        'apply_quantity': (apply_totals.get(dtype) if apply_totals is not None else None),
        'purchased_this_year': _purchased_count_until(cursor, dtype, order_year, _yymm_of(row['order_date'])),
        'budget': _budget_view(dtype, order_year, totals,
                               _budget_used_at(_budget_used_series(cursor, [order_year]),
                                               dtype, order_year, row['order_date'], row['id'])),
    })
    return jsonify({'status': 'success', 'order': data, 'cards': cards,
                    'apply_loading': apply_loading})


# ---------- 单据导出（资产申请模块） ----------
@order_bp.route('/orders/export')
@_login_required_page
def export_orders():
    """导出「资产申请」模块的单据与资产卡片（与列表同筛选条件、不分页）。

    文件下载路由：错误按纯文本返回，不走 JSON 装饰器（与 /export 一致）。
    资产卡片页的所属人 / 部门 / 领取时间 / 状态按台账实时派生，与页面口径一致。
    """
    conn = _get_db_connection()
    if not conn:
        return '数据库连接失败', 500
    cursor = None
    try:
        cursor = conn.cursor(dictionary=True, buffered=True)
        where_sql, params = _order_where(request.args)
        cursor.execute(
            f"SELECT * FROM purchase_orders{where_sql} ORDER BY order_date DESC, order_no DESC",
            tuple(params)
        )
        orders = cursor.fetchall()
        order_ids = [r['id'] for r in orders]
        counts = _card_counts(cursor, order_ids)

        order_rows = [{
            '单据编号': r['order_no'],
            '单据日期': _date_str(r['order_date']),
            '设备类型': r['device_type'],
            '规格型号': r['spec'] or '',
            'CPU': r.get('cpu') or '',
            '内存': r.get('mem') or '',
            '硬盘': r.get('disk') or '',
            '显卡': r.get('gpu') or '',
            '数量': int(r['quantity']),
            '单价': _money(r['unit_price']),
            '金额': _money(r['amount']),
            '预算内/外': '预算内' if r['in_budget'] else '预算外',
            '供应商': r['supplier'] or '',
            '备注': r['remark'] or '',
            '审核状态': '已审核' if r['reviewed'] else '未审核',
            '下推状态': '已下推' if r['pushed'] else '未下推',
            '下推月份': r['push_month'] or '',
            '卡片数': counts.get(r['id'], 0),
            '创建人': r['created_by'] or '',
            '创建时间': _datetime_str(r['created_at']),
        } for r in orders]

        card_rows = []
        if order_ids:
            placeholders = ','.join(['%s'] * len(order_ids))
            cursor.execute(
                f"SELECT * FROM asset_cards WHERE order_id IN ({placeholders}) ORDER BY order_no, card_no",
                tuple(order_ids)
            )
            for card in _enrich_cards(cursor, [_serialize_card(r) for r in cursor.fetchall()]):
                card_rows.append({
                    '卡片编号': card['card_no'],
                    '单据编号': card['order_no'],
                    '卡片月份': card['card_month'],
                    '资产编码': card['asset_number'],
                    '设备类型': card['device_type'],
                    '规格型号': card['spec'],
                    'SN': card['sn'],
                    '所属人': card['owner'],
                    '所属部门': card['department'],
                    '领取时间': card['receive_date'],
                    '卡片状态': card['card_status'],
                })

        output = rows_to_xlsx([('单据', order_rows), ('资产卡片', card_rows)])
        return send_file(
            output,
            mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            as_attachment=True,
            download_name=f"orders_export_{datetime.now().strftime('%Y%m%d%H%M')}.xlsx",
        )
    except Exception as exc:
        logger.error('导出单据失败: %s', exc, exc_info=True)
        return '导出失败: 服务器内部错误', 500
    finally:
        if cursor:
            cursor.close()
        conn.close()


# ---------- 单据新增 / 修改 / 删除 ----------
def _read_order_form(require_config=True):
    order_date = _parse_date(request.form.get('order_date', ''))
    device_type = request.form.get('device_type', '').strip()
    if not device_type:
        raise ValueError('请选择设备类型')

    quantity_raw = request.form.get('quantity', '0').strip() or '0'
    if not quantity_raw.isdigit():
        raise ValueError('设备数量必须为非负整数')
    quantity = int(quantity_raw)

    unit_price = _parse_money(request.form.get('unit_price', ''), '单价')
    amount = _parse_money(request.form.get('amount', ''), '金额')
    if amount == 0 and unit_price > 0:
        amount = (unit_price * quantity).quantize(Decimal('0.01'))
    if unit_price == 0 and amount > 0 and quantity:
        unit_price = (amount / Decimal(quantity)).quantize(Decimal('0.01'))

    in_budget_raw = request.form.get('in_budget', '1').strip()
    in_budget = 0 if in_budget_raw in ('0', 'false', 'False') else 1

    # 硬件配置：电脑类（笔记本电脑 / 台式主机 / 租赁台式主机）必填，非电脑类一律留空
    # （不信任前端传值）；下推时写入 device_list 的 cpu / mem / disk / gpu 列
    hardware = {
        'cpu': request.form.get('cpu', '').strip(),
        'mem': request.form.get('mem', '').strip(),
        'disk': request.form.get('disk', '').strip(),
        'gpu': request.form.get('gpu', '').strip(),
    }
    if requires_config(device_type):
        labels = {'cpu': 'CPU', 'mem': '内存', 'disk': '硬盘', 'gpu': '显卡'}
        missing = [labels[key] for key, value in hardware.items() if not value] if require_config else []
        if missing:
            raise ValueError(f'{device_type} 必须填写硬件配置（缺少：{"、".join(missing)}）')
    else:
        hardware = dict.fromkeys(hardware, '')

    return {
        'order_date': order_date,
        'device_type': device_type,
        'spec': request.form.get('spec', '').strip(),
        'quantity': quantity,
        'unit_price': unit_price,
        'amount': amount,
        'in_budget': in_budget,
        'supplier': request.form.get('supplier', '').strip(),
        'remark': request.form.get('remark', '').strip(),
        **hardware,
    }


@order_bp.route('/api/orders', methods=['POST'])
@_with_db
def create_order(conn, cursor):
    user = _current_user()
    if user is None:
        return _denied()

    data = _read_order_form()
    order_no = request.form.get('order_no', '').strip() or _next_order_no(cursor, data['order_date'])
    cursor.execute("SELECT id FROM purchase_orders WHERE order_no=%s", (order_no,))
    if cursor.fetchone():
        return jsonify({'status': 'error', 'message': f'单据编号 {order_no} 已存在'}), 400

    cursor.execute(
        """INSERT INTO purchase_orders
           (order_no, order_date, device_type, spec, cpu, mem, disk, gpu, quantity, unit_price, amount,
            in_budget, supplier, remark, created_by)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
        (order_no, data['order_date'], data['device_type'], data['spec'],
         data['cpu'], data['mem'], data['disk'], data['gpu'], data['quantity'],
         data['unit_price'], data['amount'], data['in_budget'], data['supplier'],
         data['remark'], user)
    )
    conn.commit()
    return jsonify({'status': 'success', 'message': f'单据 {order_no} 已创建', 'id': cursor.lastrowid,
                    'order_no': order_no})


@order_bp.route('/api/orders/<int:order_id>', methods=['POST'])
@_with_db
def update_order(conn, cursor, order_id):
    if _current_user() is None:
        return _denied()

    cursor.execute("SELECT * FROM purchase_orders WHERE id=%s", (order_id,))
    current = cursor.fetchone()
    if not current:
        return jsonify({'status': 'error', 'message': '单据不存在'}), 404

    pushed = bool(current['pushed'])
    # 已下推单据的硬件配置可能来自更早的数据（当时未采集），编辑时不强制填写；
    # 非下推单据（含新增）按电脑类必填校验
    data = _read_order_form(require_config=not pushed)
    order_no = request.form.get('order_no', '').strip() or current['order_no']
    if pushed and (order_no != current['order_no'] or data['quantity'] != int(current['quantity'])
                   or data['device_type'] != (current['device_type'] or '')):
        return jsonify({
            'status': 'error',
            'message': '单据已下推，修改编号 / 数量 / 设备类型前请先撤销下推',
        }), 400
    if order_no != current['order_no']:
        cursor.execute("SELECT id FROM purchase_orders WHERE order_no=%s", (order_no,))
        if cursor.fetchone():
            return jsonify({'status': 'error', 'message': f'单据编号 {order_no} 已存在'}), 400

    cursor.execute(
        """UPDATE purchase_orders SET order_no=%s, order_date=%s, device_type=%s, spec=%s,
           cpu=%s, mem=%s, disk=%s, gpu=%s, quantity=%s, unit_price=%s, amount=%s,
           in_budget=%s, supplier=%s, remark=%s
           WHERE id=%s""",
        (order_no, data['order_date'], data['device_type'], data['spec'],
         data['cpu'], data['mem'], data['disk'], data['gpu'], data['quantity'],
         data['unit_price'], data['amount'], data['in_budget'], data['supplier'],
         data['remark'], order_id)
    )
    if order_no != current['order_no']:
        cursor.execute(
            "UPDATE asset_cards SET order_no=%s, card_no=CONCAT(%s, '-', LPAD(id, 2, '0')) WHERE order_id=%s",
            (order_no, order_no, order_id)
        )
    if pushed:
        # 规格 / 硬件配置改动同步到本单生成的台账资产（编号 / 数量已在上面锁定）。
        # device_list 的 spec / cpu / mem / disk / gpu 只在登记 / 下推时写入，
        # 资产变更不涉及这些列，因此不会覆盖人工维护数据。
        cursor.execute(
            "SELECT asset_number FROM asset_cards WHERE order_id=%s AND asset_number <> ''",
            (order_id,)
        )
        numbers = [r['asset_number'] for r in cursor.fetchall()]
        if numbers:
            placeholders = ','.join(['%s'] * len(numbers))
            cursor.execute(
                f"UPDATE device_list SET spec=%s, cpu=%s, mem=%s, disk=%s, gpu=%s "
                f"WHERE number IN ({placeholders})",
                (data['spec'], data['cpu'], data['mem'], data['disk'], data['gpu'], *numbers)
            )
    conn.commit()
    return jsonify({'status': 'success', 'message': f'单据 {order_no} 已更新'})


@order_bp.route('/api/orders/<int:order_id>', methods=['DELETE'])
@_with_db
def delete_order(conn, cursor, order_id):
    if _current_user() is None:
        return _denied()

    cursor.execute("SELECT order_no, pushed FROM purchase_orders WHERE id=%s", (order_id,))
    row = cursor.fetchone()
    if not row:
        return jsonify({'status': 'error', 'message': '单据不存在'}), 404
    if row['pushed']:
        return jsonify({'status': 'error', 'message': '单据已下推资产卡片，请先撤销下推'}), 400

    cursor.execute("DELETE FROM purchase_orders WHERE id=%s", (order_id,))
    conn.commit()
    return jsonify({'status': 'success', 'message': f"单据 {row['order_no']} 已删除"})


# ---------- 审核状态 ----------
@order_bp.route('/api/orders/<int:order_id>/review', methods=['POST'])
@_with_db
def set_order_review(conn, cursor, order_id):
    """切换单据审核状态（未审核 <-> 已审核），仅登录用户可操作。

    列表默认只展示未审核单据；审核过的单据切「已审核 / 全部」筛选查看。
    """
    if _current_user() is None:
        return _denied()
    reviewed = 1 if request.form.get('reviewed') in ('1', 'true', 'True') else 0
    cursor.execute("SELECT id FROM purchase_orders WHERE id=%s", (order_id,))
    if not cursor.fetchone():
        return jsonify({'status': 'error', 'message': '单据不存在'}), 404
    cursor.execute("UPDATE purchase_orders SET reviewed=%s WHERE id=%s", (reviewed, order_id))
    conn.commit()
    return jsonify({'status': 'success', 'reviewed': bool(reviewed)})


# ---------- 下推 / 撤销下推 ----------
@order_bp.route('/api/orders/<int:order_id>/push', methods=['POST'])
@_with_db
def push_order(conn, cursor, order_id):
    user = _current_user()
    if user is None:
        return _denied()

    cursor.execute("SELECT * FROM purchase_orders WHERE id=%s", (order_id,))
    order = cursor.fetchone()
    if not order:
        return jsonify({'status': 'error', 'message': '单据不存在'}), 404
    if order['pushed']:
        return jsonify({'status': 'error', 'message': '该单据已下推，如需重新下推请先撤销'}), 400
    if int(order['quantity']) <= 0:
        return jsonify({'status': 'error', 'message': '单据设备数量为 0，无法下推'}), 400

    card_month = request.form.get('card_month', '').strip() or datetime.now().strftime('%Y-%m')
    try:
        datetime.strptime(card_month, '%Y-%m')
    except ValueError:
        raise ValueError('卡片月份格式应为 YYYY-MM') from None

    quantity = int(order['quantity'])
    push_date = date.today()

    # 下推与资产登记共用一套取号规则，并发时 device_list.uk_number 会拦下重复编码（1062），
    # 这里回滚后重取序号重试，避免直接抛到 _with_db 变成「服务器内部错误」。
    numbers = None
    for attempt in range(DUP_RETRY + 1):
        try:
            numbers = _register_push_assets(cursor, order, quantity, push_date)

            rows = []
            for index, number in enumerate(numbers):
                rows.append((
                    f"{order['order_no']}-{index + 1:02d}", order_id, order['order_no'], card_month, number,
                    order['device_type'], order['spec'] or '', '',
                    STOCK_CUSTODIAN_NAME, STOCK_CUSTODIAN_DEPT, push_date, CARD_IN_STOCK,
                ))

            cursor.executemany(
                """INSERT INTO asset_cards
                   (card_no, order_id, order_no, card_month, asset_number, device_type, spec, sn,
                    owner, department, receive_date, card_status)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                rows
            )
            cursor.execute(
                "UPDATE purchase_orders SET pushed=1, push_month=%s, pushed_at=NOW(), created_by=IF(created_by='', %s, created_by) WHERE id=%s",
                (card_month, user, order_id)
            )
            conn.commit()
            break
        except Error as exc:
            conn.rollback()
            if getattr(exc, 'errno', None) == ER_DUP_ENTRY and attempt < DUP_RETRY:
                logger.warning("下推取号冲突，重取序号重试（第 %s 次）: %s", attempt + 1, exc)
                continue
            if getattr(exc, 'errno', None) == ER_DUP_ENTRY:
                logger.error("下推重试 %s 次后仍冲突", DUP_RETRY)
                return jsonify({
                    'status': 'error',
                    'message': '资产编码冲突（可能有其他人正在登记或下推单据），请稍后重试',
                }), 409
            raise
    else:
        return jsonify({'status': 'error', 'message': '资产编码冲突，请稍后重试'}), 409

    message = (f'已下推 {len(rows)} 张 {card_month} 资产卡片，新增台账资产 '
               f'{numbers[0]} ~ {numbers[-1]}（IT/{STOCK_CUSTODIAN_NAME} 名下，状态入库）')
    return jsonify({
        'status': 'success',
        'message': message,
        'card_month': card_month,
        'card_count': len(rows),
        'allocated': len(numbers),
    })


@order_bp.route('/api/orders/<int:order_id>/unpush', methods=['POST'])
@_with_db
def unpush_order(conn, cursor, order_id):
    if _current_user() is None:
        return _denied()

    cursor.execute("SELECT order_no, pushed FROM purchase_orders WHERE id=%s", (order_id,))
    row = cursor.fetchone()
    if not row:
        return jsonify({'status': 'error', 'message': '单据不存在'}), 404
    if not row['pushed']:
        return jsonify({'status': 'error', 'message': '该单据尚未下推'}), 400

    cursor.execute(
        "SELECT asset_number, receive_date FROM asset_cards WHERE order_id=%s AND asset_number <> ''",
        (order_id,)
    )
    bound = cursor.fetchall()
    cursor.execute("DELETE FROM asset_cards WHERE order_id=%s", (order_id,))
    cursor.execute(
        "UPDATE purchase_orders SET pushed=0, push_month='', pushed_at=NULL WHERE id=%s", (order_id,)
    )
    # 回滚下推时创建的台账入库记录；已被后续资产变更动过的资产保留，避免误删业务数据
    rolled_back = 0
    for card in bound:
        cursor.execute(
            "DELETE FROM inventory WHERE number=%s AND tag='入库' AND datetime=%s",
            (card['asset_number'], card['receive_date'])
        )
        cursor.execute(
            "DELETE FROM device_list WHERE number=%s AND department=%s AND name=%s "
            "AND NOT EXISTS (SELECT 1 FROM inventory i WHERE i.number COLLATE utf8mb4_unicode_ci = device_list.number COLLATE utf8mb4_unicode_ci)",
            (card['asset_number'], STOCK_CUSTODIAN_DEPT, STOCK_CUSTODIAN_NAME)
        )
        rolled_back += cursor.rowcount
    conn.commit()
    message = f"已撤销 {row['order_no']} 的下推，资产卡片已删除"
    if rolled_back:
        message += f'，并回滚 {rolled_back} 条台账入库记录'
    return jsonify({'status': 'success', 'message': message})


@order_bp.route('/api/asset_cards/<int:card_id>', methods=['POST'])
@_with_db
def update_card(conn, cursor, card_id):
    if _current_user() is None:
        return _denied()

    cursor.execute("SELECT * FROM asset_cards WHERE id=%s", (card_id,))
    card = cursor.fetchone()
    if not card:
        return jsonify({'status': 'error', 'message': '资产卡片不存在'}), 404

    asset_number = request.form.get('asset_number', card['asset_number']).strip().upper()
    old_number = (card['asset_number'] or '').strip()

    # 修改已绑定卡片的资产编码 = 全系统重命名该资产（不换绑另一台设备）
    renaming = bool(old_number) and asset_number and asset_number != old_number

    if renaming:
        if not _ASSET_NUMBER_RE.fullmatch(asset_number):
            raise ValueError('资产编码格式应为「前缀+年月+流水」，如 DZ2609001')
        cursor.execute("SELECT id FROM device_list WHERE number=%s", (asset_number,))
        if cursor.fetchone():
            raise ValueError(f'编码 {asset_number} 已被其它资产使用，不能重命名为该编码')
        # 台账 / 流转 / 备份 / 卡片四处同步改名，设备本身与历史保持不变
        cursor.execute("UPDATE device_list SET number=%s WHERE number=%s", (asset_number, old_number))
        cursor.execute("UPDATE inventory SET number=%s WHERE number=%s", (asset_number, old_number))
        cursor.execute("UPDATE inventory_tmp SET number=%s WHERE number=%s", (asset_number, old_number))
        cursor.execute("UPDATE asset_cards SET asset_number=%s WHERE asset_number=%s", (asset_number, old_number))

    if asset_number:
        # 已绑定台账：派生字段一律以台账实时值为准，不接受手工覆盖
        device = fetch_devices(cursor, [asset_number]).get(asset_number)
        if not device:
            raise ValueError(f'台账中不存在资产编码 {asset_number}（如需新增资产请使用「资产登记」）')
        inv_latest, inv_receive = _inventory_index(cursor, [asset_number])
        live = live_card_fields(
            device, inv_receive.get(asset_number), inv_latest.get(asset_number)
        )
        spec, sn = live['spec'], live['sn']
        owner, department = live['owner'], live['department']
        receive_date = _parse_date(live['receive_date']) if live['receive_date'] else None
        card_status = live['card_status']
    else:
        # 待分配卡片：信息手工维护
        owner = request.form.get('owner', card['owner']).strip()
        department = request.form.get('department', card['department']).strip()
        card_status = request.form.get('card_status', card['card_status']).strip()
        if card_status not in CARD_STATUSES:
            raise ValueError('无效的卡片状态')
        receive_raw = request.form.get('receive_date', _date_str(card['receive_date'])).strip()
        receive_date = _parse_date(receive_raw) if receive_raw else None
        spec = request.form.get('spec', card['spec']).strip()
        sn = request.form.get('sn', card['sn']).strip()

    cursor.execute(
        """UPDATE asset_cards SET asset_number=%s, spec=%s, sn=%s, owner=%s, department=%s,
           receive_date=%s, card_status=%s WHERE id=%s""",
        (asset_number, spec, sn, owner, department, receive_date, card_status, card_id)
    )
    conn.commit()
    return jsonify({'status': 'success', 'message': f"卡片 {card['card_no']} 已更新"})


# ---------- 今年已采购数量下钻：部门 -> 使用人 ----------
@order_bp.route('/api/orders/asset_detail')
@_with_db
def order_asset_detail(conn, cursor):
    """看板用资产档案详情：设备配置 + 台账流转记录（只读，匿名可访问）。

    流转以 inventory 台账为准（与部门领用总览同口径），按日期倒序；首行即当前状态。
    """
    number = request.args.get('number', '').strip()
    if not number:
        return jsonify({'status': 'error', 'message': '缺少资产编码'}), 400
    cursor.execute(
        "SELECT number, type, spec, sn, department, name, cpu, mem, disk, gpu "
        "FROM device_list WHERE number=%s", (number,)
    )
    device = cursor.fetchone()
    if not device:
        return jsonify({'status': 'not_found', 'message': '未找到该资产'})
    cursor.execute(
        "SELECT DATE_FORMAT(datetime, '%Y-%m-%d') AS date, department, site, tag, status, notice "
        "FROM inventory WHERE number=%s ORDER BY datetime DESC, id DESC", (number,)
    )
    flows = cursor.fetchall()
    for flow in flows:
        flow['date'] = flow.get('date') or ''
    return jsonify({
        'status': 'success',
        'device': device,
        'latest': flows[0] if flows else None,
        'flows': flows,
    })


@order_bp.route('/api/orders/dept_usage')
@_with_db
def dept_usage(conn, cursor):
    """部门领用总览：一级「部门 × 类型」当前领用矩阵，二级入职/领用/更换明细。

    只读接口，与看板其余读接口一致匿名可访问；口径见 :func:`ledger.dept_usage_matrix`。
    """
    month_from = request.args.get('from', '').strip()
    month_to = request.args.get('to', '').strip()
    payload = {'status': 'success'}
    payload.update(dept_usage_matrix(
        cursor,
        month_from=month_from or None,
        month_to=month_to or None,
    ))
    return jsonify(payload)


def _usage_rows(cursor, device_type, year, department=None, until=None):
    sql = f"SELECT {DEVICE_FIELDS} FROM device_list WHERE type=%s AND SUBSTRING(number, 3, 2)=%s"
    params = [device_type, _year_code(year)]
    if until:
        sql += " AND SUBSTRING(number, 3, 4) <= %s"
        params.append(until)
    if department is not None:
        sql += " AND department=%s"
        params.append(department)
    sql += " ORDER BY department, number"
    cursor.execute(sql, tuple(params))
    return cursor.fetchall()


@order_bp.route('/api/orders/type_usage')
@_with_db
def type_usage(conn, cursor):
    device_type = request.args.get('type', '').strip()
    year = request.args.get('year', '').strip()
    until = _parse_until(request.args.get('until', ''))
    if not device_type or not year.isdigit():
        return jsonify({'status': 'error', 'message': '缺少设备类型或年度参数'}), 400

    rows = _usage_rows(cursor, device_type, int(year), until=until)
    inv_latest, inv_receive = _inventory_index(cursor, [r['number'] for r in rows])

    grouped = {}
    for row in rows:
        department = row['department'] or '未分配部门'
        item = grouped.setdefault(department, {
            'department': department, 'count': 0, 'issued': 0, 'in_stock': 0, 'users': set()
        })
        item['count'] += 1
        if row['name']:
            item['users'].add(row['name'])
        inv_row = inv_latest.get(row['number'])
        is_stock = (row['department'], row['name']) == (STOCK_CUSTODIAN_DEPT, STOCK_CUSTODIAN_NAME) \
            or (inv_row and inv_row.get('tag') in STOCK_TAGS and not inv_receive.get(row['number']))
        if is_stock:
            item['in_stock'] += 1
        else:
            item['issued'] += 1

    departments = [{
        'department': v['department'],
        'count': v['count'],
        'issued': v['issued'],
        'in_stock': v['in_stock'],
        'user_count': len(v['users']),
    } for v in grouped.values()]
    departments.sort(key=lambda d: (-d['count'], d['department']))

    return jsonify({
        'status': 'success',
        'device_type': device_type,
        'year': int(year),
        'title': f'{int(year)} 年 {device_type} 各部门使用情况{_until_label(until)}',
        'total': len(rows),
        'departments': departments,
    })


@order_bp.route('/api/orders/dept_users')
@_with_db
def dept_users(conn, cursor):
    device_type = request.args.get('type', '').strip()
    year = request.args.get('year', '').strip()
    department = request.args.get('department', '')
    until = _parse_until(request.args.get('until', ''))
    if not device_type or not year.isdigit():
        return jsonify({'status': 'error', 'message': '缺少设备类型或年度参数'}), 400

    rows = _usage_rows(cursor, device_type, int(year), department=department, until=until)
    inv_latest, inv_receive = _inventory_index(cursor, [r['number'] for r in rows])

    data = []
    for row in rows:
        inv_row = inv_latest.get(row['number']) or {}
        receive_date = inv_receive.get(row['number'])
        is_stock = (row['department'], row['name']) == (STOCK_CUSTODIAN_DEPT, STOCK_CUSTODIAN_NAME) \
            or (inv_row.get('tag') in STOCK_TAGS and not receive_date)
        data.append({
            'number': row['number'],
            'spec': row['spec'] or '',
            'sn': row['sn'] or '',
            'owner': row['name'] or '',
            'department': row['department'] or '',
            'receive_date': _date_str(receive_date) if receive_date else _date_str(inv_row.get('datetime')),
            'issued': not is_stock,
            'site': inv_row.get('site') or '',
            'tag': inv_row.get('tag') or '',
            'status': inv_row.get('status') or '',
            'cpu': row['cpu'] or '', 'mem': row['mem'] or '',
            'disk': row['disk'] or '', 'gpu': row['gpu'] or '',
        })

    dept_label = department if department else '全部部门'
    return jsonify({
        'status': 'success',
        'title': f'{int(year)} 年 {device_type} · {dept_label} 使用明细{_until_label(until)}',
        'device_type': device_type,
        'year': int(year),
        'department': department,
        'total': len(data),
        'data': data,
    })


# ---------- 预算配置 ----------
@order_bp.route('/api/budgets')
@_with_db
def list_budgets(conn, cursor):
    year = request.args.get('year', '').strip()
    year = int(year) if year.isdigit() else datetime.now().year
    cursor.execute(
        "SELECT id, budget_year, device_type, budget_amount, used_adjust, remark, updated_at "
        "FROM budgets WHERE budget_year=%s ORDER BY device_type",
        (year,)
    )
    rows = cursor.fetchall()
    _, used = _budget_totals(cursor, year)
    budgets = []
    for r in rows:
        # 已用 = 自动统计（当年「预算内」单据金额）+ 手动修正量；
        # 修正量设置后新创建的单据仍会自动累加，修正量持续生效
        adjust = _money(r['used_adjust']) if r['used_adjust'] is not None else None
        used_computed = round(used.get(r['device_type'], 0.0), 2)
        effective = round(used_computed + (adjust if adjust is not None else 0.0), 2)
        budgets.append({
            'id': r['id'],
            'year': int(r['budget_year']),
            'device_type': r['device_type'],
            'budget_amount': _money(r['budget_amount']),
            'remark': r['remark'] or '',
            'updated_at': _datetime_str(r['updated_at']),
            'used': effective,
            'used_computed': used_computed,
            'used_manual': adjust is not None,
            'used_adjust': round(adjust, 2) if adjust is not None else None,
            'left': round(_money(r['budget_amount']) - effective, 2),
        })
    return jsonify({'status': 'success', 'year': year, 'budgets': budgets})


@order_bp.route('/api/budgets', methods=['POST'])
@_with_db
def save_budget(conn, cursor):
    if _current_user() is None:
        return _denied()

    year = request.form.get('year', '').strip()
    device_type = request.form.get('device_type', '').strip()
    if not year.isdigit() or not device_type:
        return jsonify({'status': 'error', 'message': '年度与设备类型不能为空'}), 400
    amount = _parse_money(request.form.get('budget_amount', ''), '预算金额')
    remark = request.form.get('remark', '').strip()

    # 已用金额（提交的是「期望的已用总额」）：
    #   参数未传（如新增预算）→ 不改动既有修正量；
    #   传空串 → 清除修正量，恢复纯自动统计；
    #   传数值 → 换算为修正量 = 数值 - 当年自动统计；恰与自动统计相等时视为无需修正（置 NULL）。
    # 修正量可为负（自动统计多算了时性总比实际少），后续新单据照常累加在自动统计之上
    if 'used_amount' in request.form:
        raw_used = request.form.get('used_amount', '').strip()
        if raw_used:
            typed = _parse_money(raw_used, '已用金额')
            cursor.execute(
                "SELECT COALESCE(SUM(amount), 0) AS auto_used FROM purchase_orders "
                "WHERE in_budget=1 AND YEAR(order_date)=%s AND device_type=%s",
                (int(year), device_type)
            )
            auto_used = _money(cursor.fetchone()['auto_used'])
            used_adjust = round(float(typed) - auto_used, 2)
            if used_adjust == 0:
                used_adjust = None
        else:
            used_adjust = None
    else:
        cursor.execute(
            "SELECT used_adjust FROM budgets WHERE budget_year=%s AND device_type=%s",
            (int(year), device_type)
        )
        existing = cursor.fetchone()
        used_adjust = _money(existing['used_adjust']) if existing and existing['used_adjust'] is not None else None

    cursor.execute(
        """INSERT INTO budgets (budget_year, device_type, budget_amount, used_adjust, remark)
           VALUES (%s, %s, %s, %s, %s)
           ON DUPLICATE KEY UPDATE budget_amount=VALUES(budget_amount),
           used_adjust=VALUES(used_adjust), remark=VALUES(remark)""",
        (int(year), device_type, amount, used_adjust, remark)
    )
    conn.commit()
    return jsonify({'status': 'success', 'message': f'{year} 年 {device_type} 预算已保存'})


@order_bp.route('/api/budgets/<int:budget_id>', methods=['DELETE'])
@_with_db
def delete_budget(conn, cursor, budget_id):
    if _current_user() is None:
        return _denied()
    cursor.execute("DELETE FROM budgets WHERE id=%s", (budget_id,))
    conn.commit()
    return jsonify({'status': 'success', 'message': '预算已删除'})
