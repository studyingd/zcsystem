import os
from flask import Flask
from dotenv import load_dotenv

load_dotenv()


def create_app():
    app = Flask(__name__, template_folder='../templates', static_folder='../static')
    app.secret_key = os.environ['SECRET_KEY']

    from .auth import auth_bp
    from .inventory import inv_bp
    from .asset import asset_bp
    from .vpn import vpn_bp

    app.register_blueprint(auth_bp)
    app.register_blueprint(inv_bp)
    app.register_blueprint(asset_bp)
    app.register_blueprint(vpn_bp)

    return app
