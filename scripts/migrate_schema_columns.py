#!/usr/bin/env python3
"""旧库升级：检测/补齐缺失的列（幂等，只加列、不改类型、不动数据）。

背景：仓库里的 ``scripts/init_db.sql`` 是后来按代码反推的近似 schema，
对**已存在**的表执行 ``CREATE TABLE IF NOT EXISTS`` 不会补列。服务器上跨越
多个版本升级时，最典型的问题是老表缺列（例如 ``identified.password_bcrypt``、
``inventory.attachment_urls``），新代码一 SELECT 就直接 500。

本脚本以**当前生产库的列定义为准**，逐表比对：
- 缺列 → ``ALTER TABLE ... ADD COLUMN``（带安全默认值，存量行不会被卡）；
- 类型/可空性不一致 → 只告警，不自动改（改类型有数据风险，需人工确认）；
- 缺表 → 提示先执行 ``scripts/init_db.sql`` / ``scripts/init_documents.sql``。

用法（项目根目录）::

    uv run python scripts/migrate_schema_columns.py           # 检查 + 补列
    uv run python scripts/migrate_schema_columns.py --check    # 只检查，不改表

其它配套迁移见 README「首次部署（或升级已有库）」一节。
"""

import argparse
import os
import sys

import mysql.connector
from dotenv import load_dotenv
from mysql.connector import Error

load_dotenv()

# 表 -> 建表来源（缺表时提示）
TABLE_SOURCE = {
    'identified': 'scripts/init_db.sql',
    'device_list': 'scripts/init_db.sql',
    'inventory': 'scripts/init_db.sql',
    'inventory_tmp': 'scripts/init_db.sql',
    'budgets': 'scripts/init_documents.sql',
    'purchase_orders': 'scripts/init_documents.sql',
    'asset_cards': 'scripts/init_documents.sql',
}

# 表 -> {列: (类型, 是否可空, 默认值)}；以当前生产库为准
COLUMNS = {
    'identified': {
        'username': ('varchar(23)', True, None),
        'password': ('char(128)', True, None),
        'password_bcrypt': ('varchar(128)', True, "''"),
    },
    'device_list': {
        'type': ('varchar(255)', False, "''"),
        'number': ('varchar(255)', False, "''"),
        'spec': ('varchar(255)', False, "''"),
        'sn': ('varchar(128)', True, None),
        'department': ('varchar(128)', False, "''"),
        'name': ('varchar(20)', False, "''"),
        'cpu': ('varchar(30)', True, None),
        'mem': ('varchar(60)', True, None),
        'disk': ('varchar(30)', True, None),
        'gpu': ('varchar(30)', True, None),
    },
    'inventory': {
        'number': ('varchar(255)', False, "''"),
        'department': ('varchar(128)', False, "''"),
        'site': ('varchar(255)', False, "''"),
        'type': ('varchar(255)', False, "''"),
        'datetime': ('date', True, None),
        'status': ('varchar(20)', False, "''"),
        'tag': ('varchar(20)', False, "''"),
        'notice': ('varchar(128)', True, None),
        'attachment_urls': ('text', True, None),
    },
    'inventory_tmp': {
        'tmp_id': ('int', False, None),          # AUTO_INCREMENT 主键，见下
        'id': ('int', False, '0'),
        'number': ('varchar(255)', False, "''"),
        'department': ('varchar(128)', False, "''"),
        'site': ('varchar(255)', False, "''"),
        'type': ('varchar(255)', False, "''"),
        'datetime': ('date', True, None),
        'status': ('varchar(20)', False, "''"),
        'tag': ('varchar(20)', True, None),
        'notice': ('varchar(128)', True, None),
    },
    'budgets': {
        'budget_year': ('smallint', False, '0'),
        'device_type': ('varchar(64)', False, "''"),
        'budget_amount': ('decimal(14,2)', False, '0.00'),
        'used_adjust': ('decimal(14,2)', True, None),
        'remark': ('varchar(255)', False, "''"),
    },
    'purchase_orders': {
        'order_no': ('varchar(32)', False, "''"),
        'order_date': ('date', True, None),
        'device_type': ('varchar(64)', False, "''"),
        'spec': ('varchar(255)', False, "''"),
        'cpu': ('varchar(64)', False, "''"),
        'mem': ('varchar(64)', False, "''"),
        'disk': ('varchar(64)', False, "''"),
        'gpu': ('varchar(64)', False, "''"),
        'quantity': ('int', False, '0'),
        'unit_price': ('decimal(12,2)', False, '0.00'),
        'amount': ('decimal(14,2)', False, '0.00'),
        'in_budget': ('tinyint(1)', False, '1'),
        'supplier': ('varchar(128)', False, "''"),
        'remark': ('varchar(255)', False, "''"),
        'pushed': ('tinyint(1)', False, '0'),
        'reviewed': ('tinyint(1)', False, '0'),
        'push_month': ('char(7)', False, "''"),
        'pushed_at': ('datetime', True, None),
        'created_by': ('varchar(64)', False, "''"),
    },
    'asset_cards': {
        'card_no': ('varchar(40)', False, "''"),
        'order_id': ('int', False, '0'),
        'order_no': ('varchar(32)', False, "''"),
        'card_month': ('char(7)', False, "''"),
        'asset_number': ('varchar(32)', False, "''"),
        'device_type': ('varchar(64)', False, "''"),
        'spec': ('varchar(255)', False, "''"),
        'sn': ('varchar(128)', False, "''"),
        'owner': ('varchar(64)', False, "''"),
        'department': ('varchar(64)', False, "''"),
        'receive_date': ('date', True, None),
        'card_status': ('varchar(20)', False, "'待分配'"),
    },
}

