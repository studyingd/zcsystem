// index/overview.js — 页面状态、初始化入口、状态统计卡与按状态数据预览（index.js 拆分 1/4）
let statusCounts = {};
let statusTotal = 0;
let activeOverviewStatus = null;
let previewCurrentPage = 1;
const PAGE_SIZE = 20;
window.addEventListener('DOMContentLoaded', () => {
    loadStatusCounts();
    bindQueryBtn();
});

function loadStatusCounts() {
    fetch('/status_counts')
        .then(response => {
            if (!response.ok) throw new Error('网络请求失败');
            return response.json();
        })
        .then(res => {
            if (res.status === 'success') {
                statusCounts = res.counts;
                statusTotal = res.total;
                renderOverviewCards();
                if (activeOverviewStatus) {
                    const card = document.querySelector(`.overview-card[data-status="${activeOverviewStatus}"]`);
                    if (card) {
                        card.classList.add('active');
                        showPreviewCards(activeOverviewStatus);
                    }
                } else {
                    activeOverviewStatus = '未录入';
                    const card = document.querySelector(`.overview-card[data-status="未录入"]`);
                    if (card) {
                        card.classList.add('active');
                        showPreviewCards('未录入');
                    }
                }
            }
        })
        .catch(error => {
            console.error('加载错误:', error);
        });
}

function renderOverviewCards() {
    const container = document.getElementById('overviewCards');

    // 卡片顺序跟随后端词表，末尾补上台账里没有流转记录的「无状态」
    const statusOrder = [...STATUS_OPTIONS, '无状态'];
    const statusColors = {
        '已录入': '#28a745',
        '未录入': '#ffc107',
        '租聘': '#17a2b8',
        '借用': '#6610f2',
        '入库': '#fd7e14',
        '无需录入': '#6c757d',
        '报废': '#dc3545',
        '无状态': '#adb5bd'
    };

    let html = `
        <div class="overview-card" data-status="all">
            <div class="overview-card-count" style="color:#007bff;">${statusTotal}</div>
            <div class="overview-card-label">全部</div>
        </div>
    `;
    statusOrder.forEach(status => {
        const count = statusCounts[status] || 0;
        const color = statusColors[status] || '#6c757d';
        html += `
            <div class="overview-card" data-status="${escapeHtml(status)}">
                <div class="overview-card-count" style="color:${color};">${count}</div>
                <div class="overview-card-label">${escapeHtml(status)}</div>
            </div>
        `;
    });
    container.innerHTML = html;

    // 绑定点击事件
    container.querySelectorAll('.overview-card').forEach(card => {
        card.addEventListener('click', () => {
            container.querySelectorAll('.overview-card').forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            const status = card.dataset.status;
            activeOverviewStatus = status;
            showPreviewCards(status);
        });
    });

    // 返回按钮（先替换节点清除旧监听器，避免累积）
    const oldBackBtn = document.getElementById('previewBackBtn');
    const newBackBtn = oldBackBtn.cloneNode(true);
    oldBackBtn.parentNode.replaceChild(newBackBtn, oldBackBtn);
    newBackBtn.addEventListener('click', () => {
        activeOverviewStatus = null;
        document.getElementById('overviewCards').querySelectorAll('.overview-card').forEach(c => c.classList.remove('active'));
        document.getElementById('previewDataArea').style.display = 'none';
    });
}

function showPreviewCards(status, page) {
    if (page === undefined) page = 1;
    previewCurrentPage = page;

    const dataArea = document.getElementById('previewDataArea');
    const cardList = document.getElementById('previewCardList');
    const title = document.getElementById('previewTitle');

    cardList.innerHTML = '<div style="text-align:center;color:#999;padding:40px;">加载中...</div>';

    const url = `/list_by_status?status=${encodeURIComponent(status)}&page=${page}&page_size=${PAGE_SIZE}`;
    fetch(url)
        .then(r => r.json())
        .then(res => {
            if (res.status !== 'success') {
                cardList.innerHTML = `<div style="text-align:center;color:#dc3545;padding:40px;">${escapeHtml(res.message)}</div>`;
                return;
            }

            const data = res.data;
            const total = res.total;
            const totalPages = res.total_pages;
            const label = status === 'all' ? '全部' : status;
            title.textContent = `${label}（共 ${total} 条${totalPages > 1 ? `，第 ${page}/${totalPages} 页` : ''}）`;

            if (data.length === 0) {
                cardList.innerHTML = '<div class="empty-tip" style="padding:30px;text-align:center;color:#999;">暂无数据</div>';
            } else {
                let html = '';
                data.forEach(item => {
                    const statusClass = getStatusClass(item.status);
                    html += `
                    <div class="query-card" data-id="${escapeHtml(item.id)}" data-number="${escapeHtml(item.number || '')}" data-source="${escapeHtml(item.source || 'inventory')}" onclick="showQueryDetail(this)">
                        <div class="query-card-header">
                            <span class="query-card-number">${escapeHtml(item.number) || '-'}</span>
                            <span class="query-card-status ${statusClass}">${escapeHtml(item.status) || '无状态'}</span>
                        </div>
                        <div class="query-card-body">
                            <div class="query-card-field"><label>使用部门</label><span>${escapeHtml(item.department) || '-'}</span></div>
                            <div class="query-card-field"><label>使用人</label><span>${escapeHtml(item.site) || '-'}</span></div>
                            <div class="query-card-field"><label>资产类型</label><span>${escapeHtml(item.type) || '-'}</span></div>
                            <div class="query-card-field"><label>发放日期</label><span>${escapeHtml(item.datetime) || '-'}</span></div>
                        </div>
                    </div>
                    `;
                });

                // 分页控件
                if (totalPages > 1) {
                    html += `<div class="preview-pagination">`;
                    html += `<button class="preview-page-btn" data-page="1" ${page === 1 ? 'disabled' : ''}>首页</button>`;
                    html += `<button class="preview-page-btn" data-page="${page - 1}" ${page === 1 ? 'disabled' : ''}>上一页</button>`;
                    let startPage = Math.max(1, page - 2);
                    let endPage = Math.min(totalPages, startPage + 4);
                    if (endPage - startPage < 4) startPage = Math.max(1, endPage - 4);
                    for (let i = startPage; i <= endPage; i++) {
                        html += `<button class="preview-page-btn ${i === page ? 'active' : ''}" data-page="${i}">${i}</button>`;
                    }
                    html += `<button class="preview-page-btn" data-page="${page + 1}" ${page === totalPages ? 'disabled' : ''}>下一页</button>`;
                    html += `<button class="preview-page-btn" data-page="${totalPages}" ${page === totalPages ? 'disabled' : ''}>末页</button>`;
                    html += `</div>`;
                }

                cardList.innerHTML = html;

                // 绑定分页按钮事件
                cardList.querySelectorAll('.preview-page-btn:not([disabled])').forEach(btn => {
                    btn.addEventListener('click', () => {
                        showPreviewCards(activeOverviewStatus, parseInt(btn.dataset.page));
                    });
                });
            }

            dataArea.style.display = 'block';
        })
        .catch(() => {
            cardList.innerHTML = '<div style="text-align:center;color:#dc3545;padding:40px;">加载失败</div>';
        });
}

