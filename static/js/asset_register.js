/**
 * 资产登记页交互。
 *
 * 后端口径见 app/asset.py 与 app/ledger.py：
 *  - 编码预览 /api/generate_asset_codes：防抖 + AbortController，避免乱序响应覆盖新结果
 *  - 提交     /api/batch_create_assets：提交期间禁用按钮，防连点产生重复资产；
 *             成功响应带回实际编码区间（预览仅供参考，取号可能被他人抢先）
 *  - 列表     /api/get_all_assets：月份 / 前缀 / 关键字筛选 + 分页
 *  - 详情     /api/get_asset_detail：部门、使用人、状态取 inventory 最新一条流转记录
 *
 * 词表（部门 / 状态 / 标签）与弹窗行为分别复用 utils.js 与 modal.js。
 */

const REGISTER_CONFIG = JSON.parse(document.getElementById('registerConfig').textContent);

const state = {
    month: '',
    prefix: '',
    q: '',
    page: 1,
    pageSize: REGISTER_CONFIG.page_size,
    total: 0,
    totalPages: 1,
    rows: [],
    months: [],
    initialized: false,
    submitting: false,
    iconBase: '',
    brandIcons: [],
    previewController: null,
    listController: null,
};

const el = {};

// 字段 -> [表单组 data-field, 错误提示 span id, 控件 id]
// 顺序与表单的视觉顺序一致：focusFirstError 按此找到第一个出错控件
const FIELD_MAP = {
    asset_type: ['asset_type', 'assetTypeError', 'assetType'],
    batch_quantity: ['batch_quantity', 'batchQuantityError', 'batchQuantity'],
    asset_spec: ['asset_spec', 'assetSpecError', 'assetSpec'],
    sn: ['sn', 'snError', 'assetSN'],
};

function debounce(fn, wait) {
    let timer = null;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), wait);
    };
}

function currentMonthValue() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// ---------- 资产年月：年 / 月两个下拉 ----------
// 原生 <input type="month"> 只有 Chromium 系实现了月份选择器，
// Safari / Firefox 会退化成纯文本框。这里用两个 select 组合，
// 值仍落在隐藏域 assetYearMonth 上（YYYY-MM），后端口径不变。
function yearMonthParts(value) {
    const matched = /^(\d{4})-(\d{2})$/.exec(value || '');
    return matched ? { year: matched[1], month: matched[2] } : null;
}

function buildYearMonthOptions() {
    const currentYear = new Date().getFullYear();
    const years = [];
    for (let year = currentYear + 1; year >= currentYear - 5; year--) years.push(year);
    el.assetYearMonthYear.innerHTML = years
        .map(year => `<option value="${year}">${year}年</option>`).join('');
    el.assetYearMonthMonth.innerHTML = Array.from({ length: 12 }, (_, index) => {
        const month = String(index + 1).padStart(2, '0');
        return `<option value="${month}">${index + 1}月</option>`;
    }).join('');
}

/** 写入值（初始化 / 外部回填用），不触发 change，避免初始化时就打预览请求 */
function setYearMonth(value) {
    const parts = yearMonthParts(value) || yearMonthParts(currentMonthValue());
    el.assetYearMonthYear.value = parts.year;
    el.assetYearMonthMonth.value = parts.month;
    syncYearMonth(false);
}

/** 两个下拉 -> 隐藏域；notify 时派发 change，复用既有的预览监听 */
function syncYearMonth(notify = true) {
    const value = `${el.assetYearMonthYear.value}-${el.assetYearMonthMonth.value}`;
    if (el.assetYearMonth.value === value) return;
    el.assetYearMonth.value = value;
    if (notify) el.assetYearMonth.dispatchEvent(new Event('change', { bubbles: true }));
}

function monthLabel(month) {
    return `20${month.slice(0, 2)}年${month.slice(2, 4)}月`;
}

function isConfigType(type) {
    return REGISTER_CONFIG.config_types.includes(type);
}

