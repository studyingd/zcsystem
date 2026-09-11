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

function bindQueryBtn() {
    const queryBtn = document.getElementById('queryBtn');
    const queryMode = document.getElementById('queryMode');
    const queryValue = document.getElementById('queryValue');
    const queryResult = document.getElementById('queryResult');

    function doQuery(isHistory) {
        const mode = queryMode.value;
        const value = queryValue.value.trim();
        const table = isHistory ? 'tmp' : 'main';

        if (!value) {
            showQueryResult('请输入查询值', 'warning');
            return;
        }

        const url = `/query?mode=${encodeURIComponent(mode)}&value=${encodeURIComponent(value)}&table=${encodeURIComponent(table)}`;
        fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            },
            credentials: 'same-origin'
        })
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP错误，状态码：${response.status}`);
                }
                return response.json();
            })
            .then(res => {
                if (res.status === 'success') {
                    let html = `<h3 style="margin-bottom:15px;">${isHistory ? '历史数据查询结果' : '查询结果'}</h3>`;
                    html += '<div class="query-card-list">';
                    res.data.forEach(item => {
                        const isTmpData = isHistory;
                        const rowId = isTmpData ? item.tmp_id : item.id;
                        const source = item.source || 'inventory';
                        html += `
                        <div class="query-card" data-id="${escapeHtml(rowId)}" data-number="${escapeHtml(item.number || '')}" data-table="${isTmpData ? 'tmp' : 'main'}" data-source="${escapeHtml(source)}" onclick="showQueryDetail(this)">
                            <div class="query-card-header">
                                <span class="query-card-number">${escapeHtml(item.number) || '-'}</span>
                                <span class="query-card-status ${getStatusClass(item.status)}">${escapeHtml(item.status) || '无状态'}</span>
                            </div>
                            <div class="query-card-body">
                                <div class="query-card-field"><label>使用部门</label><span>${escapeHtml(item.department) || '-'}</span></div>
                                <div class="query-card-field"><label>使用人</label><span>${escapeHtml(item.site) || '-'}</span></div>
                                <div class="query-card-field"><label>资产类型</label><span>${escapeHtml(item.type) || '-'}</span></div>
                            </div>
                        </div>
                        `;
                    });
                    html += '</div>';
                    queryResult.innerHTML = html;
                } else if (res.status === 'not_found') {
                    const hint = getNotFoundHint(mode, value);
                    queryResult.innerHTML = `<div class="msg-box msg-warning">${escapeHtml(hint)}</div>`;
                } else {
                    showQueryResult('查询失败：' + escapeHtml(res.message), 'error');
                }
            })
            .catch(error => {
                console.error('查询请求错误：', error);
                showQueryResult(`查询失败：${escapeHtml(error.message)}`, 'error');
            });
    }

    queryBtn.addEventListener('click', () => doQuery(false));

    // 回车键触发查询
    queryValue.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            doQuery(false);
        }
    });

    // 插入新记录按钮 - 显示插入表单
    document.getElementById('showInsertFormBtn').addEventListener('click', () => {
        const mode = queryMode.value;
        const value = queryValue.value.trim();

        // 如果查询方式是 number，先检查是否已存在
        if (mode === 'number' && value) {
            fetch(`/query?mode=number&value=${encodeURIComponent(value)}&table=main`)
                .then(response => response.json())
                .then(res => {
                    if (res.status === 'success' && res.data.length > 0) {
                        queryResult.innerHTML = `<div class="msg-box msg-error">此资产编码已有相应记录！</div>`;
                    } else {
                        const prefill = getPrefillValue(mode, value);
                        const formHTML = buildInsertFormHTML(prefill);
                        queryResult.innerHTML = formHTML;
                        bindInsertFormSubmit(mode, value);
                    }
                });
        } else {
            const prefill = getPrefillValue(mode, value);
            const formHTML = buildInsertFormHTML(prefill);
            queryResult.innerHTML = formHTML;
            bindInsertFormSubmit(mode, value);
        }
    });

    function showQueryResult(text, type) {
        queryResult.innerHTML = `<div class="msg-box msg-${type}">${escapeHtml(text)}</div>`;
    }

    function getNotFoundHint(mode, value) {
        const hints = {
            'number': `未找到资产编码 "${value}" 的记录`,
            'sn': `未找到SN码 "${value}" 的记录`,
            'department': `未找到使用部门 "${value}" 的记录`,
            'site': `未找到使用人 "${value}" 的记录`,
            'id': `未找到 ID "${value}" 的记录`
        };
        return hints[mode] || '未找到记录';
    }

    function getPrefillValue(mode, value) {
        if (mode === 'number') return { number: value, site: '', department: '' };
        if (mode === 'site') return { number: '', site: value, department: '' };
        if (mode === 'department') return { number: '', site: '', department: value };
        return { number: '', site: '', department: '' };
    }

    function buildInsertFormHTML(prefill) {
        const prefillNumber = prefill.number;
        const prefillSite = prefill.site;
        const prefillDept = prefill.department;

        const typeOptions = [
            {value: '', text: '--请选择类型--'},
            {value: '台式主机', text: '台式主机'},
            {value: '租聘台式主机', text: '租聘台式主机'},
            {value: '笔记本电脑', text: '笔记本电脑'},
            {value: '显示器', text: '显示器'},
            {value: '其它', text: '其它'}
        ];

        const statusOptions = [
            {value: '', text: '--请选择状态--'},
            {value: '已录入', text: '已录入'},
            {value: '未录入', text: '未录入'},
            {value: '租聘', text: '租聘'},
            {value: '借用', text: '借用'},
            {value: '入库', text: '入库'},
            {value: '无需录入', text: '无需录入'}
        ];

        let deptSelectHTML = '<select id="prefill_department" name="department" required>' + DEPARTMENTS.map(o =>
            `<option value="${o.value}" ${prefillDept === o.value ? 'selected' : ''}>${o.text}</option>`
        ).join('') + '</select>';

        let typeSelectHTML = '<select id="prefill_type" name="type" required>' + typeOptions.map(o =>
            `<option value="${o.value}">${o.text}</option>`
        ).join('') + '</select>';

        let statusToggleHTML = `
            <input type="hidden" id="prefill_status" name="status" value="未录入">
            <div class="status-toggles" style="margin-top:0;">
                ${statusOptions.filter(o => o.value).map(o =>
                    `<span class="status-toggle${o.value === '未录入' ? ' active' : ''}" data-status="${o.value}">${o.text}</span>`
                ).join('')}
            </div>`;

        const tagOptions = ['入职', '领用', '更换', '离职', '入库'];
        let tagToggleHTML = `
            <input type="hidden" id="prefill_tag" name="tag" value="">
            <div class="status-toggles" style="margin-top:0;">
                ${tagOptions.map(t =>
                    `<span class="status-toggle" data-tag="${t}">${t}</span>`
                ).join('')}
            </div>`;

        const today = new Date().toISOString().split('T')[0];

        return `
            <form id="prefillInsertForm" class="prefill-form">
                <div class="form-group">
                    <label>资产编码:</label>
                    <input type="text" id="prefill_number" name="number" value="${escapeHtml(prefillNumber)}" required placeholder="请输入资产编码">
                </div>
                <div class="form-group">
                    <label>资产类型:</label>
                    ${typeSelectHTML}
                    <input type="text" id="prefill_custom_type" name="custom_type" placeholder="请输入自定义类型" style="display:none; margin-left:10px; flex:1;">
                </div>
                <div class="form-group">
                    <label>使用部门:</label>
                    ${deptSelectHTML}
                </div>
                <div class="form-group">
                    <label>使用人:</label>
                    <input type="text" id="prefill_site" name="site" value="${escapeHtml(prefillSite)}" required placeholder="请输入使用人">
                </div>
                <div class="form-group">
                    <label>发放日期:</label>
                    <input type="date" id="prefill_datetime" name="datetime" value="${today}" required>
                </div>
                <div class="form-group">
                    <label>资产状态:</label>
                    ${statusToggleHTML}
                </div>
                <div class="form-group">
                    <label>资产标签:</label>
                    ${tagToggleHTML}
                </div>
                <div class="form-group">
                    <label>备注信息:</label>
                    <textarea id="prefill_notice" name="notice" rows="2" placeholder="请输入备注信息（可选）"></textarea>
                </div>
                <div class="form-group attachment-group">
                    <label>附件:</label>
                    <div class="attachment-wrapper">
                        <div class="upload-area" id="uploadArea">
                            <svg class="upload-icon" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M24 32V16M24 16L18 22M24 16L30 22" stroke="#b0b8c4" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                                <path d="M8 32v6a4 4 0 004 4h24a4 4 0 004-4v-6" stroke="#b0b8c4" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                            <p class="upload-text">点击或拖拽文件到此区域上传</p>
                            <p class="upload-hint">支持图片文件，可一次选择多个</p>
                        </div>
                        <input type="file" id="prefill_attachment" name="attachment" accept="image/*" multiple style="display:none;">
                        <input type="hidden" id="prefill_attachment_urls" name="attachment_urls" value="">
                        <div class="preview-list" id="previewList"></div>
                    </div>
                </div>
                <button type="submit" class="insert-btn">插入数据</button>
                <div id="prefillInsertMsg" class="msg-box" style="display: none;"></div>
            </form>
        `;
    }

    function bindInsertFormSubmit(mode, value) {
        const form = document.getElementById('prefillInsertForm');
        if (!form) return;

        const msgEl = document.getElementById('prefillInsertMsg');
        const typeSelect = document.getElementById('prefill_type');
        const customTypeInput = document.getElementById('prefill_custom_type');
        const uploadArea = document.getElementById('uploadArea');
        const fileInput = document.getElementById('prefill_attachment');
        const previewList = document.getElementById('previewList');
        const urlsInput = document.getElementById('prefill_attachment_urls');
        const uploadedFiles = []; // {file, url, previewUrl}

        // 状态切换按钮点击
        const statusInput = document.getElementById('prefill_status');
        const statusToggles = form.querySelectorAll('.status-toggle[data-status]');
        statusToggles.forEach(toggle => {
            toggle.addEventListener('click', () => {
                statusToggles.forEach(t => t.classList.remove('active'));
                toggle.classList.add('active');
                statusInput.value = toggle.dataset.status;
            });
        });

        // 标签切换按钮点击
        const tagInput = document.getElementById('prefill_tag');
        const tagToggles = form.querySelectorAll('.status-toggle[data-tag]');
        tagToggles.forEach(toggle => {
            toggle.addEventListener('click', () => {
                if (toggle.classList.contains('active')) {
                    toggle.classList.remove('active');
                    tagInput.value = '';
                } else {
                    tagToggles.forEach(t => t.classList.remove('active'));
                    toggle.classList.add('active');
                    tagInput.value = toggle.dataset.tag;
                }
            });
        });

        // Type变更时显示/隐藏自定义类型输入框
        typeSelect.addEventListener('change', () => {
            if (typeSelect.value === '其它') {
                customTypeInput.style.display = 'inline-block';
                customTypeInput.required = true;
            } else {
                customTypeInput.style.display = 'none';
                customTypeInput.required = false;
                customTypeInput.value = '';
            }
        });

        // 点击上传区域触发文件选择
        uploadArea.addEventListener('click', () => fileInput.click());

        // 拖拽事件
        uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadArea.classList.add('drag-over');
        });
        uploadArea.addEventListener('dragleave', () => {
            uploadArea.classList.remove('drag-over');
        });
        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadArea.classList.remove('drag-over');
            handleFiles(e.dataTransfer.files);
        });

        // 文件选择
        fileInput.addEventListener('change', () => {
            handleFiles(fileInput.files);
            fileInput.value = '';
        });

        function handleFiles(files) {
            Array.from(files).forEach(file => {
                if (!file.type.startsWith('image/')) return;
                const reader = new FileReader();
                reader.onload = (e) => {
                    const item = { file, url: '', previewUrl: e.target.result };
                    uploadedFiles.push(item);
                    renderPreviews();
                };
                reader.readAsDataURL(file);
            });
        }

        function renderPreviews() {
            previewList.innerHTML = '';
            uploadedFiles.forEach((item, index) => {
                const div = document.createElement('div');
                div.className = 'preview-item';
                div.innerHTML = `
                    <img src="${item.previewUrl}" class="preview-img" alt="预览">
                    <div class="preview-item-info">
                        <span class="preview-name">${escapeHtml(item.file.name)}</span>
                        ${item.url ? '<span class="preview-status done">已上传</span>' : '<span class="preview-status pending">待上传</span>'}
                    </div>
                    <button type="button" class="preview-remove" data-index="${index}" title="移除">&times;</button>
                `;
                previewList.appendChild(div);
            });
            // 绑定移除按钮
            previewList.querySelectorAll('.preview-remove').forEach(btn => {
                btn.addEventListener('click', () => {
                    uploadedFiles.splice(parseInt(btn.dataset.index), 1);
                    renderPreviews();
                });
            });
            // 更新隐藏字段
            urlsInput.value = uploadedFiles.filter(f => f.url).map(f => f.url).join(',');
        }

        // 批量上传所有附件，返回 Promise
        function uploadAllAttachments() {
            const toUpload = uploadedFiles.filter(f => !f.url);
            if (toUpload.length === 0) return Promise.resolve();

            return Promise.all(toUpload.map(item => {
                const data = new FormData();
                data.append('attachment', item.file);
                return fetch('/upload_attachment', { method: 'POST', body: data })
                    .then(r => r.json())
                    .then(res => {
                        if (res.status === 'success') {
                            item.url = res.url;
                        } else {
                            throw new Error(res.message);
                        }
                    });
            })).then(() => {
                renderPreviews();
            });
        }

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const formData = new FormData(form);
            const typeVal = document.getElementById('prefill_type').value;
            if (typeVal === '其它') {
                const customType = document.getElementById('prefill_custom_type').value.trim();
                if (!customType) {
                    msgEl.style.display = 'block';
                    msgEl.className = 'msg-box msg-error';
                    msgEl.textContent = '请输入自定义资产类型';
                    return;
                }
                formData.set('type', customType);
            }

            // 先上传所有附件
            msgEl.style.display = 'block';
            msgEl.className = 'msg-box msg-warning';
            msgEl.textContent = uploadedFiles.length > 0 ? '正在上传附件...' : '正在提交...';

            uploadAllAttachments().then(() => {
                const urls = uploadedFiles.filter(f => f.url).map(f => f.url).join(',');
                formData.set('attachment_urls', urls);
                formData.delete('attachment');

                msgEl.textContent = '正在插入数据...';

                fetch('/insert', {
                    method: 'POST',
                    body: formData
                })
                    .then(response => {
                        if (!response.ok) throw new Error('网络请求失败');
                        return response.json();
                    })
                    .then(res => {
                        msgEl.style.display = 'block';
                        if (res.status === 'success') {
                            msgEl.className = 'msg-box msg-success';
                            msgEl.textContent = res.message;
                            form.reset();
                            uploadedFiles.length = 0;
                            previewList.innerHTML = '';
                            loadStatusCounts();
                            setTimeout(() => {
                                queryValue.value = value;
                                queryMode.value = mode;
                                document.getElementById('queryBtn').click();
                            }, 1500);
                        } else {
                            msgEl.className = 'msg-box msg-error';
                            msgEl.textContent = res.message;
                        }
                        setTimeout(() => {
                            msgEl.style.display = 'none';
                        }, 3000);
                    })
                    .catch(error => {
                        msgEl.style.display = 'block';
                        msgEl.className = 'msg-box msg-error';
                        msgEl.textContent = '插入失败，请重试';
                        console.error(error);
                    });
            }).catch(error => {
                msgEl.style.display = 'block';
                msgEl.className = 'msg-box msg-error';
                msgEl.textContent = '附件上传失败，请重试';
                console.error(error);
            });
        });
    }
}


// 状态 / 标签词表与徽章样式已上移到 utils.js（STATUS_OPTIONS / TAG_OPTIONS / getStatusClass），
// 词表由后端 #zcMeta 下发；部门选项同样使用 utils.js 的 DEPARTMENTS，避免各页各写一份

// 收集详情表单当前值并提交更新
function submitDetailUpdate(form, id, overrides) {
    const body = new URLSearchParams();
    body.set('id', id);
    body.set('number', form.querySelector('input[name="number"]').value.trim());
    body.set('department', form.querySelector('select[name="department"]').value);
    body.set('site', form.querySelector('input[name="site"]').value.trim());
    body.set('type', form.querySelector('select[name="type"]').value);
    const datetimeVal = form.querySelector('input[name="datetime"]').value.trim();
    body.set('datetime', datetimeVal || new Date().toISOString().split('T')[0]);
    body.set('status', form.querySelector('input[name="status"]').value);
    body.set('tag', form.querySelector('input[name="tag"]') ? form.querySelector('input[name="tag"]').value : '');
    body.set('notice', form.querySelector('textarea[name="notice"]').value.trim());
    // 用 overrides 覆盖指定字段
    if (overrides) {
        Object.entries(overrides).forEach(([k, v]) => body.set(k, v));
    }
    return fetch('/update', { method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: body.toString() })
        .then(r => r.json());
}

// 查询结果卡片点击 → 显示详情弹窗
window.showQueryDetail = function(cardEl) {
    const number = cardEl.dataset.number || '';
    const id = cardEl.dataset.id || '';
    const source = cardEl.dataset.source || '';

    let url = '/api/asset_full_detail?';
    if (number) url += `number=${encodeURIComponent(number)}`;
    if (id && source === 'inventory') {
        if (number) url += '&';
        url += `id=${encodeURIComponent(id)}`;
    }

    fetch(url)
        .then(r => r.json())
        .then(res => {
            if (res.status !== 'success') {
                alert(res.message || '获取详情失败');
                return;
            }
            const data = res.data || {};
            DETAIL_DATA = {
                basic: data.basic || {},
                hardware: data.hardware || {},
                history: data.history || []
            };
            renderDetailView();
            document.getElementById('queryDetailModal').style.display = 'flex';
        });
};

let DETAIL_DATA = null;

const ICON_PENCIL = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10.5 2.5l3 3L5 14H2v-3L10.5 2.5z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_TRASH = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M5.33 4V2.67a1.33 1.33 0 011.34-1.34h2.66a1.33 1.33 0 011.34 1.34V4m2 0v9.33a1.33 1.33 0 01-1.34 1.34H4.67a1.33 1.33 0 01-1.34-1.34V4h9.34z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_CHECK = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13.5 3.5l-9 9L2 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_CLOSE = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const SPINNER = '<span class="dv-spinner" aria-hidden="true"></span>';

// 状态 / 标签切换区：查看态与编辑态共用同一套组件，两种模式观感保持一致
function detailTogglesHtml(editable) {
    const { basic } = DETAIL_DATA;
    const curStatus = basic.status || '';
    const curTag = basic.tag || '';
    const chip = (attr, value, active, tip) =>
        `<span class="status-toggle${active ? ' active' : ''}" ${attr}="${escapeHtml(value)}" role="button" tabindex="0" title="${escapeHtml(tip)}">${escapeHtml(value)}</span>`;
    return `<div class="detail-toggle-row">
                <div class="detail-toggle-col">
                    <label>资产状态:<span class="toggle-hint">点击切换</span></label>
                    <div class="status-toggles" data-group="status">
                        ${editable ? `<input type="hidden" name="status" value="${escapeHtml(curStatus)}">` : ''}
                        ${STATUS_OPTIONS.map(s => chip('data-status', s, s === curStatus, `点击切换为「${s}」`)).join('')}
                    </div>
                </div>
                <div class="detail-toggle-col">
                    <label>资产标签:<span class="toggle-hint">点击切换</span></label>
                    <div class="status-toggles" data-group="tag">
                        ${editable ? `<input type="hidden" name="tag" value="${escapeHtml(curTag)}">` : ''}
                        ${TAG_OPTIONS.map(t => chip('data-tag', t, t === curTag, t === curTag ? '点击取消该标签' : `点击设为「${t}」`)).join('')}
                    </div>
                </div>
            </div>`;
}

function detailEditHtml() {
    const { basic, hardware, history } = DETAIL_DATA;
    const isRented = (basic.type || '') === '租聘台式主机';
    const isComputer = ['笔记本电脑', '台式主机', '租聘台式主机'].includes((hardware && hardware.type) || basic.type || '');

            // 区块1：资产详情
            let html = `<div class="detail-form" data-id="${escapeHtml(basic.id)}" data-number="${escapeHtml(basic.number)}" data-source="${escapeHtml(basic.source)}">`;

            html += `<div class="detail-section">
                <div class="detail-section-title">资产详情</div>
                <div class="detail-basic-grid">
                    <div class="detail-basic-item">
                        <label>资产编码:</label>
                        <span class="detail-value"><input type="text" class="edit-input" name="number" value="${escapeHtml(basic.number || '')}" disabled></span>
                    </div>
                    <div class="detail-basic-item">
                        <label>资产类型:</label>
                        <span class="detail-value">
                            <select class="edit-input" name="type" disabled>
                                <option value="台式主机" ${basic.type === '台式主机' ? 'selected' : ''}>台式主机</option>
                                <option value="租聘台式主机" ${basic.type === '租聘台式主机' ? 'selected' : ''}>租聘台式主机</option>
                                <option value="笔记本电脑" ${basic.type === '笔记本电脑' ? 'selected' : ''}>笔记本电脑</option>
                                <option value="显示器" ${basic.type === '显示器' ? 'selected' : ''}>显示器</option>
                                <option value="其它" ${basic.type === '其它' ? 'selected' : ''}>其它</option>
                                ${basic.type && !['台式主机', '租聘台式主机', '笔记本电脑', '显示器', '其它'].includes(basic.type) ? `<option value="${escapeHtml(basic.type)}" selected>${escapeHtml(basic.type)}</option>` : ''}
                            </select>
                        </span>
                    </div>
                    <div class="detail-basic-item">
                        <label>使用部门:</label>
                        <span class="detail-value">
                            <select class="edit-input" name="department" disabled>
                                ${DEPARTMENTS.map(o => `<option value="${escapeHtml(o.value)}" ${basic.department === o.value ? 'selected' : ''}>${escapeHtml(o.text)}</option>`).join('')}
                                ${basic.department && !DEPARTMENTS.some(o => o.value === basic.department) ? `<option value="${escapeHtml(basic.department)}" selected>${escapeHtml(basic.department)}</option>` : ''}
                            </select>
                        </span>
                    </div>
                    <div class="detail-basic-item">
                        <label>使用人:</label>
                        <span class="detail-value"><input type="text" class="edit-input" name="site" value="${escapeHtml(basic.site || '')}" disabled></span>
                    </div>
                    <div class="detail-basic-item">
                        <label>发放日期:</label>
                        <span class="detail-value"><input type="date" class="edit-input" name="datetime" value="${escapeHtml(basic.datetime || '')}" disabled></span>
                    </div>
                    <div class="detail-basic-item">
                        <label>资产规格:</label>
                        <span class="detail-value"><input type="text" class="edit-input" title="${escapeHtml(hardware?.spec || '')}" value="${escapeHtml(hardware?.spec || '')}" disabled></span>
                    </div>
                    ${isRented ? `<div class="detail-basic-item">
                        <label>SN码:</label>
                        <span class="detail-value"><input type="text" class="edit-input" title="${escapeHtml(hardware?.sn || '')}" value="${escapeHtml(hardware?.sn || '')}" disabled></span>
                    </div>` : ''}
                    <div class="detail-basic-item${isRented ? '' : ' wide'}">
                        <label>备注信息:</label>
                        <span class="detail-value"><textarea class="edit-input" name="notice" rows="1" disabled>${escapeHtml(basic.notice || '')}</textarea></span>
                    </div>
                </div>
                ${detailTogglesHtml(true)}
            </div>`;

            // 区块2：硬件配置
            // 显示器等非电脑类型没有硬件字段，整块隐藏
            if (isComputer) {
                html += `<div class="detail-section">
                    <div class="detail-section-title">硬件配置</div>`;
                const hw = hardware || {};
                const hwItems = [['CPU', hw.cpu], ['内存', hw.mem], ['硬盘', hw.disk], ['显卡', hw.gpu]];
                if (hwItems.some(([, v]) => v)) {
                    html += `<div class="hardware-grid">` + hwItems.map(([label, v]) =>
                        `<div class="hardware-item"><label>${label}:</label><span class="hw-value">${escapeHtml(v || '-')}</span></div>`).join('') + `</div>`;
                } else {
                    html += `<div class="hardware-empty">暂无硬件配置信息</div>`;
                }
                html += `</div>`;
            }

            // 区块3：历史数据
            html += `<div class="detail-section">
                <div class="detail-section-title">历史数据</div>`;
            if (history && history.length > 0) {
                html += `<div class="history-timeline">`;
                history.forEach(h => {
                    html += `<div class="history-item" data-tmp-id="${escapeHtml(h.tmp_id)}">
                        <div class="history-dot"></div>
                        <div class="history-line"></div>
                        <div class="history-content">
                            <span class="history-date">${escapeHtml(h.datetime || '未知日期')}</span>
                            <span class="history-info">${escapeHtml(h.department || '-')} - ${escapeHtml(h.site || '-')}${h.tag ? ` · ${escapeHtml(h.tag)}` : ''}${h.status ? ` · ${escapeHtml(h.status)}` : ''}</span>
                            <button class="history-delete-btn" title="删除此条历史记录" style="display:none;">
                                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" fill="#dc3545"/><line x1="4.5" y1="8" x2="11.5" y2="8" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>
                            </button>
                        </div>
                    </div>`;
                });
                html += `</div>`;
            } else {
                html += `<div class="history-empty">暂无历史数据</div>`;
            }
            html += `</div>`;

            // 区块4：附件
            const attachmentUrls = (basic.attachment_urls || '').split(',').filter(u => u.trim());
            html += `<div class="detail-section">
                <div class="detail-section-title">附件</div>
                <div class="attachment-detail-area">
                    <input type="hidden" name="attachment_urls" value="${escapeHtml(basic.attachment_urls || '')}">
                    <div class="attachment-detail-list" id="detailAttachmentList">
                        ${attachmentUrls.length > 0 ? attachmentUrls.map((url, i) => `
                            <div class="attachment-detail-item" data-url="${escapeHtml(url)}">
                                <img src="${escapeHtml(url)}" class="attachment-detail-img" alt="附件图片" onclick="window.open('${escapeHtml(url)}','_blank')">
                                <button type="button" class="attachment-detail-remove" style="display:none;" title="移除">&times;</button>
                            </div>
                        `).join('') : '<div class="attachment-empty">暂无附件</div>'}
                    </div>
                    <div class="attachment-detail-upload" id="detailAttachmentUpload" style="display:none;">
                        <input type="file" id="detailAttachmentInput" accept="image/*" multiple style="display:none;">
                        <button type="button" class="attachment-add-btn" id="detailAttachmentAddBtn">
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><line x1="7" y1="1" x2="7" y2="13" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>
                            添加附件
                        </button>
                    </div>
                </div>
            </div>`;

    html += `</div>`; // close detail-form
    return html;
}

function detailViewHtml() {
    const { basic, hardware, history } = DETAIL_DATA;
    const hw = hardware || {};
    // 只读态沿用编辑态的 label + value 排版，两种模式切换时视觉不跳变
    const val = (v, isMono) => {
        const has = v !== '' && v !== null && v !== undefined;
        if (!has) return '<span class="dv-empty">—</span>';
        return isMono ? `<span class="dv-mono">${escapeHtml(v)}</span>` : escapeHtml(v);
    };
    const item = (label, valueHtml, tip, wide) => `<div class="detail-basic-item${wide ? ' wide' : ''}">
                        <label>${label}:</label>
                        <span class="detail-value"${tip ? ` title="${escapeHtml(tip)}"` : ''}>${valueHtml}</span>
                    </div>`;

    const assetType = hw.type || basic.type || '';
    const isComputer = ['笔记本电脑', '台式主机', '租聘台式主机'].includes(assetType);
    const isRented = (basic.type || '') === '租聘台式主机';
    // 显示器等非电脑类型没有硬件字段，整块隐藏
    let cfgHtml = '';
    if (isComputer) {
        const cfgItems = [['CPU', hw.cpu], ['内存', hw.mem], ['硬盘', hw.disk], ['显卡', hw.gpu]];
        cfgHtml = cfgItems.some(([, v]) => v)
            ? `<div class="hardware-grid">` + cfgItems.map(([label, v]) =>
                `<div class="hardware-item"><label>${label}:</label><span class="hw-value">${escapeHtml(v || '-')}</span></div>`).join('') + `</div>`
            : '<div class="hardware-empty">暂无硬件配置信息</div>';
    }

    const historyHtml = (history && history.length)
        ? `<div class="history-timeline">` + history.map(h => `
            <div class="history-item">
                <div class="history-dot"></div>
                <div class="history-line"></div>
                <div class="history-content">
                    <span class="history-date">${escapeHtml(h.datetime || '未知日期')}</span>
                    <span class="history-info">${escapeHtml(h.department || '-')} - ${escapeHtml(h.site || '-')}${h.tag ? ` · ${escapeHtml(h.tag)}` : ''}${h.status ? ` · ${escapeHtml(h.status)}` : ''}</span>
                </div>
            </div>`).join('') + `</div>`
        : '<div class="history-empty">暂无历史数据</div>';

    const urls = (basic.attachment_urls || '').split(',').filter(u => u.trim());
    const attachHtml = urls.length
        ? urls.map(url => `
            <div class="attachment-detail-item" data-url="${escapeHtml(url)}">
                <img src="${escapeHtml(url)}" class="attachment-detail-img" alt="附件图片" onclick="window.open('${escapeHtml(url)}','_blank')">
            </div>`).join('')
        : '<div class="attachment-empty">暂无附件</div>';

    return `<div class="detail-view" data-id="${escapeHtml(basic.id)}" data-number="${escapeHtml(basic.number)}" data-source="${escapeHtml(basic.source)}">
        <div class="detail-section">
            <div class="detail-section-title">资产详情</div>
            <div class="detail-basic-grid">
                ${item('资产编码', val(basic.number, true))}
                ${item('资产类型', val(basic.type))}
                ${item('使用部门', val(basic.department))}
                ${item('使用人', val(basic.site))}
                ${item('发放日期', val(basic.datetime, true))}
                ${item('资产规格', val(hw.spec), hw.spec || '')}
                ${isRented ? item('SN码', val(hw.sn, true), hw.sn || '') : ''}
                ${item('备注信息', val(basic.notice), basic.notice || '', !isRented)}
            </div>
            ${detailTogglesHtml(false)}
        </div>
        ${cfgHtml ? `<div class="detail-section">
            <div class="detail-section-title">硬件配置</div>
            ${cfgHtml}
        </div>` : ''}
        <div class="detail-section">
            <div class="detail-section-title">历史数据</div>
            ${historyHtml}
        </div>
        <div class="detail-section">
            <div class="detail-section-title">附件</div>
            <div class="attachment-detail-list">${attachHtml}</div>
        </div>
    </div>`;
}

function renderDetailView() {
    document.getElementById('queryDetailBody').innerHTML = detailViewHtml();
    bindDetailViewActions();
}

function renderDetailEdit() {
    document.getElementById('queryDetailBody').innerHTML = detailEditHtml();
    bindDetailActions();
}

function deleteDetailRecord(id) {
    if (!confirm('是否删除，此操作不可逆！')) return;
    fetch('/delete_by_id', {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: `id=${id}`
    }).then(r => r.json()).then(res => {
        alert(res.message);
        if (res.status === 'success') {
            document.getElementById('queryDetailModal').style.display = 'none';
            document.getElementById('queryBtn').click();
            loadStatusCounts();
        }
    });
}

function bindDetailViewActions() {
    const oldEditBtn = document.getElementById('qDetailEditBtn');
    const oldDeleteBtn = document.getElementById('qDetailDeleteBtn');
    const editBtn = oldEditBtn.cloneNode(true);
    const deleteBtn = oldDeleteBtn.cloneNode(true);
    oldEditBtn.parentNode.replaceChild(editBtn, oldEditBtn);
    oldDeleteBtn.parentNode.replaceChild(deleteBtn, oldDeleteBtn);
    editBtn.className = 'detail-action-btn';
    editBtn.title = '修改'; editBtn.setAttribute('aria-label', '修改');
    editBtn.innerHTML = ICON_PENCIL;
    deleteBtn.className = 'detail-action-btn btn-danger';
    deleteBtn.title = '删除'; deleteBtn.setAttribute('aria-label', '删除');
    deleteBtn.innerHTML = ICON_TRASH;
    editBtn.addEventListener('click', renderDetailEdit);
    deleteBtn.addEventListener('click', () => deleteDetailRecord(document.querySelector('.detail-view').dataset.id));
    bindViewQuickToggles();
    // 只读视图没有「取消」按钮，保留右上角关闭图标
    document.getElementById('queryDetailClose').style.display = 'flex';
}

// 只读视图直接提交：用台账现值兜底，只覆盖被点击的状态或标签
function submitViewUpdate(overrides) {
    const b = DETAIL_DATA.basic;
    const body = new URLSearchParams();
    body.set('id', b.id || '');
    body.set('number', b.number || '');
    body.set('department', b.department || '');
    body.set('site', b.site || '');
    body.set('type', b.type || '');
    body.set('datetime', b.datetime || new Date().toISOString().split('T')[0]);
    body.set('status', b.status || (b.type === '租聘台式主机' ? '租聘' : '未录入'));
    body.set('tag', b.tag || '');
    body.set('notice', b.notice || '');
    body.set('attachment_urls', b.attachment_urls || '');
    Object.entries(overrides).forEach(([k, v]) => body.set(k, v));
    return fetch('/update', {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: body.toString()
    }).then(r => r.json());
}

// 查看态下点选状态 / 标签即刻落库，无需先进入编辑态
function bindViewQuickToggles() {
    const root = document.querySelector('.detail-view');
    if (!root) return;
    const groups = root.querySelectorAll('.status-toggles');
    const statusGroup = root.querySelector('.status-toggles[data-group="status"]');
    const tagGroup = root.querySelector('.status-toggles[data-group="tag"]');
    if (!statusGroup || !tagGroup) return;
    let saving = false;

    const setActive = (group, key, value) => {
        group.querySelectorAll('.status-toggle').forEach(t => t.classList.toggle('active', t.dataset[key] === value));
    };
    const lock = on => groups.forEach(g => g.classList.toggle('is-saving', on));

    const push = (field, value, revert) => {
        if (saving) return;
        const b = DETAIL_DATA.basic;
        if (!b.number || !b.department || !b.site) {
            revert();
            alert('该资产还缺少使用部门或使用人，请先点右上角「修改」补全后再切换。');
            return;
        }
        saving = true;
        lock(true);
        submitViewUpdate({ [field]: value })
            .then(res => {
                if (res.status === 'success') {
                    DETAIL_DATA.basic[field] = value;
                    loadStatusCounts();
                    document.getElementById('queryBtn').click();
                } else {
                    alert((field === 'status' ? '状态' : '标签') + '更新失败：' + (res.message || '未知错误'));
                    revert();
                }
            })
            .catch(() => {
                alert('更新失败，请重试');
                revert();
            })
            .finally(() => {
                saving = false;
                lock(false);
            });
    };

    const bindChips = (group, key, resolve) => {
        group.querySelectorAll('.status-toggle').forEach(chip => {
            chip.addEventListener('click', () => {
                if (saving) return;
                const prev = DETAIL_DATA.basic[key] || '';
                const next = resolve(chip, prev);
                if (next === prev) return;
                setActive(group, key, next);
                push(key, next, () => setActive(group, key, prev));
            });
            chip.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    chip.click();
                }
            });
        });
    };

    bindChips(statusGroup, 'status', chip => chip.dataset.status);
    // 标签支持再次点击取消
    bindChips(tagGroup, 'tag', (chip, prev) => (chip.dataset.tag === prev ? '' : chip.dataset.tag));
}

function bindDetailActions() {
    // 克隆按钮以清除所有旧的事件监听器，防止重复绑定
    const oldEditBtn = document.getElementById('qDetailEditBtn');
    const oldDeleteBtn = document.getElementById('qDetailDeleteBtn');
    const newEditBtn = oldEditBtn.cloneNode(true);
    const newDeleteBtn = oldDeleteBtn.cloneNode(true);
    oldEditBtn.parentNode.replaceChild(newEditBtn, oldEditBtn);
    oldDeleteBtn.parentNode.replaceChild(newDeleteBtn, oldDeleteBtn);

    const editBtn = document.getElementById('qDetailEditBtn');
    const deleteBtn = document.getElementById('qDetailDeleteBtn');
    const form = document.querySelector('.detail-form');
    const inputs = form.querySelectorAll('.edit-input');
    const id = form.dataset.id;
    const source = form.dataset.source;
    const statusToggles = form.querySelectorAll('.status-toggle[data-status]');
    const statusInput = form.querySelector('input[name="status"]');
    const tagInput = form.querySelector('input[name="tag"]');
    const tagToggles = form.querySelectorAll('.status-toggle[data-tag]');
    const attachmentUrlsInput = form.querySelector('input[name="attachment_urls"]');
    const detailAttachmentList = document.getElementById('detailAttachmentList');
    const detailAttachmentUpload = document.getElementById('detailAttachmentUpload');
    const detailAttachmentInput = document.getElementById('detailAttachmentInput');
    const detailAttachmentAddBtn = document.getElementById('detailAttachmentAddBtn');

    // 编辑模板渲染后即处于编辑态：左按钮=更新，右按钮=取消

    editBtn.className = 'detail-action-btn btn-update';
    editBtn.title = '更新'; editBtn.setAttribute('aria-label', '更新');
    editBtn.innerHTML = ICON_CHECK;
    deleteBtn.className = 'detail-action-btn btn-cancel';
    deleteBtn.title = '取消'; deleteBtn.setAttribute('aria-label', '取消');
    deleteBtn.innerHTML = ICON_CLOSE;
    statusToggles.forEach(t => {
        t.classList.add('editable');
    });

    // 编辑态已有「取消」按钮，隐藏右上角关闭图标避免重复
    document.getElementById('queryDetailClose').style.display = 'none';

    // 进入编辑态的初始动作：启用控件、状态/日期默认值、显示删除与上传入口
    // 无 name 的控件是台账派生的只读字段（资产规格/SN），启用后也不会提交，保持禁用
    inputs.forEach(i => {
        if (!i.name || i.name === 'number' || i.name === 'type') return;
        i.disabled = false;
    });
    const assetType = form.querySelector('[name="type"]').value;
    const keepStatus = assetType === '租聘台式主机' ? '租聘' : '未录入';
    statusInput.value = keepStatus;
    form.querySelectorAll('.status-toggle[data-status]').forEach(t => {
        t.classList.toggle('active', t.dataset.status === keepStatus);
    });
    const dateInput = form.querySelector('input[name="datetime"]');
    if (dateInput) dateInput.value = new Date().toISOString().split('T')[0];
    form.querySelectorAll('.history-delete-btn').forEach(btn => btn.style.display = 'flex');
    form.querySelectorAll('.attachment-detail-remove').forEach(btn => btn.style.display = 'flex');
    if (detailAttachmentUpload) detailAttachmentUpload.style.display = 'block';

    // 右按钮：编辑态下为「取消」，回到只读视图
    deleteBtn.addEventListener('click', () => {
        renderDetailView();
    });

    // 统一修改/更新按钮处理
    editBtn.addEventListener('click', () => {
            // 执行更新
            const numberVal = form.querySelector('input[name="number"]').value.trim();
            const department = form.querySelector('select[name="department"]').value;
            const site = form.querySelector('input[name="site"]').value.trim();
            const datetime = form.querySelector('input[name="datetime"]').value;
            const status = statusInput.value;

            if (!numberVal || !department || !site || !datetime || !status) {
                alert('资产编码、使用部门、使用人、发放日期、资产状态 不能为空！');
                return;
            }

            const attachmentUrls = attachmentUrlsInput ? attachmentUrlsInput.value : '';
            editBtn.disabled = true;
            editBtn.classList.add('is-loading');
            editBtn.innerHTML = SPINNER;
            submitDetailUpdate(form, id, { attachment_urls: attachmentUrls })
                .then(res => {
                    if (res.status === 'success') {
                        document.getElementById('queryDetailModal').style.display = 'none';
                        document.getElementById('queryBtn').click();
                        loadStatusCounts();
                    } else {
                        alert('更新失败：' + (res.message || '未知错误'));
                    }
                })
                .catch(() => alert('更新失败，请重试'))
                .finally(() => {
                    editBtn.disabled = false;
                    editBtn.classList.remove('is-loading');
                    editBtn.innerHTML = ICON_CHECK;
                });
    });

    // 附件管理
    function renderDetailAttachments(urlsStr, editing) {
        const urls = urlsStr.split(',').filter(u => u.trim());
        if (!detailAttachmentList) return;
        if (urls.length > 0) {
            detailAttachmentList.innerHTML = urls.map(url => `
                <div class="attachment-detail-item" data-url="${escapeHtml(url)}">
                    <img src="${escapeHtml(url)}" class="attachment-detail-img" alt="附件图片" onclick="window.open('${escapeHtml(url)}','_blank')">
                    <button type="button" class="attachment-detail-remove" style="display:${editing ? 'flex' : 'none'};" title="移除">&times;</button>
                </div>
            `).join('');
        } else {
            detailAttachmentList.innerHTML = '<div class="attachment-empty">暂无附件</div>';
        }
        bindAttachmentRemove();
    }

    function bindAttachmentRemove() {
        if (!detailAttachmentList) return;
        detailAttachmentList.querySelectorAll('.attachment-detail-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                const item = btn.closest('.attachment-detail-item');
                const removeUrl = item.dataset.url;
                const currentUrls = (attachmentUrlsInput.value || '').split(',').filter(u => u.trim());
                const newUrls = currentUrls.filter(u => u !== removeUrl);
                attachmentUrlsInput.value = newUrls.join(',');
                renderDetailAttachments(attachmentUrlsInput.value, true);
            });
        });
    }

    // 附件删除按钮初始绑定
    bindAttachmentRemove();

    // 附件添加
    if (detailAttachmentAddBtn) {
        detailAttachmentAddBtn.addEventListener('click', () => detailAttachmentInput.click());
    }
    if (detailAttachmentInput) {
        detailAttachmentInput.addEventListener('change', () => {
            const files = Array.from(detailAttachmentInput.files);
            if (files.length === 0) return;
            // 逐个上传
            files.forEach(file => {
                const data = new FormData();
                data.append('attachment', file);
                fetch('/upload_attachment', { method: 'POST', body: data })
                    .then(r => r.json())
                    .then(res => {
                        if (res.status === 'success') {
                            const currentUrls = (attachmentUrlsInput.value || '').split(',').filter(u => u.trim());
                            currentUrls.push(res.url);
                            attachmentUrlsInput.value = currentUrls.join(',');
                            renderDetailAttachments(attachmentUrlsInput.value, true);
                        } else {
                            alert('附件上传失败：' + res.message);
                        }
                    })
                    .catch(() => alert('附件上传失败，请重试'));
            });
            detailAttachmentInput.value = '';
        });
    }

    // 状态切换按钮点击 —— 随时可交互，立即同步到数据库
    let statusUpdating = false;
    statusToggles.forEach(toggle => {
        toggle.addEventListener('click', () => {
            if (statusUpdating) return;
            const newStatus = toggle.dataset.status;
            if (!newStatus) return;
            if (newStatus === statusInput.value) return;

            const prevStatus = statusInput.value;
            statusToggles.forEach(t => t.classList.remove('active'));
            toggle.classList.add('active');
            statusInput.value = newStatus;

            const numberVal = form.querySelector('input[name="number"]').value.trim();

            statusUpdating = true;
            submitDetailUpdate(form, id, { status: newStatus })
                .then(res => {
                    if (res.status === 'success') {
                        loadStatusCounts();
                        document.getElementById('queryBtn').click();
                        document.querySelectorAll('.query-card').forEach(c => {
                            if (c.querySelector('.query-card-number').textContent === numberVal) {
                                const statusSpan = c.querySelector('.query-card-status');
                                statusSpan.textContent = newStatus;
                                statusSpan.className = 'query-card-status ' + getStatusClass(newStatus);
                            }
                        });
                    } else {
                        alert('状态更新失败：' + res.message);
                        statusToggles.forEach(t => t.classList.toggle('active', t.dataset.status === prevStatus));
                        statusInput.value = prevStatus;
                    }
                })
                .catch(() => {
                    alert('状态更新失败，请重试');
                })
                .finally(() => {
                    statusUpdating = false;
                });
        });
    });

    // 标签切换按钮点击 —— 随时可交互，立即同步到数据库
    let tagUpdating = false;
    tagToggles.forEach(toggle => {
        toggle.addEventListener('click', () => {
            if (tagUpdating) return;
            const newTag = toggle.dataset.tag;
            const prevTag = tagInput ? tagInput.value : '';
            let finalTag = newTag;
            if (newTag === prevTag) {
                finalTag = '';
                tagToggles.forEach(t => t.classList.remove('active'));
            } else {
                tagToggles.forEach(t => t.classList.remove('active'));
                toggle.classList.add('active');
            }
            if (tagInput) tagInput.value = finalTag;

            tagUpdating = true;
            submitDetailUpdate(form, id, { tag: finalTag })
                .then(res => {
                    if (res.status !== 'success') {
                        alert('标签更新失败：' + res.message);
                        tagToggles.forEach(t => t.classList.toggle('active', t.dataset.tag === prevTag));
                        if (tagInput) tagInput.value = prevTag;
                    }
                })
                .catch(() => {
                    alert('标签更新失败，请重试');
                })
                .finally(() => {
                    tagUpdating = false;
                });
        });
    });

    // 历史记录删除按钮
    form.querySelectorAll('.history-delete-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const historyItem = btn.closest('.history-item');
            const tmpId = historyItem.dataset.tmpId;
            if (!tmpId) return;

            if (!confirm('确认删除此条历史记录？此操作不可逆。')) return;

            fetch('/delete_history', {
                method: 'POST',
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                body: `tmp_id=${tmpId}`
            })
                .then(r => r.json())
                .then(res => {
                    if (res.status === 'success') {
                        historyItem.remove();
                        loadStatusCounts();
                        document.getElementById('queryBtn').click();
                    } else {
                        alert('删除失败：' + res.message);
                    }
                })
                .catch(() => {
                    alert('删除失败，请重试');
                });
        });
    });
}

// 关闭详情弹窗
document.getElementById('queryDetailClose').addEventListener('click', () => {
    document.getElementById('queryDetailModal').style.display = 'none';
});
