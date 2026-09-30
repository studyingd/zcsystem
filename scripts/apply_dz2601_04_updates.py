# -*- coding: utf-8 -*-
"""按用户修改后的 Excel 回写数据库（DZ2601~04 批次）。

写入内容：
  A. inventory.tag              —— Excel 补填的流转标签（~77 条）
  B. inventory.department/site  —— 部门/使用人拆分 + 前导空格清理（~12 条）
  C. device_list 补录           —— 这 147 个资产在台账主档缺失，按 Excel 补插
     （number/spec/type/department/name，硬件字段留空），规格随行写入

安全措施：
  - 执行前把受影响 inventory 行备份到 inventory_bak_<时间戳> 表
  - C 组为新增行，回滚方式 = 按 number 删除（脚本末尾打印回滚 SQL）
  - 逐组事务，失败即回滚；默认 dry-run，加 --apply 才真正写库
"""
import sys
from datetime import datetime

from openpyxl import load_workbook

from app.config import get_db_connection

XLSX = 'scripts/DZ2601-04_asset_changes_export.xlsx'
MONTH_PREFIXES = ('DZ2601', 'DZ2602', 'DZ2603', 'DZ2604')
APPLY = '--apply' in sys.argv

# 列宽限制（init_db.sql）
LIMITS = {'number': 32, 'spec': 255, 'type': 64, 'department': 64, 'name': 64}


def norm(v):
    if v is None:
        return ''
    if hasattr(v, 'strftime'):
        return v.strftime('%Y-%m-%d')
    return str(v).strip()


def raw(v):
    return '' if v is None else str(v)


def load_excel():
    ws = load_workbook(XLSX)['明细']
    rows = list(ws.iter_rows(values_only=True))
    headers = [str(h).strip() if h is not None else '' for h in rows[0]]
    out = {}
    for r in rows[1:]:
        if all(c is None or str(c).strip() == '' for c in r):
            continue
        item = dict(zip(headers, r))
        num = norm(item.get('资产编码'))
        if num:
            out[num] = item
    return out


