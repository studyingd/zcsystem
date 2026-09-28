"""台账（device_list / inventory）的统一口径与派生逻辑。

三个业务模块的数据流：

- 资产登记 ``asset.py``：向 device_list + inventory 写入新资产（台账唯一新增入口）；
- 资产变更 ``inventory.py``：更新 device_list / inventory 的使用人、部门、状态、标签等，
  并把变更前的记录备份到 inventory_tmp；
- 资产申请 ``order.py``：只读台账，计算「今年已采购 / 剩余库存 / 部门使用情况」等指标，
  下推时把台账资产绑定到 asset_cards。

因此 device_list + inventory 是唯一事实来源。asset_cards 中已绑定卡片的
「规格 / SN / 所属人 / 所属部门 / 领取时间 / 状态」只是台账的派生快照，
统一在读取时通过 :func:`live_card_fields` 实时计算，无需任何手动同步。
"""

from datetime import date, datetime

from mysql.connector import Error

# ---- 口径常量 ----
# 新机起始编码：编码 >= 阈值视为新机，否则为旧机
NEW_LAPTOP_THRESHOLD = 'DZ2508000'
NEW_MONITOR_THRESHOLD = 'DZ2403000'
# 库存托管人：device_list 中挂在该部门/姓名下的设备视为在库
STOCK_CUSTODIAN_DEPT = 'IT'
STOCK_CUSTODIAN_NAME = '余嘉雄'
# 计入「剩余库存」的流转标签（设备退回即入库，不再单独区分离职退回）
STOCK_TAGS = ('入库',)
# 计入「已领用 / 使用明细」的流转标签
METRIC_TAGS = ('入职', '领用', '更换')
# 资产报废后打的流转标签（不计入库存，也不计入领用）
DEPRECATED_TAG = '弃用'
# 前端可选的全部流转标签：领用类 + 在库类 + 弃用
ALL_TAGS = METRIC_TAGS + STOCK_TAGS + (DEPRECATED_TAG,)

# ---- 台账资产状态（资产变更 / 查询模块共用词表）----
INVENTORY_STATUSES = ('已录入', '未录入', '租赁', '借用', '入库', '无需录入', '报废')

# ---- 资产卡片状态 ----
CARD_UNASSIGNED = '待分配'
CARD_IN_STOCK = '入库'
CARD_ISSUED = '已领用'
CARD_STATUSES = (CARD_UNASSIGNED, CARD_IN_STOCK, CARD_ISSUED)

# 笔记本 / 显示器只统计「新机」编码段
STOCK_TYPE_THRESHOLDS = {
    '笔记本电脑': NEW_LAPTOP_THRESHOLD,
    '显示器': NEW_MONITOR_THRESHOLD,
}

# Mac 机单独计库存的类型：规格含 mac 关键字（忽略大小写）的台式主机 / 笔记本电脑
# 与普通机分开统计，避免 MacBook / Mac mini 混进普通库存口径
MAC_SPEC_KEYWORD = 'mac'
MAC_SPLIT_TYPES = ('台式主机', '笔记本电脑')

# ---- 资产登记（台账新增）口径 ----
# 租赁台式主机使用 ZL 前缀，其余资产使用 DZ 前缀
RENTAL_DESKTOP_TYPE = '租赁台式主机'
CODE_PREFIX_RENTAL = 'ZL'
CODE_PREFIX_DEFAULT = 'DZ'
CODE_LENGTH = 9
# 每月每个前缀的流水号上限（3 位），超出后编码长度会变长、破坏台账取号规则
MAX_MONTHLY_SEQUENCE = 999

# 资产登记页可选的资产类型；「其它」由前端展开为自定义类型输入框
CUSTOM_TYPE_OPTION = '其它'
ASSET_TYPES = ('台式主机', RENTAL_DESKTOP_TYPE, '笔记本电脑', '显示器', CUSTOM_TYPE_OPTION)
# 需要填写硬件配置（CPU / 内存 / 硬盘 / 显卡）的类型
CONFIG_TYPES = ('笔记本电脑', '台式主机', RENTAL_DESKTOP_TYPE)
# 单据新增页可选的设备类型（其余类型经「其它」自定义输入）
ORDER_DEVICE_TYPES = ('显示器', '笔记本电脑', '台式主机')
# 租赁机规格默认值（前端仅在规格为空时回填，不覆盖用户已输入内容）
RENTAL_DEFAULT_SPEC = 'EDY易点云'

