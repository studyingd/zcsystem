"""资产变更与查询蓝图。

台账（device_list + inventory）的变更入口：更新使用人 / 部门 / 状态 / 标签，
变更前记录自动备份到 inventory_tmp。HTTP 层样板（登录检查、连接管理、
异常转 JSON）统一使用 :mod:`app.common`，本模块只写业务。
"""

import io
import logging
import uuid

import pandas as pd
from flask import Blueprint, jsonify, request, send_file

from .common import error_json, login_required_api, login_required_page, with_db
from .config import S3_BUCKET, S3_EXTERNAL_URL, get_db_connection, get_s3_client
from .ledger import INVENTORY_STATUSES

inv_bp = Blueprint('inventory', __name__)
logger = logging.getLogger(__name__)

ALLOWED_EXTENSIONS = {'jpg', 'jpeg', 'png', 'gif', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'zip', 'rar'}


def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[-1].lower() in ALLOWED_EXTENSIONS


# 上传附件
@inv_bp.route('/upload_attachment', methods=['POST'])
@login_required_api
def upload_attachment():
    file = request.files.get('attachment')
    if not file or file.filename == '':
        return error_json('请选择文件', 400)

    if not allowed_file(file.filename):
        return error_json('不支持的文件类型', 400)

    ext = file.filename.rsplit('.', 1)[-1].lower()
    filename = f"{uuid.uuid4().hex}.{ext}"

    try:
        s3 = get_s3_client()
        s3.upload_fileobj(file, S3_BUCKET, filename, ExtraArgs={'ContentType': file.content_type})
        url = f"{S3_EXTERNAL_URL}/{S3_BUCKET}/{filename}"
        return jsonify({'status': 'success', 'url': url, 'filename': filename})
    except Exception as e:
        logger.error("上传失败: %s", e)
        return error_json('服务器内部错误', 500)


# 插入记录
@inv_bp.route('/insert', methods=['POST'])
@login_required_api
@with_db
def insert_record(conn, cursor):
    number = request.form.get('number')
    department = request.form.get('department')
    site = request.form.get('site')
    type_val = request.form.get('type')
    date_val = request.form.get('datetime')
    status_val = request.form.get('status')
    tag_val = request.form.get('tag', '')
    notice_val = request.form.get('notice')
    attachment_urls_val = request.form.get('attachment_urls', '')

    if not all([number, department, site, type_val, date_val, status_val]):
        return error_json('资产编码、使用部门、使用人、资产类型、发放日期 和 资产状态 均不能为空', 400)

    if status_val not in INVENTORY_STATUSES:
        return error_json('资产状态 值不合法', 400)

    cursor.execute(
        "INSERT INTO inventory (number, department, site, type, datetime, status, tag, notice, attachment_urls) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (number, department, site, type_val, date_val, status_val, tag_val, notice_val, attachment_urls_val)
    )
    conn.commit()
    return jsonify({'status': 'success', 'message': '插入成功'})


INVENTORY_COLS = "id, number, department, site, type, DATE_FORMAT(datetime, '%Y-%m-%d') as datetime, status, tag, notice"
INVENTORY_TMP_COLS = "tmp_id, " + INVENTORY_COLS

_DEVICE_LIST_COLS = "id, number, spec, type, department, name, sn, cpu, mem, disk, gpu"


def _fallback_device_list(cursor, column, value):
    """查 device_list 作为回退，返回格式化后的数据或 None"""
    if column == 'number':
        col, op, val = 'number', 'LIKE', f'%{value}%'
    elif column == 'site':
        col, op, val = 'name', 'LIKE', f'%{value}%'
    elif column == 'sn':
        col, op, val = 'sn', 'LIKE', f'%{value}%'
    else:
        return None
    cursor.execute(f"SELECT {_DEVICE_LIST_COLS} FROM device_list WHERE {col} {op} %s", (val,))
    rows = cursor.fetchall()
    if rows:
        for item in rows:
            item['source'] = 'device_list'
            item['datetime'] = ''
            item['site'] = item.get('name', '')
    return rows or None


