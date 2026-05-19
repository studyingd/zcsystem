window.addEventListener('DOMContentLoaded', () => {
    const startInput = document.getElementById('dashboardStart');
    const endInput = document.getElementById('dashboardEnd');
    const now = new Date();
    startInput.value = formatDate(new Date(now.getFullYear(), now.getMonth(), 1));
    endInput.value = formatDate(now);

    startInput.addEventListener('change', () => { updateMonthBtns(); loadStats(); });
    endInput.addEventListener('change', () => { updateMonthBtns(); loadStats(); });
    document.getElementById('detailClose').addEventListener('click', closeModal);
    document.getElementById('detailModal').addEventListener('click', function(e) {
        if (e.target === this) closeModal();
    });
    document.getElementById('filterDept').addEventListener('change', reloadMetricDetail);
    document.getElementById('filterTag').addEventListener('change', reloadMetricDetail);
    document.getElementById('lastMonthBtn').addEventListener('click', () => {
        const cur = new Date(startInput.value);
        const y = cur.getFullYear(), m = cur.getMonth();
        const days = new Date(y, m, 0).getDate();
        startInput.value = formatDate(new Date(y, m - 1, 1));
        endInput.value = formatDate(new Date(y, m - 1, days));
        updateMonthBtns();
        loadStats();
    });
    document.getElementById('nextMonthBtn').addEventListener('click', () => {
        const cur = new Date(startInput.value);
        const y = cur.getFullYear(), m = cur.getMonth();
        const days = new Date(y, m + 2, 0).getDate();
        startInput.value = formatDate(new Date(y, m + 1, 1));
        endInput.value = formatDate(new Date(y, m + 1, days));
        updateMonthBtns();
        loadStats();
    });

    updateMonthBtns();
    loadStats();

    if (typeof DASHBOARD_ADMIN !== 'undefined' && DASHBOARD_ADMIN) {
        setTimeout(() => openAdminPanel(), 500);
    }
});

function updateMonthBtns() {
    const cur = new Date(document.getElementById('dashboardStart').value);
    const now = new Date();
    const isCurrentOrFuture = (cur.getFullYear() > now.getFullYear()) ||
        (cur.getFullYear() === now.getFullYear() && cur.getMonth() >= now.getMonth());
    document.getElementById('nextMonthBtn').disabled = isCurrentOrFuture;
}

function formatDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let currentMetricKey = null;
let detailCurrentPage = 1;
const DETAIL_PAGE_SIZE = 20;
let detailAllRows = [];

function paginateRows(rows, page) {
    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / DETAIL_PAGE_SIZE));
    if (page > totalPages) page = totalPages;
    const start = (page - 1) * DETAIL_PAGE_SIZE;
    return { pageData: rows.slice(start, start + DETAIL_PAGE_SIZE), total, totalPages, page };
}

function paginationHtml(total, totalPages, page) {
    if (totalPages <= 1) return '';
    let html = `<div class="preview-pagination" style="margin-top:12px;">`;
    html += `<span style="font-size:13px;color:#666;margin-right:8px;">共 ${total} 条，第 ${page}/${totalPages} 页</span>`;
    html += `<button class="detail-page-btn" data-page="1" ${page === 1 ? 'disabled' : ''}>首页</button>`;
    html += `<button class="detail-page-btn" data-page="${page - 1}" ${page === 1 ? 'disabled' : ''}>上一页</button>`;
    let startPage = Math.max(1, page - 2);
    let endPage = Math.min(totalPages, startPage + 4);
    if (endPage - startPage < 4) startPage = Math.max(1, endPage - 4);
    for (let i = startPage; i <= endPage; i++) {
        html += `<button class="detail-page-btn ${i === page ? 'active' : ''}" data-page="${i}">${i}</button>`;
    }
    html += `<button class="detail-page-btn" data-page="${page + 1}" ${page === totalPages ? 'disabled' : ''}>下一页</button>`;
    html += `<button class="detail-page-btn" data-page="${totalPages}" ${page === totalPages ? 'disabled' : ''}>末页</button>`;
    html += `</div>`;
    return html;
}

