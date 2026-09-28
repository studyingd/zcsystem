#!/usr/bin/env python3
"""词表改名：「租聘」→「租赁」（设备类型「租赁台式主机」/ 资产状态「租赁」）。

背景：代码侧词表（ledger.ASSET_TYPES / INVENTORY_STATUSES / RENTAL_DESKTOP_TYPE）
与前端硬编码已统一改为「租赁」。数据库存量行仍存旧值，只改代码不改数据会导致：

- inventory.status='租聘' 的行通不过 /update 的 INVENTORY_STATUSES 校验（无法原样保存）；
- device_list / inventory 中 type='租聘台式主机' 的资产掉出 ZL 前缀、
  CONFIG_TYPES 硬件配置必填、状态分桶等所有按类型匹配的口径；
- 台账 / 单据 / 预算 / 卡片按 device_type 关联的行互相匹配不上。

本脚本把这些列的旧值统一改写为新值，改写前后所有统计口径保持一致
（改名不改分组，租赁仍属在库状态、仍走 ZL 前缀、仍是电脑类必填硬件配置）。

用法（项目根目录）::

    uv run python scripts/migrate_rename_rental_terms.py --check    # 只统计行数，不改数据
    uv run python scripts/migrate_rename_rental_terms.py            # 执行改写

脚本幂等：无旧值时直接跳过。purchase_orders / budgets / asset_cards 的
device_type 在正常流程里不会出现租赁台式主机（单据类型不含它），但自定义
输入可能写入，故一并按精确值改写（0 行时无副作用）。
"""

import argparse
import os
import sys

import mysql.connector
from dotenv import load_dotenv
from mysql.connector import Error

load_dotenv()

OLD_TYPE = '租聘台式主机'
NEW_TYPE = '租赁台式主机'
OLD_STATUS = '租聘'
NEW_STATUS = '租赁'

# (表, 列, 旧值, 新值, 说明)
REWRITES = (
    ('device_list', 'type', OLD_TYPE, NEW_TYPE, '台账设备类型'),
    ('inventory', 'type', OLD_TYPE, NEW_TYPE, '流转表设备类型'),
    ('inventory', 'status', OLD_STATUS, NEW_STATUS, '流转表资产状态'),
    ('inventory_tmp', 'type', OLD_TYPE, NEW_TYPE, '历史表设备类型'),
    ('inventory_tmp', 'status', OLD_STATUS, NEW_STATUS, '历史表资产状态'),
    ('purchase_orders', 'device_type', OLD_TYPE, NEW_TYPE, '单据设备类型（自定义输入可能写入）'),
    ('budgets', 'device_type', OLD_TYPE, NEW_TYPE, '预算设备类型（自定义输入可能写入）'),
    ('asset_cards', 'device_type', OLD_TYPE, NEW_TYPE, '卡片设备类型（随单据派生）'),
)


def connect():
    return mysql.connector.connect(
        host=os.environ['DB_HOST'],
        user=os.environ['DB_USER'],
        password=os.environ['DB_PASSWORD'],
        database=os.environ['DB_NAME'],
        charset='utf8mb4',
    )


def main():
    parser = argparse.ArgumentParser(description='词表改名：租聘→租赁（类型与状态）')
    parser.add_argument('--check', action='store_true', help='只统计待改写行数，不修改数据')
    args = parser.parse_args()

    try:
        conn = connect()
        cursor = conn.cursor(dictionary=True)

        counts = []
        for table, column, old, new, note in REWRITES:
            cursor.execute(
                f'SELECT COUNT(*) AS cnt FROM {table} WHERE {column} = %s', (old,)
            )
            cnt = int(cursor.fetchone()['cnt'])
            if cnt:
                counts.append((table, column, old, new, note, cnt))

        if not counts:
            print('各表均无「租聘」旧值，无需迁移')
            return

        if args.check:
            for table, column, _old, _new, note, cnt in counts:
                print(f'[{table}.{column}] {note}：{cnt} 行待改写（--check 模式未修改）')
            sys.exit(1)

        total = 0
        for table, column, old, new, note, _ in counts:
            cursor.execute(
                f'UPDATE {table} SET {column} = %s WHERE {column} = %s', (new, old)
            )
            print(f'[{table}.{column}] {note}：「{old}」→「{new}」已改写 {cursor.rowcount} 行')
            total += cursor.rowcount
        conn.commit()
        print(f'迁移完成（共 {total} 行）。租赁仍属在库状态 / ZL 前缀 / 电脑类配置口径，改写前后指标不变。')
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
