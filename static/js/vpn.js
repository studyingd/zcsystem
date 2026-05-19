let vpnCounts = {};
let vpnTotal = 0;
let activeDepartment = null;
let vpnCurrentPage = 1;
const VPN_PAGE_SIZE = 20;

// 部门选项使用 utils.js 中的 DEPARTMENTS

// 终端选项
const VPN_TERMINAL_OPTIONS = [
    {value: '电脑翻墙', text: '电脑翻墙'},
    {value: '手机翻墙', text: '手机翻墙'},
    {value: '其它', text: '其它'}
];

// VPN类型选项
const VPN_APPTYPE_OPTIONS = [
    {value: '牧牛VPN', text: '牧牛VPN'},
    {value: '其它', text: '其它'}
];

window.addEventListener('DOMContentLoaded', () => {
    loadVpnCounts();
    bindAddBtn();
    bindModalClose();
});

function loadVpnCounts() {
    fetch('/api/vpn_counts')
        .then(response => {
            if (!response.ok) throw new Error('网络请求失败');
            return response.json();
        })
        .then(res => {
            if (res.status === 'success') {
                vpnCounts = res.counts;
                vpnTotal = res.total;
                renderVpnOverviewCards();
                if (activeDepartment !== null) {
                    const card = document.querySelector(`.overview-card[data-dept="${activeDepartment}"]`);
                    if (card) {
                        card.classList.add('active');
                        showVpnCards(activeDepartment);
                    }
                } else {
                    activeDepartment = 'all';
                    const card = document.querySelector(`.overview-card[data-dept="all"]`);
                    if (card) {
                        card.classList.add('active');
                        showVpnCards('all');
                    }
                }
            }
        })
        .catch(error => {
            console.error('加载错误:', error);
        });
}

function renderVpnOverviewCards() {
    const container = document.getElementById('vpnOverviewCards');

    const sortedDepts = Object.entries(vpnCounts).sort((a, b) => b[1] - a[1]);

    let html = `
        <div class="overview-card" data-dept="all">
            <div class="overview-card-count" style="color:#007bff;">${escapeHtml(String(vpnTotal))}</div>
            <div class="overview-card-label">全部</div>
        </div>
    `;

    const colors = ['#28a745', '#ffc107', '#17a2b8', '#6610f2', '#fd7e14', '#e83e8c', '#20c997', '#6f42c1'];
    sortedDepts.forEach(([dept, count], index) => {
        const color = colors[index % colors.length];
        html += `
            <div class="overview-card" data-dept="${escapeHtml(dept)}">
                <div class="overview-card-count" style="color:${color};">${escapeHtml(String(count))}</div>
                <div class="overview-card-label">${escapeHtml(dept)}</div>
            </div>
        `;
    });

    container.innerHTML = html;

    container.querySelectorAll('.overview-card').forEach(card => {
        card.addEventListener('click', () => {
            container.querySelectorAll('.overview-card').forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            const dept = card.dataset.dept;
            activeDepartment = dept;
            showVpnCards(dept);
        });
    });

    document.getElementById('vpnBackBtn').addEventListener('click', () => {
        activeDepartment = null;
        document.getElementById('vpnOverviewCards').querySelectorAll('.overview-card').forEach(c => c.classList.remove('active'));
        document.getElementById('vpnDataArea').style.display = 'none';
    });
}

