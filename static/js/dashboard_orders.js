/* 资产申请 - 单据视图
 * 单据列表 -> 单据详情 -> 下推资产卡片；今年已采购数量 -> 部门使用情况 -> 使用人明细。
 * 依赖 base.html 的 fetch 封装（自动带 CSRF token）与 utils.js 的 escapeHtml。
 */
(function () {
    'use strict';

    const ADMIN = typeof DASHBOARD_ADMIN !== 'undefined' && DASHBOARD_ADMIN;
    const $ = (id) => document.getElementById(id);

    // 预算设置：新增预算的设备类型默认候选，其余类型由用户自行输入
    const DEFAULT_BUDGET_TYPES = ['显示器', '笔记本电脑', '台式主机'];

    let META = {
        device_types: [], years: [], card_statuses: [],
        current_year: new Date().getFullYear(), current_month: ''
    };
    let ORDERS = [];
    // 单据列表分页：每页最多 10 条（数据仍全量拉取，仅前端分页；
    // 汇总条 / 导出始终针对全部筛选结果，与分页无关）
    const ORDER_PAGE_SIZE = 10;
    let ORDER_PAGE = 1;
    let ORDER_FILTER_SIG = '';
    let CURRENT_ORDER = null;
    let CURRENT_CARDS = [];
    let USAGE_CTX = null;
    let EDITING_ORDER_ID = null;
    let EDITING_CARD_ID = null;
    let BUDGET_CACHE = null;   // 预算面板最近一次接口响应，编辑/取消时本地重经不重新拉取
    let EDITING_BUDGET_ID = null;   // 预算表当前处于编辑态的行
    let APPLY_ORDER_ID = null;      // 申请明细最近一次打开的单据 id（失败重试用）

    // ---------- 通用工具 ----------
    function money(value) {
        const n = Number(value || 0);
        return '¥' + n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    // 弹窗统一走共享 modal.js（焦点陷阱 / 焦点归还 / aria 标注 / 入场动效）；
    // backdrop 不关闭，避免误点遮罩丢失表单内容（与原有行为一致）
    function showModal(id) { openModal($(id)); }
    function hideModal(id) { closeModal($(id)); }

    function toast(message, ok) {
        const box = document.createElement('div');
        box.className = 'float-msg ' + (ok === false ? 'float-msg-error' : 'float-msg-success');
        box.setAttribute('role', ok === false ? 'alert' : 'status');
        box.setAttribute('aria-live', 'polite');
        box.textContent = message;
        document.body.appendChild(box);
        setTimeout(() => box.classList.add('show'), 10);
        setTimeout(() => {
            box.classList.remove('show');
            setTimeout(() => box.remove(), 300);
        }, 2600);
    }

    function encodeParams(params) {
        // 只过滤 undefined/null，保留空串：预算保存需要区分「未传」（保留旧值）和「传空串」（恢复自动统计）
        return Object.keys(params)
            .filter(k => params[k] !== undefined && params[k] !== null)
            .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
            .join('&');
    }

    function getJson(url) {
        return fetch(url).then(r => r.json().catch(() => ({ status: 'error', message: `HTTP ${r.status}` })));
    }

    function postForm(url, data, method) {
        return fetch(url, {
            method: method || 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: encodeParams(data || {})
        }).then(r => r.json().catch(() => ({ status: 'error', message: `HTTP ${r.status}` })));
    }

    function loadingHtml(text) {
        return `<div class="modal-loading">${text || '加载中...'}</div>`;
    }

    /** 申请明细骨架屏：列宽与真实表格一致，避免加载完成时布局跳动 */
    function applyLoadingHtml() {
        const bar = '<span class="apply-skeleton-bar" aria-hidden="true"></span>';
        return `<div class="apply-skeleton" role="status" aria-live="polite">
                <span class="sr-only">申请明细加载中…</span>
                <div class="apply-skeleton-row apply-skeleton-head">${bar.repeat(4)}</div>
                ${`<div class="apply-skeleton-row">${bar.repeat(4)}</div>`.repeat(4)}
            </div>`;
    }

    /** 申请明细错误态：带重试入口（错误恢复路径） */
    function applyErrorHtml(message) {
        return `<div class="modal-error" role="alert">${escapeHtml(message || '加载失败，请重试')}
                <div class="modal-error-actions"><button type="button" class="mini-btn" data-action="apply-retry">重试</button></div>
            </div>`;
    }

    // ---------- 筛选与列表 ----------
    function fillFilters() {
        const yearSel = $('filterYear');
        yearSel.innerHTML = META.years.map(y =>
            `<option value="${y}"${y === META.current_year ? ' selected' : ''}>${y} 年</option>`).join('');
        const typeSel = $('filterType');
        // 筛选只列有单据的类型（order_types）；新增/编辑表单仍用全量 device_types
        const filterTypes = (META.order_types && META.order_types.length) ? META.order_types : META.device_types;
        typeSel.innerHTML = '<option value="">全部类型</option>' +
            filterTypes.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
    }

    function currentFilters() {
        return {
            year: $('filterYear').value,
            device_type: $('filterType').value,
            in_budget: $('filterBudget').value,
            pushed: $('filterPushed').value,
            reviewed: $('filterReview').value,
            keyword: $('filterKeyword').value.trim()
        };
    }

    // 顶栏导出跟随当前筛选条件（与列表同一套参数）
    function syncExportLink() {
        const link = $('topbarExport');
        if (!link) return;
        link.href = `/orders/export?${encodeParams(currentFilters())}`;
    }

    let FEISHU_RETRY = 0;

    // silent=true：自动重试时静默刷新，不闪"加载中"占位
    function loadOrders(silent) {
        syncExportLink();
        const tbody = $('orderTableBody');
        const colspan = 13;
        if (!silent) {
            FEISHU_RETRY = 0;
            tbody.innerHTML = `<tr><td colspan="${colspan}" class="table-loading">加载中...</td></tr>`;
            $('orderSummary').innerHTML = '';
        }

        getJson('/api/orders?' + encodeParams(currentFilters())).then(res => {
            if (res.status !== 'success') {
                tbody.innerHTML = `<tr><td colspan="${colspan}" class="table-error">${escapeHtml(res.message || '加载失败')}</td></tr>`;
                return;
            }
            // 筛选条件变化时回到第 1 页；编辑/下推等操作后的刷新留在当前页
            const sig = JSON.stringify(currentFilters());
            if (sig !== ORDER_FILTER_SIG) {
                ORDER_PAGE = 1;
                ORDER_FILTER_SIG = sig;
            }
            ORDERS = res.orders;
            const totalPages = Math.max(1, Math.ceil(ORDERS.length / ORDER_PAGE_SIZE));
            if (ORDER_PAGE > totalPages) ORDER_PAGE = totalPages;
            renderSummary(res.summary);
            renderOrderTable();
            renderOrderPager();
            // 飞书申请数量在后台加载中：几秒后自动补一次，避免用户手动刷新
            if (res.apply_loading && FEISHU_RETRY < 2) {
                FEISHU_RETRY += 1;
                setTimeout(() => loadOrders(true), 4000);
            } else if (!res.apply_loading) {
                FEISHU_RETRY = 0;
            }
        }).catch(() => {
            tbody.innerHTML = `<tr><td colspan="${colspan}" class="table-error">加载失败，请刷新重试</td></tr>`;
        });
    }

    function renderSummary(s) {
        if (!s) { $('orderSummary').innerHTML = ''; return; }
        const items = [
            ['单据数', `${s.order_count} 张`],
            ['设备数量', `${s.quantity} 台`],
            ['单据金额', money(s.amount)],
            ['预算内金额', money(s.in_budget_amount)],
            ['预算外金额', money(s.out_budget_amount)],
            ['已下推单据', `${s.pushed_count} 张`],
            ['资产卡片', `${s.card_count} 张`]
        ];
        $('orderSummary').innerHTML = items.map(([label, value]) =>
            `<div class="sum-item"><span class="sum-label">${label}</span><span class="sum-value">${value}</span></div>`
        ).join('');
    }

    function budgetCellHtml(budget, showSub = true) {
        if (!budget || !budget.configured) return '<span class="budget-none">未设置预算</span>';
        const level = budget.left < 0 ? 'neg' : (budget.percent >= 80 ? 'warn' : 'ok');
        return `<div class="budget-cell">
            <span class="budget-left ${level}">${money(budget.left)}</span>
            <div class="budget-bar"><i class="${level}" style="width:${Math.max(0, Math.min(100, budget.percent || 0))}%"></i></div>
            ${showSub ? `<span class="budget-sub">已用 ${money(budget.used)} / 预算 ${money(budget.total)}</span>` : ''}
        </div>`;
    }

    function orderRowHtml(o) {
        const cardCell = o.pushed
            ? `<span class="badge badge-done">已下推 ${o.card_count}/${o.quantity}</span>`
            : '<span class="badge badge-none">未下推</span>';
        const reviewCell = o.reviewed
            ? '<span class="badge badge-done">已审核</span>'
            : '<span class="badge badge-warn">未审核</span>';
        const applyCell = (o.apply_quantity === null || o.apply_quantity === undefined)
            ? '<span class="muted" title="飞书未配置、不可达或该类型暂无申请记录">-</span>'
            : `<button type="button" class="link-btn" data-action="apply-detail" data-id="${o.id}" title="查看构成此数量的申请记录明细">${o.apply_quantity}</button>`;
        return `<tr data-id="${o.id}">
            <td><button type="button" class="link-btn strong" data-action="detail" data-id="${o.id}">${escapeHtml(o.order_no)}</button></td>
            <td>${escapeHtml(o.order_date)}</td>
            <td>${escapeHtml(o.device_type)}</td>
            <td class="spec-cell" title="${escapeHtml(o.spec)}">${escapeHtml(o.spec) || '-'}</td>
            <td class="num">${o.quantity}</td>
            <td class="num amount">${money(o.amount)}</td>
            <td>${o.in_budget ? '<span class="badge badge-in">预算内</span>' : '<span class="badge badge-out">预算外</span>'}</td>
            <td>${budgetCellHtml(o.budget)}</td>
            <td class="num"><button type="button" class="link-btn" data-action="usage" data-id="${o.id}" title="查看该设备类型今年各部门使用情况">${o.purchased_this_year} 台</button></td>
            <td class="num"><button type="button" class="link-btn" data-action="stock-detail" data-id="${o.id}" title="查看在库资产明细">${o.stock_count} 台</button></td>
            <td class="num">${applyCell}</td>
            <td>${cardCell}</td>
            <td>${reviewCell}</td>
        </tr>`;
    }

    /** 审核状态切换（仅登录视图有入口）；完成后列表与详情一起刷新 */
    function setReview(orderId, reviewed) {
        postForm(`/api/orders/${orderId}/review`, { reviewed: String(reviewed) }).then(res => {
            if (res.status !== 'success') {
                alert(res.message || '审核状态更新失败');
                return;
            }
            loadOrders();
            openOrderDetail(orderId);
        });
    }

    function renderOrderTable() {
        const tbody = $('orderTableBody');
        const colspan = 13;
        if (!ORDERS.length) {
            tbody.innerHTML = `<tr><td colspan="${colspan}" class="table-empty">当前筛选条件下暂无单据${ADMIN ? '，点击右上角「+ 新增单据」录入' : ''}</td></tr>`;
            return;
        }
        // 只渲染当前页切片（每页最多 ORDER_PAGE_SIZE 条）
        const start = (ORDER_PAGE - 1) * ORDER_PAGE_SIZE;
        tbody.innerHTML = ORDERS.slice(start, start + ORDER_PAGE_SIZE).map(orderRowHtml).join('');
    }

    /** 分页控件：上一页 / 下一页 + 页码与总数；只有一页时不显示 */
    function renderOrderPager() {
        const pager = $('orderPager');
        if (!pager) return;
        const totalPages = Math.max(1, Math.ceil(ORDERS.length / ORDER_PAGE_SIZE));
        if (ORDERS.length <= ORDER_PAGE_SIZE) {
            pager.hidden = true;
            pager.innerHTML = '';
            return;
        }
        pager.hidden = false;
        pager.innerHTML = `
            <span class="order-pager-info">共 ${ORDERS.length} 条单据 · 第 ${ORDER_PAGE} / ${totalPages} 页（每页最多 ${ORDER_PAGE_SIZE} 条）</span>
            <div class="order-pager-btns">
                <button type="button" class="mini-btn" data-action="order-page" data-dir="prev"${ORDER_PAGE <= 1 ? ' disabled' : ''}>&larr; 上一页</button>
                <button type="button" class="mini-btn" data-action="order-page" data-dir="next"${ORDER_PAGE >= totalPages ? ' disabled' : ''}>下一页 &rarr;</button>
            </div>`;
    }

    function findOrder(id) {
        return ORDERS.find(o => String(o.id) === String(id));
    }

    // ---------- 单据详情 + 资产卡片 ----------
    function openOrderDetail(id) {
        showModal('orderDetailModal');
        $('orderDetailBody').innerHTML = loadingHtml();
        getJson(`/api/orders/${id}`).then(res => {
            if (res.status !== 'success') {
                $('orderDetailBody').innerHTML = `<div class="modal-error">${escapeHtml(res.message || '加载失败')}</div>`;
                return;
            }
            CURRENT_ORDER = res.order;
            CURRENT_CARDS = res.cards;
            renderOrderDetail();
        }).catch(() => {
            $('orderDetailBody').innerHTML = '<div class="modal-error">加载失败，请刷新重试</div>';
        });
    }

    function cardRowHtml(c) {
        // 已绑定台账的卡片：状态列显示流转标签（与资产变更同口径，如「领用」）；
        // 未绑定卡片没有台账流转，仍显示卡片自身的「待分配」
        const statusCell = c.asset_number
            ? tagBadgeHtml(c.inv_tag)
            : `<span class="badge badge-none">${escapeHtml(c.card_status)}</span>`;
        return `<tr data-id="${c.id}">
            <td>${c.asset_number ? escapeHtml(c.asset_number) : '<span class="muted">未关联</span>'}</td>
            <td>${escapeHtml(c.owner) || '<span class="muted">-</span>'}</td>
            <td>${escapeHtml(c.department) || '<span class="muted">-</span>'}</td>
            <td>${escapeHtml(c.receive_date) || '<span class="muted">-</span>'}</td>
            <td>${statusCell}</td>
            ${ADMIN ? `<td><button type="button" class="mini-btn" data-action="edit-card" data-id="${c.id}">编辑</button></td>` : ''}
        </tr>`;
    }

    function renderOrderDetail() {
        const o = CURRENT_ORDER;
        $('orderDetailTitle').textContent = `单据 ${o.order_no}`;
        // 分组重排：身份 → 标的 → 预算 → 执行状态 → 备注；
        // 4 列栅格下 wide 跨 2 列、full 跨 4 列，每行刚好填满不留空洞
        const reviewBadge = o.reviewed
            ? '<span class="badge badge-done">已审核</span>'
            : '<span class="badge badge-warn">未审核</span>';
        const pushBadge = o.pushed
            ? '<span class="badge badge-done">已下推</span>'
            : '<span class="badge badge-none">未下推</span>';
        const hardware = [o.cpu, o.mem, o.disk, o.gpu].filter(Boolean).join(' / ');
        const info = [
            ['单据编号', escapeHtml(o.order_no)],
            ['单据日期', escapeHtml(o.order_date)],
            ['设备类型', escapeHtml(o.device_type)],
            ['购买数量', `${o.quantity} 台`],
            ['申请数量（实时）', (o.apply_quantity === null || o.apply_quantity === undefined)
                ? '<span class="muted" title="飞书未配置、不可达或该类型暂无申请记录">-</span>'
                : `<button type="button" class="link-btn" data-action="apply-detail" data-id="${o.id}" title="查看构成此数量的申请记录明细">${o.apply_quantity} 台</button>`],
            ['规格型号', escapeHtml(o.spec) || '-', true],
            ...(hardware ? [['硬件配置', escapeHtml(hardware), true]] : []),
            ['单价', money(o.unit_price)],
            ['金额', money(o.amount)],
            ['预算内外', o.in_budget ? '<span class="badge badge-in">预算内</span>' : '<span class="badge badge-out">预算外</span>'],
            ['预算剩余（下单时）', budgetCellHtml(o.budget, false), true],
            ['供应商', escapeHtml(o.supplier) || '-'],
            ['审核状态', reviewBadge],
            ['下推状态', pushBadge],
            ['今年已采购（下单时）', `<button type="button" class="link-btn" data-action="usage" data-id="${o.id}">${o.purchased_this_year} 台</button>`],
            ['剩余库存（实时）', `<button type="button" class="link-btn" data-action="stock-detail" data-id="${o.id}" title="查看在库资产明细">${o.stock_count} 台</button>`],
        ];
        // 空备注不再占一行
        if (o.remark) info.push(['备注', escapeHtml(o.remark), 'full']);
        const infoHtml = `<div class="detail-info-grid">` +
            info.map(([label, value, span]) =>
                `<div class="detail-info-item${span === 'full' ? ' full' : (span ? ' wide' : '')}"><label>${label}</label><span>${value}</span></div>`).join('') +
            `</div>`;

        const actionBar = ADMIN ? `
            <div class="detail-action-bar">
                ${o.pushed
                    ? `<button type="button" class="mini-btn warn" data-action="unpush">撤销下推</button>`
                    : `<button type="button" class="mini-btn primary" data-action="do-push">下推资产卡片</button>`}
                ${o.reviewed
                    ? `<button type="button" class="mini-btn" data-action="unreview">取消审核</button>`
                    : `<button type="button" class="mini-btn primary" data-action="review">标记已审核</button>`}
                <button type="button" class="mini-btn" data-action="edit" data-id="${o.id}">编辑单据</button>
                <button type="button" class="mini-btn danger" data-action="delete" data-id="${o.id}">删除单据</button>
            </div>` : '';

        const cardsHtml = `
            <div class="card-table-wrap">
                <table class="data-table card-table">
                    <thead><tr>
                        <th>资产编码</th>
                        <th>所属人</th><th>所属部门</th><th>领取时间</th><th>资产状态</th>
                        ${ADMIN ? '<th>操作</th>' : ''}
                    </tr></thead>
                    <tbody>${CURRENT_CARDS.length ? CURRENT_CARDS.map(cardRowHtml).join('') : `<tr><td colspan="${ADMIN ? 6 : 5}" class="table-empty">尚未下推，暂无资产卡片</td></tr>`}</tbody>
                </table>
            </div>`;

        $('orderDetailBody').innerHTML = infoHtml + actionBar + cardsHtml;
    }

    function doPush() {
        const o = CURRENT_ORDER;
        if (!o) return;
        const month = META.current_month;
        if (!window.confirm(`确认将单据 ${o.order_no} 下推，生成当月（${month}）资产卡片 ${o.quantity} 张？`)) return;
        postForm(`/api/orders/${o.id}/push`, { card_month: month }).then(res => {
            toast(res.message, res.status === 'success');
            if (res.status === 'success') {
                openOrderDetail(o.id);
                loadOrders();
            }
        });
    }

    function doUnpush() {
        const o = CURRENT_ORDER;
        if (!window.confirm(`撤销下推将删除单据 ${o.order_no} 已生成的 ${CURRENT_CARDS.length} 张资产卡片，确认继续？`)) return;
        postForm(`/api/orders/${o.id}/unpush`, {}).then(res => {
            toast(res.message, res.status === 'success');
            if (res.status === 'success') { openOrderDetail(o.id); loadOrders(); }
        });
    }


    /** 资产档案详情：基本信息 + 设备配置 + 台账流转历史。
     *  嵌套弹窗编排（简单直观）：
     *  - 打开时若有其他弹窗在显示，先暂存并隐藏它，避免双层遮罩变深、点击穿透；
     *  - 关闭详情（点 X / 按 Esc / 点遮罩）时，一次性关闭详情并还原来源弹窗。 */
    let ASSET_FULL_RETURN_MODAL = null;
    let ASSET_FULL_WIRED = false;   // 拦截器只绑一次

    function closeAssetFull() {
        hideModal('assetFullModal');
        if (ASSET_FULL_RETURN_MODAL) {
            ASSET_FULL_RETURN_MODAL.style.display = 'flex';
            ASSET_FULL_RETURN_MODAL.setAttribute('aria-hidden', 'false');
            ASSET_FULL_RETURN_MODAL = null;
        }
    }

    function wireAssetFullInterceptors() {
        if (ASSET_FULL_WIRED) return;
        ASSET_FULL_WIRED = true;
        const modal = $('assetFullModal');
        // Esc：捕获阶段在 modal.js 的冒泡监听之前拿到，一次关闭详情 + 还原来源
        modal.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || modal.style.display !== 'flex') return;
            e.preventDefault();
            e.stopImmediatePropagation();
            closeAssetFull();
        }, true);
        // 点 X：吞掉本次点击，改走「关闭详情 + 还原来源」，避免 modal.js / data-close 重复处理
        modal.querySelector('.modal-close-btn').addEventListener('click', (e) => {
            e.preventDefault();
            e.stopImmediatePropagation();
            closeAssetFull();
        }, true);
    }

    function openAssetFull(number) {
        wireAssetFullInterceptors();
        // 打开时暂存并隐藏当前显示中的其他弹窗作为来源（仅取最外层一次）
        if (!ASSET_FULL_RETURN_MODAL) {
            for (const m of document.querySelectorAll('.custom-modal')) {
                if (m.id !== 'assetFullModal' && m.style.display === 'flex') {
                    ASSET_FULL_RETURN_MODAL = m;
                    m.style.display = 'none';
                    m.setAttribute('aria-hidden', 'true');
                    break;
                }
            }
        }
        showModal('assetFullModal');
        $('assetFullTitle').textContent = `资产详情 · ${number}`;
        $('assetFullBody').innerHTML = loadingHtml();
        getJson(`/api/orders/asset_detail?number=${encodeURIComponent(number)}`).then(res => {
            if (res.status !== 'success') {
                $('assetFullBody').innerHTML = `<div class="modal-error">${escapeHtml(res.message || '加载失败')}</div>`;
                return;
            }
            renderAssetFull(number, res);
        });
    }

    function renderAssetFull(number, res) {
        const dev = res.device || {};
        const latest = res.latest || {};
        const flows = res.flows || [];
        const head = `
            <div class="du-asset-head">
                <span class="du-asset-number">${escapeHtml(number)}</span>
                ${statusBadgeHtml(latest.status)}
                ${tagBadgeHtml(latest.tag)}
            </div>`;
        const info = [
            ['资产类型', escapeHtml(dev.type) || '-'],
            ['使用部门', escapeHtml(latest.department || dev.department) || '-'],
            ['使用人', escapeHtml(latest.site || dev.name) || '-'],
            ['最近流转', `${escapeHtml(latest.tag) || '-'} · ${escapeHtml(latest.date) || '-'}`],
            ['规格型号', escapeHtml(dev.spec) || '-', true],
            ['SN 码', escapeHtml(dev.sn) || '-'],
        ];
        const infoHtml = `<div class="detail-info-grid">` + info.map(([label, value, wide]) =>
            `<div class="detail-info-item${wide ? ' wide' : ''}"><label>${label}</label><span>${value}</span></div>`).join('') +
            `</div>`;
        const cfg = [['CPU', dev.cpu], ['内存', dev.mem], ['硬盘', dev.disk], ['显卡', dev.gpu]].filter(([, v]) => v);
        const cfgHtml = `
            <section class="du-section">
                <h4>设备配置</h4>
                ${cfg.length ? `<div class="du-cfg">` + cfg.map(([label, v]) =>
                    `<span class="du-cfg-item"><label>${label}</label><strong>${escapeHtml(v)}</strong></span>`).join('') + `</div>`
                    : '<p class="du-tagcard-empty">无硬件配置记录</p>'}
            </section>`;
        const flowsHtml = `
            <section class="du-section">
                <h4>流转情况${flows.length ? `（${flows.length}）` : ''}</h4>
                ${flows.length ? `<div class="du-table-wrap du-history-wrap"><table class="du-table">
                    <thead><tr><th scope="col" class="num">日期</th><th scope="col">标签</th><th scope="col">状态</th><th scope="col">使用部门</th><th scope="col">使用人</th></tr></thead>
                    <tbody>${flows.map(h => `<tr>
                        <td class="num">${escapeHtml(h.date) || '-'}</td>
                        <td>${h.tag ? tagBadgeHtml(h.tag) : '<span class="du-zero">-</span>'}</td>
                        <td>${h.status ? statusBadgeHtml(h.status) : '<span class="du-zero">-</span>'}</td>
                        <td>${escapeHtml(h.department) || '-'}</td>
                        <td>${escapeHtml(h.site) || '-'}</td>
                    </tr>`).join('')}</tbody>
                </table></div>
                <p class="usage-note">流转以台账 inventory 记录为准，按日期倒序；首行即当前状态。</p>`
                    : '<p class="du-tagcard-empty">无流转记录</p>'}
            </section>`;
        $('assetFullBody').innerHTML = head + infoHtml + cfgHtml + flowsHtml;
    }

    // ---------- 今年已采购下钻 ----------
    function openUsage(order) {
        // until 与单据口径一致：下钻结果同样截至单据日期（YYMM）
        USAGE_CTX = {
            type: order.device_type,
            year: order.year || META.current_year,
            until: (order.order_date || '').replace(/-/g, '').slice(2, 6)
        };
        showModal('usageModal');
        loadDeptUsage();
    }

    function loadDeptUsage() {
        $('usageTitle').textContent = '加载中...';
        $('usageBody').innerHTML = loadingHtml();
        const params = encodeParams({ type: USAGE_CTX.type, year: USAGE_CTX.year, until: USAGE_CTX.until });
        getJson(`/api/orders/type_usage?${params}`).then(res => {
            if (res.status !== 'success') {
                $('usageBody').innerHTML = `<div class="modal-error">${escapeHtml(res.message || '加载失败')}</div>`;
                return;
            }
            $('usageTitle').textContent = `${res.title}（共 ${res.total} 台）`;
            if (!res.departments.length) {
                $('usageBody').innerHTML = '<div class="table-empty">该设备类型今年暂无台账记录</div>';
                return;
            }
            const rows = res.departments.map(d => `<tr>
                <td>${escapeHtml(d.department)}</td>
                <td class="num">${d.count}</td>
                <td class="num">${d.issued}</td>
                <td class="num">${d.in_stock}</td>
                <td class="num">${d.user_count}</td>
                <td><button type="button" class="mini-btn" data-action="dept" data-dept="${escapeHtml(d.department)}">查看使用人</button></td>
            </tr>`).join('');
            $('usageBody').innerHTML = `
                <p class="usage-tip">点击「查看使用人」可查看该部门具体使用人及领取时间。</p>
                <table class="data-table usage-table">
                    <thead><tr><th>部门</th><th class="num">设备数</th><th class="num">已领用</th><th class="num">在库</th><th class="num">使用人数</th><th>操作</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>`;
        }).catch(() => {
            $('usageBody').innerHTML = '<div class="modal-error">加载失败，请刷新重试</div>';
        });
    }

    function loadDeptUsers(department) {
        $('usageBody').innerHTML = loadingHtml();
        const params = encodeParams({
            type: USAGE_CTX.type, year: USAGE_CTX.year, department: department, until: USAGE_CTX.until
        });
        getJson(`/api/orders/dept_users?${params}`).then(res => {
            if (res.status !== 'success') {
                $('usageBody').innerHTML = `<div class="modal-error">${escapeHtml(res.message || '加载失败')}</div>`;
                return;
            }
            $('usageTitle').textContent = `${res.title}（共 ${res.total} 台）`;
            const rows = res.data.map(d => `<tr>
                <td>${escapeHtml(d.number)}</td>
                <td class="spec-cell" title="${escapeHtml(d.spec)}">${escapeHtml(d.spec) || '-'}</td>
                <td>${escapeHtml(d.owner) || '<span class="muted">-</span>'}</td>
                <td>${escapeHtml(d.department) || '-'}</td>
                <td>${escapeHtml(d.receive_date) || '<span class="muted">-</span>'}</td>
                <td>${d.issued ? '<span class="badge badge-done">已领用</span>' : '<span class="badge badge-in">入库</span>'}</td>
                <td>${escapeHtml(d.tag) || '-'}</td>
                <td>${escapeHtml(d.sn) || '-'}</td>
            </tr>`).join('');
            $('usageBody').innerHTML = `
                <div class="usage-back-bar">
                    <button type="button" class="mini-btn" data-action="back-dept">&larr; 返回部门列表</button>
                    <span class="usage-dept-label">${escapeHtml(res.department || '全部部门')}</span>
                </div>
                <div class="card-table-wrap">
                    <table class="data-table usage-table">
                        <thead><tr><th>资产编码</th><th>规格型号</th><th>使用人</th><th>部门</th><th>领取时间</th><th>状态</th><th>标签</th><th>SN</th></tr></thead>
                        <tbody>${rows || '<tr><td colspan="8" class="table-empty">暂无数据</td></tr>'}</tbody>
                    </table>
                </div>`;
        }).catch(() => {
            $('usageBody').innerHTML = '<div class="modal-error">加载失败，请刷新重试</div>';
        });
    }

    // ---------- 申请数量下钻（飞书多维表申请明细） ----------
    function openApplyDetail(orderId) {
        APPLY_ORDER_ID = orderId;
        const body = $('applyBody');
        showModal('applyModal');
        body.setAttribute('aria-busy', 'true');
        body.innerHTML = applyLoadingHtml();
        $('applyTitle').textContent = '申请明细';
        getJson(`/api/orders/${orderId}/apply_detail`).then(res => {
            body.removeAttribute('aria-busy');
            if (res.status !== 'success') {
                body.innerHTML = applyErrorHtml(res.message);
                return;
            }
            $('applyTitle').textContent = `${res.device_type} · 申请明细（共 ${res.total} 条）`;
            const rows = res.items.map(i => {
                const reason = String(i.reason === null || i.reason === undefined ? '' : i.reason).trim();
                return `<tr>
                <td>${escapeHtml(i.user) || '<span class="muted">-</span>'}</td>
                <td>${escapeHtml(i.department) || '<span class="muted">-</span>'}</td>
                <td>${escapeHtml(i.date) || '-'}</td>
                <td class="apply-reason-cell" title="${escapeHtml(reason)}">${escapeHtml(reason) || '<span class="muted">-</span>'}</td>
            </tr>`;
            }).join('');
            const scopeNote = `统计口径：申请设备为「${escapeHtml(res.device_type)}」、发放状态为「未发放」的当前申请记录，每条按 1 台计（实时值）。`;
            $('applyBody').innerHTML = `
                <p class="usage-note">${scopeNote}</p>
                <div class="card-table-wrap" role="region" tabindex="0" aria-label="申请明细表格，可横向滚动">
                    <table class="data-table usage-table apply-table" aria-label="${escapeHtml(res.device_type)} 申请明细">
                        <thead><tr><th scope="col">申请人</th><th scope="col">部门</th><th scope="col">申请日期</th><th scope="col">申请理由</th></tr></thead>
                        <tbody>${rows || '<tr><td colspan="4" class="table-empty">该类型当前没有「未发放」的申请记录</td></tr>'}</tbody>
                    </table>
                </div>`;
        }).catch(() => {
            $('applyBody').removeAttribute('aria-busy');
            $('applyBody').innerHTML = applyErrorHtml('飞书接口不可用或网络异常，请稍后重试');
        });
    }

    // ---------- 剩余库存下钻 ----------
    function openStockDetail(orderId) {
        showModal('stockModal');
        $('stockTitle').textContent = '在库资产明细';
        $('stockBody').innerHTML = loadingHtml();
        $('stockBody').setAttribute('aria-busy', 'true');
        getJson(`/api/orders/${orderId}/stock_detail`).then(res => {
            $('stockBody').removeAttribute('aria-busy');
            if (res.status !== 'success') {
                $('stockBody').innerHTML = `<div class="modal-error">${escapeHtml(res.message || '加载失败')}</div>`;
                return;
            }
            const poolNote = res.is_mac ? '（Mac 机型，不含普通机）' : '';
            $('stockTitle').textContent = `${res.device_type} · 在库资产明细（共 ${res.total} 台）`;
            const scopeNote = `口径：最新流转为「入库」的${escapeHtml(res.device_type)}资产${poolNote}，实时值不随单据日期定格；点击资产编码可查看完整档案。`;
            $('stockBody').removeAttribute('aria-busy');
            if (!res.items.length) {
                $('stockBody').innerHTML = `
                    <p class="usage-note">${scopeNote}</p>
                    <p class="table-empty">该类型当前没有在库资产</p>
                    <p class="usage-note">设备领出后重新入库（打「入库」标签）才会计入此处。</p>`;
                return;
            }
            const rows = res.items.map(i => `<tr>
                <td><button type="button" class="du-item-number" data-action="asset-detail" data-number="${escapeHtml(i.number)}" title="查看该资产完整档案">${escapeHtml(i.number)}</button></td>
                <td class="spec-cell" title="${escapeHtml(i.spec)}">${escapeHtml(i.spec) || '<span class="muted">-</span>'}</td>
                <td${i.department ? ` title="${escapeHtml(i.department)}"` : ''}>${escapeHtml(i.department) || '-'}</td>
                <td${i.owner ? ` title="${escapeHtml(i.owner)}"` : ''}>${escapeHtml(i.owner) || '-'}</td>
                <td>${escapeHtml(i.stock_date) || '-'}</td>
            </tr>`).join('');
            $('stockBody').innerHTML = `
                <p class="usage-note">${scopeNote}</p>
                <div class="card-table-wrap" role="region" tabindex="0" aria-label="${escapeHtml(res.device_type)} 在库资产明细表格，可横向滚动">
                    <table class="data-table usage-table stock-table" aria-label="${escapeHtml(res.device_type)} 在库资产明细">
                        <thead><tr><th scope="col">资产编码</th><th scope="col">规格型号</th><th scope="col">部门</th><th scope="col">保管人</th><th scope="col">入库日期</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>`;
        }).catch(() => {
            $('stockBody').removeAttribute('aria-busy');
            $('stockBody').innerHTML = '<div class="modal-error">加载失败，请刷新重试</div>';
        });
    }

    // ---------- 单据表单 ----------
    function openOrderForm(order) {
        EDITING_ORDER_ID = order ? order.id : null;
        $('orderFormTitle').textContent = order ? `编辑单据 ${order.order_no}` : '新增单据';
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        // 设备类型只保留显示器 / 笔记本电脑 / 台式主机，其余走「其它」自定义输入；
        // 编辑历史单据时若类型不在列表内，自动落到「其它」并回填原值
        const editingType = order ? (order.device_type || '') : '';
        const isCustomType = Boolean(editingType) && !ORDER_DEVICE_TYPES.includes(editingType) && editingType !== CUSTOM_TYPE;
        const selectedType = isCustomType ? CUSTOM_TYPE : editingType;
        const typeOptions = ORDER_DEVICE_TYPES.concat([CUSTOM_TYPE]).map(t =>
            `<option value="${escapeHtml(t)}"${selectedType === t ? ' selected' : ''}>${escapeHtml(t)}</option>`).join('');
        const hw = (key) => escapeHtml(order ? (order[key] || '') : '');
        // 已下推单据的硬件配置可能来自更早的数据（当时未采集）：不作为必填，
        // 但修改后后端会把规格 / 配置同步到本单生成的台账资产
        const requireConfig = !(order && order.pushed);
        const cfgStar = requireConfig ? ' *' : '';
        const configHintText = (order && order.pushed)
            ? '该单据已下推：修改硬件配置会同步更新本单生成的台账资产。'
            : '电脑类设备必须填写硬件配置；下推资产卡片时会写入台账，资产登记 / 变更中可见。';

        $('orderFormBody').innerHTML = `
            <form id="orderForm" autocomplete="off">
                <div class="form-row">
                    <div class="modal-form-group"><label>单据编号</label>
                        <input type="text" name="order_no" value="${escapeHtml(order ? order.order_no : '')}" placeholder="留空自动生成（PO+年月+流水）"></div>
                    <div class="modal-form-group"><label>单据日期 *</label>
                        <input type="date" name="order_date" value="${escapeHtml(order ? order.order_date : todayStr)}" required></div>
                </div>
                <div class="form-row">
                    <div class="modal-form-group"><label>设备类型 *</label>
                        <select name="device_type" required><option value="">--请选择--</option>${typeOptions}</select></div>
                    <div class="modal-form-group"><label>规格型号</label>
                        <input type="text" name="spec" value="${escapeHtml(order ? order.spec : '')}" placeholder="如 联想ThinkBook16+ Ultra5-225H 32G 1T"></div>
                </div>
                <div class="form-row" id="orderCustomTypeRow" style="display:none;">
                    <div class="modal-form-group"><label>自定义类型 *</label>
                        <input type="text" name="device_type_custom" value="${isCustomType ? escapeHtml(editingType) : ''}" placeholder="请输入设备类型"></div>
                </div>
                <div class="form-row order-config-row" style="display:none;">
                    <div class="modal-form-group"><label>CPU${cfgStar}</label>
                        <input type="text" name="cpu" value="${hw('cpu')}" placeholder="如: Intel i5-12400"></div>
                    <div class="modal-form-group"><label>内存${cfgStar}</label>
                        <input type="text" name="mem" value="${hw('mem')}" placeholder="如: 16GB DDR4"></div>
                </div>
                <div class="form-row order-config-row" style="display:none;">
                    <div class="modal-form-group"><label>硬盘${cfgStar}</label>
                        <input type="text" name="disk" value="${hw('disk')}" placeholder="如: 512GB SSD"></div>
                    <div class="modal-form-group"><label>显卡${cfgStar}</label>
                        <input type="text" name="gpu" value="${hw('gpu')}" placeholder="如: RTX 3060"></div>
                </div>
                <div class="form-hint order-config-hint" style="display:none;">${configHintText}</div>
                <div class="form-row">
                    <div class="modal-form-group"><label>设备数量 *</label>
                        <input type="number" name="quantity" min="0" step="1" value="${order ? order.quantity : 1}" required></div>
                    <div class="modal-form-group"><label>单价（元）</label>
                        <input type="number" name="unit_price" min="0" step="0.01" value="${order ? order.unit_price : ''}"></div>
                    <div class="modal-form-group"><label>金额（元）</label>
                        <input type="number" name="amount" min="0" step="0.01" value="${order ? order.amount : ''}"></div>
                </div>
                <div class="form-row">
                    <div class="modal-form-group"><label>预算内/外</label>
                        <select name="in_budget">
                            <option value="1"${!order || order.in_budget ? ' selected' : ''}>预算内</option>
                            <option value="0"${order && !order.in_budget ? ' selected' : ''}>预算外</option>
                        </select></div>
                    <div class="modal-form-group"><label>供应商</label>
                        <input type="text" name="supplier" value="${escapeHtml(order ? order.supplier : '')}"></div>
                </div>
                <div class="modal-form-group"><label>备注</label>
                    <input type="text" name="remark" value="${escapeHtml(order ? order.remark : '')}"></div>
                <div class="modal-buttons">
                    <button type="button" class="btn-plain" data-close="orderFormModal">取消</button>
                    <button type="submit" class="btn-primary">保存</button>
                </div>
            </form>`;
        showModal('orderFormModal');

        const form = $('orderForm');
        const typeSelect = form.querySelector('[name=device_type]');
        const customRow = $('orderCustomTypeRow');
        const customInput = form.querySelector('[name=device_type_custom]');
        const configRows = Array.from(form.querySelectorAll('.order-config-row'));
        const configHint = form.querySelector('.order-config-hint');
        // 有效类型：选择「其它」时取自定义输入；电脑类（笔记本电脑 / 台式主机）必须填硬件配置
        const effectiveType = () => (typeSelect.value === CUSTOM_TYPE ? customInput.value.trim() : typeSelect.value);
        const syncTypeFields = () => {
            const isCustom = typeSelect.value === CUSTOM_TYPE;
            const needConfig = CONFIG_TYPES.includes(effectiveType());
            customRow.style.display = isCustom ? '' : 'none';
            customInput.required = isCustom;
            configRows.forEach(row => { row.style.display = needConfig ? '' : 'none'; });
            configHint.style.display = needConfig ? '' : 'none';
            ['cpu', 'mem', 'disk', 'gpu'].forEach(name => {
                form.querySelector(`[name="${name}"]`).required = needConfig && requireConfig;
            });
        };
        typeSelect.addEventListener('change', syncTypeFields);
        customInput.addEventListener('input', syncTypeFields);
        syncTypeFields();
        const qty = form.querySelector('[name=quantity]');
        const price = form.querySelector('[name=unit_price]');
        const amount = form.querySelector('[name=amount]');
        price.addEventListener('input', () => {
            if (price.value !== '' && qty.value !== '') amount.value = (Number(price.value) * Number(qty.value)).toFixed(2);
        });
        qty.addEventListener('input', () => {
            if (price.value !== '' && qty.value !== '') amount.value = (Number(price.value) * Number(qty.value)).toFixed(2);
        });
        amount.addEventListener('input', () => {
            if (amount.value !== '' && Number(qty.value) > 0) price.value = (Number(amount.value) / Number(qty.value)).toFixed(2);
        });
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const deviceType = effectiveType();
            if (!deviceType) { toast('请选择设备类型', false); return; }
            const data = {};
            new FormData(form).forEach((v, k) => { data[k] = v; });
            data.device_type = deviceType;
            delete data.device_type_custom;
            const url = EDITING_ORDER_ID ? `/api/orders/${EDITING_ORDER_ID}` : '/api/orders';
            postForm(url, data).then(res => {
                toast(res.message, res.status === 'success');
                if (res.status === 'success') {
                    hideModal('orderFormModal');
                    loadOrders();
                    loadMeta();
                }
            });
        });
    }

    // ---------- 卡片编辑 ----------
    function openCardForm(card) {
        EDITING_CARD_ID = card.id;
        $('cardFormTitle').textContent = `编辑资产卡片 ${card.card_no}`;
        const bound = Boolean(card.asset_number);
        const lock = bound ? ' disabled' : '';
        const statusOptions = META.card_statuses.map(s =>
            `<option value="${escapeHtml(s)}"${card.card_status === s ? ' selected' : ''}>${escapeHtml(s)}</option>`).join('');
        const hintHtml = bound
            ? `<div class="form-hint">已绑定台账资产 ${escapeHtml(card.asset_number)}：所属人 / 所属部门 / 领取时间 / 状态由台账自动同步，无需手工维护。修改资产编码 = 将该资产的编码在台账、流转记录、卡片中整体重命名（不能与现有编码重复）。</div>`
            : '';
        $('cardFormBody').innerHTML = `
            <form id="cardForm" autocomplete="off">
                <div class="modal-form-group"><label>资产编码</label>
                    <input type="text" name="asset_number" value="${escapeHtml(card.asset_number)}" placeholder="填写台账资产编码，自动带出所属人/部门/领取时间"></div>
                ${hintHtml}
                <div class="form-row">
                    <div class="modal-form-group"><label>所属人</label>
                        <input type="text" name="owner" value="${escapeHtml(card.owner)}"${lock}></div>
                    <div class="modal-form-group"><label>所属部门</label>
                        <input type="text" name="department" value="${escapeHtml(card.department)}" list="deptList"${lock}></div>
                </div>
                <datalist id="deptList">${(typeof deptOptionsHtml === 'function' ? DEPARTMENTS.filter(d => d.value).map(d => `<option value="${escapeHtml(d.value)}">`) : []).join('')}</datalist>
                <div class="form-row">
                    <div class="modal-form-group"><label>领取时间</label>
                        <input type="date" name="receive_date" value="${escapeHtml(card.receive_date)}"${lock}></div>
                    <div class="modal-form-group"><label>卡片状态</label>
                        <select name="card_status"${lock}>${statusOptions}</select></div>
                </div>
                <div class="modal-buttons">
                    <button type="button" class="btn-plain" data-close="cardFormModal">取消</button>
                    <button type="submit" class="btn-primary">保存</button>
                </div>
            </form>`;
        showModal('cardFormModal');

        $('cardForm').addEventListener('submit', (e) => {
            e.preventDefault();
            const data = {};
            new FormData(e.target).forEach((v, k) => { data[k] = v; });
            postForm(`/api/asset_cards/${EDITING_CARD_ID}`, data).then(res => {
                toast(res.message, res.status === 'success');
                if (res.status === 'success') {
                    hideModal('cardFormModal');
                    if (CURRENT_ORDER) openOrderDetail(CURRENT_ORDER.id);
                }
            });
        });
    }

    // ---------- 预算设置 ----------
    function openBudgetPanel() {
        showModal('budgetModal');
        renderBudgetPanel(META.current_year);
    }

    function renderBudgetPanel(year) {
        EDITING_BUDGET_ID = null;
        $('budgetBody').innerHTML = loadingHtml();
        getJson(`/api/budgets?year=${encodeURIComponent(year)}`).then(res => {
            if (res.status !== 'success') {
                BUDGET_CACHE = null;
                $('budgetBody').innerHTML = `<div class="modal-error">${escapeHtml(res.message || '加载失败')}</div>`;
                return;
            }
            BUDGET_CACHE = res;
            renderBudgetTable();
        }).catch(() => {
            BUDGET_CACHE = null;
            $('budgetBody').innerHTML = '<div class="modal-error">加载失败，请刷新重试</div>';
        });
    }

    /** 预算表主体：默认展示态（纯文本 + 编辑/删除），仅编辑中的行切换为输入框 */
    function renderBudgetTable() {
        const res = BUDGET_CACHE;
        if (!res) return;
        const yearOptions = META.years.map(y =>
            `<option value="${y}"${y === res.year ? ' selected' : ''}>${y} 年</option>`).join('');
        const rows = res.budgets.map(b => {
            const editing = String(b.id) === String(EDITING_BUDGET_ID);
            const amountCell = editing
                ? `<input type="number" class="budget-input" name="budget_amount" min="0" step="0.01" value="${b.budget_amount}">`
                : money(b.budget_amount);
            // 已用：编辑时预填当前生效值（= 自动统计 + 手动修正）；清空保存 = 取消修正恢复纯自动
            const usedHint = editing
                ? `<div class="budget-used-hint">自动 ${money(b.used_computed)}${b.used_manual ? ` + 修正 ${b.used_adjust > 0 ? '+' : ''}${money(b.used_adjust)}` : ''}</div>`
                : '';
            // 已用：平时只显示数字；进入编辑才展示构成提示（自动 + 修正），清空保存 = 取消修正恢复纯自动
            const usedCell = editing
                ? `<input type="number" class="budget-input" name="used_amount" min="0" step="0.01"
                    value="${b.used}" placeholder="自动 ${money(b.used_computed)}" title="保存后新单据仍会自动累加；清空保存 = 取消手动修正">
                   ${usedHint}`
                : money(b.used);
            const actions = editing
                ? `<button type="button" class="mini-btn primary" data-action="save-budget" data-id="${b.id}" data-type="${escapeHtml(b.device_type)}">保存</button>
                  <button type="button" class="mini-btn" data-action="cancel-budget">取消</button>
                  <button type="button" class="mini-btn danger" data-action="del-budget" data-id="${b.id}">删除</button>`
                : `<button type="button" class="mini-btn" data-action="edit-budget" data-id="${b.id}">编辑</button>
                  <button type="button" class="mini-btn danger" data-action="del-budget" data-id="${b.id}">删除</button>`;
            return `<tr data-id="${b.id}">
                <td>${escapeHtml(b.device_type)}</td>
                <td class="num">${amountCell}</td>
                <td class="num">${usedCell}</td>
                <td class="num ${b.left < 0 ? 'neg-text' : ''}">${money(b.left)}</td>
                <td class="row-actions">${actions}</td>
            </tr>`;
        }).join('');
        const typeDatalist = DEFAULT_BUDGET_TYPES.map(t => `<option value="${escapeHtml(t)}">`).join('');
        $('budgetBody').innerHTML = `
            <div class="budget-toolbar">
                <label for="budgetYear">预算年度</label>
                <select id="budgetYear">${yearOptions}</select>
                <span class="muted">剩余 = 预算金额 - 已用；已用 = 当年「预算内」单据自动统计 + 手动修正（修正后新单据仍自动累加，清空恢复纯自动）</span>
            </div>
            <table class="data-table usage-table">
                <thead><tr><th>设备类型</th><th class="num">预算金额（元）</th><th class="num">已用（元）</th><th class="num">剩余（元）</th><th>操作</th></tr></thead>
                <tbody>${rows || '<tr><td colspan="5" class="table-empty">该年度尚未设置预算</td></tr>'}</tbody>
            </table>
            <div class="budget-add-row">
                <input type="text" id="newBudgetType" list="budgetTypeList" placeholder="设备类型，可选或自定义">
                <datalist id="budgetTypeList">${typeDatalist}</datalist>
                <input type="number" id="newBudgetAmount" min="0" step="0.01" placeholder="预算金额（元）">
                <button type="button" class="mini-btn primary" data-action="add-budget">新增预算</button>
            </div>`;
        $('budgetYear').addEventListener('change', (e) => renderBudgetPanel(e.target.value));
    }

    function saveBudgetRow(id, deviceType) {
        const row = document.querySelector(`#budgetBody tr[data-id="${id}"]`);
        const amount = row.querySelector('[name=budget_amount]').value;
        const used = row.querySelector('[name=used_amount]').value.trim();
        postForm('/api/budgets', {
            year: $('budgetYear').value, device_type: deviceType, budget_amount: amount, used_amount: used
        }).then(res => {
            toast(res.message, res.status === 'success');
            if (res.status === 'success') {
                EDITING_BUDGET_ID = null;
                renderBudgetPanel($('budgetYear').value);
                loadOrders();
            }
        });
    }

    function addBudget() {
        const type = $('newBudgetType').value.trim();
        const amount = $('newBudgetAmount').value;
        if (!type) { toast('请输入设备类型', false); return; }
        // 新增不携带 used_amount，后端对已存在的同类预算保留其已用覆盖值
        postForm('/api/budgets', { year: $('budgetYear').value, device_type: type, budget_amount: amount }).then(res => {
            toast(res.message, res.status === 'success');
            if (res.status === 'success') {
                renderBudgetPanel($('budgetYear').value);
                loadOrders();
            }
        });
    }

    // ---------- 事件绑定 ----------
    function bindEvents() {
        $('orderSearchBtn').addEventListener('click', loadOrders);
        $('deptUsageBtn').addEventListener('click', () => DashboardDeptUsage.openDeptUsage());
        // duFrom/duTo 的 change 委托监听已移入 dashboard_dept_usage.js（模块自注册）
        $('filterKeyword').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadOrders(); });
        ['filterYear', 'filterType', 'filterBudget', 'filterPushed', 'filterReview'].forEach(id => {
            $(id).addEventListener('change', loadOrders);
        });

        if (ADMIN) {
            $('newOrderBtn').addEventListener('click', () => openOrderForm(null));
            $('budgetBtn').addEventListener('click', openBudgetPanel);
        }

        // 单据表格 / 详情 / 下钻弹窗内的动作，统一事件委托
        document.addEventListener('click', (e) => {
            // 关闭按钮（含弹窗内动态渲染的「取消」）统一委托处理
            const closeBtn = e.target.closest('[data-close]');
            if (closeBtn) {
                hideModal(closeBtn.dataset.close);
                return;
            }
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const action = btn.dataset.action;
            const id = btn.dataset.id;

            if (action === 'apply-retry') { if (APPLY_ORDER_ID) openApplyDetail(APPLY_ORDER_ID); return; }
            if (action === 'detail') { openOrderDetail(id); return; }
            if (action === 'review' || action === 'unreview') {
                // 详情动作区的按钮不带 data-id，回退到当前详情单据（与 edit/delete 同模式）
                const order = findOrder(id) || CURRENT_ORDER;
                if (!order) return;
                setReview(order.id, action === 'review' ? 1 : 0);
                return;
            }
            if (action === 'usage') {
                const order = findOrder(id) || CURRENT_ORDER;
                if (order) openUsage(order);
                return;
            }
            if (action === 'dept') { loadDeptUsers(btn.dataset.dept); return; }
            if (action === 'apply-detail') { openApplyDetail(id); return; }
            if (action === 'stock-detail') { openStockDetail(id); return; }
            if (action === 'back-dept') { loadDeptUsage(); return; }
            if (action === 'order-page') {
                const totalPages = Math.max(1, Math.ceil(ORDERS.length / ORDER_PAGE_SIZE));
                ORDER_PAGE = Math.min(totalPages, Math.max(1, ORDER_PAGE + (btn.dataset.dir === 'prev' ? -1 : 1)));
                renderOrderTable();
                renderOrderPager();
                return;
            }
            // 部门领用总览（矩阵 / 返回 / 快捷区间）动作在独立模块处理
            if (DashboardDeptUsage.handleAction(action, btn)) return;
            if (action === 'asset-detail') { openAssetFull(btn.dataset.number); return; }

            if (!ADMIN) return;

            if (action === 'edit') {
                const order = findOrder(id) || CURRENT_ORDER;
                if (order) openOrderForm(order);
                return;
            }
            if (action === 'delete') {
                const order = findOrder(id) || CURRENT_ORDER;
                if (!order) return;
                if (!window.confirm(`确认删除单据 ${order.order_no}？`)) return;
                fetch(`/api/orders/${id}`, { method: 'DELETE' })
                    .then(r => r.json())
                    .then(res => {
                        toast(res.message, res.status === 'success');
                        if (res.status === 'success') {
                            hideModal('orderDetailModal');
                            loadOrders();
                        }
                    });
                return;
            }
            if (action === 'do-push') { doPush(); return; }
            if (action === 'unpush') { doUnpush(); return; }
            if (action === 'edit-card') {
                const card = CURRENT_CARDS.find(c => String(c.id) === String(id));
                if (card) openCardForm(card);
                return;
            }
            if (action === 'save-budget') { saveBudgetRow(id, btn.dataset.type); return; }
            if (action === 'edit-budget') { EDITING_BUDGET_ID = id; renderBudgetTable(); return; }
            if (action === 'cancel-budget') { EDITING_BUDGET_ID = null; renderBudgetTable(); return; }
            if (action === 'del-budget') {
                if (!window.confirm('确认删除该条预算？')) return;
                fetch(`/api/budgets/${id}`, { method: 'DELETE' })
                    .then(r => r.json())
                    .then(res => {
                        toast(res.message, res.status === 'success');
                        if (res.status === 'success') {
                            if (String(EDITING_BUDGET_ID) === String(id)) EDITING_BUDGET_ID = null;
                            renderBudgetPanel($('budgetYear').value);
                            loadOrders();
                        }
                    });
                return;
            }
            if (action === 'add-budget') { addBudget(); return; }
        });
    }

    function loadMeta() {
        return getJson('/api/orders/meta').then(res => {
            if (res.status === 'success') {
                META = Object.assign(META, res);
                fillFilters();
            }
            return res;
        });
    }

    function init() {
        if (!$('orderTableBody')) return;
        // 注册全部弹窗：焦点陷阱 / Esc 关闭 / 焦点归还 / aria-hidden（backdrop 不关闭）
        initModals(document, { closeOnBackdrop: false });
        // 部门领用总览模块：注入依赖并自注册弹窗内事件
        DashboardDeptUsage.init({ $, getJson, escapeHtml, loadingHtml, showModal });
        document.querySelectorAll('.admin-only').forEach(el => {
            el.style.display = ADMIN ? '' : 'none';
        });
        bindEvents();
        loadMeta().then(loadOrders);
    }

    window.addEventListener('DOMContentLoaded', init);
})();
