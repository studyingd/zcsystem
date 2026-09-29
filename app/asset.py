"""资产登记页后端。

台账（device_list + inventory）的唯一新增入口。编码规则、批量写入、
「最新一条流转记录」等口径统一由 :mod:`app.ledger` 提供，本模块只做
参数校验与 HTTP 层，避免与单据下推（``order.py``）各写一份。
HTTP 样板（登录检查、连接管理、异常转 JSON）统一使用 :mod:`app.common`。
"""

import logging
from datetime import date, datetime

from flask import Blueprint, jsonify, render_template, request, send_file
from mysql.connector import Error

from . import ledger
from .common import error_json, login_required_api, login_required_page, with_db
from .config import S3_EXTERNAL_URL
from .config import get_db_connection as _get_db_connection
from .utils import rows_to_xlsx

asset_bp = Blueprint('asset', __name__)
logger = logging.getLogger(__name__)

# 并发取号冲突的口径与重试次数统一放在 ledger（与单据下推共用）
ER_DUP_ENTRY = ledger.ER_DUP_ENTRY
_DUP_RETRY = ledger.DUP_RETRY

LIST_PAGE_SIZE = 15
LIST_MAX_PAGE_SIZE = 200
# 列表模糊搜索覆盖的字段
_SEARCH_COLUMNS = ('number', 'sn', 'spec', 'type', 'department', 'name')

_DEVICE_COLUMNS = 'id, number, spec, type, department, name, sn, cpu, mem, disk, gpu'


def _bad_request(message):
    return error_json(message, 400)


def _int_arg(value, default, minimum, maximum):
    """参数转整数并夹在 [minimum, maximum] 内，非法值回退默认值。"""
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, number))


def _like(value):
    """转义 LIKE 通配符，避免用户输入的 % _ \\ 退化成全表匹配。"""
    escaped = value.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
    return f'%{escaped}%'


def _list_filters(args):
    """解析列表筛选参数，返回 (where_sql, params, month, prefix, keyword)。"""
    clauses = ['LENGTH(number) = %s']
    params = [ledger.CODE_LENGTH]

    month = (args.get('month') or '').strip()
    if len(month) == 4 and month.isdigit():
        clauses.append('SUBSTRING(number, 3, 4) = %s')
        params.append(month)
    else:
        month = ''

    prefix = (args.get('prefix') or '').strip().upper()
    if prefix in (ledger.CODE_PREFIX_DEFAULT, ledger.CODE_PREFIX_RENTAL):
        clauses.append('number LIKE %s')
        params.append(f'{prefix}%')
    else:
        prefix = ''

    keyword = (args.get('q') or '').strip()
    if keyword:
        pattern = _like(keyword)
        clauses.append('(' + ' OR '.join(f'{col} LIKE %s' for col in _SEARCH_COLUMNS) + ')')
        params.extend([pattern] * len(_SEARCH_COLUMNS))

    return ' AND '.join(clauses), params, month, prefix, keyword


def _months(cursor):
    """台账已覆盖的年月码，倒序（最新月份在前）。"""
    cursor.execute(
        "SELECT DISTINCT SUBSTRING(number, 3, 4) AS month FROM device_list "
        "WHERE LENGTH(number) = %s ORDER BY month DESC",
        (ledger.CODE_LENGTH,)
    )
    return [row['month'] for row in cursor.fetchall() if row['month']]


def _overlay_latest_inventory(cursor, rows):
    """用 inventory 最新一条流转记录覆盖部门 / 使用人，并带出状态与流转日期。

    device_list 是使用现状快照，inventory 才是流转事实来源；列表与详情都经过
    本函数，保证两处口径一致（读取时派生，不落库）。
    """
    latest = ledger.latest_inventory_rows(cursor, [row['number'] for row in rows])
    for row in rows:
        inv = latest.get(row['number']) or {}
        row['department'] = inv.get('department') or row.get('department') or ''
        row['name'] = inv.get('site') or row.get('name') or ''
        row['inv_status'] = inv.get('status') or ''
        row['inv_tag'] = inv.get('tag') or ''
        row['inv_date'] = inv.get('datetime') or ''
    return rows