/** 按规格匹配品牌图标（关键字与地址由后端 meta 下发，不再硬编码内网 IP） */
function brandIcon(spec) {
    if (!spec || !state.iconBase) return '';
    const upper = String(spec).toUpperCase();
    const hit = state.brandIcons.find(item => item.keywords.some(key => upper.includes(key)));
    return hit ? state.iconBase + hit.file : '';
}

function cacheElements() {
    [
        'assetRegisterForm', 'assetType', 'customType', 'assetSpec', 'assetSN',
        'assetDept', 'assetUser', 'assetYearMonth', 'assetYearMonthYear', 'assetYearMonthMonth',
        'batchQuantity', 'configSection',
        'configToggle', 'configFields', 'configCPU', 'configMem', 'configDisk', 'configGPU',
        'codePreview', 'registerMsg', 'submitBtn', 'resetBtn', 'filterMonth', 'filterPrefix',
        'searchInput', 'refreshAssetList', 'assetListContainer', 'listPagination',
        'listMsg', 'assetDetailModal', 'assetDetailContent',
    ].forEach(id => { el[id] = document.getElementById(id); });
}

// ---------- 字段级错误提示（就近显示，不用底部大横幅） ----------
function setFieldError(field, message) {
    const mapping = FIELD_MAP[field];
    if (!mapping) return;
    const [groupKey, errorId, controlId] = mapping;
    const group = document.querySelector(`.form-group[data-field="${groupKey}"]`);
    const errorEl = document.getElementById(errorId);
    const control = document.getElementById(controlId);
    if (group) group.classList.toggle('has-error', Boolean(message));
    if (errorEl) {
        errorEl.textContent = message || '';
        errorEl.hidden = !message;
    }
    if (control) {
        if (message) {
            control.setAttribute('aria-invalid', 'true');
        } else {
            control.removeAttribute('aria-invalid');
        }
    }
}

function clearFieldErrors() {
    Object.keys(FIELD_MAP).forEach(field => setFieldError(field, ''));
}

/** 第一个出错的控件获得焦点，用户不用自己在长表单里找 */
function focusFirstError(errors) {
    const field = Object.keys(FIELD_MAP).find(key => errors[key]);
    if (!field) return;
    const control = document.getElementById(FIELD_MAP[field][2]);
    if (control) control.focus();
}

// ---------- 表单：类型联动 ----------
function selectedType() {
    const type = el.assetType.value;
    return type === REGISTER_CONFIG.custom_type_option ? el.customType.value.trim() : type;
}

function snLines() {
    return el.assetSN.value.split('\n').map(line => line.trim()).filter(Boolean);
}

function applyTypeUi() {
    const type = el.assetType.value;
    const isCustom = type === REGISTER_CONFIG.custom_type_option;
    const isRental = type === REGISTER_CONFIG.rental_type;

    el.customType.hidden = !isCustom;
    el.customType.required = isCustom;
    if (!isCustom) el.customType.value = '';

    // SN 仅租赁机必填（逐台一个）；其余类型整组隐藏并清空，
    // 避免上次选了租赁机留下的 SN 被静默带到下一批
    const snGroup = document.querySelector('.form-group[data-field="sn"]');
    if (snGroup) snGroup.hidden = !isRental;
    el.assetSN.required = isRental;
    if (!isRental) {
        el.assetSN.value = '';
        setFieldError('sn', '');
    }

    // 硬件配置仅电脑类资产需要
    el.configSection.hidden = !isConfigType(type);
    if (!isConfigType(type)) {
        [el.configCPU, el.configMem, el.configDisk, el.configGPU].forEach(input => { input.value = ''; });
    }

    // 租赁机规格默认值：只在用户还没填时回填，不覆盖已有输入
    if (isRental && !el.assetSpec.value.trim()) {
        el.assetSpec.value = REGISTER_CONFIG.rental_default_spec;
    }

    setFieldError('asset_type', '');
    syncSnRows();
    refreshPreview();
}

