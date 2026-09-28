# zcsystem 生产镜像：Flask + gunicorn，多阶段构建（构建期装编译工具，运行镜像不带）。
# 构建在服务器上进行（构建上下文必须是仓库根目录，因为要打包 app/ templates/ static/）：
#   docker build -f docker/Dockerfile -t zcsystem:latest .
#   docker compose -f docker/docker-compose.yml up -d --build   # 推荐：一条命令构建并启动
# 运行：
#   docker run -d --name zcsystem-web -p 5000:5000 --env-file .env \
#     -e DB_HOST=host.docker.internal zcsystem:latest
#
# 说明：
# - 不把 .env 打进镜像（密钥用 --env-file / compose 注入）；
# - TZ=Asia/Shanghai：年月码、领取日期等都依赖本地时间，容器默认 UTC 会差一天；
# - 应用本身无本地写盘（附件走 S3），容器可随时重建。

########## 构建阶段：预编译依赖到 wheels（无 cp314 wheel 的包需要 gcc） ##########
FROM python:3.14-slim AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential libffi-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY requirements.txt ./
RUN pip wheel --wheel-dir /wheels -r requirements.txt

########## 运行阶段 ##########
FROM python:3.14-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    TZ=Asia/Shanghai \
    PORT=5000 \
    WEB_CONCURRENCY=2 \
    WEB_THREADS=4

# tzdata：让容器内 date.today() / datetime.now() 按北京时间
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata \
 && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
 && echo $TZ > /etc/timezone \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /wheels /wheels
COPY requirements.txt ./
RUN pip install --no-index --find-links=/wheels -r requirements.txt \
 && rm -rf /wheels

# 非 root 运行
RUN useradd --create-home --shell /usr/sbin/nologin appuser
WORKDIR /app
COPY --chown=appuser:appuser app ./app
COPY --chown=appuser:appuser templates ./templates
COPY --chown=appuser:appuser static ./static
COPY --chown=appuser:appuser run.py ./

USER appuser
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:5000/login', timeout=4).status == 200 else 1)"

# gthread：看板读多写少、且会等 MySQL/飞书 IO，少量 worker + 多线程更合适
CMD ["sh", "-c", "exec gunicorn 'app:create_app()' \
    --bind 0.0.0.0:${PORT} \
    --workers ${WEB_CONCURRENCY} \
    --worker-class gthread --threads ${WEB_THREADS} \
    --timeout 60 --graceful-timeout 20 \
    --access-logfile - --error-logfile -"]
