#!/usr/bin/env python3
"""给 purchase_orders 增加硬件配置列（cpu / mem / disk / gpu）。

背景：单据新增时电脑类设备（笔记本电脑 / 台式主机 / 租赁台式主机）必须填写
硬件配置，下推生成台账资产时写入 device_list 的 cpu / mem / disk / gpu，
资产登记 / 变更页据此展示。存量库的 purchase_orders 没有这四列，需要补齐。

用法（项目根目录）::

    uv run python scripts/migrate_order_hardware.py           # 检查 + 加列
    uv run python scripts/migrate_order_hardware.py --check    # 只检查，不改表

脚本幂等：列已存在时直接跳过。新增列均为 NOT NULL DEFAULT ''，对存量单据安全。
"""

import argparse
import os
import sys

import mysql.connector
from dotenv import load_dotenv
from mysql.connector import Error

load_dotenv()

TABLE = 'purchase_orders'
COLUMNS = (
    ('cpu', "VARCHAR(64) NOT NULL DEFAULT ''"),
    ('mem', "VARCHAR(64) NOT NULL DEFAULT ''"),
    ('disk', "VARCHAR(64) NOT NULL DEFAULT ''"),
    ('gpu', "VARCHAR(64) NOT NULL DEFAULT ''"),
)


def connect():
    return mysql.connector.connect(
        host=os.environ['DB_HOST'],
        user=os.environ['DB_USER'],
        password=os.environ['DB_PASSWORD'],
        database=os.environ['DB_NAME'],
        charset='utf8mb4',
    )


def column_exists(cursor, database, column):
    cursor.execute(
        "SELECT COUNT(*) AS cnt FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s AND column_name = %s",
        (database, TABLE, column)
    )
    return int(cursor.fetchone()['cnt']) > 0


def main():
    parser = argparse.ArgumentParser(description='purchase_orders 增加硬件配置列')
    parser.add_argument('--check', action='store_true', help='只检查，不改表')
    args = parser.parse_args()

    database = os.environ['DB_NAME']
    try:
        conn = connect()
        cursor = conn.cursor(dictionary=True)
        missing = [name for name, _ in COLUMNS if not column_exists(cursor, database, name)]
        if not missing:
            print(f'[{TABLE}] 硬件配置列已齐全（{", ".join(n for n, _ in COLUMNS)}），无需迁移')
            return
        if args.check:
            print(f'[{TABLE}] 缺少列：{", ".join(missing)}（--check 模式未修改）')
            sys.exit(1)
        for name, definition in COLUMNS:
            if name in missing:
                cursor.execute(f'ALTER TABLE {TABLE} ADD COLUMN {name} {definition} AFTER spec')
                print(f'[{TABLE}] 已新增列 {name}')
        conn.commit()
        print(f'[{TABLE}] 迁移完成（本次新增：{", ".join(missing)}）')
    except Error as exc:
        print(f'迁移失败：{exc}', file=sys.stderr)
        sys.exit(1)
    finally:
        try:
            cursor.close()
            conn.close()
        except Exception:
            pass


if __name__ == '__main__':
    main()