# 查询记录（支持 id, number, department, site）
@inv_bp.route('/query', methods=['GET'])
@login_required_api
@with_db
def query_record(conn, cursor):
    mode = request.args.get('mode')
    value = request.args.get('value')
    table = request.args.get('table', 'main')
    table_name = 'inventory' if table == 'main' else 'inventory_tmp'

    if not mode or not value:
        return error_json('查询方式和查询值不能为空', 400)

    valid_modes = {'id', 'number', 'sn', 'department', 'site'}
    if mode not in valid_modes:
        return error_json('不支持的查询方式', 400)

    cols = INVENTORY_TMP_COLS if table_name == 'inventory_tmp' else INVENTORY_COLS

    if mode == 'id':
        if not value.isdigit():
            return error_json('ID必须为数字', 400)
        cursor.execute(f"SELECT {cols} FROM {table_name} WHERE id = %s", (value,))
    elif mode == 'sn':
        cursor.execute("SELECT number FROM device_list WHERE sn LIKE %s", (f'%{value}%',))
        sn_rows = cursor.fetchall()
        if sn_rows:
            numbers = [r['number'] for r in sn_rows]
            placeholders = ','.join(['%s'] * len(numbers))
            cursor.execute(f"SELECT {cols} FROM {table_name} WHERE number IN ({placeholders})", tuple(numbers))
        else:
            cursor.execute("SELECT 1 WHERE 0")
    else:
        where_map = {
            'number': ("number LIKE %s", f'%{value}%'),
            'department': ("department = %s", value),
            'site': ("site LIKE %s", f'%{value}%'),
        }
        clause, param = where_map[mode]
        cursor.execute(f"SELECT {cols} FROM {table_name} WHERE {clause}", (param,))

    data = cursor.fetchall()
    if not data:
        if table == 'main' and mode in ('number', 'site', 'sn'):
            device_data = _fallback_device_list(cursor, mode, value)
            if device_data:
                return jsonify({'status': 'success', 'data': device_data}), 200
        return jsonify({'status': 'not_found', 'message': f'未找到{table_name}表中符合条件的记录'}), 200

    for item in data:
        item['datetime'] = item.get('datetime', '') or ''
        item['source'] = 'inventory'

    return jsonify({'status': 'success', 'data': data}), 200


# 删除记录（通过id）
@inv_bp.route('/delete_by_id', methods=['POST'])
@login_required_api
@with_db
def delete_record(conn, cursor):
    id_val = request.form.get('id')
    if not id_val or not id_val.isdigit():
        return error_json('ID必须为数字', 400)

    cursor.execute("SELECT COUNT(*) AS cnt FROM inventory WHERE id = %s", (id_val,))
    if cursor.fetchone()['cnt'] == 0:
        return jsonify({'status': 'not_found', 'message': '未找到对应ID的记录'}), 404

    cursor.execute("DELETE FROM inventory WHERE id = %s", (id_val,))
    cursor.execute("DELETE FROM inventory_tmp WHERE id = %s", (id_val,))

    conn.commit()
    return jsonify({'status': 'success', 'message': '删除成功'})


# 删除历史记录（通过 tmp_id）
@inv_bp.route('/delete_history', methods=['POST'])
@login_required_api
@with_db
def delete_history(conn, cursor):
    tmp_id = request.form.get('tmp_id')
    if not tmp_id or not tmp_id.isdigit():
        return error_json('历史记录ID（tmp_id）必须为数字', 400)

    cursor.execute("DELETE FROM inventory_tmp WHERE tmp_id = %s", (tmp_id,))
    affected = cursor.rowcount

    if affected == 0:
        conn.rollback()
        return jsonify({'status': 'not_found', 'message': '未找到该条历史记录'}), 404

    conn.commit()
    return jsonify({'status': 'success', 'message': '单条历史记录删除成功'}), 200


# 获取所有数据
@inv_bp.route('/list_all', methods=['GET'])
@login_required_api
@with_db
def list_all_records(conn, cursor):
    cursor.execute(
        "SELECT id, number, department, site, type, DATE_FORMAT(datetime, '%Y-%m-%d') AS datetime, "
        "status, tag, notice FROM inventory ORDER BY id ASC"
    )
    records = cursor.fetchall()
    for r in records:
        r['datetime'] = r.get('datetime') or ''
    return jsonify({'status': 'success', 'data': records})


