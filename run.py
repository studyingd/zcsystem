import os

from app import create_app

app = create_app()

if __name__ == '__main__':
    host = os.environ.get('HOST', '0.0.0.0')
    port = int(os.environ.get('PORT', 5000))
    # 注意：macOS 的 5000 端口可能被系统「隔空播放接收器」(ControlCenter) 占用，
    # 启动报 Address already in use 时，到「系统设置 → 通用 → 隔空投送与接力」
    # 关闭「隔空播放接收器」，或用 PORT=5001 uv run python run.py 换端口。
    # gunicorn 等生产入口会设置对应环境变量，此时不开调试
    production = bool(os.environ.get('GUNICORN_CMD_ARGS') or os.environ.get('FLASK_PRODUCTION'))
    # 调试模式默认关闭：Werkzeug 调试器可在页面上执行任意代码，
    # 只允许开发机显式 FLASK_DEBUG=1 打开，避免生产误用 python run.py 裸奔
    debug = not production and os.environ.get('FLASK_DEBUG', '0') == '1'
    app.run(host=host, port=port, debug=debug)
