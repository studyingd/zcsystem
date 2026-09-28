#!/usr/bin/env python3
"""把 budgets 的已用手动值从「总额覆盖」迁移为「修正量」语义。

背景：最初的 used_override 语义是"完全替代自动统计"，导致手动设置后新创建
的单据不再计入已用。现改为 ``used_adjust`` 修正量语义：

    已用 = 当年「预算内」单据自动统计 + used_adjust

修正量设置后新单据照常自动累加（见 app/order.py list_budgets / save_budget）。

迁移内容（幂等）：
  1. 全新环境（两列都不存在）→ 直接新增 used_adjust；
  2. 已有 used_override（旧语义总额）→ 重命名为 used_adjust 并换算：
     used_adjust = 旧总额 - 该行最后保存时「已存在」的当年预算内单据合计
     （以 budgets.updated_at 为界：手动值是在最后一次保存时定的，之后创建的
     单据不在共口径内、换算后会继续自动累加；若设置后又改过预算金额，
     updated_at 会被刷新，存在少量误判，需人工复核）；
  3. 已有 used_adjust → 跳过。

用法（项目根目录）::

    uv run python scripts/migrate_budgets_used_override.py            # 检查 + 迁移
    uv run python scripts/migrate_budgets_used_override.py --check    # 只检查，不改动

新库直接执行 scripts/init_documents.sql 即可，无需本脚本。
"""

import argparse
import os

import mysql.connector
from dotenv import load_dotenv

load_dotenv()

TABLE = 'budgets'
OLD_COLUMN = 'used_override'
NEW_COLUMN = 'used_adjust'
# 与 scripts/init_documents.sql 中的列定义保持一致（修正量可为负）
COLUMN_DEFINITION = 'DECIMAL(14,2) NULL DEFAULT NULL'


def connect():
    return mysql.connector.connect(
        host=os.environ['DB_HOST'],
        user=os.environ['DB_USER'],
        password=os.environ['DB_PASSWORD'],
        database=os.environ['DB_NAME'],
        charset='utf8mb4',
    )


def column_exists(cursor, column):
    cursor.execute(
        "SELECT 1 FROM information_schema.COLUMNS "
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s AND COLUMN_NAME = %s",
        (TABLE, column)
    )
    return cursor.fetchone() is not None


def table_exists(cursor):
    cursor.execute(
        "SELECT 1 FROM information_schema.TABLES "
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s",
        (TABLE,)
    )
    return cursor.fetchone() is not None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='只检查，不改动')
    args = parser.parse_args()

    conn = None
    cursor = None
    try:
        conn = connect()
        cursor = conn.cursor()

        if not table_exists(cursor):
            raise SystemExit('表 budgets 不存在，请先执行 scripts/init_documents.sql')

        if column_exists(cursor, NEW_COLUMN):
            print(f'[OK] {TABLE}.{NEW_COLUMN} 已存在，无需迁移')
            return 0

        has_old = column_exists(cursor, OLD_COLUMN)
        if args.check:
            print(f'[待迁移] {TABLE} 缺少列 {NEW_COLUMN}'
                  + (f'（存在旧列 {OLD_COLUMN}，将重命名并换算为修正量）' if has_old else ''))
            return 1

        if has_old:
            # 1) 重命名（值保持不变，此时仍是旧语义的"总额"）
            cursor.execute(f'ALTER TABLE {TABLE} CHANGE {OLD_COLUMN} {NEW_COLUMN} {COLUMN_DEFINITION}')
            # 2) 换算为修正量：旧总额 - 该行最后保存前已存在的预算内单据合计。
            #    手动值定于最后一次保存（updated_at），其后创建的单据不在其口径内，
            #    换算后会作为自动统计继续累加，不应从总额里扣除
            cursor.execute(
                f"""UPDATE {TABLE} b SET b.{NEW_COLUMN} = b.{NEW_COLUMN} - (
                        SELECT COALESCE(SUM(o.amount), 0) FROM purchase_orders o
                        WHERE o.in_budget = 1
                          AND YEAR(o.order_date) = b.budget_year
                          AND o.device_type = b.device_type
                          AND o.created_at <= b.updated_at)
                    WHERE b.{NEW_COLUMN} IS NOT NULL"""
            )
            conn.commit()
            print(f'[完成] {OLD_COLUMN} 已重命名为 {NEW_COLUMN} 并按"手动值设置前已存在的单据"换算为修正量'
                  '（已用 = 自动统计 + 修正量；若设置后还改过预算金额请人工复核各行）')
            return 0

        cursor.execute(f'ALTER TABLE {TABLE} ADD COLUMN {NEW_COLUMN} {COLUMN_DEFINITION}')
        conn.commit()
        print(f'[完成] {TABLE} 已添加列 {NEW_COLUMN} {COLUMN_DEFINITION}（NULL = 纯自动统计）')
        return 0
    except mysql.connector.Error as exc:
        print(f'[失败] {exc}')
        return 1
    finally:
        if cursor:
            cursor.close()
        if conn and conn.is_connected():
            conn.close()


if __name__ == '__main__':
    raise SystemExit(main())