/** textarea 行数跟随批量数量，逐台填 SN 时不用滚动 */
function syncSnRows() {
    const quantity = parseInt(el.batchQuantity.value, 10) || 1;
    el.assetSN.rows = Math.min(6, Math.max(2, quantity));
}

// ---------- 表单：编码预览 ----------
function refreshPreview() {
    const type = selectedType() || el.assetType.value;
    const quantity = parseInt(el.batchQuantity.value, 10) || 1;
    const yearMonth = el.assetYearMonth.value;

    if (!type) {
        el.codePreview.innerHTML = '<span class="code-preview-empty">选择资产类型后自动生成</span>';
        return;
    }

    // 取消上一个未完成的请求，避免慢响应回来后覆盖新结果
    if (state.previewController) state.previewController.abort();
    state.previewController = new AbortController();

    el.codePreview.classList.add('is-loading');
    fetch('/api/generate_asset_codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset_type: type, quantity, year_month: yearMonth }),
        signal: state.previewController.signal,
    })
        .then(response => response.json())
        .then(res => {
            el.codePreview.classList.remove('is-loading');
            if (res.status !== 'success') {
                el.codePreview.innerHTML = `<span class="code-preview-empty">${escapeHtml(res.message || '获取编码失败')}</span>`;
                return;
            }
            const codes = res.codes || [];
            const shown = codes.slice(0, 12);
            const html = shown.map(code => `<span class="code-chip">${escapeHtml(code)}</span>`).join('');
            const more = codes.length > shown.length
                ? `<span class="code-chip code-chip-more">… 共 ${codes.length} 个</span>`
                : '';
            el.codePreview.innerHTML = `<div class="code-chips">${html}${more}</div>
                <p class="code-preview-note">预览仅供参考，实际编码以提交结果为准</p>`;
        })
        .catch(error => {
            el.codePreview.classList.remove('is-loading');
            if (error.name === 'AbortError') return;
            el.codePreview.innerHTML = '<span class="code-preview-empty">获取编码失败，请重试</span>';
        });
}

// ---------- 表单：校验与提交 ----------
function showMessage(text, kind) {
    el.registerMsg.textContent = text;
    el.registerMsg.className = `msg-box ${kind === 'error' ? 'msg-error' : 'msg-success'}`;
    el.registerMsg.hidden = false;
    clearTimeout(showMessage._timer);
    showMessage._timer = setTimeout(() => { el.registerMsg.hidden = true; }, 6000);
}

/** 列表 / 详情类错误就近显示在列表面板，不要跑到左侧表单底部 */
function showListMessage(text, kind) {
    el.listMsg.textContent = text;
    el.listMsg.className = `msg-box ${kind === 'error' ? 'msg-error' : 'msg-success'}`;
    el.listMsg.hidden = false;
    clearTimeout(showListMessage._timer);
    showListMessage._timer = setTimeout(() => { el.listMsg.hidden = true; }, 6000);
}

function validateForm() {
    const errors = {};
    const rawType = el.assetType.value;
    const type = selectedType();

    if (!rawType) {
        errors.asset_type = '请选择资产类型';
    } else if (rawType === REGISTER_CONFIG.custom_type_option && !type) {
        errors.asset_type = '请输入自定义资产类型';
    }

    if (!el.assetSpec.value.trim()) errors.asset_spec = '请输入资产规格';

    const quantity = parseInt(el.batchQuantity.value, 10);
    if (!Number.isInteger(quantity) || quantity < 1) {
        errors.batch_quantity = '批量数量至少为 1';
    } else if (quantity > REGISTER_CONFIG.max_batch) {
        errors.batch_quantity = `单次批量数量不能超过 ${REGISTER_CONFIG.max_batch} 个`;
    }

    if (rawType === REGISTER_CONFIG.rental_type) {
        const lines = snLines();
        const expected = Number.isInteger(quantity) ? quantity : 1;
        if (lines.length !== expected) {
            errors.sn = `需填写 ${expected} 个 SN（每行一个），当前 ${lines.length} 个`;
        } else if (new Set(lines).size !== lines.length) {
            errors.sn = 'SN 码存在重复，请逐台核对';
        }
    }

    return errors;
}

