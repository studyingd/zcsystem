#!/usr/bin/env python3
"""给 device_list.number 加唯一索引（资产编码并发防重）。

背景：台账编码由「查该月最大序号 + 1」生成（``ledger.next_asset_numbers``），
资产登记与单据下推都会取号。没有唯一索引时，两个人同时提交会拿到同一个序号，
静默写入重复编码；有了唯一索引，冲突方会撞 1062，由 ``asset.py`` 自动重取序号重试。

用法（项目根目录）::

    uv run python scripts/migrate_asset_register.py            # 检查 + 加索引
    uv run python scripts/migrate_asset_register.py --check     # 只检查，不改表

脚本是幂等的：索引已存在时直接跳过。若台账里已有重复编码，脚本会列出重复行并
拒绝改表（重复数据必须先人工清理，否则 ALTER 会失败）。
"""

import argparse
import os
import sys

import mysql.connector
from dotenv import load_dotenv
from mysql.connector import Error

load_dotenv()

TABLE = 'device_list'
INDEX_NAME = 'uk_number'
LEGACY_INDEX = 'idx_number'


def connect():
    return mysql.connector.connect(
        host=os.environ['DB_HOST'],
        user=os.environ['DB_USER'],
        password=os.environ['DB_PASSWORD'],
        database=os.environ['DB_NAME'],
        charset='utf8mb4',
    )


def index_exists(cursor, database, index_name):
    cursor.execute(
        "SELECT COUNT(*) AS cnt FROM information_schema.statistics "
        "WHERE table_schema = %s AND table_name = %s AND index_name = %s",
        (database, TABLE, index_name)
    )
    return int(cursor.fetchone()['cnt']) > 0


def find_duplicates(cursor):
    """重复编码（含空编码）及其行 id。"""
    cursor.execute(
        f"SELECT number, COUNT(*) AS cnt, GROUP_CONCAT(id ORDER BY id) AS ids "
        f"FROM {TABLE} GROUP BY number HAVING cnt > 1 ORDER BY cnt DESC, number"
    )
    return cursor.fetchall()


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument('--check', action='store_true',
                        help='只检查重复编码与索引状态，不修改表结构')
    args = parser.parse_args()

    try:
        conn = connect()
    except Error as exc:
        print(f'数据库连接失败: {exc}', file=sys.stderr)
        return 1

    cursor = None
    try:
        cursor = conn.cursor(dictionary=True)
        database = os.environ['DB_NAME']

        duplicates = find_duplicates(cursor)
        if duplicates:
            print(f'发现 {len(duplicates)} 组重复资产编码，必须先人工清理：')
            for row in duplicates:
                print(f"  {row['number'] or '(空编码)'}  x{row['cnt']}  ids={row['ids']}")

        if index_exists(cursor, database, INDEX_NAME):
            print(f'{TABLE}.{INDEX_NAME} 唯一索引已存在，无需处理。')
            return 1 if duplicates else 0

        if args.check:
            print(f'{TABLE}.{INDEX_NAME} 唯一索引尚未创建（--check 模式不修改表结构）。')
            return 1 if duplicates else 0

        if duplicates:
            print('存在重复编码，已跳过加索引。请清理后重新运行。', file=sys.stderr)
            return 1

        # DDL 在 MySQL 中隐式提交，无需显式 commit
        cursor.execute(f"ALTER TABLE {TABLE} ADD UNIQUE KEY {INDEX_NAME} (number)")
        print(f'已为 {TABLE}.number 创建唯一索引 {INDEX_NAME}。')

        # 唯一索引已能覆盖原来按编码的查询，删掉冗余的普通索引
        if index_exists(cursor, database, LEGACY_INDEX):
            cursor.execute(f"ALTER TABLE {TABLE} DROP INDEX {LEGACY_INDEX}")
            print(f'已删除冗余索引 {LEGACY_INDEX}（由 {INDEX_NAME} 覆盖）。')
        return 0
    except Error as exc:
        print(f'执行失败: {exc}', file=sys.stderr)
        return 1
    finally:
        if cursor:
            cursor.close()
        conn.close()


if __name__ == '__main__':
    sys.exit(main())