let _cachedStats = { purchases: [], stocks: [], metrics: [] };

function getStart() { return document.getElementById('dashboardStart').value; }
function getEnd() { return document.getElementById('dashboardEnd').value; }

function loadStats() {
    const start = getStart();
    const end = getEnd();
    const purchaseContainer = document.getElementById('purchaseCards');
    const metricContainer = document.getElementById('metricCards');

    if (!start || !end) {
        purchaseContainer.innerHTML = '<div style="text-align:center;color:#999;padding:40px;">请选择起止日期</div>';
        metricContainer.innerHTML = '';
        return;
    }
    if (start > end) {
        purchaseContainer.innerHTML = '<div style="text-align:center;color:#dc3545;padding:40px;">起始日期不能晚于结束日期</div>';
        metricContainer.innerHTML = '';
        return;
    }

    closeModal();
    purchaseContainer.innerHTML = '<div style="text-align:center;color:#999;padding:40px;">加载中...</div>';
    document.getElementById('stockCards').innerHTML = '<div style="text-align:center;color:#999;padding:40px;">加载中...</div>';
    metricContainer.innerHTML = '';

    fetch(`/api/dashboard_stats?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`)
        .then(r => r.json())
        .then(res => {
            if (res.status !== 'success') {
                purchaseContainer.innerHTML = `<div style="text-align:center;color:#dc3545;">${escapeHtml(res.message)}</div>`;
                return;
            }
            renderPurchaseCards(res.purchases, res.prev_period);
            renderStockCards(res.stocks);
            renderMetricCards(res.metrics, res.prev_period);
            _cachedStats = { purchases: res.purchases, stocks: res.stocks, metrics: res.metrics };
        })
        .catch(() => {
            purchaseContainer.innerHTML = '<div style="text-align:center;color:#dc3545;">加载失败</div>';
        });
}

function trendHtml(trend, diff, prevPeriod) {
    const prevLabel = `较 ${prevPeriod}`;
    if (trend === 'up') return `<span class="stat-card-trend trend-up"><span class="trend-arrow">↑</span> +${diff} ${prevLabel}</span>`;
    if (trend === 'down') return `<span class="stat-card-trend trend-down"><span class="trend-arrow">↓</span> ${diff} ${prevLabel}</span>`;
    return `<span class="stat-card-trend trend-same"><span class="trend-arrow">-</span> 持平 ${prevLabel}</span>`;
}

function renderPurchaseCards(purchases, prevPeriod) {
    const container = document.getElementById('purchaseCards');
    let html = '';
    purchases.forEach(p => {
        html += `
            <div class="stat-card clickable" data-key="${escapeHtml(p.key)}">
                <div class="stat-card-header">${escapeHtml(p.name)}</div>
                <div class="stat-card-value">${escapeHtml(p.current)}<span class="unit">台</span></div>
                ${trendHtml(p.trend, p.diff, prevPeriod)}
            </div>
        `;
    });
    container.innerHTML = html;
    container.querySelectorAll('.clickable').forEach(card => {
        card.addEventListener('click', () => openPurchaseDetail(card.dataset.key));
    });
}

function renderMetricCards(metrics, prevPeriod) {
    const container = document.getElementById('metricCards');
    let html = '';
    metrics.forEach(m => {
        html += `
            <div class="stat-card clickable" data-key="${escapeHtml(m.key)}">
                <div class="stat-card-header">${escapeHtml(m.name)}</div>
                <div class="stat-card-value">${escapeHtml(m.current)}<span class="unit">台</span></div>
                ${trendHtml(m.trend, m.diff, prevPeriod)}
            </div>
        `;
    });
    container.innerHTML = html;
    container.querySelectorAll('.clickable').forEach(card => {
        card.addEventListener('click', () => openMetricDetail(card.dataset.key));
    });
}

