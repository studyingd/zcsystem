#!/usr/bin/env python3
"""下线流转标签「离职」：存量记录统一改写为「入库」。

背景：离职与入库在所有统计口径中行为完全一致（库存计数 / 卡片状态 / 入库日期
回退均同组，部门领用矩阵两类都不计），属冗余标签——设备退回本来就该打「入库」。
现从词表（ledger.ALL_TAGS / 前端 TAG_OPTIONS）中移除「离职」。

问题：inventory / inventory_tmp 中已存在 tag='离职' 的存量记录。只改代码不改数据，
这些资产的最新流转标签会掉出 STOCK_TAGS，库存数会静默下降。本脚本把两张表的
tag='离职' 统一改写为 tag='入库'，改写前后所有库存 / 卡片指标保持不变。

用法（项目根目录）::

    uv run python scripts/migrate_remove_departure_tag.py --check    # 只统计行数，不改数据
    uv run python scripts/migrate_remove_departure_tag.py            # 执行改写

脚本幂等：无「离职」记录时直接跳过。
"""

import argparse
import os
import sys

import mysql.connector
from dotenv import load_dotenv
from mysql.connector import Error

load_dotenv()

OLD_TAG = '离职'
NEW_TAG = '入库'
TABLES = ('inventory', 'inventory_tmp')


def connect():
    return mysql.connector.connect(
        host=os.environ['DB_HOST'],
        user=os.environ['DB_USER'],
        password=os.environ['DB_PASSWORD'],
        database=os.environ['DB_NAME'],
        charset='utf8mb4',
    )


def main():
    parser = argparse.ArgumentParser(description='流转标签「离职」改写为「入库」')
    parser.add_argument('--check', action='store_true', help='只统计待改写行数，不修改数据')
    args = parser.parse_args()

    try:
        conn = connect()
        cursor = conn.cursor(dictionary=True)

        counts = {}
        for table in TABLES:
            cursor.execute(f'SELECT COUNT(*) AS cnt FROM {table} WHERE tag = %s', (OLD_TAG,))
            counts[table] = int(cursor.fetchone()['cnt'])

        total = sum(counts.values())
        if total == 0:
            print(f'两表均无「{OLD_TAG}」记录，无需迁移')
            return

        detail = '、'.join(f'{t}={counts[t]} 行' for t in TABLES if counts[t])
        if args.check:
            print(f'待改写（{detail}）--check 模式未修改')
            sys.exit(1)

        for table in TABLES:
            if counts[table]:
                cursor.execute(
                    f"UPDATE {table} SET tag = %s WHERE tag = %s",
                    (NEW_TAG, OLD_TAG)
                )
                print(f'[{table}] tag「{OLD_TAG}」→「{NEW_TAG}」：已改写 {cursor.rowcount} 行')
        conn.commit()
        print(f'迁移完成（共 {total} 行）。库存 / 卡片等指标在改写前后保持不变。')
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
