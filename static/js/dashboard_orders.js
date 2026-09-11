/* 资产看板 - 单据视图
 * 单据列表 -> 单据详情 -> 下推资产卡片；今年已采购数量 -> 部门使用情况 -> 使用人明细。
 * 依赖 base.html 的 fetch 封装（自动带 CSRF token）与 utils.js 的 escapeHtml。
 */
(function () {
    'use strict';

    const ADMIN = typeof DASHBOARD_ADMIN !== 'undefined' && DASHBOARD_ADMIN;
    const $ = (id) => document.getElementById(id);

    let META = {
        device_types: [], years: [], card_statuses: [],
        current_year: new Date().getFullYear(), current_month: ''
    };
    let ORDERS = [];
    let CURRENT_ORDER = null;
    let CURRENT_CARDS = [];
    let USAGE_CTX = null;
    let EDITING_ORDER_ID = null;
    let EDITING_CARD_ID = null;

    // ---------- 通用工具 ----------
    function money(value) {
        const n = Number(value || 0);
        return '¥' + n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function showModal(id) { $(id).style.display = 'flex'; }
    function hideModal(id) { $(id).style.display = 'none'; }

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
        return Object.keys(params)
            .filter(k => params[k] !== undefined && params[k] !== null && params[k] !== '')
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

    // ---------- 筛选与列表 ----------
    function fillFilters() {
        const yearSel = $('filterYear');
        yearSel.innerHTML = META.years.map(y =>
            `<option value="${y}"${y === META.current_year ? ' selected' : ''}>${y} 年</option>`).join('');
        const typeSel = $('filterType');
        typeSel.innerHTML = '<option value="">全部类型</option>' +
            META.device_types.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
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

    function loadOrders() {
        const tbody = $('orderTableBody');
        const colspan = 12;
        tbody.innerHTML = `<tr><td colspan="${colspan}" class="table-loading">加载中...</td></tr>`;
        $('orderSummary').innerHTML = '';

        getJson('/api/orders?' + encodeParams(currentFilters())).then(res => {
            if (res.status !== 'success') {
                tbody.innerHTML = `<tr><td colspan="${colspan}" class="table-error">${escapeHtml(res.message || '加载失败')}</td></tr>`;
                return;
            }
            ORDERS = res.orders;
            renderSummary(res.summary);
            renderOrderTable();
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
            <td class="num">${o.stock_count} 台</td>
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
        const colspan = 12;
        if (!ORDERS.length) {
            tbody.innerHTML = `<tr><td colspan="${colspan}" class="table-empty">当前筛选条件下暂无单据${ADMIN ? '，点击右上角「+ 新增单据」录入' : ''}</td></tr>`;
            return;
        }
        tbody.innerHTML = ORDERS.map(orderRowHtml).join('');
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
        const info = [
            ['单据编号', escapeHtml(o.order_no)],
            ['单据日期', escapeHtml(o.order_date)],
            ['设备类型', escapeHtml(o.device_type)],
            ['申请数量', `${o.quantity} 台`],
            ['规格型号', escapeHtml(o.spec) || '-', true],
            ['单价', money(o.unit_price)],
            ['金额', money(o.amount)],
            ['预算内外', o.in_budget ? '<span class="badge badge-in">预算内</span>' : '<span class="badge badge-out">预算外</span>'],
            ['预算剩余（下单时）', budgetCellHtml(o.budget, false), true],
            ['供应商', escapeHtml(o.supplier) || '-'],
            ['审核状态', reviewBadge],
            ['下推状态', pushBadge],
            ['今年已采购（下单时）', `<button type="button" class="link-btn" data-action="usage" data-id="${o.id}">${o.purchased_this_year} 台</button>`],
            ['剩余库存（下单时）', `${o.stock_count} 台`],
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

    // ---------- 部门领用总览（默认当月，可切区间 -> 矩阵 -> 明细） ----------
    let DEPT_USAGE = null;
    let DU_FROM = '';
    let DU_TO = '';

    const duMonthLabel = ym => `${ym.slice(0, 4)}年${Number(ym.slice(5, 7))}月`;

    function currentYM() {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }

    function shiftYM(ym, delta) {
        const [y, m] = ym.split('-').map(Number);
        const d = new Date(y, m - 1 + delta, 1);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }

    function duQuery() {
        return `?from=${encodeURIComponent(DU_FROM)}&to=${encodeURIComponent(DU_TO)}`;
    }

    function usageTotal(cells, dept, type) {
        const cell = (cells[dept] || {})[type];
        return cell ? cell.total : 0;
    }

    function openDeptUsage() {
        // 默认当月；后续选择会保留，重开弹窗不回跳
        if (!DU_FROM || !DU_TO) {
            DU_FROM = currentYM();
            DU_TO = currentYM();
        }
        showModal('deptUsageModal');
        loadDeptUsageData();
    }

    function loadDeptUsageData() {
        $('deptUsageBody').innerHTML = loadingHtml();
        getJson('/api/orders/dept_usage' + duQuery()).then(res => {
            if (res.status !== 'success') {
                $('deptUsageBody').innerHTML = `<div class="modal-error">${escapeHtml(res.message || '加载失败')}</div>`;
                return;
            }
            DEPT_USAGE = res;
            renderUsageMatrix();
        });
    }

    /** 一级：口径工具栏 + KPI + 部门 × 类型矩阵 */
    function renderUsageMatrix() {
        const { types, departments, cells, month_from: from, month_to: to, months } = DEPT_USAGE;
        $('deptUsageTitle').textContent = '部门领用总览';

        const monthPool = (months && months.length ? months : [currentYM()]);
        const monthOptions = monthPool.map(m => `<option value="${m}">${duMonthLabel(m)}</option>`).join('');
        const rangeBar = `
            <div class="du-range">
                <label class="du-range-field">从
                    <select id="duFrom" aria-label="起始月份">${monthOptions}</select>
                </label>
                <label class="du-range-field">至
                    <select id="duTo" aria-label="结束月份">${monthOptions}</select>
                </label>
                <div class="du-presets" role="group" aria-label="快捷区间">
                    <button type="button" class="du-preset" data-action="du-preset" data-preset="this">当月</button>
                    <button type="button" class="du-preset" data-action="du-preset" data-preset="last">上月</button>
                    <button type="button" class="du-preset" data-action="du-preset" data-preset="half">半年</button>
                    <button type="button" class="du-preset" data-action="du-preset" data-preset="year">全年</button>
                </div>
            </div>`;

        let grand = 0;
        const deptTotals = departments.map(d => {
            const s = types.reduce((acc, t) => acc + usageTotal(cells, d, t), 0);
            grand += s;
            return [d, s];
        });
        const top = deptTotals.slice().sort((a, b) => b[1] - a[1])[0];
        const typeTotals = types.map(t => departments.reduce((acc, d) => acc + usageTotal(cells, d, t), 0));
        const topTypeIdx = typeTotals.indexOf(Math.max(...typeTotals, 0));
        const period = from === to
            ? `${duMonthLabel(from)} · 流转次数`
            : `${duMonthLabel(from)} ~ ${duMonthLabel(to)} · 累计流转次数`;
        const kpis = `
            <div class="du-kpis">
                <div class="du-kpi"><span class="du-kpi-label">领用总数</span><strong class="du-kpi-value">${grand}</strong><span class="du-kpi-sub">${escapeHtml(period)}</span></div>
                <div class="du-kpi"><span class="du-kpi-label">覆盖部门</span><strong class="du-kpi-value">${departments.length}</strong><span class="du-kpi-sub">${top && top[1] ? `最多 ${escapeHtml(top[0])} ${top[1]}` : '—'}</span></div>
                <div class="du-kpi"><span class="du-kpi-label">设备类型</span><strong class="du-kpi-value">${types.length}</strong><span class="du-kpi-sub">${grand ? `最多 ${escapeHtml(types[topTypeIdx])} ${typeTotals[topTypeIdx]}` : '—'}</span></div>
            </div>`;

        let max = 0;
        departments.forEach(d => types.forEach(t => { max = Math.max(max, usageTotal(cells, d, t)); }));
        const heat = v => (v && max) ? ` style="background:rgba(37, 99, 235, ${(0.07 + 0.33 * (v / max)).toFixed(2)})"` : '';
        const head = `<tr><th scope="col">部门</th>${types.map(t => `<th scope="col" class="num">${escapeHtml(t)}</th>`).join('')}<th scope="col" class="num">合计</th></tr>`;
        const footSum = types.map(() => 0);
        const body = departments.map(dept => {
            let rowTotal = 0;
            const tds = types.map((t, i) => {
                const v = usageTotal(cells, dept, t);
                rowTotal += v;
                footSum[i] += v;
                const cellHtml = v
                    ? `<button type="button" class="matrix-cell" data-action="matrix-cell" data-dept="${escapeHtml(dept)}" data-type="${escapeHtml(t)}"${heat(v)}
                        title="查看 ${escapeHtml(dept)} · ${escapeHtml(t)} 的入职/领用/更换明细">${v}</button>`
                    : '<span class="du-zero">0</span>';
                return `<td class="num">${cellHtml}</td>`;
            }).join('');
            return `<tr><th scope="row">${escapeHtml(dept)}</th>${tds}<td class="num du-total">${rowTotal}</td></tr>`;
        }).join('');
        const foot = footSum.map(s => `<td class="num du-total">${s}</td>`).join('');
        const legend = max ? `
            <p class="du-legend"><span>少</span>
                <span class="du-legend-scale" aria-hidden="true"><i style="background:rgba(37, 99, 235, 0.07)"></i><i style="background:rgba(37, 99, 235, 0.18)"></i><i style="background:rgba(37, 99, 235, 0.29)"></i><i style="background:rgba(37, 99, 235, 0.40)"></i></span>
                <span>多 · 格内数字为领用台数，点击下钻</span></p>` : '';
        const table = departments.length ? `
            <div class="du-table-wrap">
                <table class="du-table">
                    <caption class="sr-only">部门 × 设备类型领用矩阵，点击格内数字查看入职/领用/更换明细</caption>
                    <thead>${head}</thead>
                    <tbody>${body}</tbody>
                    <tfoot><tr><th scope="row">合计</th>${foot}<td class="num du-total">${grand}</td></tr></tfoot>
                </table>
            </div>${legend}`
            : '<div class="du-empty">该口径下暂无领用记录</div>';

        const note = '口径：按流转发生次数统计，区间内每条「入职 / 领用 / 更换」记录计 1 次；同一资产区间内多次流转计多次；部门取流转记录中的使用部门。';
        $('deptUsageBody').innerHTML = `
            <div class="du-toolbar">${rangeBar}</div>
            ${kpis}
            <p class="usage-note">${note}</p>
            ${table}`;
        $('duFrom').value = from;
        $('duTo').value = to;
    }

    /** 二级：某部门 × 某类型的入职/领用/更换三卡明细 */
    function renderDeptTypeUsage(dept, type) {
        const { month_from: from, month_to: to } = DEPT_USAGE;
        const period = from === to ? duMonthLabel(from) : `${duMonthLabel(from)} ~ ${duMonthLabel(to)}`;
        $('deptUsageTitle').textContent = `${dept} · ${type}`;
        const list = (DEPT_USAGE.details || {})[`${dept}|${type}`] || [];
        const cards = TAG_METRIC.map(tag => {
            const items = list.filter(item => item.tag === tag);
            const rows = items.map(item => `
                <li class="du-item">
                    <button type="button" class="du-item-number" data-action="asset-detail" data-number="${escapeHtml(item.number)}"
                        title="查看 ${escapeHtml(item.number)} 的设备配置与流转情况">${escapeHtml(item.number)}</button>
                    <span class="du-item-name">${escapeHtml(item.name) || '-'}</span>
                    <span class="du-item-date">${escapeHtml(item.date) || '-'}</span>
                </li>`).join('');
            return `
                <section class="du-tagcard" aria-label="${escapeHtml(tag)} ${items.length} 条">
                    <header class="du-tagcard-head">
                        <span class="du-tagchip du-tag-${escapeHtml(tag)}">${escapeHtml(tag)}</span>
                        <strong class="du-tagcard-count">${items.length}</strong>
                    </header>
                    ${items.length ? `<ul class="du-list">${rows}</ul>` : '<p class="du-tagcard-empty">该标签下无记录</p>'}
                </section>`;
        }).join('');
        $('deptUsageBody').innerHTML = `
            <nav class="du-crumb" aria-label="面包屑">
                <button type="button" class="du-back" data-action="back-matrix">&larr; 部门领用总览</button>
                <span class="du-crumb-sep" aria-hidden="true">/</span>
                <span class="du-crumb-current">${escapeHtml(dept)} · ${escapeHtml(type)}</span>
                <span class="du-crumb-period">${escapeHtml(period)}</span>
            </nav>
            <div class="du-tagcards">${cards}</div>`;
    }

    /** 资产档案详情：基本信息 + 设备配置 + 台账流转历史 */
    function openAssetFull(number) {
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
                <td><button type="button" class="link-btn strong" data-action="dept" data-dept="${escapeHtml(d.department)}">${escapeHtml(d.department)}</button></td>
                <td class="num">${d.count}</td>
                <td class="num">${d.issued}</td>
                <td class="num">${d.in_stock}</td>
                <td class="num">${d.user_count}</td>
                <td><button type="button" class="mini-btn" data-action="dept" data-dept="${escapeHtml(d.department)}">查看使用人</button></td>
            </tr>`).join('');
            $('usageBody').innerHTML = `
                <p class="usage-tip">点击部门可查看该部门具体使用人及领取时间。</p>
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
            const summary = res.owner_summary.map(o =>
                `<span class="owner-chip">${escapeHtml(o.owner)}<b>${o.count}</b></span>`).join('');
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
                <div class="owner-summary">${summary || '<span class="muted">暂无使用人</span>'}</div>
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

    // ---------- 单据表单 ----------
    function openOrderForm(order) {
        EDITING_ORDER_ID = order ? order.id : null;
        $('orderFormTitle').textContent = order ? `编辑单据 ${order.order_no}` : '新增单据';
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        const typeOptions = (order && !META.device_types.includes(order.device_type)
            ? [order.device_type].concat(META.device_types) : META.device_types)
            .map(t => `<option value="${escapeHtml(t)}"${order && order.device_type === t ? ' selected' : ''}>${escapeHtml(t)}</option>`).join('');

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
            const data = {};
            new FormData(form).forEach((v, k) => { data[k] = v; });
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
            ? `<div class="form-hint">已绑定台账资产 ${escapeHtml(card.asset_number)}：所属人 / 所属部门 / 领取时间 / 状态由台账自动同步，无需手工维护；如需换绑，直接修改上方资产编码即可。</div>`
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
        $('budgetBody').innerHTML = loadingHtml();
        getJson(`/api/budgets?year=${encodeURIComponent(year)}`).then(res => {
            if (res.status !== 'success') {
                $('budgetBody').innerHTML = `<div class="modal-error">${escapeHtml(res.message || '加载失败')}</div>`;
                return;
            }
            const yearOptions = META.years.map(y =>
                `<option value="${y}"${y === res.year ? ' selected' : ''}>${y} 年</option>`).join('');
            const rows = res.budgets.map(b => `<tr data-id="${b.id}">
                <td>${escapeHtml(b.device_type)}</td>
                <td><input type="number" class="budget-input" min="0" step="0.01" value="${b.budget_amount}"></td>
                <td class="num">${money(b.used)}</td>
                <td class="num ${b.left < 0 ? 'neg-text' : ''}">${money(b.left)}</td>
                <td class="row-actions">
                    <button type="button" class="mini-btn" data-action="save-budget" data-id="${b.id}" data-type="${escapeHtml(b.device_type)}">保存</button>
                    <button type="button" class="mini-btn danger" data-action="del-budget" data-id="${b.id}">删除</button>
                </td>
            </tr>`).join('');
            const typeOptions = META.device_types.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
            $('budgetBody').innerHTML = `
                <div class="budget-toolbar">
                    <label for="budgetYear">预算年度</label>
                    <select id="budgetYear">${yearOptions}</select>
                    <span class="muted">预算剩余 = 预算金额 - 当年该类型「预算内」单据金额合计</span>
                </div>
                <table class="data-table usage-table">
                    <thead><tr><th>设备类型</th><th>预算金额（元）</th><th class="num">已用</th><th class="num">剩余</th><th>操作</th></tr></thead>
                    <tbody>${rows || '<tr><td colspan="5" class="table-empty">该年度尚未设置预算</td></tr>'}</tbody>
                </table>
                <div class="budget-add-row">
                    <select id="newBudgetType"><option value="">--选择设备类型--</option>${typeOptions}</select>
                    <input type="number" id="newBudgetAmount" min="0" step="0.01" placeholder="预算金额（元）">
                    <button type="button" class="mini-btn primary" data-action="add-budget">新增预算</button>
                </div>`;
            $('budgetYear').addEventListener('change', (e) => renderBudgetPanel(e.target.value));
        }).catch(() => {
            $('budgetBody').innerHTML = '<div class="modal-error">加载失败，请刷新重试</div>';
        });
    }

    function saveBudgetRow(id, deviceType) {
        const row = document.querySelector(`#budgetBody tr[data-id="${id}"]`);
        const value = row.querySelector('.budget-input').value;
        postForm('/api/budgets', {
            year: $('budgetYear').value, device_type: deviceType, budget_amount: value
        }).then(res => {
            toast(res.message, res.status === 'success');
            if (res.status === 'success') {
                renderBudgetPanel($('budgetYear').value);
                loadOrders();
            }
        });
    }

    function addBudget() {
        const type = $('newBudgetType').value;
        const amount = $('newBudgetAmount').value;
        if (!type) { toast('请选择设备类型', false); return; }
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
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') document.querySelectorAll('.custom-modal').forEach(m => { m.style.display = 'none'; });
        });

        $('orderSearchBtn').addEventListener('click', loadOrders);
        $('deptUsageBtn').addEventListener('click', openDeptUsage);
        // 月份区间 select 在弹窗内重建，用委托监听 change
        document.addEventListener('change', (e) => {
            if (e.target.id !== 'duFrom' && e.target.id !== 'duTo') return;
            DU_FROM = $('duFrom').value;
            DU_TO = $('duTo').value;
            if (DU_FROM > DU_TO) [DU_FROM, DU_TO] = [DU_TO, DU_FROM];
            loadDeptUsageData();
        });
        $('orderResetBtn').addEventListener('click', () => {
            $('filterType').value = '';
            $('filterBudget').value = '';
            $('filterPushed').value = '';
            $('filterReview').value = '0';
            $('filterKeyword').value = '';
            $('filterYear').value = META.current_year;
            loadOrders();
        });
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
            if (action === 'back-dept') { loadDeptUsage(); return; }
            if (action === 'matrix-cell') {
                renderDeptTypeUsage(btn.dataset.dept, btn.dataset.type);
                return;
            }
            if (action === 'back-matrix') { renderUsageMatrix(); return; }
            if (action === 'asset-detail') { openAssetFull(btn.dataset.number); return; }
            if (action === 'du-preset') {
                const cur = currentYM();
                if (btn.dataset.preset === 'this') { DU_FROM = cur; DU_TO = cur; }
                else if (btn.dataset.preset === 'last') { DU_FROM = shiftYM(cur, -1); DU_TO = DU_FROM; }
                else if (btn.dataset.preset === 'half') { DU_FROM = shiftYM(cur, -5); DU_TO = cur; }
                else { DU_FROM = `${cur.slice(0, 4)}-01`; DU_TO = `${cur.slice(0, 4)}-12`; }
                loadDeptUsageData();
                return;
            }

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
            if (action === 'del-budget') {
                if (!window.confirm('确认删除该条预算？')) return;
                fetch(`/api/budgets/${id}`, { method: 'DELETE' })
                    .then(r => r.json())
                    .then(res => {
                        toast(res.message, res.status === 'success');
                        if (res.status === 'success') { renderBudgetPanel($('budgetYear').value); loadOrders(); }
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
        document.querySelectorAll('.admin-only').forEach(el => {
            el.style.display = ADMIN ? '' : 'none';
        });
        bindEvents();
        loadMeta().then(loadOrders);
    }

    window.addEventListener('DOMContentLoaded', init);
})();
