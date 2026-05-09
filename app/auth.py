from flask import Blueprint, render_template, request, redirect, url_for, session
from mysql.connector import Error
from .config import get_db_connection
from .utils import generate_md5_hash

auth_bp = Blueprint('auth', __name__)


# 登录页面
@auth_bp.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')

        conn = get_db_connection()
        if conn:
            try:
                cursor = conn.cursor(dictionary=True)
                cursor.execute("SELECT * FROM identified WHERE username = %s", (username,))
                user = cursor.fetchone()

                if user:
                    hashed_password = generate_md5_hash(password)
                    if hashed_password == user['password']:
                        session['logged_in'] = True
                        session['username'] = username
                        return redirect(url_for('auth.index'))
                    else:
                        return render_template('login.html', error='密码错误，请重试')
                else:
                    return render_template('login.html', error='用户名不存在')
            except Error as e:
                print(f"数据库查询错误: {e}")
                return render_template('login.html', error='数据库错误，请重试')
            finally:
                cursor.close()
                conn.close()
        else:
            return render_template('login.html', error='数据库连接失败')

    return render_template('login.html')


# 登出功能
@auth_bp.route('/logout')
def logout():
    session.pop('logged_in', None)
    session.pop('username', None)
    return redirect(url_for('auth.login'))


# 主页（需要登录才能访问）
@auth_bp.route('/')
def index():
    if not session.get('logged_in'):
        return redirect(url_for('auth.login'))
    return render_template('index.html')