// --- 弹窗控制 ---
function openModal(title, isMetric) {
    const modal = document.getElementById('detailModal');
    document.getElementById('detailTitle').textContent = title;
    document.getElementById('detailFilters').style.display = isMetric ? '' : 'none';
    document.getElementById('detailCards').innerHTML = '<div style="text-align:center;color:#999;padding:40px;">加载中...</div>';
    modal.style.display = 'flex';
}

function closeModal() {
    document.getElementById('detailModal').style.display = 'none';
    currentMetricKey = null;
    detailCurrentPage = 1;
    detailAllRows = [];
}

// --- 库存卡片 ---
function renderStockCards(stocks) {
    const container = document.getElementById('stockCards');
    let html = '';
    stocks.forEach(s => {
        html += `
            <div class="stat-card clickable" data-key="${escapeHtml(s.key)}">
                <div class="stat-card-header">${escapeHtml(s.name)}</div>
                <div class="stat-card-value">${escapeHtml(s.count)}<span class="unit">台</span></div>
            </div>
        `;
    });
    container.innerHTML = html;
    container.querySelectorAll('.clickable').forEach(card => {
        card.addEventListener('click', () => openStockDetail(card.dataset.key));
    });
}

function openStockDetail(key) {
    currentMetricKey = null;
    openModal('加载中...', false);

    fetch(`/api/dashboard_stock_detail?key=${encodeURIComponent(key)}`)
        .then(r => r.json())
        .then(res => {
            if (res.status !== 'success') {
                document.getElementById('detailCards').innerHTML = `<div style="text-align:center;color:#dc3545;">${escapeHtml(res.message)}</div>`;
                return;
            }
            detailAllRows = res.data;
            detailCurrentPage = 1;
            document.getElementById('detailTitle').textContent = res.title;
            renderStockDetailPage();
        })
        .catch(() => {
            document.getElementById('detailCards').innerHTML = '<div style="text-align:center;color:#dc3545;">加载失败</div>';
        });
}

function renderStockDetailPage() {
    const { pageData, total, totalPages, page } = paginateRows(detailAllRows, detailCurrentPage);
    document.getElementById('detailTitle').textContent = document.getElementById('detailTitle').textContent.replace(/（.*）$/, '') + `（共 ${total} 条${totalPages > 1 ? `，第 ${page}/${totalPages} 页` : ''}）`;
    const cards = document.getElementById('detailCards');
    cards.innerHTML = renderStockCardsList(pageData) + paginationHtml(total, totalPages, page);
    bindDetailPagination();
}

function bindDetailPagination() {
    document.querySelectorAll('.detail-page-btn:not([disabled])').forEach(btn => {
        btn.addEventListener('click', () => {
            detailCurrentPage = parseInt(btn.dataset.page);
            renderStockDetailPage();
        });
    });
}

function renderStockCardsList(rows) {
    if (!rows.length) return '<div class="empty-tip">暂无数据</div>';
    return rows.map(r => `
        <div class="query-card">
            <div class="query-card-header">
                <span class="query-card-number">${escapeHtml(r.number)}</span>
                <span class="query-card-status status-none">${escapeHtml(r.type)}</span>
            </div>
            <div class="query-card-body">
                <div class="query-card-field"><label>规格</label><span>${escapeHtml(r.spec) || '-'}</span></div>
                <div class="query-card-field"><label>部门</label><span>${escapeHtml(r.dept) || '-'}</span></div>
                <div class="query-card-field"><label>位置/使用人</label><span>${escapeHtml(r.site) || '-'}</span></div>
                ${r.tag ? `<div class="query-card-field"><label>标签</label><span>${escapeHtml(r.tag)}</span></div>` : ''}
                ${r.datetime ? `<div class="query-card-field"><label>日期</label><span>${escapeHtml(r.datetime)}</span></div>` : ''}
            </div>
        </div>
    `).join('');
}