# ---------- 页面 ----------
@asset_bp.route('/asset_register')
@login_required_page
def asset_register():
    return render_template(
        'asset_register.html',
        active_nav='asset_register',
        logged_in=True,
        asset_types=ledger.ASSET_TYPES,
        config_types=ledger.CONFIG_TYPES,
        custom_type_option=ledger.CUSTOM_TYPE_OPTION,
        rental_type=ledger.RENTAL_DESKTOP_TYPE,
        rental_default_spec=ledger.RENTAL_DEFAULT_SPEC,
        departments=ledger.DEPARTMENTS,
        max_batch=ledger.MAX_REGISTER_BATCH,
        page_size=LIST_PAGE_SIZE,
    )


# ---------- 页面元数据 ----------
@asset_bp.route('/api/asset_register/meta')
@login_required_api
def asset_register_meta():
    """品牌图标地址由后端下发：图标存放在对象存储，前端不再硬编码内网 IP。

    响应禁缓存：关键字表改动后，页面下次加载即可拿到新表，避免浏览器
    按启发式缓存旧响应导致“改了关键字但图标不更新”。
    """
    icon_base = (S3_EXTERNAL_URL or '').rstrip('/')
    response = jsonify({
        'status': 'success',
        'icon_base': f'{icon_base}/icon/' if icon_base else '',
        'brand_icons': [{'keywords': list(keywords), 'file': filename}
                        for keywords, filename in ledger.BRAND_ICONS],
    })
    response.headers['Cache-Control'] = 'no-store'
    return response


# ---------- 编码预览 ----------
@asset_bp.route('/api/generate_asset_codes', methods=['POST'])
@login_required_api
@with_db
def generate_asset_codes(conn, cursor):
    """预览将要生成的编码。

    与 ``batch_create_assets`` 共用 :func:`ledger.next_asset_numbers`，但两次调用
    之间若有其他写入（他人登记 / 单据下推），序号会前移 —— 因此预览仅供参考，
    实际编码以提交响应中的 ``first_number`` / ``last_number`` 为准。
    """
    data = request.get_json(silent=True) or {}
    asset_type = (data.get('asset_type') or '').strip()
    if not asset_type:
        return _bad_request('请选择资产类型')

    quantity = _int_arg(data.get('quantity'), 1, 1, ledger.MAX_REGISTER_BATCH)
    yymm = ledger.yymm_from_month(data.get('year_month'))  # ValueError -> 400

    codes = ledger.next_asset_numbers(cursor, asset_type, yymm, quantity)
    return jsonify({
        'status': 'success',
        'codes': codes,
        'prefix': ledger.asset_prefix(asset_type),
        'date_code': yymm,
        'quantity': quantity,
    })


# ---------- 批量登记 ----------
def _parse_registration(data):
    """校验并规范化登记请求，返回 (payload, error_message)。

    payload 含 asset_type / spec / department / user / yymm / quantity /
    config（cpu / mem / disk / gpu）/ sn_list。
    """
    asset_type = (data.get('asset_type') or '').strip()
    spec = (data.get('asset_spec') or '').strip()
    if not asset_type or not spec:
        return None, '请填写所有必填字段'

    try:
        quantity = int(data.get('batch_quantity'))
    except (TypeError, ValueError):
        return None, '批量数量必须是整数'
    if quantity < 1:
        return None, '批量数量至少为 1'
    if quantity > ledger.MAX_REGISTER_BATCH:
        return None, f'单次批量数量不能超过 {ledger.MAX_REGISTER_BATCH} 个'

    try:
        yymm = ledger.yymm_from_month(data.get('year_month'))
    except ValueError as exc:
        return None, str(exc)

    config = data.get('config') or {}
    if not isinstance(config, dict):
        config = {}
    # 硬件配置只对电脑类资产有意义，其余类型一律留空（不信任前端传值）
    hardware_keys = ('cpu', 'mem', 'disk', 'gpu') if asset_type in ledger.CONFIG_TYPES else ()
    hardware = {key: (config.get(key) or '').strip() for key in hardware_keys}

    # SN 是设备唯一标识：批量登记时必须逐台提供，不能整批共用一个
    sn_list = []
    if asset_type == ledger.RENTAL_DESKTOP_TYPE:
        raw = config.get('sn_list')
        if isinstance(raw, list):
            sn_list = [str(item).strip() for item in raw]
        else:
            sn_list = [line.strip() for line in str(config.get('sn') or '').splitlines()]
        sn_list = [item for item in sn_list if item]
        if len(sn_list) != quantity:
            return None, f'SN 码数量（{len(sn_list)}）与批量数量（{quantity}）不一致，请每行填写一个 SN'
        if len(set(sn_list)) != len(sn_list):
            return None, 'SN 码存在重复，请逐台核对'

    payload = {
        'asset_type': asset_type,
        'spec': spec,
        'department': (data.get('asset_dept') or '').strip(),
        'user': (data.get('asset_user') or '').strip(),
        'yymm': yymm,
        'quantity': quantity,
        'hardware': hardware,
        'sn_list': sn_list,
    }
    return payload, None