# 部门领用总览矩阵的设备类型列（顺序即看板展示顺序）
USAGE_MATRIX_TYPES = ('笔记本电脑', '台式主机', RENTAL_DESKTOP_TYPE, '显示器')

# 使用部门词表（服务端唯一来源，登记页由模板直接渲染，避免前端各抄一份）
DEPARTMENTS = ('FIN', 'HR', 'SCM', 'STU', 'GMO', 'COM', 'CSG', 'PMD', 'IT', 'SMG', '证券事务部')

# 台账新增时写入 inventory 的初始流转：
# 租赁机在「资产状态」维度归入租赁（资产变更页按状态分桶时单独展示），
# 但流转标签仍是入库 —— 看板库存按 tag 统计，两者口径不同是有意为之。
INITIAL_TAG = '入库'
INITIAL_STATUS_DEFAULT = '入库'
INITIAL_STATUS_RENTAL = '租赁'

# 单次批量登记数量上限（后端强校验，前端 max 只是提示）
MAX_REGISTER_BATCH = 200

# device_list.number 上的唯一索引 uk_number 冲突码：
# 登记与单据下推都靠「查该月最大序号 + 1」取号，并发时双方会拿到同一序号，
# 由唯一索引拦下（1062），冲突方回滚后重取序号重试 DUP_RETRY 次。
ER_DUP_ENTRY = 1062
DUP_RETRY = 2

# 品牌图标：按资产规格中的关键字匹配对象存储 /icon/ 下的文件名
BRAND_ICONS = (
    (('REDMI', 'XIAOMI'), 'XIAOMI.webp'),
    (('AOC',), 'AOC.png'),
    (('EDY',), 'EDY.png'),
    (('MAC', 'APPLE'), 'Apple.png'),
    (('LENOVO',), 'Lenovo.webp'),
)

DEVICE_FIELDS = 'number, spec, sn, department, name, cpu, mem, disk, gpu'


def asset_prefix(device_type):
    """台账编码前缀：租赁台式主机为 ZL，其余为 DZ。"""
    return CODE_PREFIX_RENTAL if device_type == RENTAL_DESKTOP_TYPE else CODE_PREFIX_DEFAULT


def initial_status(device_type):
    """台账新增时 inventory 的初始资产状态。"""
    return INITIAL_STATUS_RENTAL if device_type == RENTAL_DESKTOP_TYPE else INITIAL_STATUS_DEFAULT


def requires_config(device_type):
    """该设备类型是否必须填写硬件配置（CPU / 内存 / 硬盘 / 显卡）。

    资产登记与单据新增共用同一判定；电脑类（含租赁台式主机）的配置会写入
    device_list 的 cpu / mem / disk / gpu，资产登记 / 变更页据此展示。
    """
    return device_type in CONFIG_TYPES


def yymm_from_month(value):
    """'YYYY-MM' / date / datetime -> 'YYMM'（台账编号年月码），空值回退为当前月。"""
    if hasattr(value, 'strftime'):
        return value.strftime('%y%m')
    text = (value or '').strip()
    if not text:
        return datetime.now().strftime('%y%m')
    digits = text.replace('-', '')
    if len(digits) >= 6 and digits[:6].isdigit():
        return digits[2:6]
    raise ValueError('资产年月格式应为 YYYY-MM')


def year_code(year):
    """台账编号中的两位年份码，如 2026 -> '26'。"""
    return str(int(year))[-2:]


def date_str(value):
    """date/datetime -> 'YYYY-MM-DD'，空值返回 ''。"""
    if hasattr(value, 'strftime'):
        return value.strftime('%Y-%m-%d')
    return value or ''


