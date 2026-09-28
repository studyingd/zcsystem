"""migrate_schema_columns 的纯逻辑单测（不连数据库）。

重点覆盖「旧服务器升级」场景：老表缺列时生成正确的 ADD COLUMN；
类型不符只告警；主键列缺失不自动补。
"""

from scripts import migrate_schema_columns as msc


def present(cols):
    """构造 existing_columns 的返回结构：{列名: {'col_type', 'nullable'}}。"""
    return {name: {'col_type': ctype, 'nullable': nullable} for name, ctype, nullable in cols}


def test_add_definition_shapes():
    assert msc.add_definition('int', False, None, True) == 'INT NOT NULL AUTO_INCREMENT PRIMARY KEY'
    # 补列必须带默认值，否则存量行在严格模式下会被卡住
    assert msc.add_definition('varchar(128)', True, "''", False) == "varchar(128) NULL DEFAULT ''"
    assert msc.add_definition('tinyint(1)', False, '0', False) == 'tinyint(1) NOT NULL DEFAULT 0'
    assert msc.add_definition('text', True, None, False) == 'TEXT NULL'


def test_plan_columns_all_present():
    adds, warnings = msc.plan_columns(
        'identified',
        present([('id', 'int', 'NO'), ('username', 'varchar(23)', 'YES'),
                 ('password', 'char(128)', 'YES'), ('password_bcrypt', 'varchar(128)', 'YES')]),
        msc.COLUMNS['identified'],
    )
    assert adds == [] and warnings == []


def test_plan_columns_old_server_gap():
    """模拟旧服务器：identified 缺 password_bcrypt / device_list 缺硬件配置列 / inventory 缺 attachment_urls。"""
    adds, warnings = msc.plan_columns(
        'identified',
        present([('id', 'int', 'NO'), ('username', 'varchar(23)', 'YES'), ('password', 'char(128)', 'YES')]),
        msc.COLUMNS['identified'],
    )
    assert [a[0] for a in adds] == ['password_bcrypt']
    assert warnings == []

    old_device = present([
        ('id', 'int', 'NO'), ('type', 'varchar(255)', 'NO'), ('number', 'varchar(255)', 'NO'),
        ('spec', 'varchar(255)', 'NO'), ('sn', 'varchar(128)', 'YES'),
        ('department', 'varchar(128)', 'NO'), ('name', 'varchar(20)', 'NO'),
    ])
    adds, warnings = msc.plan_columns('device_list', old_device, msc.COLUMNS['device_list'])
    assert [a[0] for a in adds] == ['cpu', 'mem', 'disk', 'gpu']
    assert warnings == []

    old_inventory = present([
        ('id', 'int', 'NO'), ('number', 'varchar(255)', 'NO'), ('department', 'varchar(128)', 'NO'),
        ('site', 'varchar(255)', 'NO'), ('type', 'varchar(255)', 'NO'), ('datetime', 'date', 'NO'),
        ('status', 'varchar(20)', 'NO'), ('tag', 'varchar(20)', 'NO'), ('notice', 'varchar(128)', 'YES'),
    ])
    adds, warnings = msc.plan_columns('inventory', old_inventory, msc.COLUMNS['inventory'])
    assert [a[0] for a in adds] == ['attachment_urls']
    assert warnings == []


def test_plan_columns_type_mismatch_warns_only():
    adds, warnings = msc.plan_columns(
        'device_list',
        present([('name', 'varchar(64)', 'NO')]),
        {'name': ('varchar(20)', False, "''")},
    )
    assert adds == []
    assert len(warnings) == 1 and 'varchar(64)' in warnings[0]


def test_plan_columns_pk_missing_not_auto_added():
    adds, warnings = msc.plan_columns(
        'inventory_tmp',
        present([('id', 'int', 'NO')]),
        msc.COLUMNS['inventory_tmp'],
        has_pk=True,
    )
    assert all(a[0] != 'tmp_id' for a in adds)
    assert any('tmp_id' in w for w in warnings)


def test_required_tables_cover_all_seven():
    """升级时不能漏表：README「数据库表」列出的 7 张表都要在脚本覆盖范围内。"""
    assert set(msc.COLUMNS) == {
        'identified', 'device_list', 'inventory', 'inventory_tmp',
        'budgets', 'purchase_orders', 'asset_cards',
    }
    assert set(msc.TABLE_SOURCE) == set(msc.COLUMNS)
