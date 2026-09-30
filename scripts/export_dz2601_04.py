# -*- coding: utf-8 -*-
"""导出：资产变更(inventory)中 DZ2601~04 批次的资产 → Excel（明细 + 汇总）。

复用项目工具 app.utils.rows_to_xlsx，数据口径与 scripts/query_dz2601_04.py 一致。
"""
from datetime import datetime

from app.config import get_db_connection
from app.utils import rows_to_xlsx

MONTH_PREFIXES = ('DZ2601', 'DZ2602', 'DZ2603', 'DZ2604')
OUT = 'scripts/DZ2601-04_asset_changes_export.xlsx'


def main():
    conn = get_db_connection()
    if not conn:
        raise SystemExit('DB connect failed')
    cursor = conn.cursor(dictionary=True)
    like_sql = ' OR '.join(['number LIKE %s'] * len(MONTH_PREFIXES))
    params = [f'{p}%' for p in MONTH_PREFIXES]

    # inventory：资产变更当前记录
    cursor.execute(
        f"SELECT number, department, site, type, "
        f"DATE_FORMAT(datetime, '%Y-%m-%d') AS datetime, status, tag "
        f"FROM inventory WHERE {like_sql} ORDER BY number, id",
        params,
    )
    inv_rows = cursor.fetchall()

    # device_list：台账主档（补规格 / SN）
    cursor.execute(
        f"SELECT number, spec, sn FROM device_list WHERE {like_sql}",
        params,
    )
    dev_map = {r['number']: r for r in cursor.fetchall()}

    cursor.close()
    conn.close()

    detail = []
    for i, r in enumerate(inv_rows, 1):
        dev = dev_map.get(r['number']) or {}
        detail.append({
            '序号': i,
            '资产编码': r['number'],
            '部门': r['department'] or '',
            '使用人': r['site'] or '',
            '资产类型': r['type'] or '',
            '发放日期': r['datetime'] or '',
            '资产状态': r['status'] or '',
            '流转标签': r['tag'] or '',
            '规格': dev.get('spec') or '',
            'SN': dev.get('sn') or '',
        })

    # 汇总：按批次 + 类型；按状态；未录入清单
    batch_type = {}
    for r in inv_rows:
        key = (r['number'][:6], r['type'] or '未填写')
        cnt, first, last = batch_type.get(key) or (0, r['number'], r['number'])
        batch_type[key] = (cnt + 1, first, r['number'])
    summary = [{
        '批次': batch,
        '资产类型': type_ if type_ != '未填写' else '（未填写）',
        '数量': cnt,
        '编码范围': f'{first} ~ {last}' if cnt > 1 else first,
    } for (batch, type_), (cnt, first, last) in sorted(batch_type.items())]

    status_cnt = {}
    for r in inv_rows:
        s = (r['status'] or '').strip() or '无状态'
        status_cnt[s] = status_cnt.get(s, 0) + 1
    status_rows = [{'资产状态': s, '数量': c} for s, c in sorted(status_cnt.items())]

    unrecorded = [r['number'] for r in inv_rows if (r['status'] or '').strip() == '未录入']

    total_row = {'资产状态': '合计', '数量': len(inv_rows)}
    status_rows.append(total_row)

    output = rows_to_xlsx([
        ('明细', detail),
        ('汇总-批次类型', summary),
        ('汇总-状态', status_rows),
    ])
    with open(OUT, 'wb') as f:
        f.write(output.read())

    print(f'导出成功: {OUT}')
    print(f'  明细 {len(detail)} 行；未录入 {len(unrecorded)} 条: {", ".join(unrecorded) or "无"}')


if __name__ == '__main__':
    main()
