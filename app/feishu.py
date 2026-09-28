"""飞书多维表格接入：实时统计各设备类型「未发放」的申请数量（不落库、不快照）。

数据流（单向，只读飞书）::

    飞书 wiki 节点(QN6cw...) → bitable → 申请记录列表
        每条记录: 申请设备(类型) + 数量 + 申请日期 + 发放状态
    单据的申请数量 = 申请设备为该类型、且发放状态为「未发放」的申请记录数量合计
    （即当前未满足的申请需求），每次读看板/下钻时实时计算，随后续变化而变化。

所需环境变量（.env）::

    FEISHU_APP_ID        自建应用 App ID（需开通「知识库/多维表格」只读权限）
    FEISHU_APP_SECRET    自建应用 App Secret
    FEISHU_BITABLE_URL   多维表格链接（推荐）：直接粘贴浏览器地址即可，自动解析
                         …/wiki/<节点> 或 …/base/<app_token>，并读取链接里的 table 参数
    FEISHU_WIKI_TOKEN    多维表所在 wiki 节点 token（默认资产申请表链接里的节点）
    FEISHU_TABLE_ID      数据表 table_id（缺省取第一张表）
    FEISHU_DEVICE_FIELD  申请设备字段名（默认「申请设备」）
    FEISHU_QTY_FIELD     数量字段名（默认「申请数量」，缺失时按每条 1 台计）
    FEISHU_DATE_FIELD    申请日期字段名（缺省自动探测日期类型字段）
    FEISHU_CACHE_TTL     缓存新鲜期秒数（默认 120）；过期由后台线程刷新，请求不等待
"""

import logging
import os
import re
import ssl
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime
from json import dumps as json_dumps
from json import loads as json_loads
from urllib.parse import parse_qs, urlparse

from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

FEISHU_BASE = 'https://open.feishu.cn'

_DEFAULT_WIKI_TOKEN = 'QN6cwWmXxiEA3vkUO6Vcxm10nkc'
_TS_MIN, _TS_MAX = 1262275200000, 4102444800000   # 2010-01-01 ~ 2100-01-01（毫秒）

# 企业内网常有 SSL 中间人代理（自签证书链）：默认校验失败时降级为不校验证书
# （仅影响飞书只读拉取，不涉及敏感写入）。改懒加载：导入阶段不联网，
# 单测/CI 与冷启动都不会被这一步阻塞（首次请求时才探测）。
_SSL_CTX = None


def _ssl_context():
    """首次请求时探测并缓存 SSL 上下文（自签代理时降级为不校验）。"""
    global _SSL_CTX
    if _SSL_CTX is None:
        ctx = ssl.create_default_context()
        try:
            urllib.request.urlopen(urllib.request.Request('https://open.feishu.cn'), timeout=3)
        except Exception:
            ctx = ssl._create_unverified_context()
        _SSL_CTX = ctx
    return _SSL_CTX

_TOKEN_CACHE = {'token': None, 'expire_at': 0}
_APP_TOKEN_CACHE = {'app_token': None}


class FeishuError(Exception):
    """飞书接口异常（凭据缺失 / 接口报错等），同步时静默降级。"""


# 申请设备字段名（默认「申请设备」）、数量字段名（默认「申请数量」）、
# 日期字段名（缺省自动探测）；发放状态字段「发放状态」，值为「未发放」的才计入统计
_STATUS_FIELD = '发放状态'
_STATUS_PENDING = '未发放'


def _conf(key, default=None):
    value = os.environ.get(key, '').strip()
    return value or default


def credentials_ready():
    return bool(_conf('FEISHU_APP_ID') and _conf('FEISHU_APP_SECRET'))