function showVpnCards(dept, page) {
    if (page === undefined) page = 1;
    vpnCurrentPage = page;

    const dataArea = document.getElementById('vpnDataArea');
    const cardList = document.getElementById('vpnCardList');
    const title = document.getElementById('vpnPreviewTitle');

    cardList.innerHTML = '<div style="text-align:center;color:#999;padding:40px;">加载中...</div>';

    const deptParam = dept === 'all' ? '' : dept;
    const url = `/api/vpn_records?department=${encodeURIComponent(deptParam)}&page=${page}&page_size=${VPN_PAGE_SIZE}`;
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
            const label = dept === 'all' ? '全部' : dept;
            title.textContent = `${label}（共 ${total} 条${totalPages > 1 ? `，第 ${page}/${totalPages} 页` : ''}）`;

            if (data.length === 0) {
                cardList.innerHTML = '<div class="empty-tip" style="padding:30px;text-align:center;color:#999;">暂无数据</div>';
            } else {
                let html = '';
                data.forEach(item => {
                    html += `
                    <div class="query-card" data-id="${escapeHtml(String(item.id))}" onclick="showVpnDetail(this)">
                        <div class="query-card-header">
                            <span class="query-card-number">${escapeHtml(item.name) || '-'}</span>
                            <span class="query-card-status status-none">${escapeHtml(item.department) || '-'}</span>
                        </div>
                        <div class="query-card-body">
                            <div class="query-card-field"><label>终端类型</label><span>${escapeHtml(item.terminal) || '-'}</span></div>
                            <div class="query-card-field"><label>VPN类型</label><span>${escapeHtml(item.apptype) || '-'}</span></div>
                            <div class="query-card-field"><label>使用日期</label><span>${escapeHtml(item.datetime) || '-'}</span></div>
                            <div class="query-card-field"><label>使用用途</label><span>${escapeHtml(item.purpose) || '-'}</span></div>
                        </div>
                    </div>
                    `;
                });

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

                cardList.querySelectorAll('.preview-page-btn:not([disabled])').forEach(btn => {
                    btn.addEventListener('click', () => {
                        showVpnCards(activeDepartment, parseInt(btn.dataset.page));
                    });
                });
            }

            dataArea.style.display = 'block';
        })
        .catch(() => {
            cardList.innerHTML = '<div style="text-align:center;color:#dc3545;padding:40px;">加载失败</div>';
        });
}

// ========== 新增记录 ==========

function bindAddBtn() {
    document.getElementById('vpnAddBtn').addEventListener('click', () => {
        const area = document.getElementById('vpnInsertArea');
        if (area.style.display === 'none' || !area.style.display) {
            area.innerHTML = buildVpnInsertForm();
            area.style.display = 'block';
            bindVpnInsertSubmit();
        } else {
            area.style.display = 'none';
            area.innerHTML = '';
        }
    });
}

function buildVpnInsertForm() {
    const today = new Date().toISOString().split('T')[0];
    return `
        <form id="vpnInsertForm" style="background:#f8f9fa;padding:20px;border-radius:8px;border:1px solid #eee;">
            <h3 style="margin-bottom:15px;font-size:15px;color:#2c3e50;">新增VPN记录</h3>
            <div class="form-group">
                <label>使用部门:</label>
                <select name="department" required>
                    ${DEPARTMENTS.map(o => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.text)}</option>`).join('')}
                </select>
            </div>
            <div class="form-group">
                <label>使用人:</label>
                <input type="text" name="name" required placeholder="请输入使用人">
            </div>
            <div class="form-group">
                <label>终端类型:</label>
                <select name="terminal">
                    ${VPN_TERMINAL_OPTIONS.map(o => `<option value="${escapeHtml(o.value)}" ${o.value === '电脑翻墙' ? 'selected' : ''}>${escapeHtml(o.text)}</option>`).join('')}
                </select>
            </div>
            <div class="form-group">
                <label>使用日期:</label>
                <input type="date" name="datetime" value="${escapeHtml(today)}" required>
            </div>
            <div class="form-group">
                <label>VPN类型:</label>
                <select name="apptype" required>
                    ${VPN_APPTYPE_OPTIONS.map(o => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.text)}</option>`).join('')}
                </select>
            </div>
            <div class="form-group">
                <label>使用用途:</label>
                <textarea name="purpose" rows="2" placeholder="请输入用途（可选）" style="resize:vertical;"></textarea>
            </div>
            <button type="submit" style="margin-right:10px;">确认新增</button>
            <button type="button" id="vpnInsertCancelBtn" class="btn-secondary">取消</button>
            <div id="vpnInsertMsg" class="msg-box" style="display:none;margin-top:10px;"></div>
        </form>
    `;
}