// --- 采购明细 ---
function openPurchaseDetail(key) {
    currentMetricKey = null;
    openModal('加载中...', false);

    fetch(`/api/dashboard_purchase_detail?key=${encodeURIComponent(key)}&start=${encodeURIComponent(getStart())}&end=${encodeURIComponent(getEnd())}`)
        .then(r => r.json())
        .then(res => {
            if (res.status !== 'success') {
                document.getElementById('detailCards').innerHTML = `<div style="text-align:center;color:#dc3545;">${escapeHtml(res.message)}</div>`;
                return;
            }
            detailAllRows = res.data;
            detailCurrentPage = 1;
            document.getElementById('detailTitle').textContent = res.title;
            renderPurchaseDetailPage();
        })
        .catch(() => {
            document.getElementById('detailCards').innerHTML = '<div style="text-align:center;color:#dc3545;">加载失败</div>';
        });
}

function renderPurchaseDetailPage() {
    const { pageData, total, totalPages, page } = paginateRows(detailAllRows, detailCurrentPage);
    document.getElementById('detailTitle').textContent = document.getElementById('detailTitle').textContent.replace(/（.*）$/, '') + `（共 ${total} 条${totalPages > 1 ? `，第 ${page}/${totalPages} 页` : ''}）`;
    const cards = document.getElementById('detailCards');
    cards.innerHTML = renderPurchaseCardsList(pageData) + paginationHtml(total, totalPages, page);
    bindPurchasePagination();
}

function bindPurchasePagination() {
    document.querySelectorAll('.detail-page-btn:not([disabled])').forEach(btn => {
        btn.addEventListener('click', () => {
            detailCurrentPage = parseInt(btn.dataset.page);
            renderPurchaseDetailPage();
        });
    });
}

function renderPurchaseCardsList(rows) {
    if (!rows.length) return '<div class="empty-tip">暂无数据</div>';
    return rows.map(r => `
        <div class="query-card">
            <div class="query-card-header">
                <span class="query-card-number">${escapeHtml(r.number)}</span>
                <span class="query-card-status status-none">${escapeHtml(r.type)}</span>
            </div>
            <div class="query-card-body">
                <div class="query-card-field"><label>规格</label><span>${escapeHtml(r.spec) || '-'}</span></div>
                <div class="query-card-field"><label>部门</label><span>${escapeHtml(r.department) || '-'}</span></div>
                <div class="query-card-field"><label>使用人</label><span>${escapeHtml(r.name) || '-'}</span></div>
                ${r.sn ? `<div class="query-card-field"><label>SN码</label><span>${escapeHtml(r.sn)}</span></div>` : ''}
                ${r.cpu ? `<div class="query-card-field"><label>CPU</label><span>${escapeHtml(r.cpu)}</span></div>` : ''}
                ${r.mem ? `<div class="query-card-field"><label>内存</label><span>${escapeHtml(r.mem)}</span></div>` : ''}
                ${r.disk ? `<div class="query-card-field"><label>硬盘</label><span>${escapeHtml(r.disk)}</span></div>` : ''}
                ${r.gpu ? `<div class="query-card-field"><label>显卡</label><span>${escapeHtml(r.gpu)}</span></div>` : ''}
            </div>
        </div>
    `).join('');
}

// --- 领用明细 ---
function openMetricDetail(key) {
    currentMetricKey = key;
    document.getElementById('filterDept').value = '';
    document.getElementById('filterTag').value = '';
    openModal('加载中...', true);
    fetchMetricDetail(key, '', '');
}

function reloadMetricDetail() {
    if (!currentMetricKey) return;
    detailCurrentPage = 1;
    const dept = document.getElementById('filterDept').value;
    const tag = document.getElementById('filterTag').value;
    fetchMetricDetail(currentMetricKey, dept, tag);
}

