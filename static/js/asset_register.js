let statusData = {};
let currentMonth = '';
let initialLoadDone = false;

window.addEventListener('DOMContentLoaded', () => {
    // 设置默认年月为当前年月
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    document.getElementById('assetYearMonth').value = `${year}-${month}`;

    bindAssetTypeChange();
    bindPreviewBtn();
    bindFormSubmit();
    bindAssetListControls();
    bindAssetDetailModal();
    loadAssetList();
});

function bindAssetTypeChange() {
    const assetType = document.getElementById('assetType');
    const customTypeInput = document.getElementById('customType');
    const snField = document.getElementById('snField');

    assetType.addEventListener('change', () => {
        const type = assetType.value;

        // 显示/隐藏自定义类型输入框
        if (type === '其它') {
            customTypeInput.style.display = 'inline-block';
            customTypeInput.required = true;
        } else {
            customTypeInput.style.display = 'none';
            customTypeInput.required = false;
            customTypeInput.value = '';
        }

        // 显示/隐藏SN码输入框（租聘台式主机）
        if (type === '租聘台式主机') {
            snField.style.display = 'flex';
            // 默认填入EDY易点云
            document.getElementById('assetSpec').value = 'EDY易点云';
        } else {
            snField.style.display = 'none';
        }

        updateConfigFields(type);
        updateCodePreview();
    });
}

function updateConfigFields(type) {
    const configSection = document.getElementById('configSection');
    const configFields = document.getElementById('configFields');

    if (!['笔记本电脑', '台式主机', '租聘台式主机'].includes(type)) {
        configSection.style.display = 'none';
        configFields.innerHTML = '';
        return;
    }

    configSection.style.display = 'block';

    let html = '<div class="config-row">';

    html += `
        <div class="config-item">
            <label>CPU:</label>
            <input type="text" id="configCPU" placeholder="如: Intel i5-12400">
        </div>
        <div class="config-item">
            <label>Mem:</label>
            <input type="text" id="configMem" placeholder="如: 16GB DDR4">
        </div>
        <div class="config-item">
            <label>Disk:</label>
            <input type="text" id="configDisk" placeholder="如: 512GB SSD">
        </div>
        <div class="config-item">
            <label>GPU:</label>
            <input type="text" id="configGPU" placeholder="如: RTX 3060">
        </div>
    `;

    html += '</div>';
    configFields.innerHTML = html;
}

function bindPreviewBtn() {
    const previewBtn = document.getElementById('previewBtn');
    previewBtn.addEventListener('click', () => {
        updateCodePreview();
    });

    // 也在资产类型、数量、年月变化时自动更新预览
    document.getElementById('assetType').addEventListener('change', updateCodePreview);
    document.getElementById('batchQuantity').addEventListener('input', updateCodePreview);
    document.getElementById('assetYearMonth').addEventListener('change', updateCodePreview);
}

function updateCodePreview() {
    const assetType = document.getElementById('assetType').value;
    const quantity = parseInt(document.getElementById('batchQuantity').value) || 1;
    const yearMonth = document.getElementById('assetYearMonth').value;
    const codePreview = document.getElementById('codePreview');

    if (!assetType) {
        codePreview.innerHTML = '<span style="color: #6c757d;">请选择资产类型</span>';
        return;
    }

    // 调用后端 API 获取实际编码
    fetch('/api/generate_asset_codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset_type: assetType, quantity: quantity, year_month: yearMonth })
    })
        .then(response => response.json())
        .then(res => {
            if (res.status === 'success') {
                let html = '';
                const codes = res.codes;
                for (let i = 0; i < Math.min(codes.length, 20); i++) {
                    html += `<div class="code-preview-item">${codes[i]}</div>`;
                }
                if (codes.length > 20) {
                    html += `<div class="code-preview-item" style="color: #6c757d;">... 共 ${codes.length} 个编码</div>`;
                }
                codePreview.innerHTML = html;
            } else {
                codePreview.innerHTML = '<span style="color: #f8d7da;">获取编码失败</span>';
            }
        })
        .catch(error => {
            codePreview.innerHTML = '<span style="color: #f8d7da;">获取编码失败</span>';
        });
}

