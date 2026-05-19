import calendar
import logging
from flask import Blueprint, render_template, request, jsonify, session
from datetime import datetime, timedelta
from .config import get_db_connection

dashboard_bp = Blueprint('dashboard', __name__)
logger = logging.getLogger(__name__)

# ---- 可配置常量 ----
NEW_LAPTOP_THRESHOLD = 'DZ2508000'
NEW_MONITOR_THRESHOLD = 'DZ2403000'
STOCK_CUSTODIAN_DEPT = 'IT'
STOCK_CUSTODIAN_NAME = '余嘉雄'
OLD_LAPTOP_LOCATIONS = ('1号架子-2', '9B机房1号架子-2', '10A上机房')
OLD_MONITOR_LOCATIONS = ('10A下机房', '10A上机房')
STOCK_TAGS = ('入库', '离职')
METRIC_TAGS = ('入职', '领用', '更换')

METRICS_SQL = f"""
SELECT
  SUM(CASE WHEN type='笔记本电脑' AND number >= '{NEW_LAPTOP_THRESHOLD}' AND tag IN ('入职','领用','更换') THEN 1 ELSE 0 END) AS new_laptop,
  SUM(CASE WHEN type='笔记本电脑' AND number < '{NEW_LAPTOP_THRESHOLD}' AND tag IN ('入职','领用','更换') THEN 1 ELSE 0 END) AS old_laptop,
  SUM(CASE WHEN type='显示器' AND number >= '{NEW_MONITOR_THRESHOLD}' AND tag IN ('入职','领用','更换') THEN 1 ELSE 0 END) AS new_monitor,
  SUM(CASE WHEN type='显示器' AND number < '{NEW_MONITOR_THRESHOLD}' AND tag IN ('入职','领用','更换') THEN 1 ELSE 0 END) AS old_monitor,
  SUM(CASE WHEN type='台式主机' AND tag IN ('入职','领用','更换') THEN 1 ELSE 0 END) AS desktop,
  SUM(CASE WHEN type='租聘台式主机' AND tag IN ('入职','领用','更换') THEN 1 ELSE 0 END) AS rental
FROM inventory
WHERE datetime >= %s AND datetime < %s
"""

METRIC_KEYS = [
    ('new_laptop', '新笔记本领用'),
    ('old_laptop', '旧笔记本领用'),
    ('new_monitor', '新显示器领用'),
    ('old_monitor', '旧显示器领用'),
    ('desktop', '台式机领用'),
    ('rental', '租聘台式机领用'),
]

PURCHASE_SQL = """
SELECT
  SUM(CASE WHEN type='笔记本电脑' THEN 1 ELSE 0 END) AS laptop,
  SUM(CASE WHEN type='显示器' THEN 1 ELSE 0 END) AS monitor,
  SUM(CASE WHEN type='台式主机' THEN 1 ELSE 0 END) AS desktop,
  SUM(CASE WHEN type='租聘台式主机' THEN 1 ELSE 0 END) AS rental_desktop
FROM device_list
WHERE SUBSTRING(number, 3, 4) >= %s AND SUBSTRING(number, 3, 4) <= %s
"""

PURCHASE_KEYS = [
    ('laptop', '笔记本采购'),
    ('monitor', '显示器采购'),
    ('desktop', '台式机采购'),
    ('rental_desktop', '租聘台式机采购'),
]

_old_laptop_sites = "','".join(OLD_LAPTOP_LOCATIONS)
_old_monitor_sites = "','".join(OLD_MONITOR_LOCATIONS)
_stock_tags = "','".join(STOCK_TAGS)

STOCK_SQL = f"""
SELECT
  (SELECT COUNT(*) FROM device_list WHERE type='笔记本电脑' AND department='{STOCK_CUSTODIAN_DEPT}' AND name='{STOCK_CUSTODIAN_NAME}')
  + (SELECT COUNT(*) FROM inventory WHERE type='笔记本电脑' AND number >= '{NEW_LAPTOP_THRESHOLD}' AND tag IN ('{_stock_tags}'))
  AS new_laptop_stock,

  (SELECT COUNT(*) FROM inventory WHERE type LIKE '%%笔记本%%'
   AND site IN ('{_old_laptop_sites}') AND number < '{NEW_LAPTOP_THRESHOLD}')
  AS old_laptop_stock,

  (SELECT COUNT(*) FROM device_list WHERE type='显示器' AND department='{STOCK_CUSTODIAN_DEPT}' AND name='{STOCK_CUSTODIAN_NAME}')
  + (SELECT COUNT(*) FROM inventory WHERE type='显示器' AND number >= '{NEW_MONITOR_THRESHOLD}' AND tag IN ('{_stock_tags}'))
  AS new_monitor_stock,

  (SELECT COUNT(*) FROM inventory WHERE type='显示器'
   AND site IN ('{_old_monitor_sites}') AND number < '{NEW_MONITOR_THRESHOLD}')
  AS old_monitor_stock,

  (SELECT COUNT(*) FROM inventory WHERE type='台式主机' AND tag IN ('{_stock_tags}'))
  AS desktop_stock,

  (SELECT COUNT(*) FROM inventory WHERE type='租聘台式主机' AND tag IN ('{_stock_tags}'))
  AS rental_stock
"""

