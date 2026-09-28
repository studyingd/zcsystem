# Docker 相关文件

| 文件 | 作用 |
|------|------|
| `Dockerfile` | 生产镜像：`python:3.14-slim` 多阶段构建、gunicorn（gthread）、非 root、`TZ=Asia/Shanghai`、健康检查打 `/login` |
| `docker-compose.yml` | 编排：应用容器 + 健康检查 + 重启策略；MySQL/S3 保持外部（附注释版 MySQL 服务） |

> `.dockerignore` 在**仓库根目录**：Docker 只读取「构建上下文根目录」下的该文件，放到 `docker/` 里不生效。
> 构建上下文因此必须是仓库根（镜像要打包 `app/ templates/ static/`），命令里用 `-f docker/Dockerfile` 指定 Dockerfile。

镜像一律在**服务器上**构建：代码拉到服务器后本地 build，天然匹配服务器架构，
不存在「本机导出 tar 再上传」传错架构导致 `exec format error` 的问题（该工作流已废弃）。

## 服务器上构建并启动

```bash
# 1) 服务器上拉代码
git clone <仓库地址> /opt/zcsystem
cd /opt/zcsystem

# 2) 准备 .env（不要打进镜像，运行时注入）
cp .env.example .env
vim .env          # 填数据库 / S3 / SECRET_KEY 等实际值，各项含义见文件内注释

# 3) 构建并启动（一条命令，已含健康检查与重启策略）
docker compose -f docker/docker-compose.yml up -d --build

# 看日志 / 停止
docker compose -f docker/docker-compose.yml logs -f web
docker compose -f docker/docker-compose.yml down
```

不用 compose 时等价于：

```bash
docker build -f docker/Dockerfile -t zcsystem:latest .
docker run -d --name zcsystem-web --restart unless-stopped \
  -p 5000:5000 --env-file .env \
  zcsystem:latest
```

## 升级

```bash
cd /opt/zcsystem
git pull
docker compose -f docker/docker-compose.yml up -d --build
```

应用无本地写盘（附件走 S3），数据都在 MySQL，容器可随时删除重建。

## 要点

- **`DB_HOST` 必须是容器可直达的地址**：内网 IP / 域名 / 同一 compose 网络的服务名均可；
  `localhost` 在容器内指向容器自身，永远连不上库。
- **时区**：镜像固定 `Asia/Shanghai`。年月码、领取日期都取自本地时间，UTC 会整体差一天。
- **健康检查**：`docker ps` 看到 `(healthy)` 即就绪（打 `/login`）。
- **并发**：默认 2 worker × 4 线程。需要调整时在 `.env` 里加 `WEB_CONCURRENCY` / `WEB_THREADS`
 （env_file 会注入容器并覆盖镜像默认值），或 `docker run -e` 覆盖。
  每个 worker 会各自预热/刷新飞书缓存，worker 越多飞书请求越多，2 个足够。
- **数据库初始化**：首次部署需先建库导表，见根目录 `README.md` 的「数据库初始化」；
  也可取消 compose 里 mysql 服务的注释，首次启动会自动执行 `scripts/` 下的建表脚本。
