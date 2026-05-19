import logging
from flask import Blueprint, render_template, request, jsonify, session
from .config import get_db_connection

vpn_bp = Blueprint('vpn', __name__)
logger = logging.getLogger(__name__)


@vpn_bp.route('/vpn')
def vpn_page():
    if not session.get('logged_in'):
        return render_template('login.html')
    return render_template('vpn.html', active_nav='vpn', logged_in=True)


@vpn_bp.route('/api/vpn_counts', methods=['GET'])
def vpn_counts():
    if not session.get('logged_in'):
        return jsonify({'status': 'error', 'message': '未登录，请先登录'}), 401

    conn = get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': '数据库连接失败'}), 500

    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT department, COUNT(*) as cnt FROM vpn_record GROUP BY department")
        rows = cursor.fetchall()
        counts = {}
        total = 0
        for r in rows:
            dept = r['department'] or '未知'
            counts[dept] = counts.get(dept, 0) + r['cnt']
            total += r['cnt']
        return jsonify({'status': 'success', 'counts': counts, 'total': total})
    except Exception as e:
        logger.error("VPN统计失败: %s", e)
        return jsonify({'status': 'error', 'message': '服务器内部错误'}), 500
    finally:
        cursor.close()
        conn.close()


@vpn_bp.route('/api/vpn_records', methods=['GET'])
def vpn_records():
    if not session.get('logged_in'):
        return jsonify({'status': 'error', 'message': '未登录，请先登录'}), 401

    department = request.args.get('department', '').strip()
    page = request.args.get('page', '1')
    page_size = request.args.get('page_size', '20')

    try:
        page = max(1, int(page))
        page_size = max(1, min(100, int(page_size)))
    except ValueError:
        return jsonify({'status': 'error', 'message': '分页参数错误'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': '数据库连接失败'}), 500

    cursor = conn.cursor(dictionary=True)
    try:
        if department and department != 'all':
            where = 'WHERE department = %s'
            params = [department]
        else:
            where = ''
            params = []

        # 总数
        cursor.execute(f"SELECT COUNT(*) as total FROM vpn_record {where}", params)
        total = cursor.fetchone()['total']

        # 分页数据
        offset = (page - 1) * page_size
        cursor.execute(
            f"SELECT id, department, name, terminal, datetime, apptype, purpose "
            f"FROM vpn_record {where} ORDER BY datetime DESC, id ASC LIMIT %s OFFSET %s",
            params + [page_size, offset]
        )
        records = cursor.fetchall()
        for r in records:
            if r.get('datetime'):
                r['datetime'] = r['datetime'].strftime('%Y-%m-%d')
            else:
                r['datetime'] = ''

        return jsonify({
            'status': 'success',
            'data': records,
            'total': total,
            'page': page,
            'page_size': page_size,
            'total_pages': max(1, -(-total // page_size))
        })
    except Exception as e:
        logger.error("VPN记录查询失败: %s", e)
        return jsonify({'status': 'error', 'message': '服务器内部错误'}), 500
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
        logger.error("VPN记录新增失败: %s", e)
        return jsonify({'status': 'error', 'message': '服务器内部错误'}), 500
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
        logger.error("VPN记录更新失败: %s", e)
        return jsonify({'status': 'error', 'message': '服务器内部错误'}), 500
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
        logger.error("VPN记录删除失败: %s", e)
        return jsonify({'status': 'error', 'message': '服务器内部错误'}), 500
    finally:
        cursor.close()
        conn.close()