# ---------- 基础请求 ----------
def _request(method, path, payload=None, token=None, timeout=8):
    url = f'{FEISHU_BASE}{path}'
    headers = {'Content-Type': 'application/json; charset=utf-8'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    data = json_dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ssl_context()) as resp:
            body = json_loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode('utf-8', 'ignore')[:300]
        raise FeishuError(f'飞书接口 HTTP {exc.code}: {detail}') from None
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise FeishuError(f'飞书接口不可达: {exc}') from None
    if body.get('code') not in (0, None):
        raise FeishuError(f"飞书接口错误 {body.get('code')}: {body.get('msg')}")
    # token 类接口（auth/v3）成功时字段直接在顶层、无 data 包装；其余接口在 data 里
    return body.get('data') or body


def tenant_access_token():
    """自建应用 tenant_access_token，缓存至过期前 60 秒。"""
    if not credentials_ready():
        raise FeishuError('未配置 FEISHU_APP_ID / FEISHU_APP_SECRET')
    now = time.time()
    if _TOKEN_CACHE['token'] and now < _TOKEN_CACHE['expire_at']:
        return _TOKEN_CACHE['token']
    data = _request('POST', '/open-apis/auth/v3/tenant_access_token/internal', {
        'app_id': _conf('FEISHU_APP_ID'),
        'app_secret': _conf('FEISHU_APP_SECRET'),
    })
    token = data.get('tenant_access_token')
    if not token:
        raise FeishuError('飞书未返回 tenant_access_token')
    _TOKEN_CACHE['token'] = token
    _TOKEN_CACHE['expire_at'] = now + max(int(data.get('expire', 3600)) - 60, 60)
    return token


# ---------- 多维表格读取 ----------
_URL_KIND_RE = re.compile(r'/(wiki|base|bitable)/([A-Za-z0-9]{8,})')


def parse_bitable_url(url):
    """从多维表格链接解析 (wiki_token, app_token, table_id, view_id)。

    支持（只看路径，域名不限，feishu.cn / larksuite.com 均可）::

        https://<tenant>.feishu.cn/wiki/<wiki_token>?table=<table_id>&view=<view_id>
        https://<tenant>.feishu.cn/base/<app_token>?table=<table_id>&view=<view_id>
        https://<tenant>.feishu.cn/bitable/<app_token>?table=<table_id>&view=<view_id>

    /wiki/ 拿到的是 wiki 节点 token（还要换成 app_token）；/base/、/bitable/
    本身就是 app_token，可省一次接口调用。识别不出 token 时抛 ValueError。
    """
    url = (url or '').strip()
    if not url:
        return None, None, None, None
    parsed = urlparse(url if '//' in url else 'https://' + url)
    match = _URL_KIND_RE.search(parsed.path)
    if not match:
        raise ValueError(f'无法从链接解析多维表格 token（应形如 …/wiki/xxx 或 …/base/xxx）：{url}')
    kind, token = match.group(1), match.group(2)
    query = parse_qs(parsed.query)
    table_id = (query.get('table') or [''])[0].strip() or None
    view_id = (query.get('view') or [''])[0].strip() or None
    return (token if kind == 'wiki' else None,
            token if kind in ('base', 'bitable') else None,
            table_id, view_id)


def _url_parts():
    """FEISHU_BITABLE_URL 的解析结果（未配置时全为 None）。"""
    url = _conf('FEISHU_BITABLE_URL')
    return parse_bitable_url(url) if url else (None, None, None, None)


def describe_target():
    """当前配置解析结果（排障用）：token 来源 / app_token / 数据表及来源。"""
    url_wiki, url_app, url_table, _view = _url_parts()
    if url_app:
        source, wiki_token = 'FEISHU_BITABLE_URL(/base 或 /bitable)', None
    elif url_wiki:
        source, wiki_token = 'FEISHU_BITABLE_URL(/wiki)', url_wiki
    elif _conf('FEISHU_WIKI_TOKEN'):
        source, wiki_token = 'FEISHU_WIKI_TOKEN', _conf('FEISHU_WIKI_TOKEN')
    else:
        source, wiki_token = '内置默认资产申请表节点', _DEFAULT_WIKI_TOKEN
    app_token = resolve_bitable_app_token()
    if _conf('FEISHU_TABLE_ID'):
        table_source = 'FEISHU_TABLE_ID'
    elif url_table:
        table_source = '链接里的 table 参数'
    else:
        table_source = '多维表第一张表'
    return {'token_source': source, 'wiki_token': wiki_token, 'app_token': app_token,
            'table_id': _default_table_id(app_token), 'table_id_source': table_source}


