-- 单据视图演示数据：年度预算 + 采购单据
-- 数量与 device_list 中真实的编号批次（DZ/ZL + yymm + 流水）一一对应，
-- 因此"下推资产卡片"能直接关联到真实台账资产，并带出所属人/所属部门/领取时间。
-- 幂等：重复执行只会更新，不会产生重复单据。
-- 清理演示数据:
--   DELETE FROM asset_cards; DELETE FROM purchase_orders; DELETE FROM budgets;
-- 用法: docker exec -i zcsystem-mysql mysql --default-character-set=utf8mb4 -uadmin -p"$DB_PASSWORD" db < scripts/seed_documents.sql

SET NAMES utf8mb4;

-- 2026 年度预算（预算剩余 = 预算金额 - 当年该类型"预算内"单据金额合计）
INSERT INTO budgets (budget_year, device_type, budget_amount, remark) VALUES
(2026, '笔记本电脑',   500000.00, '演示数据'),
(2026, '显示器',       200000.00, '演示数据'),
(2026, '台式主机',      60000.00, '演示数据'),
(2026, '租聘台式主机',  30000.00, '演示数据'),
(2026, '平板电脑',      50000.00, '演示数据')
ON DUPLICATE KEY UPDATE budget_amount = VALUES(budget_amount), remark = VALUES(remark);

-- 采购单据（均未下推，可在页面上点击单据编号后执行"下推资产卡片"）
INSERT INTO purchase_orders
(order_no, order_date, device_type, spec, quantity, unit_price, amount, in_budget, supplier, remark, created_by) VALUES
('PO2605001', '2026-05-08', '显示器',       'AOC27英寸显示器4K U27P10',              50, 1650.00,  82500.00, 1, '深圳视界科技',   '演示数据', 'seed'),
('PO2605002', '2026-05-08', '笔记本电脑',   '联想ThinkBook16+ Ultra5-225H 32G 1T',   40, 6200.00, 248000.00, 1, '联想华南代理',   '演示数据', 'seed'),
('PO2605003', '2026-05-20', '平板电脑',     'iPad 10代 64G',                         24, 2300.00,  55200.00, 0, '苹果授权经销商', '演示数据（预算外）', 'seed'),
('PO2606001', '2026-06-10', '显示器',       'AOC27英寸显示器4K U27P10',              20, 1650.00,  33000.00, 1, '深圳视界科技',   '演示数据', 'seed'),
('PO2606002', '2026-06-15', '租聘台式主机', '租用台式机 i5-12400 16G 512G',           9,  450.00,   4050.00, 1, '易租办公设备',   '演示数据（月租）', 'seed'),
('PO2607001', '2026-07-06', '笔记本电脑',   '联想ThinkBook16+ Ultra5-225H 32G 1T',   22, 6500.00, 143000.00, 1, '联想华南代理',   '演示数据', 'seed'),
('PO2607002', '2026-07-06', '显示器',       'AOC27英寸显示器4K U27P10',              20, 1650.00,  33000.00, 1, '深圳视界科技',   '演示数据', 'seed'),
('PO2608001', '2026-08-11', '显示器',       'AOC27英寸显示器4K U27P10',              20, 1680.00,  33600.00, 1, '深圳视界科技',   '演示数据', 'seed'),
('PO2609001', '2026-09-03', '笔记本电脑',   '联想ThinkBook16+ Ultra5-225H 32G 1T',   10, 6800.00,  68000.00, 1, '联想华南代理',   '演示数据（可下推）', 'seed'),
('PO2609002', '2026-09-05', '台式主机',     'Dell OptiPlex i7-14700 32G 1T',          4, 5200.00,  20800.00, 0, '戴尔直销',       '演示数据（预算外）', 'seed')
ON DUPLICATE KEY UPDATE
  order_date = VALUES(order_date), device_type = VALUES(device_type), spec = VALUES(spec),
  quantity = VALUES(quantity), unit_price = VALUES(unit_price), amount = VALUES(amount),
  in_budget = VALUES(in_budget), supplier = VALUES(supplier), remark = VALUES(remark);
