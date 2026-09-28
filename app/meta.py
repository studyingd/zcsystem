"""前端词表下发（meta）。

资产状态 / 流转标签 / 部门 / 卡片状态的词表以前在前端 ``static/js/utils.js`` 里
各存一份，后端改了口径前端不会跟着变。现在统一由本模块从 :mod:`app.ledger`
组装，两种下发方式：

- 模板渲染：``create_app`` 注册的 context processor 把 :func:`frontend_meta`
  注入所有模板，``base.html`` 输出为 ``<script type="application/json" id="zcMeta">``，
  页面加载即可用，无额外请求、无渲染竞态；
- 接口：``GET /api/meta`` 供不经过 base.html 的页面或外部脚本使用。

词表不含敏感信息（看板对匿名用户只读开放），因此接口不要求登录。
"""

import logging

from flask import Blueprint, jsonify

from . import ledger

meta_bp = Blueprint('meta', __name__)
logger = logging.getLogger(__name__)


def frontend_meta():
    """页面渲染与 /api/meta 共用的词表负载。"""
    return {
        'statuses': list(ledger.INVENTORY_STATUSES),
        'tags': list(ledger.ALL_TAGS),
        'departments': list(ledger.DEPARTMENTS),
        'card_statuses': list(ledger.CARD_STATUSES),
        'asset_types': list(ledger.ASSET_TYPES),
        'order_device_types': list(ledger.ORDER_DEVICE_TYPES),
        'config_types': list(ledger.CONFIG_TYPES),
        'custom_type': ledger.CUSTOM_TYPE_OPTION,
    }


@meta_bp.route('/api/meta')
def api_meta():
    """下发前端词表（只读，无需登录）。"""
    payload = frontend_meta()
    payload['status'] = 'success'
    return jsonify(payload)