def next_asset_numbers(cursor, device_type, yymm, quantity):
    """接续该月已有最大序号，生成 quantity 个台账编码。

    登记（asset.py）与单据下推（order.py）共用本函数，避免编码规则各写一份。
    cursor 需为 dictionary=True。注意：本函数只负责取号，并发下的唯一性
    由 device_list.number 的唯一索引兜底（scripts/migrate_asset_register.py）。

    该月剩余序号不够时抛 ValueError，由调用方转成 400。
    """
    if quantity <= 0:
        return []
    prefix = asset_prefix(device_type)
    cursor.execute(
        "SELECT number FROM device_list WHERE number LIKE %s AND LENGTH(number) = %s "
        "ORDER BY number DESC LIMIT 1",
        (f"{prefix}{yymm}%", CODE_LENGTH)
    )
    row = cursor.fetchone()
    number = row['number'] if row else ''
    next_seq = int(number[-3:]) + 1 if number and number[-3:].isdigit() else 1
    if next_seq + quantity - 1 > MAX_MONTHLY_SEQUENCE:
        raise ValueError(
            f'{yymm} 批次编码序号不足：已用到 {next_seq - 1}，'
            f'每月上限 {MAX_MONTHLY_SEQUENCE} 个，无法再生成 {quantity} 个'
        )
    return [f"{prefix}{yymm}{next_seq + i:03d}" for i in range(quantity)]


def insert_ledger_assets(cursor, assets, register_date):
    """批量写入台账：device_list 每资产一行 + inventory 追加一条入库流转记录。

    ``assets`` 为 dict 列表，必须包含 number / type / spec / department / name，
    可选 sn / cpu / mem / disk / gpu / status（缺省按类型取 :func:`initial_status`）。
    inventory.id 为 AUTO_INCREMENT（存量库用 scripts/migrate_inventory_autoincrement.py
    迁移），逐行插入并用 lastrowid 回写，不再应用层 MAX(id)+1 取号（并发会撞主键）。
    cursor 需为 dictionary=True，事务由调用方 commit。

    返回写入的资产编码列表。
    """
    if not assets:
        return []

    device_rows = []
    for item in assets:
        device_rows.append((
            item['type'], item['number'], item.get('spec') or '',
            item.get('department') or '', item.get('name') or '',
            item.get('sn') or '', item.get('cpu') or '', item.get('mem') or '',
            item.get('disk') or '', item.get('gpu') or '',
        ))

    cursor.executemany(
        "INSERT INTO device_list (type, number, spec, department, name, sn, cpu, mem, disk, gpu) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
        device_rows
    )
    for item in assets:
        cursor.execute(
            "INSERT INTO inventory (number, department, site, type, datetime, status, tag, notice, attachment_urls) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (item['number'], item.get('department') or '', item.get('name') or '',
             item['type'], register_date,
             item.get('status') or initial_status(item['type']), INITIAL_TAG, '', '')
        )
    return [item['number'] for item in assets]


def latest_inventory_rows(cursor, numbers):
    """取一批资产编号各自最新的一条 inventory 流转记录，返回 {number: row}。

    inventory 是流转表（同一编号多行），任何「当前部门 / 使用人 / 状态」
    的读取都应经本函数，否则会拿到任意一条历史记录。
    """
    if not numbers:
        return {}
    placeholders = ','.join(['%s'] * len(numbers))
    cursor.execute(
        f"SELECT id, number, department, site, type, status, tag, notice, "
        f"DATE_FORMAT(datetime, '%Y-%m-%d') AS datetime "
        f"FROM inventory WHERE number IN ({placeholders}) ORDER BY number, datetime, id",
        tuple(numbers)
    )
    latest = {}
    for row in cursor.fetchall():
        latest[row['number']] = row  # 同一编号按日期升序，最后一条即最新
    return latest