def _execute_registration(conn, payload):
    """执行一次登记，撞唯一键时重取序号重试；连接由调用方管理。"""
    cursor = None
    for attempt in range(_DUP_RETRY + 1):
        try:
            cursor = conn.cursor(dictionary=True)
            numbers = ledger.next_asset_numbers(
                cursor, payload['asset_type'], payload['yymm'], payload['quantity']
            )
            assets = []
            for index, number in enumerate(numbers):
                item = {
                    'number': number,
                    'type': payload['asset_type'],
                    'spec': payload['spec'],
                    'department': payload['department'],
                    'name': payload['user'],
                }
                item.update(payload['hardware'])
                if payload['sn_list']:
                    item['sn'] = payload['sn_list'][index]
                assets.append(item)

            ledger.insert_ledger_assets(cursor, assets, date.today())
            conn.commit()

            quantity = len(numbers)
            span = numbers[0] if quantity == 1 else f'{numbers[0]} ~ {numbers[-1]}'
            return jsonify({
                'status': 'success',
                'message': f'资产登记成功：{span}（共 {quantity} 个）',
                'first_number': numbers[0],
                'last_number': numbers[-1],
                'numbers': numbers,
                'quantity': quantity,
            })
        except ValueError as exc:
            conn.rollback()
            return _bad_request(str(exc))
        except Error as exc:
            conn.rollback()
            if getattr(exc, 'errno', None) == ER_DUP_ENTRY and attempt < _DUP_RETRY:
                logger.warning("登记序号冲突，重取序号重试（第 %s 次）: %s", attempt + 1, exc)
                continue
            logger.error("登记失败: %s", exc)
            if getattr(exc, 'errno', None) == ER_DUP_ENTRY:
                return error_json('资产编码冲突（可能有其他人正在登记或下推单据），请稍后重试', 409)
            return error_json('服务器内部错误', 500)
        finally:
            if cursor:
                cursor.close()
                cursor = None

    logger.error("登记重试 %s 次后仍失败", _DUP_RETRY)
    return error_json('资产编码冲突，请稍后重试', 409)


@asset_bp.route('/api/batch_create_assets', methods=['POST'])
@login_required_api
@with_db
def batch_create_assets(conn, cursor):
    # 重试逻辑需要按尝试轮次控制游标生命周期，_execute_registration 自管游标，
    # 不使用 with_db 注入的 cursor
    payload, error = _parse_registration(request.get_json(silent=True) or {})
    if error:
        return _bad_request(error)
    return _execute_registration(conn, payload)


# 列表排序口径：DZ（自有）前缀优先排完，再排 ZL（租赁）前缀；
# 组内按编码、id 升序。
_LIST_ORDER_SQL = (
    f"CASE WHEN number LIKE '{ledger.CODE_PREFIX_DEFAULT}%' THEN 0 ELSE 1 END, "
    'number ASC, id ASC'
)


