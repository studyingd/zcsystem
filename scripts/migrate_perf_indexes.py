#!/usr/bin/env python3
"""补齐台账/流转表的索引（性能优化，幂等、不改数据）。

背景：现网库建于 scripts/init_db.sql 之前，只有主键 —— init_db.sql 里声明的
idx_number / idx_type / idx_tag / idx_status / idx_datetime / idx_dept_name 等
全部缺失。数据量小时无感，增长后所有按 number / type / tag 过滤的读取都会全表扫描：
- ledger.inventory_index / latest_inventory_rows / 卡片实时字段：WHERE number IN (...)
- ledger.stock_count_until：WHERE type=? AND datetime<=?
- 部门领用总览 / 流转月份：WHERE tag IN (...) AND datetime IS NOT NULL
- 单据 meta：device_list GROUP BY type；资产变更查询：device_list.department/name

用法（项目根目录）::

    uv run python scripts/migrate_perf_indexes.py           # 检查 + 建索引
    uv run python scripts/migrate_perf_indexes.py --check    # 只检查，不改表
"""

import argparse
import os
import sys

import mysql.connector
from dotenv import load_dotenv
from mysql.connector import Error

load_dotenv()

# 复合索引覆盖单列索引的最左前缀，故 number/type/tag 只建复合版
INDEXES = (
    ('inventory', 'idx_number_datetime', '(number, datetime)'),
    ('inventory', 'idx_type_datetime', '(type, datetime)'),
    ('inventory', 'idx_tag_datetime', '(tag, datetime)'),
    ('inventory', 'idx_datetime', '(datetime)'),
    ('inventory', 'idx_status', '(status)'),
    ('inventory_tmp', 'idx_number', '(number)'),
    ('inventory_tmp', 'idx_id', '(id)'),
    ('device_list', 'idx_type', '(type)'),
    ('device_list', 'idx_dept_name', '(department, name)'),
)


def connect():
    return mysql.connector.connect(
        host=os.environ['DB_HOST'],
        user=os.environ['DB_USER'],
        password=os.environ['DB_PASSWORD'],
        database=os.environ['DB_NAME'],
        charset='utf8mb4',
    )


def index_exists(cursor, table, index_name):
    cursor.execute(
        "SELECT COUNT(*) AS cnt FROM information_schema.statistics "
        "WHERE table_schema = DATABASE() AND table_name = %s AND index_name = %s",
        (table, index_name)
    )
    return int(cursor.fetchone()['cnt']) > 0


def main():
    parser = argparse.ArgumentParser(description='补齐查询热点索引')
    parser.add_argument('--check', action='store_true', help='只检查，不改表')
    args = parser.parse_args()

    cursor = None
    conn = None
    try:
        conn = connect()
        cursor = conn.cursor(dictionary=True)
        missing = [
            (table, name, cols) for table, name, cols in INDEXES
            if not index_exists(cursor, table, name)
        ]
        if not missing:
            print('索引已齐全，无需迁移')
            return
        for table, name, cols in missing:
            print(f'缺索引：{table}.{name} {cols}')
        if args.check:
            print('（--check 模式未修改）')
            sys.exit(1)
        for table, name, cols in missing:
            cursor.execute(f'CREATE INDEX {name} ON {table} {cols}')
            print(f'已创建 {table}.{name} {cols}')
        conn.commit()
        print('迁移完成')
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