function fetchMetricDetail(key, department, tag) {
    const cards = document.getElementById('detailCards');
    cards.innerHTML = '<div style="text-align:center;color:#999;padding:40px;">加载中...</div>';

    let url = `/api/dashboard_metric_detail?key=${encodeURIComponent(key)}&start=${encodeURIComponent(getStart())}&end=${encodeURIComponent(getEnd())}`;
    if (department) url += `&department=${encodeURIComponent(department)}`;
    if (tag) url += `&tag=${encodeURIComponent(tag)}`;

    fetch(url)
        .then(r => r.json())
        .then(res => {
            if (res.status !== 'success') {
                cards.innerHTML = `<div style="text-align:center;color:#dc3545;">${escapeHtml(res.message)}</div>`;
                return;
            }
            detailAllRows = res.data;
            document.getElementById('detailTitle').textContent = res.title;

            // fill filters
            const deptSelect = document.getElementById('filterDept');
            const tagSelect = document.getElementById('filterTag');
            const prevDept = deptSelect.value;
            const prevTag = tagSelect.value;

            deptSelect.innerHTML = '<option value="">全部部门</option>' + res.departments.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
            tagSelect.innerHTML = '<option value="">全部标签</option>' + res.tags.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
            deptSelect.value = prevDept;
            tagSelect.value = prevTag;

            renderMetricDetailPage();
        })
        .catch(() => {
            cards.innerHTML = '<div style="text-align:center;color:#dc3545;">加载失败</div>';
        });
}

function renderMetricDetailPage() {
    const { pageData, total, totalPages, page } = paginateRows(detailAllRows, detailCurrentPage);
    document.getElementById('detailTitle').textContent = document.getElementById('detailTitle').textContent.replace(/（.*）$/, '') + `（共 ${total} 条${totalPages > 1 ? `，第 ${page}/${totalPages} 页` : ''}）`;
    const cards = document.getElementById('detailCards');
    cards.innerHTML = renderMetricCardsList(pageData) + paginationHtml(total, totalPages, page);
    bindMetricPagination();
}

function bindMetricPagination() {
    document.querySelectorAll('.detail-page-btn:not([disabled])').forEach(btn => {
        btn.addEventListener('click', () => {
            detailCurrentPage = parseInt(btn.dataset.page);
            renderMetricDetailPage();
        });
    });
}

function renderMetricCardsList(rows) {
    if (!rows.length) return '<div class="empty-tip">暂无数据</div>';
    return rows.map(r => `
        <div class="query-card">
            <div class="query-card-header">
                <span class="query-card-number">${escapeHtml(r.number)}</span>
                <span class="query-card-status status-none">${escapeHtml(r.tag)}</span>
            </div>
            <div class="query-card-body">
                <div class="query-card-field"><label>类型</label><span>${escapeHtml(r.type)}</span></div>
                <div class="query-card-field"><label>部门</label><span>${escapeHtml(r.department) || '-'}</span></div>
                <div class="query-card-field"><label>使用人</label><span>${escapeHtml(r.site) || '-'}</span></div>
                <div class="query-card-field"><label>日期</label><span>${escapeHtml(r.datetime) || '-'}</span></div>
                <div class="query-card-field"><label>状态</label><span>${escapeHtml(r.status) || '-'}</span></div>
                ${r.notice ? `<div class="query-card-field"><label>备注</label><span>${escapeHtml(r.notice)}</span></div>` : ''}
            </div>
        </div>
    `).join('');
}

