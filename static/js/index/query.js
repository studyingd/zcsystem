// index/query.js — 资产查询交互与结果渲染、详情更新提交、详情弹窗打开入口（index.js 拆分 2/4）
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

