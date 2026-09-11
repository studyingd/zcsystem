// index/detail-render.js — 详情弹窗数据缓存、图标常量、查看/编辑态 HTML 模板与渲染（index.js 拆分 3/4）
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

