# 资产管理系统 (zcsystem)

基于 Flask 的企业资产管理系统，支持资产登记、变更追踪、VPN 记录管理和数据导出。

## 功能模块

- **用户认证** — 登录/登出，MD5 密码加密
- **资产登记** — 批量创建资产，自动生成编码（DZ/ZL 前缀），同时写入 `device_list` 和 `inventory` 表
- **资产变更与查询** — 支持按资产编码、SN码、使用人、使用部门、ID 查询；变更使用人时自动备份历史记录
- **实时数据预览** — 按资产状态（已录入/未录入/租聘/借用/入库/无需录入）分类展示
- **VPN 记录管理** — VPN 使用记录的增删改查
- **附件管理** — 基于 S3 兼容对象存储的文件上传
- **数据导出** — 导出 Excel 文件

## 技术栈

- **后端**: Flask, MySQL (mysql-connector-python)
- **前端**: 原生 HTML/CSS/JavaScript
- **对象存储**: S3 兼容存储 (boto3)
- **数据处理**: pandas + openpyxl
- **包管理**: uv

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
│   ├── vpn.py              # VPN 记录管理蓝图
│   └── utils.py            # 工具函数（MD5）
├── templates/
│   ├── login.html          # 登录页
│   ├── index.html          # 首页（资产变更与查询）
│   ├── asset_register.html # 资产登记页
│   └── vpn.html            # VPN 记录页
├── static/
│   ├── css/
│   ├── js/
```

## 数据库表

| 表名 | 说明 |
|------|------|
| `identified` | 用户账号表（username, MD5 password） |
| `device_list` | 设备台账表（number, spec, type, department, name, sn, cpu, mem, disk, gpu） |
| `inventory` | 资产主表（number, department, site, type, datetime, status, tag, notice, attachment_urls） |
| `inventory_tmp` | 资产历史表（site 变更时自动备份） |
| `vpn_record` | VPN 使用记录表 |

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
```

## 安装与运行

```bash
# 安装依赖
uv sync

# 启动开发服务器
uv run python run.py
```

访问 `http://localhost:5000`。

生产环境可使用 Gunicorn：

```bash
uv run gunicorn -w 4 -b 0.0.0.0:5000 "app:create_app()"
```