def resolve_bitable_app_token():
    """解析出 bitable app_token（缓存）：链接优先，其次 wiki 节点 token。"""
    if _APP_TOKEN_CACHE['app_token']:
        return _APP_TOKEN_CACHE['app_token']
    url_wiki, url_app, _table, _view = _url_parts()
    if url_app:
        _APP_TOKEN_CACHE['app_token'] = url_app
        return url_app
    node_token = url_wiki or _conf('FEISHU_WIKI_TOKEN', _DEFAULT_WIKI_TOKEN)
    data = _request('GET', f'/open-apis/wiki/v2/spaces/get_node?token={node_token}&obj_type=wiki',
                    token=tenant_access_token())
    node = (data.get('node') or {})
    if node.get('obj_type') != 'bitable':
        raise FeishuError(
            f'wiki 节点不是多维表格（obj_type={node.get("obj_type")}）；请贴多维表格自身的链接（…/wiki/… 或 …/base/…）')
    app_token = node.get('obj_token')
    if not app_token:
        raise FeishuError('wiki 节点未返回 obj_token')
    _APP_TOKEN_CACHE['app_token'] = app_token
    return app_token


def _list_tables(app_token):
    data = _request('GET', f'/open-apis/bitable/v1/apps/{app_token}/tables?page_size=100',
                    token=tenant_access_token())
    return data.get('items') or []


def _list_records(app_token, table_id):
    """分页拉取全部记录，返回 [{fields: {...}}, ...]。"""
    records, page_token = [], ''
    while True:
        path = (f'/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records'
                f'?page_size=500' + (f'&page_token={page_token}' if page_token else ''))
        data = _request('GET', path, token=tenant_access_token())
        records.extend(data.get('items') or [])
        if not data.get('has_more'):
            break
        page_token = data.get('page_token') or ''
        if not page_token:
            break
    return records


# ---------- 字段解析 ----------
def _field_text(value):
    """多维表格字段值 -> 文本：数字直接返回，富文本取 text 段拼接。"""
    if value is None:
        return ''
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        parts = []
        for seg in value:
            if isinstance(seg, dict):
                parts.append(str(seg.get('text') or seg.get('name') or ''))
            else:
                parts.append(str(seg))
        return ''.join(parts).strip()
    if isinstance(value, dict):   # 人员等复杂类型
        return str(value.get('text') or value.get('name') or '')
    return str(value)


def _field_number(value):
    text = _field_text(value)
    if not text:
        return None
    match = re.search(r'\d+', text.replace(',', ''))
    if not match:
        return None
    return int(match.group())


def _parse_ts(value):
    """飞书日期字段值（毫秒时间戳/秒时间戳/日期字符串）-> 本地 naive datetime。"""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        ts = float(value)
        if _TS_MIN <= ts <= _TS_MAX:
            return datetime.fromtimestamp(ts / 1000)
        if _TS_MIN // 1000 <= ts <= _TS_MAX // 1000:
            return datetime.fromtimestamp(ts)
        return None
    if isinstance(value, str):
        for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%Y-%m-%d',
                    '%Y/%m/%d %H:%M:%S', '%Y/%m/%d %H:%M', '%Y/%m/%d', '%Y.%m.%d'):
            try:
                return datetime.strptime(value.strip(), fmt)
            except ValueError:
                continue
    return None


