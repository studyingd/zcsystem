-- zcsystem 数据库初始化脚本（建新库用；幂等，重复执行不报错）
-- 全部表统一 charset=utf8mb4 / collate=utf8mb4_unicode_ci：
-- 跨表 JOIN（如台账与流转表按 number 关联）要求排序规则一致。
-- 老库若存在混杂排序规则，用 scripts/migrate_unify_collation.py 统一。
-- 用法: mysql --default-character-set=utf8mb4 -u<user> -p <库名> < scripts/init_db.sql

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 资产主表：id 为自增主键（存量库用 scripts/migrate_inventory_autoincrement.py 迁移，
-- 历史上由应用层 MAX(id)+1 分配，并发会撞主键，已废弃）
CREATE TABLE IF NOT EXISTS inventory (
  id              INT AUTO_INCREMENT PRIMARY KEY,
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