STOCK_KEYS = [
    ('new_laptop_stock', '新笔记本库存'),
    ('old_laptop_stock', '旧笔记本库存'),
    ('new_monitor_stock', '新显示器库存'),
    ('old_monitor_stock', '旧显示器库存'),
    ('desktop_stock', '台式机库存'),
    ('rental_stock', '租聘台式机库存'),
]

STOCK_DETAIL_MAP = {
    'new_laptop_stock': {
        'queries': [
            (f"SELECT id, number, type, spec, department as dept, name as site FROM device_list WHERE type='笔记本电脑' AND department='{STOCK_CUSTODIAN_DEPT}' AND name='{STOCK_CUSTODIAN_NAME}'", []),
            (f"SELECT id, number, type, '' as spec, department as dept, site, datetime, tag FROM inventory WHERE type='笔记本电脑' AND number >= '{NEW_LAPTOP_THRESHOLD}' AND tag IN ('{_stock_tags}')", []),
        ],
        'title': '新笔记本库存明细',
    },
    'old_laptop_stock': {
        'queries': [
            (f"SELECT id, number, type, '' as spec, department as dept, site, datetime, tag FROM inventory WHERE type LIKE '%%笔记本%%' AND site IN ('{_old_laptop_sites}') AND number < '{NEW_LAPTOP_THRESHOLD}'", []),
        ],
        'title': '旧笔记本库存明细',
    },
    'new_monitor_stock': {
        'queries': [
            (f"SELECT id, number, type, spec, department as dept, name as site FROM device_list WHERE type='显示器' AND department='{STOCK_CUSTODIAN_DEPT}' AND name='{STOCK_CUSTODIAN_NAME}'", []),
            (f"SELECT id, number, type, '' as spec, department as dept, site, datetime, tag FROM inventory WHERE type='显示器' AND number >= '{NEW_MONITOR_THRESHOLD}' AND tag IN ('{_stock_tags}')", []),
        ],
        'title': '新显示器库存明细',
    },
    'old_monitor_stock': {
        'queries': [
            (f"SELECT id, number, type, '' as spec, department as dept, site, datetime, tag FROM inventory WHERE type='显示器' AND site IN ('{_old_monitor_sites}') AND number < '{NEW_MONITOR_THRESHOLD}'", []),
        ],
        'title': '旧显示器库存明细',
    },
    'desktop_stock': {
        'queries': [
            (f"SELECT id, number, type, '' as spec, department as dept, site, datetime, tag FROM inventory WHERE type='台式主机' AND tag IN ('{_stock_tags}')", []),
        ],
        'title': '台式机库存明细',
    },
    'rental_stock': {
        'queries': [
            (f"SELECT id, number, type, '' as spec, department as dept, site, datetime, tag FROM inventory WHERE type='租聘台式主机' AND tag IN ('{_stock_tags}')", []),
        ],
        'title': '租聘台式机库存明细',
    },
}


@dashboard_bp.route('/dashboard')
def dashboard_page():
    if not session.get('logged_in'):
        return render_template('login.html')
    return render_template('dashboard.html', active_nav='dashboard')