def inventory_index(cursor, numbers=None):
    """inventory 按资产编号归并。

    返回 (latest, receive)：latest 为每个编号最新一条流转记录，
    receive 为最近一次领用类标签（入职/领用/更换）记录的日期。

    ``numbers`` 为 None 时扫全表（仅限确实需要全量口径的场景，如部门领用
    总览）；否则按编号集合下推 WHERE number IN (...) 过滤，避免看板详情类
    接口每次把全表加载进内存。
    """
    sql = "SELECT number, department, site, type, datetime, status, tag, notice FROM inventory"
    params = ()
    if numbers is not None:
        numbers = list(numbers)
        if not numbers:
            return {}, {}
        placeholders = ','.join(['%s'] * len(numbers))
        sql += f" WHERE number IN ({placeholders})"
        params = tuple(numbers)
    cursor.execute(sql, params)
    latest = {}
    receive = {}
    for row in cursor.fetchall():
        number = row['number']
        row_date = row['datetime'] or date.min
        prev = latest.get(number)
        if prev is None or row_date >= (prev['datetime'] or date.min):
            latest[number] = row
        if row['tag'] in METRIC_TAGS and row['datetime']:
            if number not in receive or row['datetime'] > receive[number]:
                receive[number] = row['datetime']
    return latest, receive


def fetch_devices(cursor, numbers):
    """按资产编码批量取台账行，返回 {number: row}。"""
    if not numbers:
        return {}
    placeholders = ','.join(['%s'] * len(numbers))
    cursor.execute(
        f"SELECT {DEVICE_FIELDS} FROM device_list WHERE number IN ({placeholders})",
        tuple(numbers)
    )
    return {r['number']: r for r in cursor.fetchall()}


def yymm_of(value):
    """date/datetime/'YYYY-MM' -> 'YYMM'，与台账编号第 3-6 位（年月码）对齐。"""
    if hasattr(value, 'strftime'):
        return value.strftime('%y%m')
    digits = (value or '').replace('-', '')
    return digits[2:6] if len(digits) >= 6 else ''


def purchased_count_until(cursor, device_type, year, yymm):
    """截至 yymm 当月：该年度台账中编号年月码不晚于 yymm 的设备数。"""
    cursor.execute(
        "SELECT COUNT(*) AS cnt FROM device_list "
        "WHERE type=%s AND SUBSTRING(number, 3, 2)=%s AND SUBSTRING(number, 3, 4) <= %s",
        (device_type, year_code(year), yymm)
    )
    return int(cursor.fetchone()['cnt'])


def is_mac_spec(spec):
    """规格型号是否为 Mac 机（含 mac 关键字，忽略大小写）。

    仅对 :data:`MAC_SPLIT_TYPES` 内的类型使用；订单与台账其规格型号包含
    MacBook / iMac / Mac mini / MAC 等字样时均命中。
    """
    return MAC_SPEC_KEYWORD in (spec or '').lower()


def _in_stock_rows(cursor, device_type, as_of, mac=None):
    """口径核心：截至 as_of 在库的资产（最新流转行，按编号去重）。

    取不晚于 as_of 的最后一条流转记录判断：标签为入库视为在库；
    as_of 之前尚无流转记录的资产视为尚未入账，不计入。

    ``mac`` 仅对台式主机 / 笔记本电脑有意义（规格含 mac 关键字）：
    True 只统计 Mac 机，False 排除之，None 不区分（全口径）；
    其余类型忽略该参数，始终全口径。

    规格存在 device_list（与 inventory 排序规则不一致，SQL JOIN 会报
    1267 Illegal mix of collations），因此拆两次单表查询、Python 侧对齐；
    仅 mac 过滤时才查规格，全口径不增加额外查询。
    """
    cursor.execute(
        "SELECT number, datetime, tag FROM inventory WHERE type=%s AND datetime <= %s",
        (device_type, as_of)
    )
    latest = {}
    for row in cursor.fetchall():
        prev = latest.get(row['number'])
        if prev is None or (row['datetime'] or date.min) >= (prev['datetime'] or date.min):
            latest[row['number']] = row
    rows = list(latest.values())
    rows = [r for r in rows if r['tag'] in STOCK_TAGS]
    threshold = STOCK_TYPE_THRESHOLDS.get(device_type)
    if threshold:
        rows = [r for r in rows if r['number'] >= threshold]
    if mac is not None and device_type in MAC_SPLIT_TYPES:
        cursor.execute(
            "SELECT number, spec FROM device_list WHERE type=%s",
            (device_type,)
        )
        specs = {r['number']: (r['spec'] or '') for r in cursor.fetchall()}
        # 台账里存在但 device_list 没有的资产（specs 缺项）视为非 Mac
        rows = [r for r in rows if is_mac_spec(specs.get(r['number'])) == mac]
    return rows