AUTO_INCREMENT_PK = {('inventory_tmp', 'tmp_id')}


def connect():
    return mysql.connector.connect(
        host=os.environ['DB_HOST'],
        user=os.environ['DB_USER'],
        password=os.environ['DB_PASSWORD'],
        database=os.environ['DB_NAME'],
        charset='utf8mb4',
    )


def table_exists(cursor, table):
    cursor.execute(
        "SELECT COUNT(*) AS cnt FROM information_schema.tables "
        "WHERE table_schema = DATABASE() AND table_name = %s",
        (table,)
    )
    return int(cursor.fetchone()['cnt']) > 0


def primary_key_exists(cursor, table):
    cursor.execute(
        "SELECT COUNT(*) AS cnt FROM information_schema.statistics "
        "WHERE table_schema = DATABASE() AND table_name = %s AND index_name = 'PRIMARY'",
        (table,)
    )
    return int(cursor.fetchone()['cnt']) > 0


def existing_columns(cursor, table):
    cursor.execute(
        "SELECT column_name AS name, column_type AS col_type, is_nullable AS nullable "
        "FROM information_schema.columns "
        "WHERE table_schema = DATABASE() AND table_name = %s",
        (table,)
    )
    return {r['name']: r for r in cursor.fetchall()}


def plan_columns(table, present, required, has_pk=False):
    """比对单表列结构，返回 (adds, warnings)。

    adds:     [(列名, ADD COLUMN 的完整定义)]，按需补列；
    warnings: 需人工确认的差异（类型不符 / 主键列缺失但表已有主键）。

    present 形如 {列名: {'col_type': 'varchar(64)', 'nullable': 'YES'}}；
    纯函数，便于单测（见 tests/test_schema_columns.py）。
    """
    adds, warnings = [], []
    for column, (ctype, nullable, default) in required.items():
        if column in present:
            cur_type = present[column]['col_type'].lower()
            if cur_type != ctype.lower():
                warnings.append(
                    f'{table}.{column}：库中 {cur_type} / 预期 {ctype}（未自动修改，请人工确认）')
            continue
        is_pk = (table, column) in AUTO_INCREMENT_PK
        if is_pk and has_pk:
            warnings.append(
                f'{table}.{column} 缺失，但该表已有主键 —— 需人工处理（本脚本不自动加主键列）')
            continue
        adds.append((column, add_definition(ctype, nullable, default, is_pk)))
    return adds, warnings


def add_definition(column_type, nullable, default, with_pk):
    if with_pk:
        return 'INT NOT NULL AUTO_INCREMENT PRIMARY KEY'
    parts = [column_type.upper() if column_type in ('date', 'int', 'smallint', 'datetime', 'text')
             else column_type]
    parts.append('NULL' if nullable else 'NOT NULL')
    if default is not None:
        parts.append(f'DEFAULT {default}')
    return ' '.join(parts)


def main():
    parser = argparse.ArgumentParser(description='旧库升级：补缺失的列')
    parser.add_argument('--check', action='store_true', help='只检查，不改表')
    args = parser.parse_args()

    cursor = None
    conn = None
    missing_tables = []
    added = []
    mismatches = []
    try:
        conn = connect()
        cursor = conn.cursor(dictionary=True)

        for table, columns in COLUMNS.items():
            if not table_exists(cursor, table):
                missing_tables.append(table)
                continue
            present = existing_columns(cursor, table)
            adds, warnings = plan_columns(table, present, columns, has_pk=primary_key_exists(cursor, table))
            mismatches.extend(warnings)
            for column, ddl in adds:
                if args.check:
                    print(f'缺列：{table}.{column} {ddl}')
                    added.append(f'{table}.{column}')
                    continue
                cursor.execute(f'ALTER TABLE {table} ADD COLUMN {column} {ddl}')
                print(f'已补列：{table}.{column} {ddl}')
                added.append(f'{table}.{column}')

        if not args.check:
            conn.commit()

        print()
        if missing_tables:
            print('缺表（请先执行对应 SQL 建表）：')
            for t in missing_tables:
                print(f'  {t}  <- {TABLE_SOURCE.get(t, "?")}')
        if mismatches:
            print('需人工确认的差异（未自动修改）：')
            for m in mismatches:
                print(f'  {m}')
        if not missing_tables and not mismatches:
            print('列结构一致，无需迁移')
        if args.check and (added or missing_tables or mismatches):
            sys.exit(1)
    except Error as exc:
        print(f'迁移失败：{exc}', file=sys.stderr)
        sys.exit(1)
    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()


if __name__ == '__main__':
    main()