@dashboard_bp.route('/api/dashboard_stats')
def dashboard_stats():
    if not session.get('logged_in'):
        return jsonify({'status': 'error', 'message': '未登录'}), 401

    start_str = request.args.get('start', '')
    end_str = request.args.get('end', '')

    try:
        if not start_str or not end_str:
            return jsonify({'status': 'error', 'message': '请选择起止日期'}), 400

        current_start = datetime.strptime(start_str, '%Y-%m-%d')
        end_date = datetime.strptime(end_str, '%Y-%m-%d')
        current_end = end_date + timedelta(days=1)
    except ValueError:
        return jsonify({'status': 'error', 'message': '日期格式错误'}), 400

    # 对比区间：起始日期所在月的上一个完整自然月
    prev_year = current_start.year if current_start.month > 1 else current_start.year - 1
    prev_month = current_start.month - 1 if current_start.month > 1 else 12
    prev_month_days = calendar.monthrange(prev_year, prev_month)[1]
    prev_start = datetime(prev_year, prev_month, 1)
    prev_end = datetime(prev_year, prev_month, prev_month_days) + timedelta(days=1)

    conn = get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': '数据库连接失败'}), 500

    try:
        cursor = conn.cursor(dictionary=True)

        cursor.execute(METRICS_SQL, (current_start.strftime('%Y-%m-%d'), current_end.strftime('%Y-%m-%d')))
        current_data = cursor.fetchone()

        cursor.execute(METRICS_SQL, (prev_start.strftime('%Y-%m-%d'), prev_end.strftime('%Y-%m-%d')))
        prev_data = cursor.fetchone()

        metrics = []
        for idx, (key, name) in enumerate(METRIC_KEYS):
            cur = int(current_data.get(key) or 0)
            pre = int(prev_data.get(key) or 0)
            if cur > pre:
                trend = 'up'
            elif cur < pre:
                trend = 'down'
            else:
                trend = 'same'
            metrics.append({
                'key': key,
                'name': name,
                'current': cur,
                'prev': pre,
                'diff': cur - pre,
                'trend': trend,
            })

        # 实际采购数量：从 device_list 按资产编号中的日期码范围查询
        date_start = current_start.strftime('%y%m')
        date_end = end_date.strftime('%y%m')
        prev_date_start = prev_start.strftime('%y%m')
        prev_date_end = (prev_end - timedelta(days=1)).strftime('%y%m')

        cursor.execute(PURCHASE_SQL, (date_start, date_end))
        purchase_data = cursor.fetchone()

        cursor.execute(PURCHASE_SQL, (prev_date_start, prev_date_end))
        prev_purchase_data = cursor.fetchone()

        purchases = []
        for key, name in PURCHASE_KEYS:
            cur = int(purchase_data.get(key) or 0)
            pre = int(prev_purchase_data.get(key) or 0)
            if cur > pre:
                trend = 'up'
            elif cur < pre:
                trend = 'down'
            else:
                trend = 'same'
            purchases.append({
                'key': key,
                'name': name,
                'current': cur,
                'prev': pre,
                'diff': cur - pre,
                'trend': trend,
            })

        # 当前库存快照
        cursor.execute(STOCK_SQL)
        stock_data = cursor.fetchone()

        stocks = []
        for key, name in STOCK_KEYS:
            stocks.append({
                'key': key,
                'name': name,
                'count': int(stock_data.get(key) or 0),
            })

        return jsonify({
            'status': 'success',
            'current_period': f'{start_str} ~ {end_str}',
            'prev_period': f'{prev_start.strftime("%Y-%m-%d")} ~ {(prev_end - timedelta(days=1)).strftime("%Y-%m-%d")}',

            'metrics': metrics,
            'purchases': purchases,
            'stocks': stocks,
        })
    except Exception as e:
        return jsonify({'status': 'error', 'message': '服务器内部错误'}), 500
    finally:
        cursor.close()
        conn.close()


# 采购明细：点击采购卡片查看 device_list 中的资产详情
PURCHASE_DETAIL_MAP = {
    'laptop': '笔记本电脑',
    'monitor': '显示器',
    'desktop': '台式主机',
    'rental_desktop': '租聘台式主机',
}

PURCHASE_DETAIL_FIELDS = 'id, number, type, spec, department, name, sn, cpu, mem, disk, gpu'


@dashboard_bp.route('/api/dashboard_purchase_detail')
def dashboard_purchase_detail():
    if not session.get('logged_in'):
        return jsonify({'status': 'error', 'message': '未登录'}), 401

    key = request.args.get('key', '')
    start_str = request.args.get('start', '')
    end_str = request.args.get('end', '')

    if key not in PURCHASE_DETAIL_MAP:
        return jsonify({'status': 'error', 'message': '无效的采购类型'}), 400

    try:
        current_start = datetime.strptime(start_str, '%Y-%m-%d')
        end_date = datetime.strptime(end_str, '%Y-%m-%d')
    except (ValueError, TypeError):
        return jsonify({'status': 'error', 'message': '日期参数错误'}), 400

    date_start = current_start.strftime('%y%m')
    date_end = end_date.strftime('%y%m')
    asset_type = PURCHASE_DETAIL_MAP[key]

    conn = get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': '数据库连接失败'}), 500

    try:
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            f"SELECT {PURCHASE_DETAIL_FIELDS} FROM device_list "
            "WHERE type = %s AND SUBSTRING(number, 3, 4) >= %s AND SUBSTRING(number, 3, 4) <= %s "
            "ORDER BY number ASC",
            (asset_type, date_start, date_end)
        )
        rows = cursor.fetchall()
        return jsonify({'status': 'success', 'data': rows, 'title': f'{asset_type}采购明细'})
    except Exception as e:
        return jsonify({'status': 'error', 'message': '服务器内部错误'}), 500
    finally:
        cursor.close()
        conn.close()