def stock_count_until(cursor, device_type, as_of, mac=None):
    """截至 as_of 当日处于在库状态的资产数（口径见 :func:`_in_stock_rows`）。"""
    return len(_in_stock_rows(cursor, device_type, as_of, mac))


def stock_counts_by_type(cursor, device_types, as_of):
    """一次窗口查询批量算出多类型在库数，口径与 :func:`stock_count_until` 一致。

    返回 ``{(type, mac): 数量}``：非 Mac 拆分类型 mac 恒为 ``None``；
    Mac 拆分类型（:data:`MAC_SPLIT_TYPES`）按 ``True / False`` 分桶。

    ``list_orders`` 每次请求会对每个出现过的 (类型, Mac池) 调一次
    :func:`stock_count_until`，而它把该类型全部流转历史拉进 Python 逐行归并
    ——库存按年线性增长时这是看板最重的路径。这里把「每个资产最新一条流转」
    下推到 SQL 窗口函数（(type, number) 分区，datetime/id 倒序取第一行，
    与 Python 归并的「并列取后写入」语义一致），阈值与 Mac 规格过滤仍在
    Python 侧复用同一套常量，保证两种实现口径完全一致。
    MySQL < 8.0 无窗口函数时自动回退逐类型 Python 归并。
    """
    types = sorted(set(device_types))
    if not types:
        return {}

    placeholders = ','.join(['%s'] * len(types))
    rows = None
    try:
        cursor.execute(
            "SELECT type, number, tag FROM ("
            "  SELECT type, number, tag,"
            "         ROW_NUMBER() OVER (PARTITION BY type, number"
            "                           ORDER BY datetime DESC, id DESC) AS rn"
            "  FROM inventory WHERE type IN (" + placeholders + ") AND datetime <= %s"
            ") t WHERE rn = 1",
            (*types, as_of)
        )
        rows = cursor.fetchall()
    except Error:
        # 旧版 MySQL（< 8.0，无窗口函数）：回退逐类型 Python 归并，口径不变
        rows = []
        for t in types:
            cursor.execute(
                "SELECT type, number, datetime, tag FROM inventory WHERE type=%s AND datetime <= %s",
                (t, as_of)
            )
            latest = {}
            for row in cursor.fetchall():
                prev = latest.get(row['number'])
                if prev is None or (row['datetime'] or date.min) >= (prev['datetime'] or date.min):
                    latest[row['number']] = row
            rows.extend(latest.values())

    # 在库 + 新机阈值过滤（阈值规则按类型，复用 _in_stock_rows 同一常量表）
    in_stock = {}
    for row in rows:
        if row['tag'] not in STOCK_TAGS:
            continue
        threshold = STOCK_TYPE_THRESHOLDS.get(row['type'])
        if threshold and (row['number'] or '') < threshold:
            continue
        in_stock.setdefault(row['type'], []).append(row)

    # Mac 拆分：一次查询取齐所有 Mac 拆分类型的规格映射（缺规格视为非 Mac）
    mac_types = [t for t in types if t in MAC_SPLIT_TYPES]
    specs = {}
    if mac_types:
        ph = ','.join(['%s'] * len(mac_types))
        cursor.execute(
            f"SELECT number, spec FROM device_list WHERE type IN ({ph})",
            tuple(mac_types)
        )
        specs = {r['number']: (r['spec'] or '') for r in cursor.fetchall()}

    counts = {}
    for t in types:
        if t in MAC_SPLIT_TYPES:
            counts[(t, True)] = 0
            counts[(t, False)] = 0
        else:
            counts[(t, None)] = 0
    for t, bucket in in_stock.items():
        if t in MAC_SPLIT_TYPES:
            for r in bucket:
                counts[(t, is_mac_spec(specs.get(r['number'])))] += 1
        else:
            counts[(t, None)] = len(bucket)
    return counts


