-- zcsystem 资产看板"单据视图"所需表结构
-- 设计说明：
--   1. 仓库原有表（device_list / inventory）里没有任何金额、预算、单据信息，
--      因此单据（purchase_orders）、年度预算（budgets）、资产卡片（asset_cards）三张表为新增。
--   2. 单据编号规则 PO + yymm + 3 位流水（如 PO2609001），与台账编号 DZ2609001 的 yymm 批次对齐，
--      这样"下推资产卡片"时可以从 device_list 里按同批次自动挑选真实资产。
--   3. 排序规则统一用 utf8mb4_unicode_ci，与 init_db.sql 的全部表一致（跨表 JOIN 要求一致）。
-- 用法: docker exec -i zcsystem-mysql mysql --default-character-set=utf8mb4 -uadmin -p"$DB_PASSWORD" db < scripts/init_documents.sql

SET NAMES utf8mb4;

-- 年度预算：按 年度 + 设备类型 配置预算总额，用于计算"预算剩余情况"
-- used_adjust：已用手动修正量；已用 = 当年「预算内」单据金额自动统计 + 该值（NULL = 纯自动统计）。
-- 设置后新创建的单据仍会自动累加，修正量持续生效；可为负（自动统计多算时拉低）
CREATE TABLE IF NOT EXISTS budgets (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  budget_year   SMALLINT      NOT NULL,
  device_type   VARCHAR(64)   NOT NULL,
  budget_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  used_adjust   DECIMAL(14,2) NULL DEFAULT NULL,
  remark        VARCHAR(255)  NOT NULL DEFAULT '',
  updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_year_type (budget_year, device_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 采购单据：资产看板的主视图数据源
CREATE TABLE IF NOT EXISTS purchase_orders (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  order_no    VARCHAR(32)   NOT NULL,              -- 单据编号 PO2609001
  order_date  DATE          NOT NULL,              -- 单据日期
  device_type VARCHAR(64)   NOT NULL,              -- 设备类型
  spec        VARCHAR(255)  NOT NULL DEFAULT '',   -- 规格型号
  cpu         VARCHAR(64)   NOT NULL DEFAULT '',   -- 硬件配置：CPU（电脑类必填）
  mem         VARCHAR(64)   NOT NULL DEFAULT '',   -- 内存
  disk        VARCHAR(64)   NOT NULL DEFAULT '',   -- 硬盘
  gpu         VARCHAR(64)   NOT NULL DEFAULT '',   -- 显卡
  quantity    INT           NOT NULL DEFAULT 0,    -- 设备数量
  unit_price  DECIMAL(12,2) NOT NULL DEFAULT 0.00, -- 单价
  amount      DECIMAL(14,2) NOT NULL DEFAULT 0.00, -- 金额（默认 = 单价 * 数量）
  in_budget   TINYINT(1)    NOT NULL DEFAULT 1,    -- 1=预算内 0=预算外
  apply_quantity INT        NULL DEFAULT NULL,     -- 已废弃：申请数量改为实时读取飞书，仅保留历史数据
  supplier    VARCHAR(128)  NOT NULL DEFAULT '',   -- 供应商
  remark      VARCHAR(255)  NOT NULL DEFAULT '',
  pushed      TINYINT(1)    NOT NULL DEFAULT 0,    -- 是否已下推资产卡片
  reviewed    TINYINT(1)    NOT NULL DEFAULT 0,    -- 审核状态：0 未审核 / 1 已审核
  push_month  CHAR(7)       NOT NULL DEFAULT '',   -- 下推生成的卡片所属月份 YYYY-MM
  pushed_at   DATETIME      NULL,
  created_by  VARCHAR(64)   NOT NULL DEFAULT '',
  created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_order_no (order_no),
  KEY idx_order_date (order_date),
  KEY idx_device_type (device_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 资产卡片：由单据"下推"生成，一张卡片对应一台设备
CREATE TABLE IF NOT EXISTS asset_cards (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  card_no      VARCHAR(40)  NOT NULL,              -- 卡片编号 = 单据编号-序号，如 PO2609001-01
  order_id     INT          NOT NULL,
  order_no     VARCHAR(32)  NOT NULL,
  card_month   CHAR(7)      NOT NULL,              -- 卡片所属月份（下推当月）YYYY-MM
  asset_number VARCHAR(32)  NOT NULL DEFAULT '',   -- 关联台账资产编码，未分配时为空
  device_type  VARCHAR(64)  NOT NULL DEFAULT '',
  spec         VARCHAR(255) NOT NULL DEFAULT '',
  sn           VARCHAR(128) NOT NULL DEFAULT '',
  owner        VARCHAR(64)  NOT NULL DEFAULT '',   -- 所属人
  department   VARCHAR(64)  NOT NULL DEFAULT '',   -- 所属部门
  receive_date DATE         NULL,                  -- 领取时间
  card_status  VARCHAR(20)  NOT NULL DEFAULT '待分配', -- 待分配/在库/已领用
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_card_no (card_no),
  KEY idx_order_id (order_id),
  KEY idx_card_month (card_month),
  KEY idx_asset_number (asset_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
