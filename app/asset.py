import logging
from flask import Blueprint, render_template, request, jsonify, redirect, url_for, session
from datetime import datetime, date
from mysql.connector import Error
from .config import get_db_connection

asset_bp = Blueprint('asset', __name__)
logger = logging.getLogger(__name__)

# 资产登记页面
@asset_bp.route('/asset_register')
def asset_register():
    if not session.get('logged_in'):
        return redirect(url_for('auth.login'))
    return render_template('asset_register.html', active_nav='asset_register')

# 生成资产编码（预览用）
@asset_bp.route('/api/generate_asset_codes', methods=['POST'])
def generate_asset_codes():
    if not session.get('logged_in'):
        return jsonify({'status': 'error', 'message': '未登录'}), 401

    data = request.get_json()
    asset_type = data.get('asset_type')
    quantity = data.get('quantity', 1)
    year_month = data.get('year_month')  # 格式: 2026-03

    if not asset_type:
        return jsonify({'status': 'error', 'message': '请选择资产类型'}), 400

    # 前缀规则
    prefix = 'ZL' if asset_type == '租聘台式主机' else 'DZ'

    # 日期码 (2603 格式 - 年月)
    if year_month:
        parts = year_month.split('-')
        date_code = parts[0][2:] + parts[1]
    else:
        today = datetime.now()
        date_code = today.strftime('%y%m')

    # 查询同月最大序号
    conn = get_db_connection()
    next_seq = 1
    cursor = None
    if conn:
        try:
            cursor = conn.cursor()
            cursor.execute(
                f"SELECT number FROM device_list WHERE number LIKE %s AND LENGTH(number) = 9 ORDER BY number DESC LIMIT 1",
                (f"{prefix}{date_code}%",)
            )
            result = cursor.fetchone()
            if result:
                last_code = result[0]
                last_seq = int(last_code[-3:])
                next_seq = last_seq + 1
        except Error as e:
            logger.error("查询最大序号错误: %s", e)
        finally:
            if cursor:
                cursor.close()
            conn.close()

    # 生成编码列表
    codes = []
    for i in range(next_seq, next_seq + quantity):
        seq = str(i).zfill(3)
        codes.append(f"{prefix}{date_code}{seq}")

    return jsonify({
        'status': 'success',
        'codes': codes,
        'prefix': prefix,
        'date_code': date_code
    })

# 批量创建资产
@asset_bp.route('/api/batch_create_assets', methods=['POST'])
def batch_create_assets():
    if not session.get('logged_in'):
        return jsonify({'status': 'error', 'message': '未登录'}), 401

    data = request.get_json()
    asset_type = data.get('asset_type')
    asset_spec = data.get('asset_spec')
    asset_dept = data.get('asset_dept', '')
    asset_user = data.get('asset_user', '')
    year_month = data.get('year_month', '')
    batch_quantity = data.get('batch_quantity', 1)
    config = data.get('config', {})

    if not all([asset_type, asset_spec]):
        return jsonify({'status': 'error', 'message': '请填写所有必填字段'}), 400

    # 前缀规则
    prefix = 'ZL' if asset_type == '租聘台式主机' else 'DZ'

    # 日期码
    if year_month:
        parts = year_month.split('-')
        date_code = parts[0][2:] + parts[1]
    else:
        today = datetime.now()
        date_code = today.strftime('%y%m')

    conn = get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': '数据库连接失败'}), 500

    next_seq = 1
    cursor = None
    try:
        cursor = conn.cursor()
        cursor.execute(
            f"SELECT number FROM device_list WHERE number LIKE %s AND LENGTH(number) = 9 ORDER BY number DESC LIMIT 1",
            (f"{prefix}{date_code}%",)
        )
        result = cursor.fetchone()
        if result:
            last_code = result[0]
            last_seq = int(last_code[-3:])
            next_seq = last_seq + 1

        cursor.execute("SELECT COALESCE(MAX(id), 0) FROM inventory")
        inv_next_id = cursor.fetchone()[0] + 1

        today_str = date.today().strftime('%Y-%m-%d')

        for i in range(next_seq, next_seq + batch_quantity):
            seq = str(i).zfill(3)
            asset_number = f"{prefix}{date_code}{seq}"

            if asset_type in ['笔记本电脑', '台式主机', '租聘台式主机']:
                if asset_type == '租聘台式主机':
                    cursor.execute(
                        "INSERT INTO device_list (type, number, spec, department, name, sn, cpu, mem, disk, gpu) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                        (asset_type, asset_number, asset_spec, asset_dept, asset_user, config.get('sn', ''), config.get('cpu', ''), config.get('mem', ''), config.get('disk', ''), config.get('gpu', ''))
                    )
                else:
                    cursor.execute(
                        "INSERT INTO device_list (type, number, spec, department, name, cpu, mem, disk, gpu) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                        (asset_type, asset_number, asset_spec, asset_dept, asset_user, config.get('cpu', ''), config.get('mem', ''), config.get('disk', ''), config.get('gpu', ''))
                    )
            else:
                cursor.execute(
                    "INSERT INTO device_list (type, number, spec, department, name) VALUES (%s, %s, %s, %s, %s)",
                    (asset_type, asset_number, asset_spec, asset_dept, asset_user)
                )

            cursor.execute(
                "INSERT INTO inventory (id, number, department, site, type, datetime, status, tag, notice, attachment_urls) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (inv_next_id, asset_number, asset_dept, asset_user, asset_type, today_str, '租聘' if asset_type == '租聘台式主机' else '入库', '入库', '', '')
            )
            inv_next_id += 1

        conn.commit()
        return jsonify({
            'status': 'success',
            'message': f'资产登记成功（批量 {batch_quantity} 个）'
        })
    except Error as e:
        conn.rollback()
        logger.error("登记失败: %s", e)
        return jsonify({'status': 'error', 'message': '服务器内部错误'}), 500
    finally:
        if cursor:
            cursor.close()
        conn.close()

