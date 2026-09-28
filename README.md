# 资产管理系统 (zcsystem)

基于 Flask 的企业资产管理系统：资产登记、变更追踪、申请单据看板（预算/库存/部门领用统计）与数据导出。

## 功能模块

- **资产登记** — 批量创建资产，自动生成编码（`DZ/ZL` + 年月 + 流水），同时写入台账
- **资产变更与查询** — 按编码 / SN / 使用人 / 部门查询；变更使用人时自动备份历史记录
- **资产申请（单据看板）** — 单据 / 预算 / 今年已采购 / 剩余库存 / 申请数量（飞书实时）/ 部门领用总览；
  单据可「下推」生成当月资产卡片并写入台账，支持审核与撤销下推
- **附件管理** — S3 兼容对象存储上传
- **数据导出** — 各模块按当前筛选导出 Excel

## 技术栈

- **后端**: Flask + MySQL 8.0+（mysql-connector-python）
- **前端**: 原生 HTML/CSS/JavaScript（无构建步骤）
- **对象存储**: S3 兼容存储（boto3）
- **Excel**: openpyxl
- **包管理**: uv

## 快速开始（本地开发）

```bash
# 1) 安装依赖
uv sync

# 2) 配置环境变量
cp .env.example .env && vim .env

# 3) 建库导表（见下节「数据库初始化」）

# 4) 启动
uv run python run.py          # http://localhost:5000
```

> 端口默认 5000。macOS 若启动报 `Address already in use`，是系统「隔空播放接收器」占用了 5000：
> 到「系统设置 → 通用 → 隔空投送与接力」关闭它，或用 `PORT=5001 uv run python run.py` 换端口。

## 数据库初始化

要求 **MySQL 8.0+**（看板库存统计使用窗口函数）。

```sql
CREATE DATABASE zcsystem CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

按顺序导入（均在 `scripts/`，可重复执行）：

```bash
mysql --default-character-set=utf8mb4 -u<user> -p zcsystem < scripts/init_db.sql          # 台账 4 张表
mysql --default-character-set=utf8mb4 -u<user> -p zcsystem < scripts/init_documents.sql   # 单据 3 张表

# 可选：演示数据（含登录账号 admin / admin123，体验后请修改或删除）
mysql --default-character-set=utf8mb4 -u<user> -p zcsystem < scripts/seed_demo.sql
mysql --default-character-set=utf8mb4 -u<user> -p zcsystem < scripts/seed_documents.sql
```

`.env` 里的 `DB_NAME` 填上面创建的库名即可。所有表统一 `utf8mb4 / utf8mb4_unicode_ci`
（跨表 JOIN 要求排序规则一致，勿单独改某张表）。

### 表结构

| 表名 | 作用 | 关键列 |
|------|------|--------|
| `identified` | 用户账号 | username（唯一）, password_bcrypt |
| `device_list` | 设备台账（资产唯一主档） | number（唯一，`DZ2609001` 式编码）, spec, type, department, name, sn, cpu/mem/disk/gpu |
| `inventory` | 资产流转记录 | id（自增）, number, department, site, type, datetime, status, tag, notice, attachment_urls |
| `inventory_tmp` | 流转历史备份 | site 变更时自动写入，id 指向 inventory.id |
| `budgets` | 年度预算 | budget_year + device_type（唯一）, budget_amount, used_adjust（人工修正量） |
| `purchase_orders` | 资产申请单据 | order_no（唯一，`PO2609001` 式）, order_date, device_type, spec, quantity, unit_price, amount, in_budget, pushed, reviewed |
| `asset_cards` | 资产卡片（下推生成） | card_no（唯一）, order_id, asset_number, owner, department, receive_date, card_status |

### 数据流

`device_list` + `inventory` 是唯一事实来源，三个模块共用：

```
资产登记 ──写入──▶ device_list / inventory ◀──更新── 资产变更（变更前备份 inventory_tmp）
                        │ 只读
                        ▼
              资产申请（预算 / 库存 / 部门领用统计）
                        │ 下推生成卡片并写入新台账资产
                        ▼
                  asset_cards（绑定 asset_number）