# 导出 Excel（文件下载路由，错误按纯文本返回，不走 JSON 装饰器）
@inv_bp.route('/export')
@login_required_page
def export_excel():
    sort_order = request.args.get('order', 'asc').lower()
    if sort_order not in ('asc', 'desc'):
        sort_order = 'asc'

    conn = get_db_connection()
    if not conn:
        return "数据库连接失败", 500

    try:
        query = f"SELECT id, number, department, site, type, datetime, status, tag, notice FROM inventory ORDER BY number {sort_order}"
        df = pd.read_sql(query, conn)
        output = io.BytesIO()
        with pd.ExcelWriter(output, engine='openpyxl') as writer:
            df.to_excel(writer, index=False, sheet_name='Inventory')
        output.seek(0)
        filename = f'inventory_export_{sort_order}.xlsx'
        return send_file(
            output,
            mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            as_attachment=True,
            download_name=filename
        )
    except Exception as e:
        logger.error("导出Excel失败: %s", e)
        return "导出失败: 服务器内部错误", 500
    finally:
        conn.close()


# 更新记录接口
@inv_bp.route('/update', methods=['POST'])
@login_required_api
@with_db
def update_record(conn, cursor):
    id_val = request.form.get('id')
    number = request.form.get('number')
    department = request.form.get('department')
    site = request.form.get('site')
    type_val = request.form.get('type')
    date_val = request.form.get('datetime')
    status_val = request.form.get('status')
    tag_val = request.form.get('tag', '')
    notice_val = request.form.get('notice')
    attachment_urls_val = request.form.get('attachment_urls', '')

    if not all([id_val, number, department, site, type_val, date_val, status_val]):
        return error_json('ID、资产编码、使用部门、使用人、资产类型、发放日期 和 资产状态 均不能为空', 400)

    if status_val not in INVENTORY_STATUSES:
        return error_json('资产状态 值不合法', 400)

    cursor.execute("SELECT * FROM inventory WHERE id = %s", (id_val,))
    old_data = cursor.fetchone()

    # 详情弹窗对「只存在于 device_list 的资产」会带出 device_list.id，
    # 它与 inventory.id 同号时会误伤无关记录，这里统一按资产编码重新定位。
    if old_data and old_data.get('number') != number:
        logger.warning("inventory id=%s 属于资产 %s，与提交的 %s 不一致，改按编码定位",
                       id_val, old_data.get('number'), number)
        old_data = None
    if not old_data:
        cursor.execute(
            "SELECT * FROM inventory WHERE number = %s ORDER BY datetime DESC, id DESC LIMIT 1",
            (number,)
        )
        old_data = cursor.fetchone()

    if not old_data:
        cursor.execute("SELECT * FROM device_list WHERE number = %s", (number,))
        device_orig = cursor.fetchone()

        cursor.execute(
            "INSERT INTO inventory (number, department, site, type, datetime, status, tag, notice, attachment_urls) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (number, department, site, type_val, date_val, status_val, tag_val, notice_val, attachment_urls_val)
        )
        new_id = cursor.lastrowid

        if device_orig and (device_orig.get('department') or device_orig.get('name')):
            cursor.execute(
                "INSERT INTO inventory_tmp (id, number, department, site, type, datetime, status, tag, notice) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    new_id,
                    device_orig.get('number', ''),
                    device_orig.get('department', ''),
                    device_orig.get('name', ''),
                    device_orig.get('type', ''),
                    None,
                    '已录入',
                    '',
                    ''
                )
            )

        cursor.execute(
            "UPDATE device_list SET department = %s, name = %s WHERE number = %s",
            (department, site, number)
        )

        conn.commit()
        return jsonify({'status': 'success', 'message': '资产信息已新增并同步到device_list'})

    if old_data['site'] != site:
        cursor.execute(
            "INSERT INTO inventory_tmp (id, number, department, site, type, datetime, status, tag, notice) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (
                old_data['id'],
                old_data['number'],
                old_data['department'],
                old_data['site'],
                old_data['type'],
                old_data['datetime'],
                old_data['status'],
                old_data.get('tag', ''),
                old_data['notice']
            )
        )

    cursor.execute(
        "UPDATE inventory SET number = %s, department = %s, site = %s, type = %s, datetime = %s, "
        "status = %s, tag = %s, notice = %s, attachment_urls = %s WHERE id = %s",
        (number, department, site, type_val, date_val, status_val, tag_val, notice_val,
         attachment_urls_val, id_val)
    )

    cursor.execute(
        "UPDATE device_list SET department = %s, name = %s WHERE number = %s",
        (department, site, number)
    )

    conn.commit()
    if old_data['site'] != site:
        return jsonify({'status': 'success', 'message': '更新成功，历史数据已备份到 inventory_tmp'})
    return jsonify({'status': 'success', 'message': '更新成功'})


