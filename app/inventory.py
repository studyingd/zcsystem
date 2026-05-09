from flask import Blueprint, request, jsonify, send_file, redirect, url_for, session
from mysql.connector import Error
import pandas as pd
import io
import uuid
from .config import get_db_connection, get_s3_client, S3_EXTERNAL_URL

inv_bp = Blueprint('inventory', __name__)


# 上传附件
@inv_bp.route('/upload_attachment', methods=['POST'])
def upload_attachment():
    if not session.get('logged_in'):
        return jsonify({'status': 'error', 'message': '未登录，请先登录'}), 401

    file = request.files.get('attachment')
    if not file or file.filename == '':
        return jsonify({'status': 'error', 'message': '请选择文件'}), 400

    ext = file.filename.rsplit('.', 1)[-1] if '.' in file.filename else ''
    filename = f"{uuid.uuid4().hex}.{ext}" if ext else uuid.uuid4().hex

    try:
        s3 = get_s3_client()
        s3.upload_fileobj(file, 'zcsystem', filename, ExtraArgs={'ContentType': file.content_type})
        url = f"{S3_EXTERNAL_URL}/zcsystem/{filename}"
        return jsonify({'status': 'success', 'url': url, 'filename': filename})
    except Exception as e:
        return jsonify({'status': 'error', 'message': f'上传失败: {str(e)}'}), 500


