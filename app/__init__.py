import os
import logging
from flask import Flask, render_template, request
from flask_wtf.csrf import CSRFProtect, CSRFError
from dotenv import load_dotenv

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
    # CSRF token 跟随会话：不设独立倒计时，会话活着 token 就一直有效
    # （会话为浏览器会话级：关浏览器 / 登出即失效，下次进入重新签发）
    app.config['WTF_CSRF_TIME_LIMIT'] = None

    csrf.init_app(app)

    @app.errorhandler(CSRFError)
    def handle_csrf_error(e):
        if request.path == '/login':
            return render_template('login.html', error='页面已过期，请重新输入账号密码'), 400
        return e.get_response()

    from .auth import auth_bp
    from .inventory import inv_bp
    from .asset import asset_bp
    from .dashboard import dashboard_bp
    from .order import order_bp
    from .meta import meta_bp, frontend_meta

    app.register_blueprint(auth_bp)
    app.register_blueprint(inv_bp)
    app.register_blueprint(asset_bp)
    app.register_blueprint(dashboard_bp)
    app.register_blueprint(order_bp)
    app.register_blueprint(meta_bp)

    @app.context_processor
    def inject_meta():
        # base.html 把词表渲染成 #zcMeta，前端不再自带一份常量
        return {'zc_meta': frontend_meta()}

    return app