# 同步Inventory数据到Device_List
@inv_bp.route('/sync_to_device_list', methods=['POST'])
@login_required_api
@with_db
def sync_to_device_list(conn, cursor):
    number = request.form.get('number')
    department = request.form.get('department')
    site = request.form.get('site')

    if not number:
        return error_json('资产编码不能为空', 400)

    cursor.execute("SELECT id FROM device_list WHERE number = %s", (number,))
    if not cursor.fetchone():
        return jsonify({'status': 'not_found', 'message': '未找到对应Number的设备记录'}), 404

    cursor.execute(
        "UPDATE device_list SET department = %s, name = %s WHERE number = %s",
        (department, site, number)
    )
    conn.commit()
    return jsonify({'status': 'success', 'message': '同步成功'})


# 更新历史记录接口
@inv_bp.route('/update_history', methods=['POST'])
@login_required_api
@with_db
def update_history_record(conn, cursor):
    tmp_id = request.form.get('tmp_id')
    number = request.form.get('number')
    department = request.form.get('department')
    site = request.form.get('site')
    type_val = request.form.get('type')
    date_val = request.form.get('datetime')
    status_val = request.form.get('status')
    tag_val = request.form.get('tag', '')
    notice_val = request.form.get('notice')

    if not all([tmp_id, number, department, site, type_val, date_val, status_val]):
        return error_json('历史记录ID、资产编码、使用部门、使用人、资产类型、发放日期 和 资产状态 均不能为空', 400)

    if status_val not in INVENTORY_STATUSES:
        return error_json('资产状态 值不合法', 400)

    cursor.execute("SELECT tmp_id FROM inventory_tmp WHERE tmp_id = %s", (tmp_id,))
    if not cursor.fetchone():
        return jsonify({'status': 'not_found', 'message': '未找到对应历史记录ID的记录'}), 404

    cursor.execute(
        "UPDATE inventory_tmp SET number = %s, department = %s, site = %s, type = %s, "
        "datetime = %s, status = %s, tag = %s, notice = %s WHERE tmp_id = %s",
        (number, department, site, type_val, date_val, status_val, tag_val, notice_val, tmp_id)
    )
    conn.commit()
    return jsonify({'status': 'success', 'message': '历史记录更新成功'})