def main():
    excel = load_excel()

    conn = get_db_connection()
    if not conn:
        raise SystemExit('DB connect failed')
    cur = conn.cursor(dictionary=True)
    like_sql = ' OR '.join(['number LIKE %s'] * len(MONTH_PREFIXES))
    like_params = tuple(f'{p}%' for p in MONTH_PREFIXES)

    cur.execute(
        f"SELECT number, department, site, type, "
        f"DATE_FORMAT(datetime, '%Y-%m-%d') AS datetime, status, tag "
        f"FROM inventory WHERE {like_sql} ORDER BY number",
        like_params,
    )
    inv_rows = cur.fetchall()
    inv = {}
    dup_inv = set()
    for r in inv_rows:
        if r['number'] in inv:
            dup_inv.add(r['number'])
        inv[r['number']] = r
    if dup_inv:
        print(f'!! inventory 中同编码多条记录，需人工处理: {sorted(dup_inv)}')
        return 1

    cur.execute(f"SELECT number FROM device_list WHERE {like_sql}", like_params)
    existing_dev = {r['number'] for r in cur.fetchall()}

    if set(excel) != set(inv):
        print(f'!! 编码集合不一致，中止: 仅Excel={sorted(set(excel)-set(inv))} '
              f'仅DB={sorted(set(inv)-set(excel))}')
        return 1

    # ---- 计算更新计划 ----
    tag_updates = []    # (number, tag)
    dept_updates = []   # (number, department, site) —— 用原始值比较，含纯空格清理
    other_diffs = []
    for num, item in excel.items():
        db = inv[num]
        tag = norm(item.get('流转标签'))
        dept, site = norm(item.get('部门')), norm(item.get('使用人'))
        if tag != norm(db['tag']):
            tag_updates.append((num, tag))
        if dept != raw(db['department']) or site != raw(db['site']):
            dept_updates.append((num, dept, site))
        for col, db_col, xl in (('资产类型', 'type', norm(item.get('资产类型'))),
                                ('发放日期', 'datetime', norm(item.get('发放日期'))),
                                ('资产状态', 'status', norm(item.get('资产状态')))):
            if xl != norm(db[db_col]):
                other_diffs.append((num, col, xl, db[db_col]))

    dev_inserts = []    # (number, spec, type, department, name)
    dev_existing_conflict = []
    for num, item in excel.items():
        row = (num, norm(item.get('资产规格')), norm(item.get('资产类型')),
               norm(item.get('部门')), norm(item.get('使用人')))
        if num in existing_dev:
            dev_existing_conflict.append(num)
        else:
            dev_inserts.append(row)

    # 长度校验
    too_long = []
    for num, spec, type_, dept, name in dev_inserts:
        for val, limit, field in ((num, 32, 'number'), (spec, 255, 'spec'),
                                  (type_, 64, 'type'), (dept, 64, 'department'),
                                  (name, 64, 'name')):
            if len(val) > limit:
                too_long.append((num, field, len(val), limit))

    print(f'A. inventory.tag 更新: {len(tag_updates)} 条')
    print(f'B. inventory.department/site 更新: {len(dept_updates)} 条')
    print(f'C. device_list 补录: {len(dev_inserts)} 条（含规格）')
    if dev_existing_conflict:
        print(f'   其中 {len(dev_existing_conflict)} 个编码已存在，改为仅更新 spec: '
              f'{dev_existing_conflict[:5]}...')
    if other_diffs:
        print(f'!! 类型/日期/状态差异 {len(other_diffs)} 条（不自动写，请人工确认）:')
        for x in other_diffs:
            print('   ', x)
        return 1
    if too_long:
        print('!! 超出列宽，中止:')
        for x in too_long:
            print('   ', x)
        return 1

    if not APPLY:
        print('\n[dry-run] 未写库。加 --apply 执行。')
        return 0

    bak = datetime.now().strftime('%Y%m%d%H%M%S')

    try:
        # ---- 备份受影响的 inventory 行 ----
        affected_inv = sorted({u[0] for u in tag_updates} | {u[0] for u in dept_updates})
        if affected_inv:
            ph = ','.join(['%s'] * len(affected_inv))
            cur.execute(f"CREATE TABLE inventory_bak_{bak} LIKE inventory")
            cur.execute(f"INSERT INTO inventory_bak_{bak} SELECT * FROM inventory "
                        f"WHERE number IN ({ph})", affected_inv)
            conn.commit()
            print(f'备份完成: inventory_bak_{bak}（{len(affected_inv)} 行）')

        # ---- A ----
        for num, tag in tag_updates:
            cur.execute("UPDATE inventory SET tag = %s WHERE number = %s", (tag, num))
        conn.commit()
        print(f'A 完成: {len(tag_updates)} 条 tag 已更新')

        # ---- B ----
        for num, d, s in dept_updates:
            cur.execute("UPDATE inventory SET department = %s, site = %s WHERE number = %s",
                        (d, s, num))
        conn.commit()
        print(f'B 完成: {len(dept_updates)} 条 部门/使用人 已更新')

        # ---- C ----
        for number, spec, type_, dept, name in dev_inserts:
            cur.execute(
                "INSERT INTO device_list (number, spec, type, department, name) "
                "VALUES (%s, %s, %s, %s, %s)",
                (number, spec, type_, dept, name),
            )
        conn.commit()
        print(f'C 完成: {len(dev_inserts)} 行已补录 device_list（规格随行写入）')

        # 已存在主档的（当前为 0 个）仅更新 spec，保持口径完整
        for num in dev_existing_conflict:
            spec = norm(excel[num].get('资产规格'))
            cur.execute("UPDATE device_list SET spec = %s WHERE number = %s", (spec, num))
        conn.commit()
    except Exception as exc:
        conn.rollback()
        print(f'!! 执行失败已回滚: {exc}')
        return 1
    finally:
        cur.close()
        conn.close()

    print(f"""
全部写入完成。
回滚参考：
  A/B: INSERT INTO inventory SELECT * FROM inventory_bak_{bak}
       WHERE number IN (受影响编码)  -- 先删后插或按需恢复字段
  C:   DELETE FROM device_list WHERE number IN ({', '.join(r[0] for r in dev_inserts[:3])}...)
       （完整清单见本输出对应的 Excel 明细，共 {len(dev_inserts)} 个编码）""")
    return 0


if __name__ == '__main__':
    sys.exit(main())
