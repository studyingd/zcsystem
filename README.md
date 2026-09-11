# 资产管理系统 (zcsystem)

基于 Flask 的企业资产管理系统，支持资产登记、变更追踪和数据导出。

## 功能模块

- **用户认证** — 登录/登出，bcrypt 密码哈希（MD5 已全量迁移并下线）；登录失败统一提示 + 限流（同 IP+用户名 10 分钟内失败 5 次锁定 15 分钟）
- **资产登记** — 批量创建资产，自动生成编码（DZ/ZL 前缀），同时写入 `device_list` 和 `inventory` 表
- **资产变更与查询** — 支持按资产编码、SN码、使用人、使用部门、ID 查询；变更使用人时自动备份历史记录
- **实时数据预览** — 按资产状态（已录入/未录入/租聘/借用/入库/无需录入）分类展示
- **单据看板** — 以资产申请单据为主视图：单据编号、设备类型、申请数量、金额、预算内/外、预算剩余、今年已采购数量、剩余库存、下推状态、审核状态；
  列表默认只展示「未审核」单据（工具栏可切已审核 / 全部），登录用户可在单据详情里「标记已审核 / 取消审核」；
- **部门领用总览** — 看板工具栏入口（只读，匿名可见）：**默认显示当月**，起始/结束月下拉可改区间，
  另提供当月 / 上月 / 半年（近 6 月）/ 全年（本年 1–12 月）快捷区间；按流转发生次数统计（区间内每条入职/领用/更换记录计 1 次）。
  一级为 KPI 卡 + 「部门 × 设备类型」矩阵（居中热力胶囊格内印数值 + 数值色标图例 + 吸顶表头/合计行），
  点击单元格下钻二级：面包屑返回 + 入职/领用/更换三张标签卡（资产编码、使用人、流转日期）。
  接口 `GET /api/orders/dept_usage?from=&to=`，派生逻辑在 `ledger.dept_usage_matrix`。
  单据可"下推"生成当月资产卡片（自动关联台账资产并带出所属人/所属部门/领取时间）；
  点击"今年已采购数量"可下钻到该设备类型今年各部门使用情况，再点部门查看具体使用人
- **附件管理** — 基于 S3 兼容对象存储的文件上传
- **数据导出** — 导出 Excel 文件

## 技术栈

- **后端**: Flask, MySQL (mysql-connector-python)
- **前端**: 原生 HTML/CSS/JavaScript
- **对象存储**: S3 兼容存储 (boto3)
- **数据处理**: pandas + openpyxl
- **包管理**: uv

## 界面与设计系统

- 布局为「左侧侧边导航 + 顶部栏 + 内容区」的应用外壳（`templates/base.html`），
  导航项：资产看板 / 资产登记 / 资产变更。
  桌面端（>1024px）顶栏按钮可把侧边栏折叠为 68px 图标栏，状态写入 `localStorage`（键 `zc-sidebar-collapsed`）并在下次进入时恢复；
  ≤1024px 时侧边栏改为抽屉（汉堡按钮 + 遮罩 + Esc 关闭）。
- 视觉体系参考 ui-ux-pro-max 的「Minimalism & Swiss Style」浅色企业方案：
  navy 主色 `#1E3A5F`、蓝色链接 `#2563EB`、绿色语义色 `#059669`、浅灰背景 `#F8FAFC`；
  设计令牌集中在 `static/css/index/tokens.css` 的 `:root`，卡片/表格以 1px 边框代替重阴影。
- 表单控件统一在 `static/css/index/forms.css` 管控：38px 高度（紧凑场景 34px）、8px 圆角、
  悬浮 `#CBD5E1` 边框、聚焦蓝色边框 + 3px 焦点环；`select` 去掉系统默认外观，改用内联 SVG 箭头；
  复选框/单选框使用 `accent-color`。页面级样式不再各自覆写控件外观。
- 无障碍：跳转主内容链接、`aria-current` 当前导航、图标按钮均带 `aria-label`、
  键盘焦点可见、`prefers-reduced-motion` 降级、触屏命中区 ≥44px。
- 品牌标记统一为「资产标签」造型：侧边栏 logo、登录页品牌区与浏览器 favicon（`static/favicon.svg`）同源；
  此前侧边栏（立方体）与登录页（显示器）各用一套图标、且无 favicon 的状态已结束。

## 项目结构

