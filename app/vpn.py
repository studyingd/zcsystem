from flask import Blueprint, render_template, request, jsonify, session
from .config import get_db_connection

vpn_bp = Blueprint('vpn', __name__)


@vpn_bp.route('/vpn')
def vpn_page():
    if not session.get('logged_in'):
        return render_template('login.html')
    return render_template('vpn.html')


@vpn_bp.route('/api/vpn_records', methods=['GET'])
def vpn_records():
    if not session.get('logged_in'):
        return jsonify({'status': 'error', 'message': '未登录，请先登录'}), 401

    department = request.args.get('department', '').strip()

    conn = get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': '数据库连接失败'}), 500

    cursor = conn.cursor(dictionary=True)
    try:
        if department:
            cursor.execute(
                "SELECT id, department, name, terminal, datetime, apptype, purpose FROM vpn_record WHERE department = %s ORDER BY datetime DESC, id ASC",
                (department,)
            )
        else:
            cursor.execute(
                "SELECT id, department, name, terminal, datetime, apptype, purpose FROM vpn_record ORDER BY datetime DESC, id ASC"
            )

        records = cursor.fetchall()
        for r in records:
            if r.get('datetime'):
                r['datetime'] = r['datetime'].strftime('%Y-%m-%d')
            else:
                r['datetime'] = ''

        return jsonify({'status': 'success', 'data': records})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@vpn_bp.route('/api/vpn_insert', methods=['POST'])
def vpn_insert():
    if not session.get('logged_in'):
        return jsonify({'status': 'error', 'message': '未登录，请先登录'}), 401

    department = request.form.get('department', '').strip()
    name = request.form.get('name', '').strip()
    terminal = request.form.get('terminal', '').strip()
    datetime_val = request.form.get('datetime', '').strip()
    apptype = request.form.get('apptype', '').strip()
    purpose = request.form.get('purpose', '').strip()

    if not all([department, name, datetime_val, apptype]):
        return jsonify({'status': 'error', 'message': '部门、使用人、日期、VPN类型 不能为空'}), 400

    if not terminal:
        terminal = '电脑翻墙'

    conn = get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': '数据库连接失败'}), 500

    cursor = conn.cursor()
    try:
        cursor.execute(
            "INSERT INTO vpn_record (department, name, terminal, datetime, apptype, purpose) VALUES (%s, %s, %s, %s, %s, %s)",
            (department, name, terminal, datetime_val, apptype, purpose)
        )
        conn.commit()
        return jsonify({'status': 'success', 'message': '新增成功'})
    except Exception as e:
        conn.rollback()
        return jsonify({'status': 'error', 'message': str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@vpn_bp.route('/api/vpn_update', methods=['POST'])
def vpn_update():
    if not session.get('logged_in'):
        return jsonify({'status': 'error', 'message': '未登录，请先登录'}), 401

    id_val = request.form.get('id', '').strip()
    department = request.form.get('department', '').strip()
    name = request.form.get('name', '').strip()
    terminal = request.form.get('terminal', '').strip()
    datetime_val = request.form.get('datetime', '').strip()
    apptype = request.form.get('apptype', '').strip()
    purpose = request.form.get('purpose', '').strip()

    if not all([id_val, department, name, datetime_val, apptype]):
        return jsonify({'status': 'error', 'message': 'ID、部门、使用人、日期、VPN类型 不能为空'}), 400

    if not id_val.isdigit():
        return jsonify({'status': 'error', 'message': 'ID必须为数字'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': '数据库连接失败'}), 500

    cursor = conn.cursor()
    try:
        cursor.execute(
            "UPDATE vpn_record SET department=%s, name=%s, terminal=%s, datetime=%s, apptype=%s, purpose=%s WHERE id=%s",
            (department, name, terminal, datetime_val, apptype, purpose, id_val)
        )
        if cursor.rowcount == 0:
            conn.rollback()
            return jsonify({'status': 'error', 'message': '未找到对应记录'}), 404
        conn.commit()
        return jsonify({'status': 'success', 'message': '更新成功'})
    except Exception as e:
        conn.rollback()
        return jsonify({'status': 'error', 'message': str(e)}), 500
    finally:
        cursor.close()
        conn.close()


@vpn_bp.route('/api/vpn_delete', methods=['POST'])
def vpn_delete():
    if not session.get('logged_in'):
        return jsonify({'status': 'error', 'message': '未登录，请先登录'}), 401

    id_val = request.form.get('id', '').strip()
    if not id_val or not id_val.isdigit():
        return jsonify({'status': 'error', 'message': 'ID必须为数字'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': '数据库连接失败'}), 500

    cursor = conn.cursor()
    try:
        cursor.execute("DELETE FROM vpn_record WHERE id = %s", (id_val,))
        if cursor.rowcount == 0:
            conn.rollback()
            return jsonify({'status': 'error', 'message': '未找到对应记录'}), 404
        conn.commit()
        return jsonify({'status': 'success', 'message': '删除成功'})
    except Exception as e:
        conn.rollback()
        return jsonify({'status': 'error', 'message': str(e)}), 500
    finally:
        cursor.close()
        conn.close()