def _detect_date_field(records, sample=100):
    """自动探测日期字段：值能解析为时间戳的字段中，优先名字含「日期/时间」且命中率最高者。"""
    counts = {}
    for record in records[:sample]:
        for name, value in (record.get('fields') or {}).items():
            if _parse_ts(value) is not None:
                counts[name] = counts.get(name, 0) + 1
    if not counts:
        return None
    named = {k: v for k, v in counts.items() if '日期' in k or '时间' in k}
    pool = named or counts
    return max(pool, key=pool.get)


# ---------- 申请记录统计 ----------
# 缓存策略（stale-while-revalidate）：请求线程只读缓存，飞书拉取一律走后台线程。
# 实测飞书接口在该网络出口单次 3~5 秒（TLS 代理 + 全量分页），若放在请求关键路径，
# 看板首屏每次缓存过期都要卡这么久；改为后台刷新后，接口耗时回到毫秒级。
_APPS_CACHE = {'apps': None, 'dated': False, 'at': 0.0, 'error_at': 0.0}
_REFRESH = {'running': False}
_REFRESH_LOCK = threading.Lock()
_DEFAULT_CACHE_TTL = 120     # 数据新鲜期（秒），可用 FEISHU_CACHE_TTL 覆盖
_REFRESH_BACKOFF = 30        # 刷新失败后的重试间隔（秒），避免失败时被反复触发
_TABLE_CACHE = {'table_id': None}


def cache_snapshot():
    """(是否有可用数据, 是否有后台刷新在进行)，供接口层决定前端是否稍后自动重试。"""
    return _APPS_CACHE['apps'] is not None, bool(_REFRESH['running'])


def _cache_ttl():
    try:
        return max(int(_conf('FEISHU_CACHE_TTL', _DEFAULT_CACHE_TTL)), 10)
    except (TypeError, ValueError):
        return _DEFAULT_CACHE_TTL


def _default_table_id(app_token):
    """缺省数据表 table_id（取到后缓存，避免每次刷新多一次 list_tables 往返）。"""
    if _TABLE_CACHE['table_id']:
        return _TABLE_CACHE['table_id']
    _wiki, _app, url_table, _view = _url_parts()
    table_id = _conf('FEISHU_TABLE_ID') or url_table
    if not table_id:
        tables = _list_tables(app_token)
        if not tables:
            raise FeishuError('多维表格中没有数据表')
        table_id = tables[0]['table_id']
    _TABLE_CACHE['table_id'] = table_id
    return table_id


def _fetch_sync():
    """同步拉取飞书表并写入缓存。耗时数秒，只应在后台线程 / 启动预热中调用。"""
    device_field = _conf('FEISHU_DEVICE_FIELD', '申请设备')
    qty_field = _conf('FEISHU_QTY_FIELD', '申请数量')
    date_field = _conf('FEISHU_DATE_FIELD')

    app_token = resolve_bitable_app_token()
    table_id = _default_table_id(app_token)
    records = _list_records(app_token, table_id)
    if not date_field:
        date_field = _detect_date_field(records)

    applications = []
    for record in records:
        fields = record.get('fields') or {}
        dtype = _field_text(fields.get(device_field))
        if not dtype:
            continue
        qty = _field_number(fields.get(qty_field))
        if qty is None:
            qty = 1   # 无数量字段时每条按 1 台计
        applications.append({
            'type': dtype,
            'qty': qty,
            'ts': _parse_ts(fields.get(date_field)) if date_field else None,
            # 下钻明细字段（字段名以实际多维表为准）
            'no': _field_text(fields.get('申请单号')),
            'user': _field_text(fields.get('需求人')),
            'department': _field_text(fields.get('部门')),
            'reason': _field_text(fields.get('申请理由')),
            # 发放状态：仅「未发放」（含空值视为未处理）计入统计
            'pending': not _field_text(fields.get(_STATUS_FIELD)) or
                        _field_text(fields.get(_STATUS_FIELD)) == _STATUS_PENDING,
        })
    _APPS_CACHE['apps'] = applications
    _APPS_CACHE['dated'] = bool(date_field)
    _APPS_CACHE['at'] = time.time()
    _APPS_CACHE['error_at'] = 0.0
    return applications, bool(date_field)