function bindFormSubmit() {
    const form = document.getElementById('assetRegisterForm');
    const msgEl = document.getElementById('registerMsg');

    form.addEventListener('submit', (e) => {
        e.preventDefault();

        let assetType = document.getElementById('assetType').value;
        const assetSpec = document.getElementById('assetSpec').value;
        const batchQuantity = parseInt(document.getElementById('batchQuantity').value);

        // 如果选择"其它"，使用自定义类型
        if (assetType === '其它') {
            const customType = document.getElementById('customType').value.trim();
            if (!customType) {
                msgEl.style.display = 'block';
                msgEl.className = 'msg-box msg-error';
                msgEl.textContent = '请输入自定义资产类型';
                return;
            }
            assetType = customType;
        }

        if (!assetType || !assetSpec) {
            msgEl.style.display = 'block';
            msgEl.className = 'msg-box msg-error';
            msgEl.textContent = '请填写所有必填字段';
            return;
        }

        // 收集配置信息
        let config = {};
        if (['笔记本电脑', '台式主机', '租聘台式主机'].includes(assetType)) {
            config = {
                cpu: document.getElementById('configCPU')?.value || '',
                mem: document.getElementById('configMem')?.value || '',
                disk: document.getElementById('configDisk')?.value || '',
                gpu: document.getElementById('configGPU')?.value || ''
            };
            // 租聘台式主机需要SN码
            if (assetType === '租聘台式主机') {
                const sn = document.getElementById('assetSN')?.value.trim();
                if (!sn) {
                    msgEl.style.display = 'block';
                    msgEl.className = 'msg-box msg-error';
                    msgEl.textContent = '请输入SN码';
                    return;
                }
                config.sn = sn;
            }
        } else {
            config = {
                desc: document.getElementById('configDesc')?.value || ''
            };
        }

        const formData = {
            asset_type: assetType,
            asset_spec: assetSpec,
            asset_dept: document.getElementById('assetDept')?.value || '',
            asset_user: document.getElementById('assetUser')?.value || '',
            year_month: document.getElementById('assetYearMonth')?.value || '',
            batch_quantity: batchQuantity,
            config: config
        };

        fetch('/api/batch_create_assets', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(formData)
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
                    // 恢复资产年月为当前年月
                    const now = new Date();
                    const curYear = now.getFullYear();
                    const curMonth = String(now.getMonth() + 1).padStart(2, '0');
                    document.getElementById('assetYearMonth').value = `${curYear}-${curMonth}`;
                    updateConfigFields('');
                    updateCodePreview();
                    // 刷新资产列表
                    loadAssetList();
                } else {
                    msgEl.className = 'msg-box msg-error';
                    msgEl.textContent = res.message;
                }
                setTimeout(() => {
                    msgEl.style.display = 'none';
                }, 5000);
            })
            .catch(error => {
                msgEl.style.display = 'block';
                msgEl.className = 'msg-box msg-error';
                msgEl.textContent = '登记失败，请重试';
                console.error(error);
            });
    });
}

function bindAssetListControls() {
    const filterMonth = document.getElementById('filterMonth');
    const refreshBtn = document.getElementById('refreshAssetList');

    filterMonth.addEventListener('change', () => {
        currentMonth = filterMonth.value;
        loadAssetList();
    });

    refreshBtn.addEventListener('click', () => {
        loadAssetList();
    });
}

function loadAssetList() {
    const container = document.getElementById('assetListContainer');
    container.innerHTML = '<div class="loading-tip">加载中...</div>';

    let url = '/api/get_all_assets';
    if (currentMonth) {
        url += `?month=${currentMonth}`;
    }

    fetch(url)
        .then(response => response.json())
        .then(res => {
            if (res.status === 'success') {
                renderMonthOptions(res.months);
                // Cache all rows for detail lookup
                window._assetRows = [];
                for (const month in res.grouped) {
                    window._assetRows = window._assetRows.concat(res.grouped[month]['DZ'] || []);
                    window._assetRows = window._assetRows.concat(res.grouped[month]['ZL'] || []);
                }
                renderAssetListByGroup(res.grouped);
            } else {
                container.innerHTML = '<div class="loading-tip">加载失败</div>';
            }
        })
        .catch(error => {
            console.error(error);
            container.innerHTML = '<div class="loading-tip">加载失败</div>';
        });
}

function renderMonthOptions(months) {
    const filterMonth = document.getElementById('filterMonth');
    const currentValue = filterMonth.value;

    filterMonth.innerHTML = '<option value="">全部月份</option>';
    months.forEach(month => {
        const label = `20${month.slice(0, 2)}年${month.slice(2, 4)}月`;
        filterMonth.innerHTML += `<option value="${month}">${label}</option>`;
    });

    if (currentValue && filterMonth.querySelector(`option[value="${currentValue}"]`)) {
        filterMonth.value = currentValue;
    } else if (!initialLoadDone) {
        // 仅首次加载时默认选择最近的月份
        const sorted = [...months].sort((a, b) => b.localeCompare(a));
        if (sorted.length > 0) {
            filterMonth.value = sorted[0];
            currentMonth = sorted[0];
            initialLoadDone = true;
            loadAssetList();
            return;
        }
    }
}