// --- 管理面板 ---
function openAdminPanel() {
    const start = getStart();
    const end = getEnd();

    const existing = document.getElementById('adminModal');
    if (existing) { existing.style.display = 'flex'; loadAdminData(); return; }

    const modal = document.createElement('div');
    modal.className = 'custom-modal';
    modal.id = 'adminModal';
    modal.style.cssText = 'display:flex;';

    modal.innerHTML = `
        <div class="modal-content" style="max-width:540px;width:92vw;max-height:85vh;overflow-y:auto;overflow-x:hidden;">
            <div class="modal-header-bar">
                <span class="modal-header-title">数据管理</span>
                <button class="modal-close-btn" id="adminClose">&times;</button>
            </div>
            <div style="padding:8px 12px 0;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <input type="date" id="adminStart" value="${escapeHtml(start)}" style="padding:4px 6px;border:1px solid #ccc;border-radius:3px;flex:1;min-width:120px;">
                <span>~</span>
                <input type="date" id="adminEnd" value="${escapeHtml(end)}" style="padding:4px 6px;border:1px solid #ccc;border-radius:3px;flex:1;min-width:120px;">
                <button id="adminLoadBtn" style="padding:4px 12px;background:#007bff;color:#fff;border:none;border-radius:3px;cursor:pointer;white-space:nowrap;">查询</button>
            </div>
            <div id="adminBody" style="padding:12px;">
                <div style="text-align:center;color:#999;padding:20px;">加载中...</div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', function(e) { if (e.target === modal) closeAdminPanel(); });
    document.getElementById('adminClose').addEventListener('click', closeAdminPanel);
    document.getElementById('adminLoadBtn').addEventListener('click', loadAdminData);
    loadAdminData();
}

function closeAdminPanel() {
    const modal = document.getElementById('adminModal');
    if (modal) modal.style.display = 'none';
}

function loadAdminData() {
    const body = document.getElementById('adminBody');
    body.innerHTML = '<div style="text-align:center;color:#999;padding:20px;">加载中...</div>';

    const start = document.getElementById('adminStart').value;
    const end = document.getElementById('adminEnd').value;
    if (!start || !end) { body.innerHTML = '<div style="color:#dc3545;">请选择起止日期</div>'; return; }

    fetch(`/api/dashboard_admin_overrides?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`)
        .then(r => r.json())
        .then(res => {
            if (res.status !== 'success') {
                body.innerHTML = `<div style="color:#dc3545;">${escapeHtml(res.message)}</div>`;
                return;
            }
            // Load stats for the selected period to get computed values
            fetch(`/api/dashboard_stats?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`)
                .then(r2 => r2.json())
                .then(stats => {
                    if (stats.status !== 'success') {
                        body.innerHTML = `<div style="color:#dc3545;">${escapeHtml(stats.message)}</div>`;
                        return;
                    }
                    _cachedStats = { purchases: stats.purchases, stocks: stats.stocks, metrics: stats.metrics };
                    renderAdminForm(res, _cachedStats);
                });
        })
        .catch(() => {
            body.innerHTML = '<div style="color:#dc3545;">加载失败</div>';
        });
}

function renderAdminForm(adminRes, stats) {
    const body = document.getElementById('adminBody');
    const overrides = adminRes.overrides;
    const labels = adminRes.labels;

    const purchaseKeys = ['laptop', 'monitor', 'desktop', 'rental_desktop'];
    const stockKeys = ['new_laptop_stock', 'old_laptop_stock', 'new_monitor_stock', 'old_monitor_stock', 'desktop_stock', 'rental_stock'];
    const metricKeys = ['new_laptop', 'old_laptop', 'new_monitor', 'old_monitor', 'desktop', 'rental'];

    function renderGroup(title, keys, getValue) {
        let html = `<h4 style="margin:12px 0 6px;font-size:13px;color:#333;">${title}</h4>`;
        html += `<table style="width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed;">`;
        html += `<colgroup><col style="width:auto;"><col style="width:54px;"><col style="width:62px;"><col style="width:40px;"></colgroup>`;
        html += `<tr style="background:#f5f5f5;"><th style="padding:4px 6px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">指标</th><th style="padding:4px 2px;text-align:center;">计算</th><th style="padding:4px 2px;text-align:center;">覆盖</th><th style="padding:4px 2px;"></th></tr>`;
        keys.forEach(key => {
            const label = labels[key] || key;
            const currentVal = getValue(key);
            const ov = overrides[key];
            const isOverridden = !!ov;
            const displayVal = isOverridden ? ov.value : currentVal;
            const rowBg = isOverridden ? 'background:#fff8e1;' : '';
            html += `<tr style="${rowBg}border-bottom:1px solid #eee;">`;
            html += `<td style="padding:4px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(label)}">${escapeHtml(label)}</td>`;
            html += `<td style="padding:4px 2px;color:#999;text-align:center;">${currentVal}</td>`;
            html += `<td style="padding:4px 2px;"><input type="number" data-key="${escapeHtml(key)}" data-computed="${currentVal}" value="${displayVal}" style="width:100%;padding:2px 4px;border:1px solid #ccc;border-radius:3px;text-align:center;font-size:12px;" min="0"></td>`;
            html += `<td style="padding:4px 2px;text-align:center;">`;
            if (isOverridden) {
                html += `<button class="admin-reset-btn" data-key="${escapeHtml(key)}" data-id="${ov.id}" style="background:none;border:none;color:#dc3545;cursor:pointer;font-size:11px;padding:0;" title="恢复计算值">恢复</button>`;
            }
            html += `</td></tr>`;
        });
        html += `</table>`;
        return html;
    }

    let html = '';
    html += renderGroup('实际采购数量', purchaseKeys, key => {
        const item = stats.purchases.find(p => p.key === key);
        return item ? item.current : 0;
    });
    html += renderGroup('当前库存', stockKeys, key => {
        const item = stats.stocks.find(s => s.key === key);
        return item ? item.count : 0;
    });
    html += renderGroup('资产领用', metricKeys, key => {
        const item = stats.metrics.find(m => m.key === key);
        return item ? item.current : 0;
    });
    html += `<div style="margin-top:16px;text-align:right;"><button id="adminSaveAllBtn" style="padding:8px 20px;background:#007bff;color:#fff;border:none;border-radius:4px;cursor:pointer;">保存全部</button></div>`;
    html += `<div id="adminMsg" style="margin-top:8px;font-size:13px;"></div>`;

    body.innerHTML = html;

    body.querySelectorAll('.admin-reset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.id;
            fetch(`/api/dashboard_admin_override?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
                .then(r => r.json())
                .then(res => {
                    if (res.status === 'success') {
                        loadAdminData();
                        loadStats();
                    }
                });
        });
    });

    document.getElementById('adminSaveAllBtn').addEventListener('click', () => {
        const start = document.getElementById('adminStart').value;
        const end = document.getElementById('adminEnd').value;
        const inputs = body.querySelectorAll('input[data-key]');
        const msgEl = document.getElementById('adminMsg');

        let promises = [];
        inputs.forEach(input => {
            const key = input.dataset.key;
            const value = input.value;
            const computed = parseInt(input.dataset.computed) || 0;
            if (value === '' || isNaN(value)) return;
            const intVal = parseInt(value);

            if (intVal === computed) {
                const ov = overrides[key];
                if (ov) {
                    promises.push(
                        fetch(`/api/dashboard_admin_override?id=${encodeURIComponent(ov.id)}`, { method: 'DELETE' })
                            .then(r => r.json())
                    );
                }
            } else {
                promises.push(
                    fetch('/api/dashboard_admin_override', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: `start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&key=${encodeURIComponent(key)}&value=${encodeURIComponent(value)}`
                    }).then(r => r.json())
                );
            }
        });

        if (promises.length === 0) {
            msgEl.style.color = '#28a745';
            msgEl.textContent = '没有需要保存的变更';
            return;
        }
        Promise.all(promises).then(results => {
            const failed = results.filter(r => r.status !== 'success');
            if (failed.length === 0) {
                msgEl.style.color = '#28a745';
                msgEl.textContent = '保存成功';
                loadStats();
                loadAdminData();
            } else {
                msgEl.style.color = '#dc3545';
                msgEl.textContent = `${failed.length} 项保存失败`;
            }
        });
    });
}