# 插入记录
@inv_bp.route('/insert', methods=['POST'])
def insert_record():
    if not session.get('logged_in'):
        return jsonify({'status': 'error', 'message': '未登录，请先登录'}), 401
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
        return jsonify({'status': 'error', 'message': '资产编码、使用部门、使用人、资产类型、发放日期 和 资产状态 均不能为空'}), 400

    valid_statuses = {'已录入', '未录入', '无需录入', '租聘', '借用', '入库'}
    if status_val not in valid_statuses:
        return jsonify({'status': 'error', 'message': '资产状态 值不合法'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': '数据库连接失败'}), 500

    cursor = conn.cursor()
    try:
        cursor.execute("SELECT COALESCE(MAX(id), 0) + 1 FROM inventory")
        next_id = cursor.fetchone()[0]
        cursor.execute(
            "INSERT INTO inventory (id, number, department, site, type, datetime, status, tag, notice, attachment_urls) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (next_id, number, department, site, type_val, date_val, status_val, tag_val, notice_val, attachment_urls_val)
        )
        conn.commit()
        return jsonify({'status': 'success', 'message': '插入成功'})
    except Error as e:
        conn.rollback()
        return jsonify({'status': 'error', 'message': str(e)}), 500
    finally:
        cursor.close()
        conn.close()


# 查询记录（支持 id, number, department, site）
@inv_bp.route('/query', methods=['GET'])
def query_record():
    if not session.get('logged_in'):
        return jsonify({'status': 'error', 'message': '未登录，请先登录'}), 401
    try:
        mode = request.args.get('mode')
        value = request.args.get('value')
        table = request.args.get('table', 'main')
        table_name = 'inventory' if table == 'main' else 'inventory_tmp'

        if not mode or not value:
            return jsonify({'status': 'error', 'message': '查询方式和查询值不能为空'}), 400

        valid_modes = {'id', 'number', 'sn', 'department', 'site'}
        if mode not in valid_modes:
            return jsonify({'status': 'error', 'message': '不支持的查询方式'}), 400

        conn = get_db_connection()
        if not conn:
            return jsonify({'status': 'error', 'message': '数据库连接失败'}), 500

        cursor = conn.cursor(dictionary=True)
        try:
            if mode == 'id':
                if not value.isdigit():
                    return jsonify({'status': 'error', 'message': 'ID必须为数字'}), 400
                if table_name == 'inventory_tmp':
                    sql = f"SELECT tmp_id, id, number, department, site, type, DATE_FORMAT(datetime, '%Y-%m-%d') as datetime, status, tag, notice FROM {table_name} WHERE id = %s"
                else:
                    sql = f"SELECT id, number, department, site, type, DATE_FORMAT(datetime, '%Y-%m-%d') as datetime, status, tag, notice FROM {table_name} WHERE id = %s"
                cursor.execute(sql, (value,))
            elif mode == 'number':
                if table_name == 'inventory_tmp':
                    sql = f"SELECT tmp_id, id, number, department, site, type, DATE_FORMAT(datetime, '%Y-%m-%d') as datetime, status, tag, notice FROM {table_name} WHERE number LIKE %s"
                else:
                    sql = f"SELECT id, number, department, site, type, DATE_FORMAT(datetime, '%Y-%m-%d') as datetime, status, tag, notice FROM {table_name} WHERE number LIKE %s"
                cursor.execute(sql, (f'%{value}%',))
            elif mode == 'department':
                if table_name == 'inventory_tmp':
                    sql = f"SELECT tmp_id, id, number, department, site, type, DATE_FORMAT(datetime, '%Y-%m-%d') as datetime, status, tag, notice FROM {table_name} WHERE department = %s"
                else:
                    sql = f"SELECT id, number, department, site, type, DATE_FORMAT(datetime, '%Y-%m-%d') as datetime, status, tag, notice FROM {table_name} WHERE department = %s"
                cursor.execute(sql, (value,))
            elif mode == 'site':
                if table_name == 'inventory_tmp':
                    sql = f"SELECT tmp_id, id, number, department, site, type, DATE_FORMAT(datetime, '%Y-%m-%d') as datetime, status, tag, notice FROM {table_name} WHERE site LIKE %s"
                else:
                    sql = f"SELECT id, number, department, site, type, DATE_FORMAT(datetime, '%Y-%m-%d') as datetime, status, tag, notice FROM {table_name} WHERE site LIKE %s"
                cursor.execute(sql, (f'%{value}%',))
            elif mode == 'sn':
                cursor.execute("SELECT number FROM device_list WHERE sn LIKE %s", (f'%{value}%',))
                sn_rows = cursor.fetchall()
                if sn_rows:
                    numbers = [r['number'] for r in sn_rows]
                    placeholders = ','.join(['%s'] * len(numbers))
                    if table_name == 'inventory_tmp':
                        sql = f"SELECT tmp_id, id, number, department, site, type, DATE_FORMAT(datetime, '%Y-%m-%d') as datetime, status, tag, notice FROM {table_name} WHERE number IN ({placeholders})"
                    else:
                        sql = f"SELECT id, number, department, site, type, DATE_FORMAT(datetime, '%Y-%m-%d') as datetime, status, tag, notice FROM {table_name} WHERE number IN ({placeholders})"
                    cursor.execute(sql, tuple(numbers))
                else:
                    cursor.execute("SELECT 1 WHERE 0")

            data = cursor.fetchall()
            if not data:
                if mode == 'number' and table == 'main':
                    cursor.execute(
                        "SELECT id, number, spec, type, department, name, sn, cpu, mem, disk, gpu FROM device_list WHERE number LIKE %s",
                        (f'%{value}%',)
                    )
                    device_data = cursor.fetchall()
                    if device_data:
                        for item in device_data:
                            item['source'] = 'device_list'
                            item['datetime'] = ''
                            item['site'] = item.get('name', '')
                        return jsonify({'status': 'success', 'data': device_data}), 200
                elif mode == 'sn' and table == 'main':
                    cursor.execute(
                        "SELECT id, number, spec, type, department, name, sn, cpu, mem, disk, gpu FROM device_list WHERE sn LIKE %s",
                        (f'%{value}%',)
                    )
                    device_data = cursor.fetchall()
                    if device_data:
                        for item in device_data:
                            item['source'] = 'device_list'
                            item['datetime'] = ''
                            item['site'] = item.get('name', '')
                        return jsonify({'status': 'success', 'data': device_data}), 200
                return jsonify({'status': 'not_found', 'message': f'未找到{table_name}表中符合条件的记录'}), 200

            for item in data:
                item['datetime'] = item.get('datetime', '') or ''
                item['source'] = 'inventory'

            return jsonify({'status': 'success', 'data': data}), 200

        except Exception as e:
            print(f"查询异常：{str(e)}")
            return jsonify({'status': 'error', 'message': f'查询失败：{str(e)}'}), 500
        finally:
            cursor.close()
            conn.close()

    except Exception as e:
        return jsonify({'status': 'error', 'message': f'服务器异常：{str(e)}'}), 500


# 删除记录（通过id）
@inv_bp.route('/delete_by_id', methods=['POST'])
def delete_record():
    if not session.get('logged_in'):
        return jsonify({'status': 'error', 'message': '未登录，请先登录'}), 401
    conn = None
    cursor = None
    try:
        id_val = request.form.get('id')
        if not id_val or not id_val.isdigit():
            return jsonify({'status': 'error', 'message': 'ID必须为数字'}), 400

        conn = get_db_connection()
        if not conn:
            return jsonify({'status': 'error', 'message': '数据库连接失败'}), 500

        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM inventory WHERE id = %s", (id_val,))
        main_record_count = cursor.fetchone()[0]

        if main_record_count == 0:
            return jsonify({'status': 'not_found', 'message': '未找到对应ID的记录'}), 404

        cursor.execute("DELETE FROM inventory WHERE id = %s", (id_val,))
        cursor.execute("DELETE FROM inventory_tmp WHERE id = %s", (id_val,))

        conn.commit()
        return jsonify({'status': 'success', 'message': '删除成功'})
    except Exception as e:
        if conn:
            conn.rollback()
        return jsonify({'status': 'error', 'message': str(e)}), 500
    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()


# 删除历史记录（通过 tmp_id）
@inv_bp.route('/delete_history', methods=['POST'])
def delete_history():
    if not session.get('logged_in'):
        return jsonify({'status': 'error', 'message': '未登录，请先登录'}), 401
    conn = None
    cursor = None
    try:
        tmp_id = request.form.get('tmp_id')
        if not tmp_id or not tmp_id.isdigit():
            return jsonify({'status': 'error', 'message': '历史记录ID（tmp_id）必须为数字'}), 400

        conn = get_db_connection()
        if not conn:
            return jsonify({'status': 'error', 'message': '数据库连接失败'}), 500

        cursor = conn.cursor()
        cursor.execute("DELETE FROM inventory_tmp WHERE tmp_id = %s", (tmp_id,))
        affected = cursor.rowcount

        if affected == 0:
            conn.rollback()
            return jsonify({'status': 'not_found', 'message': '未找到该条历史记录'}), 404

        conn.commit()
        return jsonify({'status': 'success', 'message': '单条历史记录删除成功'}), 200

    except Exception as e:
        if conn:
            conn.rollback()
        return jsonify({'status': 'error', 'message': f'删除失败：{str(e)}'}), 500
    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()


# 获取所有数据
@inv_bp.route('/list_all', methods=['GET'])
def list_all_records():
    if not session.get('logged_in'):
        return jsonify({'status': 'error', 'message': '未登录，请先登录'}), 401
    conn = get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': '数据库连接失败'}), 500

    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT id, number, department, site, type, datetime, status, tag, notice FROM inventory ORDER BY id ASC")
        records = cursor.fetchall()
        for r in records:
            if r['datetime']:
                r['datetime'] = r['datetime'].strftime('%Y-%m-%d')
        return jsonify({'status': 'success', 'data': records})
    except Error as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500
    finally:
        cursor.close()
        conn.close()


# 导出 Excel
@inv_bp.route('/export')
def export_excel():
    if not session.get('logged_in'):
        return redirect(url_for('auth.login'))
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
        return f"导出失败: {str(e)}", 500
    finally:
        conn.close()


# 更新记录接口
@inv_bp.route('/update', methods=['POST'])
def update_record():
    if not session.get('logged_in'):
        return jsonify({'status': 'error', 'message': '未登录，请先登录'}), 401
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
        return jsonify({'status': 'error', 'message': 'ID、资产编码、使用部门、使用人、资产类型、发放日期 和 资产状态 均不能为空'}), 400

    valid_statuses = {'已录入', '未录入', '无需录入', '租聘', '借用', '入库'}
    if status_val not in valid_statuses:
        return jsonify({'status': 'error', 'message': '资产状态 值不合法'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': '数据库连接失败'}), 500

    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT * FROM inventory WHERE id = %s", (id_val,))
        old_data = cursor.fetchone()

        if not old_data:
            cursor.execute("SELECT * FROM device_list WHERE number = %s", (number,))
            device_orig = cursor.fetchone()

            cursor.execute("SELECT COALESCE(MAX(id), 0) + 1 FROM inventory")
            next_id = cursor.fetchone()['COALESCE(MAX(id), 0) + 1']
            cursor.execute("""
                INSERT INTO inventory (id, number, department, site, type, datetime, status, tag, notice, attachment_urls)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (next_id, number, department, site, type_val, date_val, status_val, tag_val, notice_val, attachment_urls_val))

            if device_orig and (device_orig.get('department') or device_orig.get('name')):
                cursor.execute("""
                    INSERT INTO inventory_tmp (id, number, department, site, type, datetime, status, tag, notice)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """, (
                    next_id,
                    device_orig.get('number', ''),
                    device_orig.get('department', ''),
                    device_orig.get('name', ''),
                    device_orig.get('type', ''),
                    None,
                    '已录入',
                    '',
                    ''
                ))

            cursor.execute("""
                UPDATE device_list
                SET department = %s, name = %s
                WHERE number = %s
            """, (department, site, number))

            conn.commit()
            return jsonify({'status': 'success', 'message': '资产信息已新增并同步到device_list'})

        if old_data['site'] != site:
            cursor.execute("""
                INSERT INTO inventory_tmp
                (id, number, department, site, type, datetime, status, tag, notice)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (
                old_data['id'],
                old_data['number'],
                old_data['department'],
                old_data['site'],
                old_data['type'],
                old_data['datetime'],
                old_data['status'],
                old_data.get('tag', ''),
                old_data['notice']
            ))

        cursor.execute("""
            UPDATE inventory
            SET number = %s, department = %s, site = %s, type = %s, datetime = %s, status = %s, tag = %s, notice = %s, attachment_urls = %s
            WHERE id = %s
        """, (
            number,
            department,
            site,
            type_val,
            date_val,
            status_val,
            tag_val,
            notice_val,
            attachment_urls_val,
            id_val
        ))

        cursor.execute("""
            UPDATE device_list
            SET department = %s, name = %s
            WHERE number = %s
        """, (department, site, number))

        conn.commit()
        if old_data['site'] != site:
            return jsonify({'status': 'success', 'message': '更新成功，历史数据已备份到 inventory_tmp'})
        else:
            return jsonify({'status': 'success', 'message': '更新成功'})

    except Error as e:
        conn.rollback()
        return jsonify({'status': 'error', 'message': str(e)}), 500
    finally:
        cursor.close()
        conn.close()


# 同步Inventory数据到Device_List
@inv_bp.route('/sync_to_device_list', methods=['POST'])
def sync_to_device_list():
    if not session.get('logged_in'):
        return jsonify({'status': 'error', 'message': '未登录，请先登录'}), 401

    number = request.form.get('number')
    department = request.form.get('department')
    site = request.form.get('site')

    if not number:
        return jsonify({'status': 'error', 'message': '资产编码不能为空'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': '数据库连接失败'}), 500

    try:
        cursor = conn.cursor()
        cursor.execute("""
            UPDATE device_list
            SET department = %s, name = %s
            WHERE number = %s
        """, (department, site, number))
        conn.commit()

        if cursor.rowcount == 0:
            return jsonify({'status': 'not_found', 'message': '未找到对应Number的设备记录'}), 404

        return jsonify({'status': 'success', 'message': '同步成功'})

    except Error as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500
    finally:
        cursor.close()
        conn.close()


# 更新历史记录接口
@inv_bp.route('/update_history', methods=['POST'])
def update_history_record():
    if not session.get('logged_in'):
        return jsonify({'status': 'error', 'message': '未登录，请先登录'}), 401
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
        return jsonify({'status': 'error', 'message': '历史记录ID、资产编码、使用部门、使用人、资产类型、发放日期 和 资产状态 均不能为空'}), 400

    valid_statuses = {'已录入', '未录入', '无需录入', '租聘', '借用', '入库'}
    if status_val not in valid_statuses:
        return jsonify({'status': 'error', 'message': '资产状态 值不合法'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': '数据库连接失败'}), 500

    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT * FROM inventory_tmp WHERE tmp_id = %s", (tmp_id,))
        record = cursor.fetchone()
        if not record:
            return jsonify({'status': 'not_found', 'message': '未找到对应历史记录ID的记录'}), 404

        cursor.execute("""
            UPDATE inventory_tmp
            SET number = %s, department = %s, site = %s, type = %s, datetime = %s, status = %s, tag = %s, notice = %s
            WHERE tmp_id = %s
        """, (
            number,
            department,
            site,
            type_val,
            date_val,
            status_val,
            tag_val,
            notice_val,
            tmp_id
        ))

        if cursor.rowcount == 0:
            conn.rollback()
            return jsonify({'status': 'error', 'message': '更新失败，未找到对应历史记录ID的记录'}), 404

        conn.commit()
        return jsonify({'status': 'success', 'message': '历史记录更新成功'})

    except Error as e:
        conn.rollback()
        return jsonify({'status': 'error', 'message': str(e)}), 500
    finally:
        cursor.close()
        conn.close()


# 资产详情综合查询接口
@inv_bp.route('/api/asset_full_detail', methods=['GET'])
def asset_full_detail():
    if not session.get('logged_in'):
        return jsonify({'status': 'error', 'message': '未登录，请先登录'}), 401

    number = request.args.get('number')
    record_id = request.args.get('id')
    if not number:
        return jsonify({'status': 'error', 'message': '资产编码不能为空'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': '数据库连接失败'}), 500

    cursor = conn.cursor(dictionary=True, buffered=True)
    try:
        result = {'basic': None, 'hardware': None, 'history': []}

        if record_id and record_id.isdigit():
            cursor.execute(
                "SELECT id, number, department, site, type, DATE_FORMAT(datetime, '%Y-%m-%d') as datetime, status, tag, notice, attachment_urls FROM inventory WHERE id = %s",
                (record_id,)
            )
        else:
            cursor.execute(
                "SELECT id, number, department, site, type, DATE_FORMAT(datetime, '%Y-%m-%d') as datetime, status, tag, notice, attachment_urls FROM inventory WHERE number = %s",
                (number,)
            )
        inv = cursor.fetchone()
        if inv:
            inv['source'] = 'inventory'
            inv['datetime'] = inv.get('datetime', '') or ''
            result['basic'] = inv

        cursor.execute(
            "SELECT id, number, spec, type, department, name, sn, cpu, mem, disk, gpu FROM device_list WHERE number = %s",
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

        cursor.execute(
            "SELECT tmp_id, id, number, department, site, type, DATE_FORMAT(datetime, '%Y-%m-%d') as datetime, status, tag, notice FROM inventory_tmp WHERE number = %s ORDER BY datetime DESC",
            (number,)
        )
        history = cursor.fetchall()
        for h in history:
            h['datetime'] = h.get('datetime', '') or ''
        result['history'] = history

        if not result['basic']:
            return jsonify({'status': 'not_found', 'message': '未找到该资产的记录'}), 200

        return jsonify({'status': 'success', 'data': result})

    except Exception as e:
        return jsonify({'status': 'error', 'message': f'查询失败：{str(e)}'}), 500
    finally:
        cursor.close()
        conn.close()


# 按状态分类查询数据
@inv_bp.route('/list_by_status', methods=['GET'])
def list_by_status():
    if not session.get('logged_in'):
        return jsonify({'status': 'error', 'message': '未登录，请先登录'}), 401
    conn = get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': '数据库连接失败'}), 500

    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT id, number, department, site, type, datetime, status, tag, notice FROM inventory ORDER BY id ASC")
        records = cursor.fetchall()

        status_groups = {
            '已录入': [],
            '未录入': [],
            '租聘': [],
            '借用': [],
            '入库': [],
            '无需录入': [],
            '无状态': []
        }

        for r in records:
            if r['datetime']:
                r['datetime'] = r['datetime'].strftime('%Y-%m-%d')

            status_val = r['status'].strip() if r['status'] and r['status'].strip() else '无状态'
            if status_val in status_groups:
                status_groups[status_val].append(r)
            else:
                status_groups['无状态'].append(r)

        return jsonify({'status': 'success', 'data': status_groups})
    except Error as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500
    finally:
        cursor.close()
        conn.close()