```

资产状态 / 流转标签 / 部门等词表由后端 `app/ledger.py` 统一定义，经 `app/meta.py`
下发到前端（`GET /api/meta`），改词表只改 `app/ledger.py`。

## Docker 部署

镜像：`python:3.14-slim` 多阶段构建 + gunicorn（2 worker × 4 线程）+ 非 root + `TZ=Asia/Shanghai` + 健康检查。

```bash
git clone <仓库地址> /opt/zcsystem && cd /opt/zcsystem
cp .env.example .env && vim .env
docker compose -f docker/docker-compose.yml up -d --build
```

- `.env` 里的 `DB_HOST` 必须写**容器可直达**的地址（内网 IP / 域名 / compose 服务名）；
  `localhost` 在容器内指向容器自身，连不上库。
- 需要自带 MySQL 时，取消 `docker/docker-compose.yml` 里 mysql 服务的注释：首次启动会自动执行 `scripts/` 下的建表与种子脚本，无需手工导 SQL。
- 升级：`git pull` 后重跑 `up -d --build`。应用无本地写盘（附件走 S3），容器可随时重建。
- 细节见 `docker/README.md`。

## 环境变量

集中在 `.env`（模板 `.env.example` 已入库，实际值不入库）：

- **必填**：`DB_HOST` / `DB_USER` / `DB_PASSWORD` / `DB_NAME`、
  `S3_ENDPOINT` / `S3_ACCESS_KEY` / `S3_SECRET_KEY`、`SECRET_KEY`（`openssl rand -hex 32`）
- **可选**：`S3_EXTERNAL_URL` / `S3_BUCKET`（附件外链与桶名）、`SESSION_COOKIE_SECURE=1`（HTTPS 部署）、
  `DB_POOL_SIZE`（连接池，默认 8）、`FEISHU_*`（不配置时看板「申请数量」留空，其余不受影响）、
  `HOST` / `PORT` / `FLASK_DEBUG`（仅开发入口 `run.py` 生效）

## 质量检查

```bash
uv run ruff check app/ scripts/ tests/   # lint
uv run pytest                            # 单元测试（不连数据库）
```

CI：GitHub Actions（`.github/workflows/ci.yml`）与 GitLab CI（`.gitlab-ci.yml`）均跑 ruff + pytest 与 JS 语法检查。

## 项目结构

```
├── run.py                  # 开发启动入口
├── pyproject.toml          # 依赖与工具配置
├── .env.example            # 环境变量模板（cp 为 .env 后填写）
├── app/
│   ├── __init__.py         # 应用工厂（含 static_url 静态资源指纹）
│   ├── config.py           # 数据库连接池与 S3 配置
│   ├── auth.py             # 登录认证（bcrypt + 登录限流）
│   ├── asset.py            # 资产登记蓝图
│   ├── inventory.py        # 资产变更与查询蓝图
│   ├── order.py            # 单据看板蓝图
│   ├── feishu.py           # 飞书多维表集成（申请数量，缓存 + 后台刷新）
│   ├── ledger.py           # 台账口径与派生逻辑（三模块共用，唯一事实来源）
│   ├── meta.py             # 前端词表下发
│   ├── dashboard.py        # 看板页面路由
│   ├── common.py           # 登录检查 / 连接管理 / 统一错误响应
│   └── utils.py            # 密码工具 + Excel 导出（openpyxl）
├── templates/              # base / login / index / dashboard / asset_register
├── static/
│   ├── css/index/          # 全局样式（tokens 设计令牌 + 按职责拆分）
│   ├── js/
│   │   ├── utils.js        # 共享工具与词表
│   │   ├── modal.js        # 公共弹窗组件
│   │   ├── index/          # 资产变更与查询交互
│   │   ├── dashboard_orders.js      # 单据看板交互
│   │   └── dashboard_dept_usage.js  # 部门领用总览（独立模块）
│   └── asset_register.js / login.css / dashboard.css ...
├── scripts/
│   ├── init_db.sql               # 台账表结构（建库用）
│   ├── init_documents.sql        # 单据表结构（建库用）
│   ├── seed_demo.sql             # 演示数据：台账 + admin 账号
│   ├── seed_documents.sql        # 演示数据：预算 + 单据
│   └── migrate_*.py              # 老库升级用的幂等迁移脚本（新库不需要）
├── tests/                  # 单元测试（口径 / 导出 / 限流，不连数据库）
├── docker/                 # Dockerfile + docker-compose.yml + 部署说明
└── .github/workflows/ci.yml  # CI（ruff + pytest + JS 语法检查）
```