def stock_detail_until(cursor, device_type, as_of, mac=None):
    """在库资产明细（下钻用），口径与 :func:`stock_count_until` 完全一致。

    每行带资产编码 / 规格 / 入库日期（最新一条入库类流转的日期）/ 保管部门 /
    保管人（在库资产通常挂在库存托管人名下）。单据类型不含租赁台式主机，
    SN 仅租赁机必填，故不返回。
    """
    rows = _in_stock_rows(cursor, device_type, as_of, mac)
    if not rows:
        return []
    # 规格 / 保管人来自 device_list；同样避免 SQL JOIN（collation 不一致）
    cursor.execute(
        "SELECT number, spec, department, name FROM device_list WHERE type=%s",
        (device_type,)
    )
    devices = {r['number']: r for r in cursor.fetchall()}
    items = []
    for r in rows:
        dev = devices.get(r['number']) or {}
        items.append({
            'number': r['number'],
            'spec': dev.get('spec') or '',
            'department': dev.get('department') or '',
            'owner': dev.get('name') or '',
            'stock_date': date_str(r['datetime']),
        })
    items.sort(key=lambda item: item['number'])
    return items


def card_state(device, receive_date, inv_row):
    """依据台账判断卡片状态：保管人名下或在库标签 -> 入库，否则视为已领用。"""
    owner = device['name'] or ''
    department = device['department'] or ''
    if not owner and not department:
        return CARD_UNASSIGNED
    if (department, owner) == (STOCK_CUSTODIAN_DEPT, STOCK_CUSTODIAN_NAME):
        return CARD_IN_STOCK
    if receive_date:
        return CARD_ISSUED
    if inv_row and inv_row.get('tag') in STOCK_TAGS:
        return CARD_IN_STOCK
    return CARD_ISSUED


def live_card_fields(device, receive_date, inv_row):
    """已绑定台账的卡片应展示的实时字段（读取时派生，不落库）。

    领取时间优先取最近一次领用类流转（入职/领用/更换）日期；
    从未领用（在库）时回退为最近一次入库类流转日期，即资产入库存放的时间。
    """
    stock_in = inv_row.get('datetime') if inv_row and inv_row.get('tag') in STOCK_TAGS else None
    return {
        'spec': device['spec'] or '',
        'sn': device['sn'] or '',
        'owner': device['name'] or '',
        'department': device['department'] or '',
        'receive_date': date_str(receive_date or stock_in),
        'card_status': card_state(device, receive_date, inv_row),
    }


def _metric_months(cursor):
    """有领用类流转发生的月份（YYYY-MM，倒序），供前端月份筛选选项。"""
    cursor.execute(
        "SELECT datetime FROM inventory WHERE tag IN ({}) AND datetime IS NOT NULL".format(
            ','.join(['%s'] * len(METRIC_TAGS))),
        tuple(METRIC_TAGS)
    )
    return sorted({date_str(r['datetime'])[:7] for r in cursor.fetchall()}, reverse=True)


def _device_type_map(cursor, numbers):
    """{number: type}；DEVICE_FIELDS 不含 type，按需单独取列。"""
    if not numbers:
        return {}
    placeholders = ','.join(['%s'] * len(numbers))
    cursor.execute(
        f"SELECT number, type FROM device_list WHERE number IN ({placeholders})",
        tuple(numbers)
    )
    return {row['number']: row['type'] for row in cursor.fetchall()}


