# -*- coding: utf-8 -*-
"""临时查询：资产变更(inventory)中 DZ2601~04 批次的资产，结果写入 UTF-8 文本。"""
from app.config import get_db_connection

MONTH_PREFIXES = ('DZ2601', 'DZ2602', 'DZ2603', 'DZ2604')
OUT = 'scripts/dz2601_04_result.txt'


def main():
    conn = get_db_connection()
    if not conn:
        raise SystemExit('DB connect failed')
    cursor = conn.cursor(dictionary=True)
    like_sql = ' OR '.join(['number LIKE %s'] * len(MONTH_PREFIXES))
    params = [f'{p}%' for p in MONTH_PREFIXES]

    cursor.execute(
        f"SELECT id, number, department, site, type, "
        f"DATE_FORMAT(datetime, '%Y-%m-%d') AS datetime, status, tag "
        f"FROM inventory WHERE {like_sql} ORDER BY number, id",
        params,
    )
    inv_rows = cursor.fetchall()

    cursor.execute(
        f"SELECT number, spec, type, sn FROM device_list WHERE {like_sql} ORDER BY number",
        params,
    )
    dev_rows = {r['number']: r for r in cursor.fetchall()}

    cursor.close()
    conn.close()

    lines = []
    lines.append(f'共 {len(inv_rows)} 条变更记录，涉及 {len({r["number"] for r in inv_rows})} 个资产编码')
    lines.append('')
    lines.append('序号 | 资产编码 | 部门 | 使用人 | 类型 | 日期 | 状态 | 标签 | 规格 | SN')
    lines.append('-' * 110)
    for i, r in enumerate(inv_rows, 1):
        dev = dev_rows.get(r['number']) or {}
        lines.append(
            f"{i} | {r['number']} | {r['department']} | {r['site']} | {r['type']} | "
            f"{r['datetime'] or ''} | {r['status']} | {r['tag'] or ''} | "
            f"{dev.get('spec') or ''} | {dev.get('sn') or ''}"
        )

    only_dev = set(dev_rows) - {r['number'] for r in inv_rows}
    if only_dev:
        lines.append('')
        lines.append(f'另有 {len(only_dev)} 个 DZ2601~04 台账资产无变更记录: '
                     f'{", ".join(sorted(only_dev))}')

    with open(OUT, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    print('written', OUT)


if __name__ == '__main__':
    main()
