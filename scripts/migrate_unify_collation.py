#!/usr/bin/env python3
"""统一 device_list / inventory 的排序规则（幂等）。

背景：device_list 建表于 init_db.sql 之前（服务器默认 utf8mb4_0900_ai_ci，
MySQL 8 专属），inventory / inventory_tmp 为 utf8mb4_unicode_ci。两表字符列
排序规则不一致，任何 SQL JOIN / IN 比较都会报 1267 Illegal mix of collations，
迫使 app/ledger.py 把大量对齐工作拉到 Python 侧做（见 stock_detail_until /
dept_usage_matrix 等处的注释）。统一后即恢复 SQL JOIN 能力。

方向选择：全部统一到 utf8mb4_unicode_ci ——
- 兼容 MySQL 5.7 与 8.0（0900_ai_ci 在 5.7 上不存在，反向统一会锁死升级路径）；
- device_list 是台账主表、体量小于流转表 inventory，ALTER 锁表时间更短；
- inventory / inventory_tmp 已是 unicode_ci，无需改动。

用法（项目根目录）::

    uv run python scripts/migrate_unify_collation.py            # 检查 + 统一
    uv run python scripts/migrate_unify_collation.py --check     # 只检查，不改表

注意：ALTER ... CONVERT TO 会重建表（拷贝全表数据），device_list 当前体量
（数千行）秒级完成；生产执行建议在低峰期。执行后 Python 侧对齐逻辑无需
改动即继续正确（单表查询不受 collation 影响）；后续可另行把对齐改回 JOIN。
"""

import argparse
import os
import sys

import mysql.connector
from dotenv import load_dotenv
from mysql.connector import Error

load_dotenv()

TARGET_COLLATION = 'utf8mb4_unicode_ci'
TARGET_TABLE = 'device_list'   # 唯一需要转换的表（其余表已是 unicode_ci）

# 1267/1267：字符集或排序规则不一致导致比较失败
MISMATCH_ERRORS = (1267, 1270)


def connect():
    return mysql.connector.connect(
        host=os.environ['DB_HOST'],
        user=os.environ['DB_USER'],
        password=os.environ['DB_PASSWORD'],
        database=os.environ['DB_NAME'],
        charset='utf8mb4',
        use_pure=True,
    )


def table_collation(cur, table):
    cur.execute(
        "SELECT table_collation FROM information_schema.tables "
        "WHERE table_schema = DATABASE() AND table_name = %s",
        (table,)
    )
    row = cur.fetchone()
    return row[0] if row else None


def collations_differ(cur):
    """JOIN 关键列上两表 collation 是否不一致（以 information_schema 为准）。"""
    cur.execute(
        "SELECT table_name, collation_name FROM information_schema.columns "
        "WHERE table_schema = DATABASE() AND table_name IN ('device_list','inventory') "
        "AND column_name = 'number'"
    )
    found = {r[0]: r[1] for r in cur.fetchall()}
    dl, inv = found.get('device_list'), found.get('inventory')
    return bool(dl and inv and dl != inv), (dl, inv)


def can_join(cur):
    """直接尝试两表按 number JOIN（存在性 + collation 一致性的最终判据）。"""
    try:
        cur.execute(
            "SELECT 1 FROM device_list d JOIN inventory i ON d.number = i.number LIMIT 1"
        )
        cur.fetchall()  # 消费结果集（未缓冲游标不取完会污染后续查询）
        return True, None
    except Error as exc:
        if any(str(exc.args[0]) == str(code) for code in MISMATCH_ERRORS if exc.args):
            return False, exc
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--check', action='store_true', help='只检查，不改表')
    args = parser.parse_args()

    conn = connect()
    cur = conn.cursor()
    try:
        ok, exc = can_join(cur)
        col_dl, col_inv = collations_differ(cur)[1]
        print(f"device_list.number     collation: {col_dl}")
        print(f"inventory.number       collation: {col_inv}")
        print(f"SQL JOIN (d.number = i.number): {'OK' if ok else '失败: ' + str(exc)}")

        cur_coll = table_collation(cur, TARGET_TABLE)
        if ok and cur_coll == TARGET_COLLATION:
            print(f"\n✅ 已统一（{TARGET_TABLE} = {TARGET_COLLATION}），无需迁移。")
            return 0
        if args.check:
            print(f"\n⚠️ 需要迁移：{TARGET_TABLE} 当前 {cur_coll} → {TARGET_COLLATION}")
            return 1

        print(f"\n开始迁移：ALTER TABLE {TARGET_TABLE} CONVERT TO CHARACTER SET utf8mb4 "
              f"COLLATE {TARGET_COLLATION} ...")
        cur.execute(
            f"ALTER TABLE {TARGET_TABLE} CONVERT TO CHARACTER SET utf8mb4 "
            f"COLLATE {TARGET_COLLATION}"
        )
        conn.commit()

        ok2, exc2 = can_join(cur)
        print(f"迁移后 JOIN 验证: {'OK' if ok2 else '仍失败: ' + str(exc2)}")
        if not ok2:
            return 1
        print("✅ 完成。app/ledger.py 的 Python 侧对齐逻辑无需改动即兼容；")
        print("   后续可把对齐改回 SQL JOIN（见 ledger.py 内各处 collation 注释）。")
        return 0
    finally:
        cur.close()
        conn.close()


if __name__ == '__main__':
    sys.exit(main())
