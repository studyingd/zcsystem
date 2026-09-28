import logging
import os

from dotenv import load_dotenv
from flask import Flask, render_template, request, url_for
from flask_wtf.csrf import CSRFError, CSRFProtect

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s'
)

csrf = CSRFProtect()


def create_app():
    app = Flask(__name__, template_folder='../templates', static_folder='../static')
    app.secret_key = os.environ['SECRET_KEY']
    app.config['SESSION_COOKIE_HTTPONLY'] = True
    app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
    # HTTPS 部署时设 SESSION_COOKIE_SECURE=1，禁止 cookie 走明文信道
    app.config['SESSION_COOKIE_SECURE'] = os.environ.get('SESSION_COOKIE_SECURE', '0') == '1'
    # CSRF token 跟随会话：不设独立倒计时，会话活着 token 就一直有效
    # （会话为浏览器会话级：关浏览器 / 登出即失效，下次进入重新签发）
    app.config['WTF_CSRF_TIME_LIMIT'] = None

    csrf.init_app(app)

    @app.template_global('static_url')
    def static_url(filename):
        """静态资源地址，自动附带基于文件 mtime+大小的版本号。

        取代手写在模板里的 ？v=N：文件一改指纹即变，无需同步修改模板，
        浏览器也不会拿到旧缓存。模板里用 {{ static_url('css/dashboard.css') }}。
        """
        path = os.path.join(app.static_folder, filename)
        try:
            st = os.stat(path)
            ver = f'{int(st.st_mtime):x}-{st.st_size:x}'
        except OSError:
            ver = None
        url = url_for('static', filename=filename)
        return f'{url}?v={ver}' if ver else url

    @app.errorhandler(CSRFError)
    def handle_csrf_error(e):
        if request.path == '/login':
            return render_template('login.html', error='页面已过期，请重新输入账号密码'), 400
        return e.get_response()

    from . import feishu
    from .asset import asset_bp
    from .auth import auth_bp
    from .dashboard import dashboard_bp
    from .inventory import inv_bp
    from .meta import frontend_meta, meta_bp
    from .order import order_bp

    app.register_blueprint(auth_bp)
    app.register_blueprint(inv_bp)
    app.register_blueprint(asset_bp)
    app.register_blueprint(dashboard_bp)
    app.register_blueprint(order_bp)
    app.register_blueprint(meta_bp)

    # 启动预热飞书申请数据：后台线程拉取，请求线程不再等待飞书接口
    # （网络不可达时只在日志留一条 warning，不影响启动；FEISHU_WARMUP=0 可关闭）
    if os.environ.get('FEISHU_WARMUP', '1') != '0':
        feishu.warm_up()

    @app.context_processor
    def inject_meta():
        # base.html 把词表渲染成 #zcMeta，前端不再自带一份常量
        return {'zc_meta': frontend_meta()}

    return app