function buildPayload() {
    const quantity = parseInt(el.batchQuantity.value, 10) || 1;
    const type = selectedType();
    const config = {};
    if (isConfigType(el.assetType.value)) {
        config.cpu = el.configCPU.value.trim();
        config.mem = el.configMem.value.trim();
        config.disk = el.configDisk.value.trim();
        config.gpu = el.configGPU.value.trim();
    }
    if (el.assetType.value === REGISTER_CONFIG.rental_type) config.sn_list = snLines();

    return {
        asset_type: type,
        asset_spec: el.assetSpec.value.trim(),
        asset_dept: el.assetDept.value,
        asset_user: el.assetUser.value.trim(),
        year_month: el.assetYearMonth.value,
        batch_quantity: quantity,
        config,
    };
}

function setSubmitting(submitting) {
    state.submitting = submitting;
    el.submitBtn.disabled = submitting;
    el.resetBtn.disabled = submitting;
    el.submitBtn.classList.toggle('is-busy', submitting);
    el.submitBtn.querySelector('.btn-label').textContent = submitting ? '登记中…' : '确认登记';
}

/** 提交成功后只清空「本批」输入：类型/规格/部门/使用人/年月保留，便于连续登记同规格资产 */
function resetBatchInputs() {
    el.batchQuantity.value = '1';
    el.assetSN.value = '';
    [el.configCPU, el.configMem, el.configDisk, el.configGPU].forEach(input => { input.value = ''; });
    syncSnRows();
    clearFieldErrors();
}