# ---------- 资产列表（搜索 / 筛选 / 分页） ----------
@asset_bp.route('/api/get_all_assets', methods=['GET'])
@login_required_api
@with_db
def get_all_assets(conn, cursor):
    """台账资产列表。

    支持按年月码（month=YYMM）、编码前缀（prefix=DZ|ZL）、关键字（q，覆盖
    编码 / SN / 规格 / 类型 / 部门 / 使用人）筛选，并分页返回。排序为
    DZ 前缀在前、ZL 前缀在后，组内按编码升序。每行都会用
    inventory 最新一条流转记录覆盖部门与使用人，并带出资产状态，因此列表
    与详情弹窗、资产变更页看到的是同一份口径。
    """
    args = request.args
    where_sql, params, month, prefix, keyword = _list_filters(args)
    page = _int_arg(args.get('page'), 1, 1, 100000)
    page_size = _int_arg(args.get('page_size'), LIST_PAGE_SIZE, 10, LIST_MAX_PAGE_SIZE)

    cursor.execute(f"SELECT COUNT(*) AS cnt FROM device_list WHERE {where_sql}", params)
    total = int(cursor.fetchone()['cnt'])

    total_pages = max(1, -(-total // page_size))
    page = min(page, total_pages)
    offset = (page - 1) * page_size

    cursor.execute(
        f"SELECT {_DEVICE_COLUMNS} FROM device_list WHERE {where_sql} "
        f"ORDER BY {_LIST_ORDER_SQL} LIMIT %s OFFSET %s",
        (*params, page_size, offset)
    )
    rows = _overlay_latest_inventory(cursor, list(cursor.fetchall()))

    return jsonify({
        'status': 'success',
        'rows': rows,
        'total': total,
        'page': page,
        'page_size': page_size,
        'total_pages': total_pages,
        'months': _months(cursor),
        'filters': {'month': month, 'prefix': prefix, 'q': keyword},
    })


# ---------- 导出（资产登记模块：台账资产） ----------
@asset_bp.route('/asset_register/export')
@login_required_page
def export_asset_register():
    """导出「资产登记」模块的台账资产（与页面「资产列表」同筛选、同口径，不分页）。

    月份 / 编码前缀 / 关键字与列表一致；使用部门、使用人、资产状态按 inventory
    最新流转覆盖（与列表、详情弹窗同一口径）。排序与列表一致（DZ 前缀在
    前、ZL 在后，组内升序），可用 order=desc 反转组内顺序。
    错误按纯文本返回（文件下载路由）。
    """
    sort_order = (request.args.get('order') or 'asc').lower()
    if sort_order not in ('asc', 'desc'):
        sort_order = 'asc'
    conn = _get_db_connection()
    if not conn:
        return '数据库连接失败', 500
    cursor = None
    try:
        cursor = conn.cursor(dictionary=True, buffered=True)
        where_sql, params, _month, _prefix, _keyword = _list_filters(request.args)
        cursor.execute(
            f"SELECT {_DEVICE_COLUMNS} FROM device_list WHERE {where_sql} "
            f"ORDER BY CASE WHEN number LIKE '{ledger.CODE_PREFIX_DEFAULT}%' THEN 0 ELSE 1 END, "
            f"number {sort_order}, id {sort_order}",
            tuple(params)
        )
        rows = _overlay_latest_inventory(cursor, list(cursor.fetchall()))
        data = [{
            '资产编码': r['number'],
            '类型': r['type'],
            '规格': r['spec'] or '',
            'CPU': r['cpu'] or '',
            '内存': r['mem'] or '',
            '硬盘': r['disk'] or '',
            '显卡': r['gpu'] or '',
            'SN': r['sn'] or '',
            '使用部门': r['department'] or '',
            '使用人': r['name'] or '',
            '资产状态': r.get('inv_status') or '',
            '流转标签': r.get('inv_tag') or '',
            '流转日期': r.get('inv_date') or '',
        } for r in rows]
        output = rows_to_xlsx([('资产台账', data)])
        return send_file(
            output,
            mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            as_attachment=True,
            download_name=f"asset_register_export_{datetime.now().strftime('%Y%m%d%H%M')}.xlsx",
        )
    except Exception as exc:
        logger.error('导出资产台账失败: %s', exc, exc_info=True)
        return '导出失败: 服务器内部错误', 500
    finally:
        if cursor:
            cursor.close()
        conn.close()


# ---------- 资产详情 ----------
@asset_bp.route('/api/get_asset_detail', methods=['GET'])
@login_required_api
@with_db
def get_asset_detail(conn, cursor):
    """单个资产详情，部门 / 使用人 / 状态取 inventory 最新一条流转记录。"""
    asset_id = (request.args.get('id') or '').strip()
    if not asset_id.isdigit():
        return _bad_request('缺少资产ID')

    cursor.execute(f"SELECT {_DEVICE_COLUMNS} FROM device_list WHERE id = %s", (asset_id,))
    asset = cursor.fetchone()
    if not asset:
        return error_json('资产不存在', 404)

    asset = _overlay_latest_inventory(cursor, [asset])[0]
    return jsonify({'status': 'success', 'data': asset})