# 资产详情综合查询接口
@inv_bp.route('/api/asset_full_detail', methods=['GET'])
@login_required_api
@with_db
def asset_full_detail(conn, cursor):
    number = request.args.get('number')
    record_id = request.args.get('id')
    if not number and not record_id:
        return error_json('资产编码和ID不能同时为空', 400)

    result = {'basic': None, 'hardware': None, 'history': []}

    inv_cols = ("id, number, department, site, type, DATE_FORMAT(datetime, '%Y-%m-%d') as datetime, "
                "status, tag, notice, attachment_urls")
    if record_id and record_id.isdigit():
        cursor.execute(f"SELECT {inv_cols} FROM inventory WHERE id = %s", (record_id,))
    else:
        cursor.execute(f"SELECT {inv_cols} FROM inventory WHERE number = %s", (number,))
    inv = cursor.fetchone()
    if inv:
        inv['source'] = 'inventory'
        inv['datetime'] = inv.get('datetime', '') or ''
        result['basic'] = inv
        if not number:
            number = inv.get('number', '')

    if number:
        cursor.execute(
            "SELECT id, number, spec, type, department, name, sn, cpu, mem, disk, gpu "
            "FROM device_list WHERE number = %s",
            (number,)
        )
        dev = cursor.fetchone()
        if dev:
            result['hardware'] = {
                'spec': dev.get('spec', ''),
                'sn': dev.get('sn', ''),
                'cpu': dev.get('cpu', ''),
                'mem': dev.get('mem', ''),
                'disk': dev.get('disk', ''),
                'gpu': dev.get('gpu', ''),
                'type': dev.get('type', '')
            }
            if not result['basic']:
                result['basic'] = {
                    'id': dev.get('id', ''),
                    'number': dev.get('number', ''),
                    'department': dev.get('department', ''),
                    'site': dev.get('name', ''),
                    'type': dev.get('type', ''),
                    'datetime': '',
                    'status': '',
                    'tag': '',
                    'notice': '',
                    'source': 'device_list'
                }

    tmp_cols = ("tmp_id, id, number, department, site, type, "
                "DATE_FORMAT(datetime, '%Y-%m-%d') as datetime, status, tag, notice")
    if record_id and record_id.isdigit() and number:
        cursor.execute(
            f"SELECT {tmp_cols} FROM inventory_tmp WHERE id = %s AND number = %s ORDER BY datetime DESC",
            (record_id, number)
        )
    elif record_id and record_id.isdigit():
        cursor.execute(f"SELECT {tmp_cols} FROM inventory_tmp WHERE id = %s ORDER BY datetime DESC", (record_id,))
    elif number:
        cursor.execute(f"SELECT {tmp_cols} FROM inventory_tmp WHERE number = %s ORDER BY datetime DESC", (number,))
    history = cursor.fetchall()
    for h in history:
        h['datetime'] = h.get('datetime', '') or ''
    result['history'] = history

    if not result['basic']:
        return jsonify({'status': 'not_found', 'message': '未找到该资产的记录'}), 200

    return jsonify({'status': 'success', 'data': result})


# 按状态分类统计数量
@inv_bp.route('/status_counts', methods=['GET'])
@login_required_api
@with_db
def status_counts(conn, cursor):
    cursor.execute("SELECT status, COUNT(*) as cnt FROM inventory GROUP BY status")
    rows = cursor.fetchall()
    counts = {}
    total = 0
    for r in rows:
        status_val = r['status'].strip() if r['status'] and r['status'].strip() else '无状态'
        if status_val not in INVENTORY_STATUSES:
            status_val = '无状态'
        counts[status_val] = counts.get(status_val, 0) + r['cnt']
        total += r['cnt']
    return jsonify({'status': 'success', 'counts': counts, 'total': total})


# 按状态分页查询
@inv_bp.route('/list_by_status', methods=['GET'])
@login_required_api
@with_db
def list_by_status(conn, cursor):
    status_val = request.args.get('status', 'all').strip()
    page = request.args.get('page', '1')
    page_size = request.args.get('page_size', '20')

    try:
        page = max(1, int(page))
        page_size = max(1, min(100, int(page_size)))
    except ValueError:
        return error_json('分页参数错误', 400)

    if status_val == 'all':
        where = ''
        params = []
    elif status_val in INVENTORY_STATUSES:
        where = 'WHERE status = %s'
        params = [status_val]
    else:
        placeholders = ','.join(['%s'] * len(INVENTORY_STATUSES))
        where = f"WHERE (status IS NULL OR status = '' OR status NOT IN ({placeholders}))"
        params = list(INVENTORY_STATUSES)

    # 总数
    cursor.execute(f"SELECT COUNT(*) as total FROM inventory {where}", params)
    total = cursor.fetchone()['total']

    # 分页数据
    offset = (page - 1) * page_size
    cursor.execute(
        f"SELECT id, number, department, site, type, DATE_FORMAT(datetime, '%Y-%m-%d') as datetime, status, tag, notice "
        f"FROM inventory {where} ORDER BY id ASC LIMIT %s OFFSET %s",
        params + [page_size, offset]
    )
    records = cursor.fetchall()

    for r in records:
        r['datetime'] = r.get('datetime', '') or ''

    return jsonify({
        'status': 'success',
        'data': records,
        'total': total,
        'page': page,
        'page_size': page_size,
        'total_pages': max(1, -(-total // page_size))
    })
