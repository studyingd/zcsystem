-- 本地演示数据（可随时 TRUNCATE 清空），仅用于让页面/看板有内容可看
SET NAMES utf8mb4;

-- 登录账号: admin / admin123  (password 为 MD5，首次登录成功后应用会自动写入 password_bcrypt)
INSERT INTO identified (username, password, password_bcrypt)
VALUES ('admin', '0192023a7bbd73250516f069df18b500', '')
ON DUPLICATE KEY UPDATE password = VALUES(password);

-- 台账：IT/余嘉雄 名下为"库存"保管人（与 app/dashboard.py 的常量一致）
INSERT INTO device_list (number, spec, type, department, name, sn, cpu, mem, disk, gpu) VALUES
('DZ2601001', 'ThinkPad T14', '笔记本电脑', 'IT', '余嘉雄', 'SN-T14-0001', 'i5-1340P', '16G', '512G', ''),
('DZ2601002', 'ThinkPad T14', '笔记本电脑', 'IT', '余嘉雄', 'SN-T14-0002', 'i5-1340P', '16G', '512G', ''),
('DZ2601003', 'Dell U2723QE',  '显示器',     'IT', '余嘉雄', 'SN-U27-0003', '', '', '', ''),
('DZ2602001', 'Dell OptiPlex', '台式主机',   'IT', '余嘉雄', 'SN-OP-0001',  'i7-14700', '32G', '1T', ''),
('ZL2602001', '租用台式机',    '租聘台式主机','IT','余嘉雄', 'SN-Rental-1', 'i5-12400', '16G', '512G', ''),
('DZ2401001', 'ThinkPad X1',   '笔记本电脑', '研发部', '张三', 'SN-X1-0001', 'i7-1165G7', '16G', '1T', ''),
('DZ2402001', 'Dell P2419H',   '显示器',     '研发部', '李四', 'SN-P24-0001', '', '', '', '');

-- 资产主表（datetime 落在 2026-01 ~ 2026-03，方便看板按区间统计）
INSERT INTO inventory (id, number, department, site, type, datetime, status, tag, notice, attachment_urls) VALUES
(1, 'DZ2601001', 'IT',     '余嘉雄', '笔记本电脑',  '2026-01-05', '入库',   '入库', '', ''),
(2, 'DZ2601002', 'IT',     '余嘉雄', '笔记本电脑',  '2026-01-05', '入库',   '入库', '', ''),
(3, 'DZ2601003', 'IT',     '余嘉雄', '显示器',      '2026-01-08', '入库',   '入库', '', ''),
(4, 'DZ2602001', 'IT',     '余嘉雄', '台式主机',    '2026-02-10', '入库',   '入库', '', ''),
(5, 'ZL2602001', 'IT',     '余嘉雄', '租聘台式主机','2026-02-10', '租聘',   '入库', '', ''),
(6, 'DZ2601004', '研发部', '王五',   '笔记本电脑',  '2026-02-18', '已录入', '入职', '新员工入职领用', ''),
(7, 'DZ2601005', '研发部', '赵六',   '显示器',      '2026-03-02', '已录入', '领用', '', ''),
(8, 'DZ2401001', '研发部', '10A上机房', '笔记本电脑', '2024-01-15', '入库', '入库', '旧机在库', ''),
(9, 'DZ2402001', '研发部', '10A下机房', '显示器',     '2024-02-20', '入库', '入库', '旧机在库', '');

-- 历史记录示例
INSERT INTO inventory_tmp (id, number, department, site, type, datetime, status, tag, notice) VALUES
(6, 'DZ2601004', 'IT', '余嘉雄', '笔记本电脑', '2026-01-05', '已录入', '入库', '');
