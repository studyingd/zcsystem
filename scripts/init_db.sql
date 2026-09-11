-- zcsystem 本地开发数据库初始化脚本
-- 表结构由 app/ 下的 SQL 语句反推得到（仓库原本没有 schema 文件）
-- 各表排序规则与生产库实测一致，注意是"混合"的：
--   device_list -> utf8mb4_0900_ai_ci
--   identified / inventory / inventory_tmp -> utf8mb4_unicode_ci
-- 这正是 app/order.py 里跨表比较必须写 CONVERT(... USING utf8mb4) COLLATE ... 的原因，
-- 若统一成同一种排序规则，该问题会被掩盖，本地就复现不出生产行为了。
-- 用法: docker exec -i zcsystem-mysql mysql -uadmin -p"$DB_PASSWORD" db < scripts/init_db.sql

SET NAMES utf8mb4;

-- 用户账号表：password 为历史 MD5，password_bcrypt 为登录成功后自动迁移的哈希
CREATE TABLE IF NOT EXISTS identified (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  username        VARCHAR(64)  NOT NULL,
  password        CHAR(32)     NOT NULL DEFAULT '',
  password_bcrypt VARCHAR(100) NOT NULL DEFAULT '',
  UNIQUE KEY uk_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 设备台账表：name 字段存"使用人"，资产编码 number 形如 DZ2603001 / ZL2603001
-- number 必须唯一：编码由「该月最大序号 + 1」取号（ledger.next_asset_numbers），
-- 登记与单据下推并发时靠唯一索引兜底，冲突方由 asset.py 重取序号重试。
-- 已有库请用 scripts/migrate_asset_register.py 迁移（会先检查重复编码）。
CREATE TABLE IF NOT EXISTS device_list (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  number     VARCHAR(32)  NOT NULL DEFAULT '',
  spec       VARCHAR(255) NOT NULL DEFAULT '',
  type       VARCHAR(64)  NOT NULL DEFAULT '',
  department VARCHAR(64)  NOT NULL DEFAULT '',
  name       VARCHAR(64)  NOT NULL DEFAULT '',
  sn         VARCHAR(64)  NOT NULL DEFAULT '',
  cpu        VARCHAR(64)  NOT NULL DEFAULT '',
  mem        VARCHAR(64)  NOT NULL DEFAULT '',
  disk       VARCHAR(64)  NOT NULL DEFAULT '',
  gpu        VARCHAR(64)  NOT NULL DEFAULT '',
  UNIQUE KEY uk_number (number),
  KEY idx_type (type),
  KEY idx_dept_name (department, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 资产主表：id 由应用层 MAX(id)+1 分配，因此不是 AUTO_INCREMENT
CREATE TABLE IF NOT EXISTS inventory (
  id              INT PRIMARY KEY,
  number          VARCHAR(32)  NOT NULL DEFAULT '',
  department      VARCHAR(64)  NOT NULL DEFAULT '',
  site            VARCHAR(64)  NOT NULL DEFAULT '',
  type            VARCHAR(64)  NOT NULL DEFAULT '',
  datetime        DATE         NULL,
  status          VARCHAR(16)  NOT NULL DEFAULT '',
  tag             VARCHAR(16)  NOT NULL DEFAULT '',
  notice          VARCHAR(255) NOT NULL DEFAULT '',
  attachment_urls TEXT         NULL,
  KEY idx_number (number),
  KEY idx_datetime (datetime),
  KEY idx_type (type),
  KEY idx_status (status),
  KEY idx_tag (tag)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 资产历史表：site(使用人) 变更时自动备份，tmp_id 为自增主键，id 指向 inventory.id
CREATE TABLE IF NOT EXISTS inventory_tmp (
  tmp_id     INT AUTO_INCREMENT PRIMARY KEY,
  id         INT          NOT NULL DEFAULT 0,
  number     VARCHAR(32)  NOT NULL DEFAULT '',
  department VARCHAR(64)  NOT NULL DEFAULT '',
  site       VARCHAR(64)  NOT NULL DEFAULT '',
  type       VARCHAR(64)  NOT NULL DEFAULT '',
  datetime   DATE         NULL,
  status     VARCHAR(16)  NOT NULL DEFAULT '',
  tag        VARCHAR(16)  NOT NULL DEFAULT '',
  notice     VARCHAR(255) NOT NULL DEFAULT '',
  KEY idx_id (id),
  KEY idx_number (number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