```
├── run.py                  # 启动入口
├── pyproject.toml          # 项目配置与依赖
├── .env                    # 环境变量配置（不提交到版本库）
├── app/
│   ├── __init__.py         # Flask 应用工厂，加载 .env
│   ├── config.py           # 数据库与 S3 连接配置
│   ├── auth.py             # 用户认证蓝图
│   ├── asset.py            # 资产登记蓝图
│   ├── inventory.py        # 资产变更与查询蓝图
│   ├── order.py            # 单据看板蓝图（单据/预算/资产卡片/下钻）
│   ├── ledger.py           # 台账口径与派生逻辑（三模块共用，唯一事实来源）
│   ├── meta.py             # 前端词表下发（context processor + /api/meta）
│   ├── dashboard.py        # 看板页面路由（仅渲染，不含业务逻辑）
│   ├── common.py           # 跨蓝图 HTTP 样板（登录检查装饰器 / 连接管理 / 统一错误响应）
│   └── utils.py            # 密码工具（bcrypt 哈希与校验）
├── templates/
│   ├── base.html           # 应用外壳（侧边导航 + 顶栏 + #zcMeta 词表）
│   ├── login.html          # 登录页
│   ├── index.html          # 首页（资产变更与查询）
│   ├── dashboard.html      # 资产看板（单据视图）
│   └── asset_register.html # 资产登记页
├── static/
│   ├── favicon.svg         # 品牌 favicon（与侧边栏/登录页 logo 同源）
│   ├── css/
│   │   ├── index/          # 全局样式（原 index.css 按职责拆为 11 片，加载顺序即原章节顺序）
│   │   │                   # tokens/base/forms/buttons/modal/responsive/query/detail/shell/components/shared
│   │   ├── dashboard.css   # 看板单据视图样式
│   │   ├── asset_register.css # 资产登记页样式
│   │   └── login.css       # 登录页样式
│   ├── js/
│   │   ├── utils.js        # 跨页共享工具与词表（读取 #zcMeta，含兜底常量）
│   │   ├── modal.js        # 公共弹窗组件（Esc/遮罩关闭、焦点陷阱、aria）
│   │   ├── index/          # 资产变更与查询交互（原 index.js 拆为 4 片顺序加载，共享全局作用域）
│   │   │                   # overview/query/detail-render/detail-actions
│   │   ├── asset_register.js   # 资产登记交互
│   │   └── dashboard_orders.js # 单据看板交互（单 IIFE 模块，内部状态私有，不再拆分）
├── scripts/
│   ├── init_db.sql         # 基础表结构
│   ├── init_documents.sql  # 单据/预算/资产卡片表结构
│   ├── seed_documents.sql  # 单据与预算演示数据（幂等）
│   ├── seed_demo.sql       # 台账演示数据
│   ├── migrate_asset_register.py         # 给 device_list.number 加唯一索引（幂等，含 --check）
│   ├── migrate_inventory_autoincrement.py # inventory.id 改 AUTO_INCREMENT（幂等，含 --check）
│   └── check_password_migration.py       # 复核账号 bcrypt 迁移进度（只读）
├── tests/
│   └── test_ledger.py      # 台账口径单元测试（纯逻辑，不连数据库）
├── requirements.txt        # 由 uv export 生成（勿手改），供非 uv 环境 pip 安装
└── .gitlab-ci.yml          # CI：ruff lint + pytest + 密钥扫描
```

## 数据库表

| 表名 | 说明 |
|------|------|
| `identified` | 用户账号表（username, password_bcrypt；`password` MD5 列仅历史兼容保留，登录不再使用） |
| `device_list` | 设备台账表（number, spec, type, department, name, sn, cpu, mem, disk, gpu）；`number` 上有唯一索引 `uk_number`，并发取号撞 1062 时由 `asset.py` 自动重取序号重试 |
| `inventory` | 资产主表（id AUTO_INCREMENT, number, department, site, type, datetime, status, tag, notice, attachment_urls） |
| `inventory_tmp` | 资产历史表（site 变更时自动备份） |
| `budgets` | 年度预算表（budget_year, device_type, budget_amount） |
| `purchase_orders` | 资产申请单据表（表名沿用 purchase_orders；order_no, order_date, device_type, spec, quantity, unit_price, amount, in_budget, pushed...） |
| `asset_cards` | 资产卡片表（card_no, order_id, card_month, asset_number, owner, department, receive_date, card_status） |

## 模块联动与数据流

