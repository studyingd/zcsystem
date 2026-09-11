"""密码哈希工具。

仅保留 bcrypt：存量 MD5 密码已全部迁移完毕（可用
``scripts/check_password_migration.py`` 复核），弱哈希分支已下线。
``hash_password_bcrypt`` 供管理员重置 / 新建账号时使用。
"""

import bcrypt


def hash_password_bcrypt(password):
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')


def verify_password_bcrypt(password, hashed):
    return bcrypt.checkpw(password.encode('utf-8'), hashed.encode('utf-8'))
