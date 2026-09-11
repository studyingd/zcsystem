#!/usr/bin/env python3
"""把 inventory.id 改为 AUTO_INCREMENT（消除应用层 MAX(id)+1 取号的并发撞键）。

背景：inventory.id 历史上由应用层 ``SELECT MAX(id)+1`` 分配，两个并发请求会
拿到同一个 id，后写的一方直接撞主键失败。改为 AUTO_INCREMENT 后由 MySQL 原子
分配，代码侧（ledger.insert_ledger_assets / inventory.py）已同步去掉手工取号。

用法（项目根目录）::

    uv run python scripts/migrate_inventory_autoincrement.py            # 检查 + 改表
    uv run python scripts/migrate_inventory_autoincrement.py --check    # 只检查，不改表

脚本是幂等的：列已经是 AUTO_INCREMENT 时直接跳过。

注意：存量 inventory.datetime 可能有 '0000-00-00' 脏数据，严格模式下 ALTER
重建表会报 1292。脚本会在会话级临时放宽 sql_mode 完成改表（不影响其它
连接），并提示脏数据行数供后续治理。
"""

import argparse
import os
import sys

import mysql.connector
from dotenv import load_dotenv
from mysql.connector import Error

load_dotenv()

TABLE = 'inventory'
COLUMN = 'id'
# 与现有列定义保持一致（见 scripts/init_db.sql）
COLUMN_DEFINITION = 'INT NOT NULL AUTO_INCREMENT'


def connect():
    return mysql.connector.connect(
        host=os.environ['DB_HOST'],
        user=os.environ['DB_USER'],
        password=os.environ['DB_PASSWORD'],
        database=os.environ['DB_NAME'],
        charset='utf8mb4',
    )


def column_extra(cursor):
    cursor.execute(
        "SELECT EXTRA FROM information_schema.COLUMNS "
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s AND COLUMN_NAME = %s",
        (TABLE, COLUMN)
    )
    row = cursor.fetchone()
    if row is None:
        raise SystemExit(f'表 {TABLE} 不存在列 {COLUMN}，请先执行 scripts/init_db.sql')
    return (row[0] or '').lower()


def zero_date_count(cursor):
    """datetime 为 '0000-00-00' 的脏数据行数（严格模式下会阻碍 ALTER）。"""
    cursor.execute(
        "SELECT COUNT(*) FROM inventory WHERE CAST(datetime AS CHAR) = '0000-00-00'"
    )
    return int(cursor.fetchone()[0])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='只检查，不改表')
    args = parser.parse_args()

    conn = None
    cursor = None
    try:
        conn = connect()
        cursor = conn.cursor()
        extra = column_extra(cursor)

        if 'auto_increment' in extra:
            print(f'[OK] {TABLE}.{COLUMN} 已经是 AUTO_INCREMENT，无需迁移')
            return 0

        print(f'[..] {TABLE}.{COLUMN} 当前 EXTRA={extra!r}，需要迁移')
        if args.check:
            print('[--check] 未做任何修改')
            return 1

        # 主键已存在（id 为 PRIMARY KEY），直接 MODIFY 即可；
        # MySQL 会自动把 AUTO_INCREMENT 计数器设为 MAX(id)+1。
        # 存量 '0000-00-00' 脏日期在严格模式下会让重建表失败（1292），
        # 会话级临时放宽 sql_mode（仅影响本连接）。
        dirty = zero_date_count(cursor)
        if dirty:
            print(f'[!!] 发现 {dirty} 行 datetime=\'0000-00-00\' 脏数据，改表时会话级放宽 sql_mode')
            cursor.execute("SELECT @@SESSION.sql_mode")
            original_mode = cursor.fetchone()[0]
            relaxed = ','.join(m for m in original_mode.split(',')
                                if m.strip() not in ('STRICT_TRANS_TABLES', 'STRICT_ALL_TABLES',
                                                     'NO_ZERO_DATE', 'NO_ZERO_IN_DATE'))
            cursor.execute(f"SET SESSION sql_mode = '{relaxed}'")
        cursor.execute(f'ALTER TABLE {TABLE} MODIFY {COLUMN} {COLUMN_DEFINITION}')
        conn.commit()
        print(f'[OK] {TABLE}.{COLUMN} 已改为 AUTO_INCREMENT')

        cursor.execute(f'SELECT MAX({COLUMN}) FROM {TABLE}')
        max_id = cursor.fetchone()[0]
        print(f'[OK] 当前最大 id = {max_id}，后续插入将从 {max_id + 1} 开始' if max_id
              else '[OK] 表为空，后续插入将从 1 开始')
        return 0
    except Error as e:
        print(f'[FAIL] 数据库错误: {e}', file=sys.stderr)
        return 2
    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()


if __name__ == '__main__':
    sys.exit(main())