def dept_usage_matrix(cursor, device_types=None, month_from=None, month_to=None):
    """部门 × 设备类型的领用矩阵与入职/领用/更换明细。

    两种口径：
    - 不带月份参数（``mode='current'``）：与资产变更页一致，以每个资产**最新一条**
      流转为准，最新标签属于 :data:`METRIC_TAGS` 即计为当前被领用；
    - 带月份参数（``mode='range'``）：按**流转发生次数**统计，[month_from, month_to]
      区间内每条入职/领用/更换记录计 1 次，同一资产区间内多次流转计多次。

    返回 ``types / departments / cells / details / months / mode / month_from / month_to``：
    ``cells[dept][type] = {'total': n, 'by_tag': {tag: n}}`` 供一级矩阵，
    ``details['dept|type'] = [{number, name, tag, date}]`` 供二级下钻。
    """
    types = list(device_types or USAGE_MATRIX_TYPES)
    months = _metric_months(cursor)
    if month_from and month_to:
        if month_from > month_to:
            month_from, month_to = month_to, month_from
        return _dept_usage_range(cursor, types, month_from, month_to, months)
    # 只有带领用类流转的编号才可能计入矩阵，先筛编号再取各自最新流转，避免全表扫描
    cursor.execute(
        "SELECT DISTINCT number FROM inventory WHERE tag IN ({})".format(
            ','.join(['%s'] * len(METRIC_TAGS))),
        tuple(METRIC_TAGS)
    )
    latest, _receive = inventory_index(cursor, [r['number'] for r in cursor.fetchall()])
    if not latest:
        return {'types': types, 'departments': [], 'cells': {}, 'details': {},
                'months': months, 'mode': 'current', 'month_from': '', 'month_to': ''}
    # DEVICE_FIELDS 不含 type，矩阵按需单独取列
    devices = _device_full_map(cursor, list(latest))
    cells = {}
    details = {}
    for number, inv in latest.items():
        tag = inv.get('tag') or ''
        if tag not in METRIC_TAGS:
            continue
        device = devices.get(number)
        if not device or device['type'] not in types:
            continue
        dept = inv.get('department') or device['department'] or '未分配'
        cell = cells.setdefault(dept, {}).setdefault(
            device['type'], {'total': 0, 'by_tag': {t: 0 for t in METRIC_TAGS}})
        cell['total'] += 1
        cell['by_tag'][tag] += 1
        details.setdefault(f'{dept}|{device["type"]}', []).append({
            'number': number,
            'name': inv.get('site') or device['name'] or '',
            'tag': tag,
            'date': date_str(inv.get('datetime')),
        })
    for items in details.values():
        items.sort(key=lambda item: (METRIC_TAGS.index(item['tag']), item['number']))
    return {
        'types': types,
        'departments': sorted(cells),
        'cells': cells,
        'details': details,
        'months': months,
        'mode': 'current',
        'month_from': '',
        'month_to': '',
    }


def _device_full_map(cursor, numbers):
    """{number: row(number,type,department,name)}，当前领用口径需要部门/使用人兜底。"""
    if not numbers:
        return {}
    placeholders = ','.join(['%s'] * len(numbers))
    cursor.execute(
        f"SELECT number, type, department, name FROM device_list WHERE number IN ({placeholders})",
        tuple(numbers)
    )
    return {row['number']: row for row in cursor.fetchall()}


def _dept_usage_range(cursor, types, month_from, month_to, months):
    """月份区间口径：按流转发生次数统计（区间内每条领用类记录计 1 次）。"""
    cursor.execute(
        "SELECT number, department, site, datetime, tag FROM inventory "
        "WHERE tag IN ({}) AND datetime IS NOT NULL".format(
            ','.join(['%s'] * len(METRIC_TAGS))),
        tuple(METRIC_TAGS)
    )
    rows = [r for r in cursor.fetchall()
            if month_from <= date_str(r['datetime'])[:7] <= month_to]
    cells = {}
    details = {}
    if rows:
        devices = _device_type_map(cursor, {r['number'] for r in rows})
        for row in rows:
            dtype = devices.get(row['number'])
            if not dtype or dtype not in types:
                continue
            dept = row['department'] or '未分配'
            cell = cells.setdefault(dept, {}).setdefault(
                dtype, {'total': 0, 'by_tag': {t: 0 for t in METRIC_TAGS}})
            cell['total'] += 1
            cell['by_tag'][row['tag']] += 1
            details.setdefault(f'{dept}|{dtype}', []).append({
                'number': row['number'],
                'name': row['site'] or '',
                'tag': row['tag'],
                'date': date_str(row['datetime']),
            })
    for items in details.values():
        items.sort(key=lambda item: item['date'], reverse=True)
    return {
        'types': types,
        'departments': sorted(cells),
        'cells': cells,
        'details': details,
        'months': months,
        'mode': 'range',
        'month_from': month_from,
        'month_to': month_to,
    }