# 获取所有资产列表（按月份分组）
@asset_bp.route('/api/get_all_assets', methods=['GET'])
def get_all_assets():
    if not session.get('logged_in'):
        return jsonify({'status': 'error', 'message': '未登录'}), 401

    month = request.args.get('month', '')

    conn = get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': '数据库连接失败'}), 500

    try:
        cursor = conn.cursor(dictionary=True, buffered=True)

        if month:
            where_clause = "WHERE LENGTH(number) = 9 AND SUBSTRING(number, 3, 4) = %s"
            params = [month]
        else:
            where_clause = "WHERE LENGTH(number) = 9"
            params = []

        query = f"""
            SELECT id, number, spec, type, department, name, sn, cpu, mem, disk, gpu
            FROM device_list {where_clause}
            ORDER BY number ASC
        """
        cursor.execute(query, params)
        all_rows = cursor.fetchall()

        grouped = {}
        for row in all_rows:
            code = row['number']
            if len(code) >= 4:
                month_key = code[2:6]
                if month_key not in grouped:
                    grouped[month_key] = {'DZ': [], 'ZL': []}
                if code.startswith('ZL'):
                    grouped[month_key]['ZL'].append(row)
                else:
                    grouped[month_key]['DZ'].append(row)

        cursor.execute("SELECT DISTINCT SUBSTRING(number, 3, 4) as month FROM device_list WHERE LENGTH(number) = 9 ORDER BY month DESC")
        months = [r['month'] for r in cursor.fetchall()]

        return jsonify({
            'status': 'success',
            'grouped': grouped,
            'months': months,
            'current_month': month
        })
    except Error as e:
        return jsonify({'status': 'error', 'message': '服务器内部错误'}), 500
    finally:
        cursor.close()
        conn.close()

# 获取单个资产详情
@asset_bp.route('/api/get_asset_detail', methods=['GET'])
def get_asset_detail():
    if not session.get('logged_in'):
        return jsonify({'status': 'error', 'message': '未登录'}), 401

    asset_id = request.args.get('id')
    if not asset_id:
        return jsonify({'status': 'error', 'message': '缺少资产ID'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': '数据库连接失败'}), 500

    try:
        cursor = conn.cursor(dictionary=True, buffered=True)
        cursor.execute(
            "SELECT id, number, spec, type, site, department, name, sn, cpu, mem, disk, gpu FROM device_list WHERE id = %s",
            (asset_id,)
        )
        asset = cursor.fetchone()

        if not asset:
            return jsonify({'status': 'error', 'message': '资产不存在'}), 404

        cursor.execute(
            "SELECT department, site FROM inventory WHERE number = %s",
            (asset['number'],)
        )
        inv = cursor.fetchone()
        if inv:
            asset['department'] = inv['department']
            asset['site'] = inv['site']

        return jsonify({'status': 'success', 'data': asset})
    except Error as e:
        return jsonify({'status': 'error', 'message': '服务器内部错误'}), 500
    finally:
        cursor.close()
        conn.close()