function renderAssetListByGroup(grouped) {
    const container = document.getElementById('assetListContainer');

    if (Object.keys(grouped).length === 0) {
        container.innerHTML = '<div class="loading-tip">暂无数据</div>';
        return;
    }

    let html = '';

    // 按月份分组显示
    const sortedMonths = Object.keys(grouped).sort((a, b) => b.localeCompare(a));

    sortedMonths.forEach(month => {
        const dzAssets = grouped[month]['DZ'] || [];
        const zlAssets = grouped[month]['ZL'] || [];
        const monthLabel = `20${month.slice(0, 2)}年${month.slice(2, 4)}月`;

        html += `
            <div class="month-group">
                <div class="month-title">${monthLabel}</div>
                <div class="month-content">
                    <div class="asset-column">
                        <div class="column-header">DZ 资产 (<span class="count">${dzAssets.length}</span>)</div>
                        <div class="column-body">
                            ${renderColumnItems(dzAssets)}
                        </div>
                    </div>
                    <div class="asset-column">
                        <div class="column-header">ZL 资产 (<span class="count">${zlAssets.length}</span>)</div>
                        <div class="column-body">
                            ${renderColumnItems(zlAssets)}
                        </div>
                    </div>
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}

// 根据资产规格返回品牌图标URL
function getBrandIcon(spec) {
    if (!spec) return '';
    const s = spec.toUpperCase();
    const baseUrl = 'http://192.168.1.101:9001/icon/';
    if (s.includes('REDMI') || s.includes('XIAOMI')) return baseUrl + 'XIAOMI.webp';
    if (s.includes('AOC')) return baseUrl + 'AOC.png';
    if (s.includes('EDY')) return baseUrl + 'EDY.png';
    if (s.includes('MAC') || s.includes('APPLE')) return baseUrl + 'Apple.png';
    return '';
}

function renderColumnItems(assets) {
    if (!assets || assets.length === 0) {
        return '<div class="empty-column">暂无资产</div>';
    }

    let html = '<div class="asset-grid">';
    assets.forEach(item => {
        const iconUrl = getBrandIcon(item.spec);
        const iconHtml = iconUrl ? `<img src="${iconUrl}" class="brand-icon" alt="brand">` : '';
        html += `
            <div class="asset-item" onclick="showAssetDetail(${item.id})" style="cursor:pointer;">
                ${iconHtml}
                <div class="asset-number">${item.number}</div>
                <div class="asset-info">${item.type || '-'}</div>
                <div class="asset-info">${item.name || '-'}</div>
            </div>
        `;
    });
    html += '</div>';
    return html;
}

function showAssetDetail(assetId) {
    // Find the asset data from grouped data
    const containers = document.querySelectorAll('.asset-item');
    let assetData = null;

    // Search through all rendered assets to find the one with matching id
    const allRows = window._assetRows || [];
    assetData = allRows.find(item => item.id === assetId);

    if (!assetData) {
        // If not found in cached data, need to fetch
        fetch(`/api/get_asset_detail?id=${assetId}`)
            .then(response => response.json())
            .then(res => {
                if (res.status === 'success') {
                    displayAssetDetailModal(res.data);
                }
            })
            .catch(error => console.error(error));
        return;
    }

    displayAssetDetailModal(assetData);
}

function displayAssetDetailModal(asset) {
    const modal = document.getElementById('assetDetailModal');
    const content = document.getElementById('assetDetailContent');

    const iconUrl = getBrandIcon(asset.spec);
    const iconHtml = iconUrl ? `<img src="${iconUrl}" class="detail-brand-icon" alt="brand">` : '';

    let html = `
        <div style="position:relative;">
            ${iconHtml}
            <div class="detail-row">
                <label>资产编码:</label>
                <span class="detail-value number">${asset.number}</span>
            </div>
            <div class="detail-row">
                <label>资产类型:</label>
                <span class="detail-value">${asset.type || '-'}</span>
            </div>
            <div class="detail-row">
                <label>资产规格:</label>
                <span class="detail-value">${asset.spec || '-'}</span>
            </div>
            <div class="detail-row">
                <label>使用部门:</label>
                <span class="detail-value">${asset.department || '-'}</span>
            </div>
            <div class="detail-row">
                <label>使用人:</label>
                <span class="detail-value">${asset.name || '-'}</span>
            </div>
        </div>
    `;

    // 租聘台式主机显示SN码
    if (asset.type === '租聘台式主机' && asset.sn) {
        html += `
            <div class="detail-row">
                <label>SN码:</label>
                <span class="detail-value">${asset.sn}</span>
            </div>
        `;
    }

    // 如果有配置信息，显示配置
    if (asset.cpu || asset.mem || asset.disk || asset.gpu) {
        html += `
            <div class="detail-section">
                <h4>硬件配置</h4>
                <div class="detail-row">
                    <label>CPU:</label>
                    <span class="detail-value">${asset.cpu || '-'}</span>
                </div>
                <div class="detail-row">
                    <label>内存:</label>
                    <span class="detail-value">${asset.mem || '-'}</span>
                </div>
                <div class="detail-row">
                    <label>硬盘:</label>
                    <span class="detail-value">${asset.disk || '-'}</span>
                </div>
                <div class="detail-row">
                    <label>显卡:</label>
                    <span class="detail-value">${asset.gpu || '-'}</span>
                </div>
            </div>
        `;
    }

    content.innerHTML = html;
    modal.style.display = 'flex';
}

function bindAssetDetailModal() {
    const modal = document.getElementById('assetDetailModal');
    const closeBtn = document.getElementById('closeAssetDetail');

    closeBtn.addEventListener('click', () => {
        modal.style.display = 'none';
    });

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.style.display = 'none';
        }
    });
}