function bindVpnInsertSubmit() {
    const form = document.getElementById('vpnInsertForm');
    const msgEl = document.getElementById('vpnInsertMsg');
    const area = document.getElementById('vpnInsertArea');

    document.getElementById('vpnInsertCancelBtn').addEventListener('click', () => {
        area.style.display = 'none';
        area.innerHTML = '';
    });

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const formData = new FormData(form);

        msgEl.style.display = 'block';
        msgEl.className = 'msg-box msg-warning';
        msgEl.textContent = '正在提交...';

        fetch('/api/vpn_insert', { method: 'POST', body: formData })
            .then(r => r.json())
            .then(res => {
                msgEl.style.display = 'block';
                if (res.status === 'success') {
                    msgEl.className = 'msg-box msg-success';
                    msgEl.textContent = res.message;
                    form.reset();
                    loadVpnCounts();
                    setTimeout(() => {
                        area.style.display = 'none';
                        area.innerHTML = '';
                    }, 1000);
                } else {
                    msgEl.className = 'msg-box msg-error';
                    msgEl.textContent = res.message;
                }
                setTimeout(() => { msgEl.style.display = 'none'; }, 3000);
            })
            .catch(() => {
                msgEl.style.display = 'block';
                msgEl.className = 'msg-box msg-error';
                msgEl.textContent = '新增失败，请重试';
            });
    });
}

// ========== 详情弹窗 ==========

function bindModalClose() {
    document.getElementById('vpnDetailClose').addEventListener('click', () => {
        document.getElementById('vpnDetailModal').style.display = 'none';
    });
    document.getElementById('vpnDetailModal').addEventListener('click', (e) => {
        if (e.target.id === 'vpnDetailModal') {
            document.getElementById('vpnDetailModal').style.display = 'none';
        }
    });
}

window.showVpnDetail = function(cardEl) {
    const id = cardEl.dataset.id;
    // 从 vpnData 中找到对应记录
    const item = vpnData.find(r => String(r.id) === String(id));
    if (!item) {
        alert('未找到该记录');
        return;
    }

    const body = document.getElementById('vpnDetailBody');
    let html = `<div class="detail-form" data-id="${escapeHtml(String(item.id))}">`;

    html += `<div class="detail-section">
        <div class="detail-basic-grid">
            <div class="detail-basic-item">
                <label>使用部门:</label>
                <span class="detail-value">
                    <select class="edit-input" name="department" disabled>
                        ${DEPARTMENTS.map(o => `<option value="${escapeHtml(o.value)}" ${item.department === o.value ? 'selected' : ''}>${escapeHtml(o.text)}</option>`).join('')}
                    </select>
                </span>
            </div>
            <div class="detail-basic-item">
                <label>使用人:</label>
                <span class="detail-value"><input type="text" class="edit-input" name="name" value="${escapeHtml(item.name || '')}" disabled></span>
            </div>
            <div class="detail-basic-item">
                <label>终端类型:</label>
                <span class="detail-value">
                    <select class="edit-input" name="terminal" disabled>
                        ${VPN_TERMINAL_OPTIONS.map(o => `<option value="${escapeHtml(o.value)}" ${item.terminal === o.value ? 'selected' : ''}>${escapeHtml(o.text)}</option>`).join('')}
                    </select>
                </span>
            </div>
            <div class="detail-basic-item">
                <label>使用日期:</label>
                <span class="detail-value"><input type="date" class="edit-input" name="datetime" value="${escapeHtml(item.datetime || '')}" disabled></span>
            </div>
            <div class="detail-basic-item">
                <label>VPN类型:</label>
                <span class="detail-value">
                    <select class="edit-input" name="apptype" disabled>
                        ${VPN_APPTYPE_OPTIONS.map(o => `<option value="${escapeHtml(o.value)}" ${item.apptype === o.value ? 'selected' : ''}>${escapeHtml(o.text)}</option>`).join('')}
                    </select>
                </span>
            </div>
            <div class="detail-basic-item">
                <label>使用用途:</label>
                <span class="detail-value"><textarea class="edit-input" name="purpose" rows="1" disabled>${escapeHtml(item.purpose || '')}</textarea></span>
            </div>
        </div>
    </div>`;

    html += `</div>`;
    body.innerHTML = html;

    bindVpnDetailActions(id);
    document.getElementById('vpnDetailModal').style.display = 'flex';
};

