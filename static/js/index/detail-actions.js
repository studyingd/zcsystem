// index/detail-actions.js — 详情弹窗交互：编辑/删除/状态速切/附件上传，含顶层关闭按钮绑定（index.js 拆分 4/4）
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
