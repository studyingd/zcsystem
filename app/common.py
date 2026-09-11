"""跨蓝图公用的 HTTP 层工具。

三个业务蓝图（asset / inventory / order）此前各自手写「登录检查 + 获取连接 +
try/finally 关闭 + 异常转 JSON」的样板代码，口径不一（有的返回 401 JSON、
有的重定向登录页，有的 rollback 有的不 rollback）。统一收敛到本模块：

- :func:`login_required_api`  —— JSON 接口的登录检查（401）
- :func:`login_required_page` —— 页面路由的登录检查（302 到登录页）
- :func:`with_db`             —— 连接生命周期 + 事务回滚 + 异常转 JSON
- :func:`error_json` / :func:`denied` / :func:`db_error` —— 统一错误响应

handler 约定：``with_db`` 装饰的视图签名为 ``(conn, cursor, *args, **kwargs)``，
cursor 为 ``dictionary=True``；handler 内抛 ``ValueError`` 转 400（业务校验），
其余异常转 500，均自动 rollback。
"""

import logging
from functools import wraps

from flask import jsonify, redirect, request, session, url_for

from .config import get_db_connection

logger = logging.getLogger(__name__)


def error_json(message, code=500, **extra):
    payload = {'status': 'error', 'message': message}
    payload.update(extra)
    return jsonify(payload), code


def denied():
    """未登录（JSON 接口）。"""
    return error_json('未登录，请先登录', 401)


def db_error():
    """数据库连接失败。"""
    return error_json('数据库连接失败', 500)


def login_required_api(view):
    """JSON 接口登录检查：未登录返回 401 JSON。"""
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not session.get('logged_in'):
            return denied()
        return view(*args, **kwargs)
    return wrapper


def login_required_page(view):
    """页面路由登录检查：未登录重定向到登录页。"""
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not session.get('logged_in'):
            return redirect(url_for('auth.login'))
        return view(*args, **kwargs)
    return wrapper


def with_db(handler):
    """统一获取 / 关闭数据库连接，异常自动回滚并转 JSON 响应。"""
    @wraps(handler)
    def wrapper(*args, **kwargs):
        conn = get_db_connection()
        if not conn:
            return db_error()
        cursor = None
        try:
            cursor = conn.cursor(dictionary=True, buffered=True)
            return handler(conn, cursor, *args, **kwargs)
        except ValueError as e:
            conn.rollback()
            return error_json(str(e), 400)
        except Exception as e:
            conn.rollback()
            logger.error("%s 异常: %s", request.path, e, exc_info=True)
            return error_json('服务器内部错误', 500)
        finally:
            if cursor:
                cursor.close()
            conn.close()
    return wrapper