三个业务模块共用一套台账，`device_list` + `inventory` 是唯一事实来源：

```
资产登记 asset.py ──写入──▶ device_list / inventory ◀──更新── 资产变更 inventory.py
                                     │                        （变更前备份到 inventory_tmp）
                                     │ 只读
                                     ▼
                          资产看板 order.py + ledger.py
                          （今年已采购 / 剩余库存 / 部门使用 / 预算）
                                     │ 下推
                                     ▼
                              asset_cards（绑定 asset_number）
```

- **资产登记**：台账唯一的新增入口，批量生成 `DZ/ZL` 编码并同时写入 `device_list` 与 `inventory`。
- **资产变更**：更新使用人、使用部门、状态、流转标签等，把变更前记录备份到 `inventory_tmp`，
  并在同一个事务里回写 `device_list.department / name`（后端 `/update` 内部完成，前端不再重复调用同步接口；
  `/sync_to_device_list` 仅保留为手工补偿入口）。提交前会校验资产编码与 `inventory.id` 是否指向同一条记录，
  避免「只存在于 device_list 的资产」带出的 `device_list.id` 与 `inventory.id` 同号时误改无关记录。
- **资产看板**：只读台账计算指标；下推时把台账资产绑定到 `asset_cards.asset_number`。
- **`app/ledger.py`**：口径常量（新机编码阈值、库存托管人、流转标签分组、`INVENTORY_STATUSES` 资产状态词表）
  与派生函数（`inventory_index` / `stock_count_until` / `purchased_count_until` / `card_state` / `live_card_fields`）的唯一归属，
  避免同一规则在多个蓝图里各写一份。
- **`app/common.py`**：登录检查（`login_required_api` / `login_required_page`）、连接生命周期与异常转 JSON
  （`with_db`）的跨蓝图统一实现，三个业务蓝图不再各写一份样板。
- **无手动同步**：`asset_cards` 中已绑定卡片的规格 / SN / 所属人 / 所属部门 / 领取时间 / 状态只是台账派生快照，
  统一在读取时刷新；未绑定（待分配）卡片的字段仍由人工维护。看板与变更模块之间因此不存在数据滞后。
- **权限分层**：未登录用户可只读查看看板与查询接口；单据增删改、下推 / 撤销下推、卡片编辑、预算维护均需登录
  （`/dashboard` 登录后即为管理视图，`/dashboard/admin` 强制跳转登录）。
- **词表下发**：资产状态 / 流转标签 / 部门 / 卡片状态 / 资产类型由后端 `app/meta.py` 从 `ledger` 组装，
  经 context processor 渲染进 `base.html` 的 `<script type="application/json" id="zcMeta">`（另有 `GET /api/meta`），
  `static/js/utils.js` 读取后导出 `STATUS_OPTIONS` / `TAG_OPTIONS` / `DEPARTMENTS`；内置常量仅作解析失败时的兜底。
  改词表只需改 `app/ledger.py`，前端自动跟随。

## 单据看板说明

- **单据编号**：`PO` + 年月 + 3 位流水（如 `PO2609001`），与台账编号 `DZ2609001` 的年月批次对齐。
- **预算剩余**：`budgets.budget_amount` − 当年该设备类型「预算内」单据金额合计；预算在页面上以「预算设置」维护（需登录）。
- **三个指标的口径（截至单据日期，含本单）**：单据列表与详情中的「预算剩余 / 今年已采购 / 剩余库存」
  都不是实时值，而是截至该单据 `order_date` 的历史口径，逐单累计、不随后续业务变化：
  - 预算剩余 = 年度预算 − 同类型同年度「预算内」单据中日期不晚于本单的金额合计（预算外单据不计入）；
  - 今年已采购 = 台账中该年度、编号年月码不晚于本单月份的设备数（`ledger.purchased_count_until`）；
  - 剩余库存 = 以不晚于本单日期的最后一条流转记录判断在库（入库/离职标签）的资产数（`ledger.stock_count_until`）。
  点击「今年已采购」下钻的部门使用情况与使用人明细同样携带 `until=YYMM`，与单据口径保持一致；
  「预算设置」面板展示的仍是当前年度的实时预算执行总览。
