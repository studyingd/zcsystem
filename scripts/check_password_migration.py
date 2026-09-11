#!/usr/bin/env python3
"""检查存量账号的密码迁移进度（MD5 -> bcrypt）。

MD5 兼容分支已从登录逻辑（app/auth.py）下线，密码仅支持 bcrypt。
本脚本用于复核：若发现仍无 bcrypt 哈希的账号，该账号将无法登录，
需管理员用 ``app.utils.hash_password_bcrypt`` 重置密码。

用法（项目根目录）::

    uv run python scripts/check_password_migration.py
"""

import os
import sys

import mysql.connector
from dotenv import load_dotenv
from mysql.connector import Error

load_dotenv()


def connect():
    return mysql.connector.connect(
        host=os.environ['DB_HOST'],
        user=os.environ['DB_USER'],
        password=os.environ['DB_PASSWORD'],
        database=os.environ['DB_NAME'],
        charset='utf8mb4',
    )


def main():
    conn = None
    cursor = None
    try:
        conn = connect()
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            "SELECT username, password_bcrypt FROM identified ORDER BY username"
        )
        rows = cursor.fetchall()

        pending = [r['username'] for r in rows if not (r['password_bcrypt'] or '').strip()]
        migrated = len(rows) - len(pending)

        print(f'账号总数: {len(rows)}')
        print(f'已迁移 bcrypt: {migrated}')
        print(f'无 bcrypt 哈希: {len(pending)}')
        if pending:
            print('以下账号无法登录（MD5 分支已下线），需管理员重置密码:')
            for username in pending:
                print(f'  - {username}')
            return 1
        print('[OK] 全部账号均已使用 bcrypt')
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
