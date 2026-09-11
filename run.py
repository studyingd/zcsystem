import os

from app import create_app

app = create_app()

if __name__ == '__main__':
    # 默认 5001：macOS 的 5000 端口被系统「隔空播放接收器」(ControlCenter) 占用，
    # 直接跑 5000 会 Address already in use。需要 5000 时先关掉该系统服务，
    # 或用 PORT=5000 uv run python run.py 覆盖。
    host = os.environ.get('HOST', '0.0.0.0')
    port = int(os.environ.get('PORT', 5001))
    # gunicorn 等生产入口会设置对应环境变量，此时不开调试
    production = bool(os.environ.get('GUNICORN_CMD_ARGS') or os.environ.get('FLASK_PRODUCTION'))
    debug = not production and os.environ.get('FLASK_DEBUG', '1') == '1'
    app.run(host=host, port=port, debug=debug)