def refresh_async():
    """触发一次后台刷新（已有刷新在跑则跳过），立即返回。"""
    if not credentials_ready():
        return False
    with _REFRESH_LOCK:
        if _REFRESH['running']:
            return False
        _REFRESH['running'] = True

    def worker():
        try:
            _fetch_sync()
        except Exception as exc:   # 后台线程必须自己兜住异常，否则只留 traceback
            _APPS_CACHE['error_at'] = time.time()
            logger.warning('飞书申请数据后台刷新失败：%s', exc)
        finally:
            with _REFRESH_LOCK:
                _REFRESH['running'] = False

    threading.Thread(target=worker, daemon=True, name='feishu-refresh').start()
    return True


def warm_up():
    """启动预热：让首个打开看板的用户不必等飞书接口。"""
    return refresh_async()


def fetch_applications():
    """读取申请记录：请求线程不等待飞书（过期返回旧值并触发后台刷新）。

    - 缓存新鲜：直接返回；
    - 缓存过期：返回旧值 + 后台刷新（下次请求即拿到新值）；
    - 无缓存（服务刚启动 / 预热未完成）：触发后台刷新并抛 FeishuError，
      调用方降级为 "-"，前端会在几秒后自动重试。

    返回 (applications, dated)：
      applications: [{'type': 设备类型, 'qty': 数量, 'ts': 申请日期或 None,
                      'no': 申请单号, 'user': 需求人, 'department': 部门, 'reason': 申请理由}, ...]
      dated:        是否解析到日期字段（仅影响明细里能否显示申请日期）
    """
    if _APPS_CACHE['apps'] is not None:
        if time.time() - _APPS_CACHE['at'] >= _cache_ttl() \
                and time.time() - _APPS_CACHE['error_at'] >= _REFRESH_BACKOFF:
            refresh_async()
        return _APPS_CACHE['apps'], _APPS_CACHE['dated']
    if not credentials_ready():
        # 凭据没配时不要误报"正在加载"：明确告诉调用方飞书接入未启用
        raise FeishuError('未配置 FEISHU_APP_ID / FEISHU_APP_SECRET，申请数量不可用')
    if time.time() - _APPS_CACHE['error_at'] >= _REFRESH_BACKOFF:
        refresh_async()
    raise FeishuError('飞书申请数据正在后台加载，请稍后刷新')


def _totals(applications):
    """按类型汇总「未发放」申请数量（空值视为未处理也计入）。"""
    totals = {}
    for app in applications:
        if not app.get('pending'):
            continue
        totals[app['type']] = totals.get(app['type'], 0) + app['qty']
    return totals


def current_apply_totals():
    """当前各设备类型的未发放申请数量（实时口径，无时点截取）。

    返回 {设备类型: 数量}：多维表中有记录的类型都会出现（无未发放时为 0）；
    完全无记录的类型不在返回中（前端显示 "-"）。飞书不可达时抛 FeishuError。
    """
    applications, _ = fetch_applications()
    totals = _totals(applications)
    return {app['type']: totals.get(app['type'], 0) for app in applications}


def apply_detail(device_type):
    """某设备类型当前「未发放」的申请明细（下钻弹窗用，按申请日期倒序）。

    返回 items：含申请单号/需求人/部门/申请理由/日期/数量，与列表中的申请数量实时口径一致。
    """
    applications, _ = fetch_applications()
    items = []
    for app in applications:
        if app['type'] != device_type or not app.get('pending'):
            continue
        items.append({
            'no': app.get('no') or '',
            'user': app.get('user') or '',
            'department': app.get('department') or '',
            'reason': app.get('reason') or '',
            'date': app['ts'].strftime('%Y-%m-%d') if app['ts'] else '',
            'qty': app['qty'],
        })
    items.sort(key=lambda x: x['date'], reverse=True)
    return items