- **下推资产卡片 = 采购入库**：按单据数量生成**全新**台账编码并写入 `device_list` + `inventory`，再绑定到当月卡片。
  编码规则与「资产登记」一致：前缀（租聘台式主机 `ZL`，其余 `DZ`）+ 单据日期年月码 + 3 位流水（接续该月最大序号），
  因此 9 月的单据必然生成 `DZ2609xxx`；新资产统一挂在库存托管人 `IT/余嘉雄` 名下，流转标签「入库」、日期为下推当日，
  卡片默认显示 所属人=余嘉雄、所属部门=IT、领取时间=下推日期、状态=入库。
  下推不会复用/占用任何历史或在用资产；撤销下推会删除卡片并回滚这批入库记录（已被后续资产变更动过的资产保留）。
- **并发取号防重**：登记与下推都靠「查该月最大序号 + 1」取号，`device_list.number` 上的唯一索引 `uk_number`
  （`scripts/migrate_asset_register.py` 创建）会拦下并发产生的重复编码；冲突方回滚后重取序号重试
  `ledger.DUP_RETRY`（2）次，仍冲突则返回 409「资产编码冲突，请稍后重试」，不会静默写入重复台账。
- **卡片状态词表**：待分配 / 入库 / 已领用（`ledger.CARD_STATUSES`）；在库资产领取时间显示最近一次入库类流转日期。
- 单据的新增/编辑/删除、下推/撤销下推、卡片编辑、预算维护均需登录后操作（`/dashboard/admin`）。

初始化单据相关表与演示数据：

```bash
docker exec -i zcsystem-mysql mysql --default-character-set=utf8mb4 -uadmin -p"$DB_PASSWORD" db < scripts/init_documents.sql
docker exec -i zcsystem-mysql mysql --default-character-set=utf8mb4 -uadmin -p"$DB_PASSWORD" db < scripts/seed_documents.sql
```

## 环境配置

复制 `.env` 文件并填写实际值：

```env
DB_HOST=数据库地址
DB_USER=数据库用户名
DB_PASSWORD=数据库密码
DB_NAME=数据库名
S3_ENDPOINT=http://对象存储地址:9001
S3_ACCESS_KEY=访问密钥
S3_SECRET_KEY=秘密密钥
S3_EXTERNAL_URL=http://外部访问地址:9001
SECRET_KEY=Flask会话密钥

# 可选：不填则使用默认值
S3_BUCKET=zcsystem          # 附件存储桶名
SESSION_COOKIE_SECURE=0     # HTTPS 部署时设 1，禁止 cookie 走明文信道
PORT=5001
HOST=0.0.0.0
FLASK_DEBUG=0               # 默认关闭；开发机需要调试器/热重载时显式设 1
```

## 安装与运行

```bash
# 安装依赖（含 dev 组：pytest / ruff）
uv sync

# 启动开发服务器（调试模式需显式 FLASK_DEBUG=1）
FLASK_DEBUG=1 uv run python run.py
```

访问 `http://localhost:5001`。

质量检查：

```bash
uv run ruff check .    # lint
uv run pytest          # 单元测试（不连数据库）
```

`requirements.txt` 由 `uv export --no-hashes --no-dev --no-emit-project -o requirements.txt` 生成，
供非 uv 环境（如服务器 pip）安装使用；**勿手工编辑**，依赖变更请改 `pyproject.toml` 后重新导出。

默认端口是 **5001** 而不是 5000：macOS 的 5000 端口被系统「隔空播放接收器」（`ControlCenter`）占用，
直接监听 5000 会报 `Address already in use`。确需 5000 时，可在「系统设置 → 通用 → 隔空投送与接力」
关闭「隔空播放接收器」，然后 `PORT=5000 uv run python run.py`。

首次部署（或升级已有库）需要执行两个幂等迁移：

```bash
uv run python scripts/migrate_asset_register.py --check   # 只检查重复编码与索引状态
uv run python scripts/migrate_asset_register.py           # 加 uk_number 唯一索引
uv run python scripts/migrate_inventory_autoincrement.py  # inventory.id 改 AUTO_INCREMENT
```

前者会先列出重复编码并拒绝改表（重复数据需人工清理后重跑）；后者把历史上由应用层
`MAX(id)+1` 分配的 `inventory.id` 改为数据库原子分配，消除并发撞主键风险
（存量 `'0000-00-00'` 脏日期会在会话级放宽 sql_mode 后完成改表，并提示行数）。

生产环境可使用 Gunicorn：

```bash
uv run gunicorn -w 4 -b 0.0.0.0:5001 "app:create_app()"
```