function bindVpnDetailActions(id) {
    // 克隆按钮清除旧事件
    const oldEditBtn = document.getElementById('vpnEditBtn');
    const oldDeleteBtn = document.getElementById('vpnDeleteBtn');
    const newEditBtn = oldEditBtn.cloneNode(true);
    const newDeleteBtn = oldDeleteBtn.cloneNode(true);
    oldEditBtn.parentNode.replaceChild(newEditBtn, oldEditBtn);
    oldDeleteBtn.parentNode.replaceChild(newDeleteBtn, oldDeleteBtn);

    const editBtn = document.getElementById('vpnEditBtn');
    const deleteBtn = document.getElementById('vpnDeleteBtn');
    const form = document.querySelector('#vpnDetailBody .detail-form');
    const inputs = form.querySelectorAll('.edit-input');
    const originalValues = {};
    let isEditing = false;

    // 初始状态
    editBtn.className = 'detail-action-btn';
    editBtn.title = '修改';
    editBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10.5 2.5l3 3L5 14H2v-3L10.5 2.5z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    deleteBtn.className = 'detail-action-btn btn-danger';
    deleteBtn.title = '删除';
    deleteBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M5.33 4V2.67a1.33 1.33 0 011.34-1.34h2.66a1.33 1.33 0 011.34 1.34V4m2 0v9.33a1.33 1.33 0 01-1.34 1.34H4.67a1.33 1.33 0 01-1.34-1.34V4h9.34z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    deleteBtn.addEventListener('click', () => {
        if (!isEditing) {
            // 删除
            if (confirm('是否删除，此操作不可逆！')) {
                fetch('/api/vpn_delete', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                    body: `id=${id}`
                })
                .then(r => r.json())
                .then(res => {
                    alert(res.message);
                    if (res.status === 'success') {
                        document.getElementById('vpnDetailModal').style.display = 'none';
                        loadVpnCounts();
                    }
                });
            }
        } else {
            // 取消：恢复原始值
            inputs.forEach(i => {
                if (originalValues[i.name] !== undefined) i.value = originalValues[i.name];
                i.disabled = true;
            });
            isEditing = false;
            editBtn.className = 'detail-action-btn';
            editBtn.title = '修改';
            editBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10.5 2.5l3 3L5 14H2v-3L10.5 2.5z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            deleteBtn.className = 'detail-action-btn btn-danger';
            deleteBtn.title = '删除';
            deleteBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M5.33 4V2.67a1.33 1.33 0 011.34-1.34h2.66a1.33 1.33 0 011.34 1.34V4m2 0v9.33a1.33 1.33 0 01-1.34 1.34H4.67a1.33 1.33 0 01-1.34-1.34V4h9.34z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        }
    });

    editBtn.addEventListener('click', () => {
        if (!isEditing) {
            // 进入编辑
            inputs.forEach(i => { originalValues[i.name] = i.value; });
            inputs.forEach(i => { i.disabled = false; });
            isEditing = true;
            editBtn.className = 'detail-action-btn btn-update';
            editBtn.title = '更新';
            editBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13.5 3.5l-9 9L2 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            deleteBtn.className = 'detail-action-btn btn-cancel';
            deleteBtn.title = '取消';
            deleteBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
        } else {
            // 更新
            const department = form.querySelector('[name="department"]').value;
            const name = form.querySelector('[name="name"]').value.trim();
            const terminal = form.querySelector('[name="terminal"]').value;
            const datetime = form.querySelector('[name="datetime"]').value;
            const apptype = form.querySelector('[name="apptype"]').value;
            const purpose = form.querySelector('[name="purpose"]').value.trim();

            if (!department || !name || !datetime || !apptype) {
                alert('使用部门、使用人、日期、VPN类型 不能为空！');
                return;
            }

            const body = `id=${id}&department=${encodeURIComponent(department)}&name=${encodeURIComponent(name)}&terminal=${encodeURIComponent(terminal)}&datetime=${encodeURIComponent(datetime)}&apptype=${encodeURIComponent(apptype)}&purpose=${encodeURIComponent(purpose)}`;

            fetch('/api/vpn_update', {
                method: 'POST',
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                body: body
            })
            .then(r => r.json())
            .then(res => {
                alert(res.message);
                if (res.status === 'success') {
                    document.getElementById('vpnDetailModal').style.display = 'none';
                    loadVpnCounts();
                }
            });
        }
    });
}