# 领用明细：点击领用卡片查看 inventory 中的记录
METRIC_DETAIL_MAP = {
    'new_laptop': ("笔记本电脑", f"AND number >= '{NEW_LAPTOP_THRESHOLD}'"),
    'old_laptop': ("笔记本电脑", f"AND number < '{NEW_LAPTOP_THRESHOLD}'"),
    'new_monitor': ("显示器", f"AND number >= '{NEW_MONITOR_THRESHOLD}'"),
    'old_monitor': ("显示器", f"AND number < '{NEW_MONITOR_THRESHOLD}'"),
    'desktop': ("台式主机", ""),
    'rental': ("租聘台式主机", ""),
}

INVENTORY_DETAIL_FIELDS = 'id, number, department, site, type, datetime, status, tag, notice'


@dashboard_bp.route('/api/dashboard_metric_detail')
def dashboard_metric_detail():
    if not session.get('logged_in'):
        return jsonify({'status': 'error', 'message': '未登录'}), 401

    key = request.args.get('key', '')
    start_str = request.args.get('start', '')
    end_str = request.args.get('end', '')
    department = request.args.get('department', '')
    tag = request.args.get('tag', '')

    if key not in METRIC_DETAIL_MAP:
        return jsonify({'status': 'error', 'message': '无效的指标类型'}), 400

    try:
        current_start = datetime.strptime(start_str, '%Y-%m-%d')
        end_date = datetime.strptime(end_str, '%Y-%m-%d')
        current_end = end_date + timedelta(days=1)
    except (ValueError, TypeError):
        return jsonify({'status': 'error', 'message': '日期参数错误'}), 400

    asset_type, extra_cond = METRIC_DETAIL_MAP[key]

    conditions = ["type = %s", "tag IN ('入职','领用','更换')", "datetime >= %s", "datetime < %s"]
    params = [asset_type, current_start.strftime('%Y-%m-%d'), current_end.strftime('%Y-%m-%d')]

    if department:
        conditions.append("department = %s")
        params.append(department)
    if tag:
        conditions.append("tag = %s")
        params.append(tag)

    where = ' AND '.join(conditions)
    if extra_cond:
        where += f' {extra_cond}'

    conn = get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': '数据库连接失败'}), 500

    try:
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            f"SELECT {INVENTORY_DETAIL_FIELDS} FROM inventory WHERE {where} ORDER BY datetime DESC, id DESC",
            params
        )
        rows = cursor.fetchall()

        # 转换 datetime 对象为字符串
        for row in rows:
            dt = row.get('datetime')
            if hasattr(dt, 'strftime'):
                row['datetime'] = dt.strftime('%Y-%m-%d')

        # 获取可选的部门列表和标签列表（当前日期范围内的去重值）
        cursor.execute(
            "SELECT DISTINCT department FROM inventory "
            "WHERE tag IN ('入职','领用','更换') AND datetime >= %s AND datetime < %s AND department != '' "
            "ORDER BY department",
            (current_start.strftime('%Y-%m-%d'), current_end.strftime('%Y-%m-%d'))
        )
        departments = [r['department'] for r in cursor.fetchall()]

        tags = ['入职', '领用', '更换']

        return jsonify({
            'status': 'success',
            'data': rows,
            'title': f'{asset_type}领用明细',
            'departments': departments,
            'tags': tags,
        })
    except Exception as e:
        return jsonify({'status': 'error', 'message': '服务器内部错误'}), 500
    finally:
        cursor.close()
        conn.close()


# 库存明细：点击库存卡片查看详情
@dashboard_bp.route('/api/dashboard_stock_detail')
def dashboard_stock_detail():
    if not session.get('logged_in'):
        return jsonify({'status': 'error', 'message': '未登录'}), 401

    key = request.args.get('key', '')
    if key not in STOCK_DETAIL_MAP:
        return jsonify({'status': 'error', 'message': '无效的库存类型'}), 400

    config = STOCK_DETAIL_MAP[key]
    conn = get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': '数据库连接失败'}), 500

    try:
        cursor = conn.cursor(dictionary=True)
        all_rows = []
        for sql, params in config['queries']:
            cursor.execute(sql, params)
            rows = cursor.fetchall()
            for row in rows:
                dt = row.get('datetime')
                if hasattr(dt, 'strftime'):
                    row['datetime'] = dt.strftime('%Y-%m-%d')
            all_rows.extend(rows)
        return jsonify({'status': 'success', 'data': all_rows, 'title': config['title']})
    except Exception as e:
        return jsonify({'status': 'error', 'message': '服务器内部错误'}), 500
    finally:
        cursor.close()
        conn.close()
