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