function handleSubmit(event) {
    event.preventDefault();
    if (state.submitting) return;

    const errors = validateForm();
    clearFieldErrors();
    Object.entries(errors).forEach(([field, message]) => setFieldError(field, message));
    if (Object.keys(errors).length) {
        showMessage('请先修正表单中标红的字段', 'error');
        focusFirstError(errors);
        return;
    }

    const payload = buildPayload();
    setSubmitting(true);

    fetch('/api/batch_create_assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    })
        .then(response => response.json().then(data => ({ ok: response.ok, data })))
        .then(({ data }) => {
            if (data.status !== 'success') {
                showMessage(data.message || '登记失败，请重试', 'error');
                return;
            }
            showMessage(data.message, 'success');
            resetBatchInputs();
            // 让列表立刻显示这批新资产：切到登记所属月份的第一页
            const yymm = (payload.year_month || '').replace('-', '').slice(2);
            state.month = yymm;
            state.page = 1;
            loadList(yymm);
            refreshPreview();
        })
        .catch(error => {
            console.error(error);
            showMessage('登记失败，请检查网络后重试', 'error');
        })
        .finally(() => setSubmitting(false));
}

// ---------- 表单绑定 ----------
function bindForm() {
    const debouncedPreview = debounce(refreshPreview, 300);
    const debouncedSnHint = debounce(() => {
        syncSnRows();
        if (el.assetType.value === REGISTER_CONFIG.rental_type) {
            const errors = validateForm();
            setFieldError('sn', errors.sn || '');
        }
    }, 200);

    el.assetType.addEventListener('change', applyTypeUi);
    el.customType.addEventListener('input', debouncedPreview);
    el.batchQuantity.addEventListener('input', () => { debouncedSnHint(); debouncedPreview(); });
    el.assetYearMonth.addEventListener('change', debouncedPreview);
    el.assetYearMonthYear.addEventListener('change', () => syncYearMonth());
    el.assetYearMonthMonth.addEventListener('change', () => syncYearMonth());
    el.assetSN.addEventListener('input', debouncedSnHint);

    // 输入即清除该字段的错误态，避免「改好了还红着」
    [['assetType', 'asset_type'], ['customType', 'asset_type'], ['assetSpec', 'asset_spec'],
     ['batchQuantity', 'batch_quantity'], ['assetSN', 'sn']].forEach(([id, field]) => {
        el[id].addEventListener('input', () => setFieldError(field, ''));
        el[id].addEventListener('change', () => setFieldError(field, ''));
    });

    el.configToggle.addEventListener('click', () => {
        const expanded = el.configToggle.getAttribute('aria-expanded') === 'true';
        el.configToggle.setAttribute('aria-expanded', String(!expanded));
        el.configFields.hidden = expanded;
        el.configSection.classList.toggle('is-collapsed', expanded);
    });

    el.resetBtn.addEventListener('click', () => {
        resetBatchInputs();
        el.registerMsg.hidden = true;
        refreshPreview();
    });

    el.assetRegisterForm.addEventListener('submit', handleSubmit);
}

/** 品牌图标地址由后端下发（对象存储），前端不再硬编码内网 IP */
function loadMeta() {
    return fetch('/api/asset_register/meta')
        .then(response => response.json())
        .then(res => {
            if (res.status === 'success') {
                state.iconBase = res.icon_base || '';
                state.brandIcons = res.brand_icons || [];
            }
        })
        .catch(error => console.error('加载页面元数据失败', error));
}

// ---------- 资产列表 ----------
function listQuery() {
    const params = new URLSearchParams();
    if (state.month) params.set('month', state.month);
    if (state.prefix) params.set('prefix', state.prefix);
    if (state.q) params.set('q', state.q);
    params.set('page', String(state.page));
    params.set('page_size', String(state.pageSize));
    return params.toString();
}

function setListState(html) {
    el.assetListContainer.innerHTML = `<div class="list-state">${html}</div>`;
    el.listPagination.hidden = true;
}

// 顶栏导出跟随当前筛选条件（月份 / 编码前缀 / 关键字）
function syncExportLink() {
    const link = document.getElementById('topbarExport');
    if (!link) return;
    const params = new URLSearchParams();
    if (state.month) params.set('month', state.month);
    if (state.prefix) params.set('prefix', state.prefix);
    if (state.q) params.set('q', state.q);
    const qs = params.toString();
    link.href = `/asset_register/export${qs ? `?${qs}` : ''}`;
}

function loadList(monthOverride) {
    if (typeof monthOverride === 'string') state.month = monthOverride;
    syncExportLink();

    if (state.listController) state.listController.abort();
    state.listController = new AbortController();

    el.assetListContainer.classList.add('is-loading');
    setListState('加载中…');

    fetch(`/api/get_all_assets?${listQuery()}`, { signal: state.listController.signal })
        .then(response => response.json())
        .then(res => {
            el.assetListContainer.classList.remove('is-loading');
            if (res.status !== 'success') {
                setListState(`${escapeHtml(res.message || '加载失败')}
                    <button type="button" class="btn-secondary btn-sm" data-list-retry>重试</button>`);
                return;
            }
            // 首屏默认只看最近月份，避免一次拉全部台账（仅首次多一次请求）
            if (!state.initialized) {
                state.initialized = true;
                if (!state.month && !state.q && res.months && res.months.length) {
                    state.month = res.months[0];
                    loadList();
                    return;
                }
            }
            renderList(res);
        })
        .catch(error => {
            // 被新请求主动取消的旧请求：容器状态归新请求管，这里不能动
            if (error.name === 'AbortError') return;
            el.assetListContainer.classList.remove('is-loading');
            console.error(error);
            setListState(`加载失败，请检查网络
                <button type="button" class="btn-secondary btn-sm" data-list-retry>重试</button>`);
        });
}

function renderMonthOptions(months) {
    state.months = months || [];
    const options = ['<option value="">全部月份</option>']
        .concat(state.months.map(month => `<option value="${escapeHtml(month)}">${escapeHtml(monthLabel(month))}</option>`));
    el.filterMonth.innerHTML = options.join('');
    el.filterMonth.value = state.months.includes(state.month) ? state.month : '';
    state.month = el.filterMonth.value;
}

function renderList(data) {
    state.rows = data.rows || [];
    state.total = data.total || 0;
    state.page = data.page || 1;
    state.totalPages = data.total_pages || 1;
    state.q = (data.filters && data.filters.q) || '';
    state.prefix = (data.filters && data.filters.prefix) || '';

    renderMonthOptions(data.months);
    el.filterPrefix.value = state.prefix;

    if (!state.rows.length) {
        setListState(state.total || state.q || state.month || state.prefix
            ? '没有符合条件的资产 <button type="button" class="btn-secondary btn-sm" data-list-reset>清空筛选</button>'
            : '暂无资产，先在左侧登记');
        return;
    }

    el.assetListContainer.innerHTML = `
        <div class="table-scroll">
            <table class="asset-table">
                <caption class="sr-only">资产台账列表，按编码倒序</caption>
                <thead>
                    <tr>
                        <th scope="col">资产编码</th>
                        <th scope="col">类型</th>
                        <th scope="col">规格</th>
                        <th scope="col">使用部门</th>
                        <th scope="col">使用人</th>
                        <th scope="col">状态</th>
                        <th scope="col"><span class="sr-only">操作</span></th>
                    </tr>
                </thead>
                <tbody>${state.rows.map(renderRow).join('')}</tbody>
            </table>
        </div>`;
    renderPagination();
}

function renderRow(row) {
    const icon = brandIcon(row.spec);
    const iconHtml = icon
        ? `<img src="${escapeHtml(icon)}" class="brand-icon" alt="" aria-hidden="true" loading="lazy">`
        : '';
    const spec = row.spec || '';
    return `
        <tr>
            <td class="cell-number">${iconHtml}<span class="number-text">${escapeHtml(row.number)}</span></td>
            <td>${escapeHtml(row.type) || '-'}</td>
            <td class="cell-spec" title="${escapeHtml(spec)}">${escapeHtml(spec) || '-'}</td>
            <td>${escapeHtml(row.department) || '-'}</td>
            <td>${escapeHtml(row.name) || '-'}</td>
            <td>${statusBadgeHtml(row.inv_status)}</td>
            <td>
                <button type="button" class="btn-link" data-detail-id="${escapeHtml(String(row.id))}"
                        aria-label="查看 ${escapeHtml(row.number)} 的详情">详情</button>
            </td>
        </tr>`;
}

function renderPagination() {
    if (state.totalPages <= 1) {
        el.listPagination.hidden = true;
        el.listPagination.innerHTML = '';
        return;
    }
    const page = state.page;
    const total = state.totalPages;
    const btn = (label, target, disabled, active) =>
        `<button type="button" class="page-btn${active ? ' active' : ''}" data-page="${target}"
            ${disabled ? 'disabled' : ''}${active ? ' aria-current="page"' : ''}>${label}</button>`;

    let start = Math.max(1, page - 2);
    let end = Math.min(total, start + 4);
    if (end - start < 4) start = Math.max(1, end - 4);

    const pages = [];
    for (let i = start; i <= end; i += 1) pages.push(btn(String(i), i, false, i === page));

    el.listPagination.innerHTML = [
        btn('首页', 1, page === 1, false),
        btn('上一页', page - 1, page === 1, false),
        pages.join(''),
        btn('下一页', page + 1, page === total, false),
        btn('末页', total, page === total, false),
        `<span class="page-info">共 ${state.total} 条</span>`,
    ].join('');
    el.listPagination.hidden = false;
}

function resetFilters() {
    state.month = '';
    state.prefix = '';
    state.q = '';
    state.page = 1;
    el.searchInput.value = '';
    el.filterPrefix.value = '';
    loadList();
}

function bindList() {
    const debouncedSearch = debounce(() => {
        state.q = el.searchInput.value.trim();
        state.page = 1;
        loadList();
    }, 300);

    el.searchInput.addEventListener('input', debouncedSearch);
    el.filterMonth.addEventListener('change', () => {
        state.month = el.filterMonth.value;
        state.page = 1;
        loadList();
    });
    el.filterPrefix.addEventListener('change', () => {
        state.prefix = el.filterPrefix.value;
        state.page = 1;
        loadList();
    });
    el.refreshAssetList.addEventListener('click', () => loadList());

    // 事件委托：分页 / 详情 / 重试 / 清空筛选
    document.querySelector('.list-panel').addEventListener('click', (event) => {
        const target = event.target;

        const pageBtn = target.closest('[data-page]');
        if (pageBtn && !pageBtn.disabled) {
            state.page = parseInt(pageBtn.dataset.page, 10);
            loadList();
            return;
        }

        const detailBtn = target.closest('[data-detail-id]');
        if (detailBtn) {
            openDetail(detailBtn.dataset.detailId);
            return;
        }

        if (target.closest('[data-list-retry]')) {
            loadList();
            return;
        }
        if (target.closest('[data-list-reset]')) {
            resetFilters();
        }
    });
}

// ---------- 资产详情 ----------
function detailRow(label, value, extraClass) {
    return `<div class="detail-row">
        <span class="detail-label">${escapeHtml(label)}</span>
        <span class="detail-value${extraClass ? ` ${extraClass}` : ''}">${escapeHtml(value) || '-'}</span>
    </div>`;
}

function renderDetail(asset) {
    const icon = brandIcon(asset.spec);
    const iconHtml = icon
        ? `<img src="${escapeHtml(icon)}" class="detail-brand-icon" alt="" aria-hidden="true">`
        : '';
    const parts = [
        `<div class="detail-head">${iconHtml}
            <div>
                <div class="detail-number">${escapeHtml(asset.number)}</div>
                <div class="detail-sub">${escapeHtml(asset.type) || '-'}${asset.inv_status ? ` · ${escapeHtml(asset.inv_status)}` : ''}</div>
            </div>
        </div>`,
        detailRow('资产规格', asset.spec),
        detailRow('使用部门', asset.department),
        detailRow('使用人', asset.name),
    ];

    if (asset.sn) parts.push(detailRow('SN 码', asset.sn));

    const hardware = [['CPU', asset.cpu], ['内存', asset.mem], ['硬盘', asset.disk], ['显卡', asset.gpu]]
        .filter(([, value]) => value);
    if (hardware.length) {
        parts.push('<div class="detail-section"><h4>硬件配置</h4>'
            + hardware.map(([label, value]) => detailRow(label, value)).join('')
            + '</div>');
    }

    if (asset.inv_tag || asset.inv_date) {
        parts.push('<div class="detail-section"><h4>最近流转</h4>'
            + detailRow('流转标签', asset.inv_tag)
            + detailRow('流转日期', asset.inv_date)
            + '</div>');
    }

    el.assetDetailContent.innerHTML = parts.join('');
    openModal(el.assetDetailModal);
}

function openDetail(assetId) {
    // 列表行已是台账派生口径（部门 / 使用人 / 状态由 inventory 最新记录覆盖），
    // 直接复用同一份数据，避免「缓存命中」与「走接口」两条路径口径不一致
    const row = state.rows.find(item => String(item.id) === String(assetId));
    if (row) {
        renderDetail(row);
        return;
    }
    fetch(`/api/get_asset_detail?id=${encodeURIComponent(assetId)}`)
        .then(response => response.json())
        .then(res => {
            if (res.status === 'success') {
                renderDetail(res.data);
            } else {
                showListMessage(res.message || '资产详情加载失败', 'error');
            }
        })
        .catch(error => {
            console.error(error);
            showListMessage('资产详情加载失败，请重试', 'error');
        });
}

// ---------- 初始化 ----------
function init() {
    cacheElements();
    buildYearMonthOptions();
    setYearMonth(currentMonthValue());
    bindForm();
    bindList();
    // 详情弹窗只允许点右上角关闭按钮：遮罩点击 / Esc 都不关
    initModal(el.assetDetailModal, { closeOnBackdrop: false, closeOnEsc: false });
    applyTypeUi();

    // 图标地址就位后再渲染列表，避免图标二次重排
    loadMeta().then(() => loadList());
}

document.addEventListener('DOMContentLoaded', init);
