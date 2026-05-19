import logging

from flask import Blueprint, render_template, request, redirect, url_for, session
from mysql.connector import Error
from .config import get_db_connection
from .utils import generate_md5_hash, hash_password_bcrypt, verify_password_bcrypt

auth_bp = Blueprint('auth', __name__)
logger = logging.getLogger(__name__)


# 登录页面
@auth_bp.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')

        conn = get_db_connection()
        if conn:
            cursor = None
            try:
                cursor = conn.cursor(dictionary=True)
                cursor.execute("SELECT * FROM identified WHERE username = %s", (username,))
                user = cursor.fetchone()

                if user:
                    bcrypt_hash = user.get('password_bcrypt', '') or ''
                    password_ok = False

                    if bcrypt_hash:
                        password_ok = verify_password_bcrypt(password, bcrypt_hash)
                    else:
                        password_ok = (generate_md5_hash(password) == user['password'])
                        if password_ok:
                            new_hash = hash_password_bcrypt(password)
                            cursor.execute(
                                "UPDATE identified SET password_bcrypt = %s WHERE username = %s",
                                (new_hash, username)
                            )
                            conn.commit()

                    if password_ok:
                        session.clear()
                        session['logged_in'] = True
                        session['username'] = username
                        return redirect(url_for('auth.index'))
                    else:
                        return render_template('login.html', error='密码错误，请重试')
                else:
                    return render_template('login.html', error='用户名不存在')
            except Error as e:
                logger.error("数据库查询错误: %s", e)
                return render_template('login.html', error='数据库错误，请重试')
            finally:
                if cursor:
                    cursor.close()
                conn.close()
        else:
            return render_template('login.html', error='数据库连接失败')

    return render_template('login.html')


# 登出功能
@auth_bp.route('/logout', methods=['POST'])
def logout():
    session.clear()
    return redirect(url_for('auth.login'))


# 默认进入资产看板（无需登录）
@auth_bp.route('/')
def index():
    return redirect(url_for('dashboard.dashboard_page'))


# 资产变更
@auth_bp.route('/asset_change')
def asset_change():
    if not session.get('logged_in'):
        return redirect(url_for('auth.login'))
    return render_template('index.html', active_nav='asset_change', logged_in=True)
