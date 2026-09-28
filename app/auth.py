"""用户认证：登录 / 登出 / 页面路由。

安全口径：

- 登录失败统一提示「用户名或密码错误」，不区分用户是否存在（防用户枚举）；
- 内存级登录限流：同一「IP + 用户名」10 分钟内失败 5 次锁定 15 分钟，
  防暴力破解。单进程内存计数（gunicorn 多 worker 时各自计数，阈值等效放宽；
  如需严格全局限流可换 redis + flask-limiter）；
- 密码仅支持 bcrypt（存量 MD5 已全部迁移完毕，MD5 兼容分支已下线；
  迁移进度可用 ``scripts/check_password_migration.py`` 复核）。
"""

import logging
import threading
import time

from flask import Blueprint, redirect, render_template, request, session, url_for
from mysql.connector import Error

from .common import login_required_page
from .config import get_db_connection
from .utils import verify_password_bcrypt

auth_bp = Blueprint('auth', __name__)
logger = logging.getLogger(__name__)

# ---- 登录限流（进程内） ----
LOGIN_WINDOW_SECONDS = 600      # 失败计数窗口：10 分钟
LOGIN_MAX_FAILURES = 5          # 窗口内最多失败次数
LOGIN_LOCK_SECONDS = 900        # 超限时锁定：15 分钟

_login_mutex = threading.Lock()
_login_failures = {}            # key -> [count, window_start]
_login_locks = {}               # key -> unlock_timestamp

LOGIN_ERROR = '用户名或密码错误'


def _throttle_key():
    return f'{request.remote_addr}|{(request.form.get("username") or "").strip().lower()}'


def _locked_seconds(key):
    """返回该 key 剩余锁定秒数（0 表示未锁定），顺带清理过期条目。"""
    now = time.monotonic()
    with _login_mutex:
        unlock_at = _login_locks.get(key, 0)
        if unlock_at and now >= unlock_at:
            _login_locks.pop(key, None)
            _login_failures.pop(key, None)
            return 0
        return max(0, int(unlock_at - now))


def _register_failure(key):
    now = time.monotonic()
    with _login_mutex:
        entry = _login_failures.get(key)
        if not entry or now - entry[1] > LOGIN_WINDOW_SECONDS:
            entry = [0, now]
            _login_failures[key] = entry
        entry[0] += 1
        if entry[0] >= LOGIN_MAX_FAILURES:
            _login_locks[key] = now + LOGIN_LOCK_SECONDS
            _login_failures.pop(key, None)
            logger.warning("登录失败超限，锁定 %s 分钟: %s", LOGIN_LOCK_SECONDS // 60, key)


def _clear_failures(key):
    with _login_mutex:
        _login_failures.pop(key, None)
        _login_locks.pop(key, None)


def _verify_user(cursor, username, password):
    """校验用户名密码（仅 bcrypt）。"""
    cursor.execute(
        "SELECT password_bcrypt FROM identified WHERE username = %s",
        (username,)
    )
    user = cursor.fetchone()
    if not user:
        return False

    bcrypt_hash = user.get('password_bcrypt') or ''
    if not bcrypt_hash:
        # 正常不会发生（存量 MD5 已全部迁移）；若出现说明有新账号未设 bcrypt 哈希
        logger.warning("账号 %s 无 bcrypt 哈希，拒绝登录", username)
        return False
    return verify_password_bcrypt(password, bcrypt_hash)


# 登录页面
@auth_bp.route('/login', methods=['GET', 'POST'])
def login():
    if request.method != 'POST':
        return render_template('login.html')

    key = _throttle_key()
    locked = _locked_seconds(key)
    if locked:
        return render_template(
            'login.html',
            error=f'尝试次数过多，请 {max(1, locked // 60)} 分钟后再试'
        ), 429

    username = (request.form.get('username') or '').strip()
    password = request.form.get('password') or ''

    conn = get_db_connection()
    if not conn:
        return render_template('login.html', error='服务暂时不可用，请稍后重试'), 503

    cursor = None
    try:
        cursor = conn.cursor(dictionary=True)
        password_ok = _verify_user(cursor, username, password)
    except Error as e:
        logger.error("登录数据库错误: %s", e)
        return render_template('login.html', error='服务暂时不可用，请稍后重试'), 503
    finally:
        if cursor:
            cursor.close()
        conn.close()

    if not password_ok:
        _register_failure(key)
        return render_template('login.html', error=LOGIN_ERROR), 401

    _clear_failures(key)
    session.clear()
    session['logged_in'] = True
    session['username'] = username
    return redirect(url_for('auth.index'))


# 登出功能
@auth_bp.route('/logout', methods=['POST'])
def logout():
    session.clear()
    return redirect(url_for('auth.login'))


# 默认进入资产申请（无需登录）
@auth_bp.route('/')
def index():
    return redirect(url_for('dashboard.dashboard_page'))


# 资产变更
@auth_bp.route('/asset_change')
@login_required_page
def asset_change():
    return render_template('index.html', active_nav='asset_change', logged_in=True)
