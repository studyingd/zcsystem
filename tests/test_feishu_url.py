"""feishu.parse_bitable_url 的纯函数单测（不连网络、不需要凭据）。"""

import pytest

from app import feishu


def test_wiki_url_with_table_and_view():
    wiki, app_token, table_id, view_id = feishu.parse_bitable_url(
        'https://seeed.feishu.cn/wiki/QN6cwWmXxiEA3vkUO6Vcxm10nkc?table=tblR6fmEVzTGJxfR&view=vewABC123')
    assert wiki == 'QN6cwWmXxiEA3vkUO6Vcxm10nkc'
    assert app_token is None
    assert table_id == 'tblR6fmEVzTGJxfR'
    assert view_id == 'vewABC123'


def test_base_url_gives_app_token_directly():
    # /base/ 形式本身就是 app_token，可省掉一次 wiki 节点解析请求
    wiki, app_token, table_id, view_id = feishu.parse_bitable_url(
        'https://seeed.feishu.cn/base/XojDbPJiGaXEYJs3353cMLReneb?table=tblR6fmEVzTGJxfR')
    assert wiki is None
    assert app_token == 'XojDbPJiGaXEYJs3353cMLReneb'
    assert table_id == 'tblR6fmEVzTGJxfR'
    assert view_id is None


def test_bitable_larksuite_and_scheme_less_urls():
    assert feishu.parse_bitable_url(
        'https://seeed.feishu.cn/bitable/XojDbPJiGaXEYJs3353cMLReneb')[1] == 'XojDbPJiGaXEYJs3353cMLReneb'
    assert feishu.parse_bitable_url(
        'https://seeed.larksuite.com/wiki/QN6cwWmXxiEA3vkUO6Vcxm10nkc')[0] == 'QN6cwWmXxiEA3vkUO6Vcxm10nkc'
    assert feishu.parse_bitable_url(
        'seeed.feishu.cn/wiki/QN6cwWmXxiEA3vkUO6Vcxm10nkc?table=tblR6fmEVzTGJxfR')[2] == 'tblR6fmEVzTGJxfR'


def test_link_without_table_param_leaves_table_none():
    wiki, _, table_id, view_id = feishu.parse_bitable_url(
        'https://seeed.feishu.cn/wiki/QN6cwWmXxiEA3vkUO6Vcxm10nkc?from=from_copylink')
    assert wiki == 'QN6cwWmXxiEA3vkUO6Vcxm10nkc'
    assert table_id is None and view_id is None


def test_empty_url_returns_all_none():
    assert feishu.parse_bitable_url('') == (None, None, None, None)
    assert feishu.parse_bitable_url(None) == (None, None, None, None)


def test_non_bitable_link_raises():
    with pytest.raises(ValueError):
        feishu.parse_bitable_url('https://seeed.feishu.cn/docx/AbCdEfGhIjKlMnOp')
