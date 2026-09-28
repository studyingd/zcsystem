"""资产申请页面路由。

看板已重构为「单据视图」，业务接口全部在 app/order.py；
台账口径与派生逻辑集中在 app/ledger.py。
"""

import logging

from flask import Blueprint, redirect, render_template, session, url_for

dashboard_bp = Blueprint('dashboard', __name__)
logger = logging.getLogger(__name__)


@dashboard_bp.route('/dashboard')
def dashboard_page():
    # 登录用户直接进入管理视图（可下推/编辑/改预算），匿名仅只读
    logged_in = bool(session.get('logged_in'))
    return render_template(
        'dashboard.html',
        active_nav='dashboard',
        logged_in=logged_in,
        admin=logged_in,
    )


@dashboard_bp.route('/dashboard/admin')
def dashboard_admin():
    # 管理视图可新增/删除单据、下推资产卡片、改预算，必须登录后进入
    if not session.get('logged_in'):
        return redirect(url_for('auth.login'))
    return render_template('dashboard.html', active_nav='dashboard', logged_in=True, admin=True)
