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


def rows_to_xlsx(sheets):
    """字典行列表 → 内存中的 xlsx（openpyxl 直写，不经过 pandas）。

    ``sheets`` 为 ``(工作表名, [{列名: 值}, ...])`` 列表；表头取第一行的键序，
    空列表输出空工作表（与旧 pandas 行为一致）。值 None 写为空白单元格。
    """
    from io import BytesIO

    from openpyxl import Workbook

    wb = Workbook()
    wb.remove(wb.active)
    for name, rows in sheets:
        ws = wb.create_sheet(title=name)
        if rows:
            headers = list(rows[0].keys())
            ws.append(headers)
            for row in rows:
                ws.append([row.get(h) for h in headers])
    buf = BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf
