/**
 * 跨页面共享的小工具与词表。
 *
 * 词表的权威来源是后端 app/ledger.py，由 base.html 渲染进 #zcMeta（见 app/meta.py）。
 * 这里的常量只是「拿不到 meta 时的兜底」（例如脚本被单独引用、模板漏渲染），
 * 正常页面一律使用后端下发的值，避免前后端词表漂移。
 */

function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 后端下发的词表（app/meta.py 的 frontend_meta）
const ZC_META = (function () {
    const node = document.getElementById('zcMeta');
    if (!node) return null;
    try {
        return JSON.parse(node.textContent);
    } catch (err) {
        console.warn('zcMeta 解析失败，使用内置兜底词表', err);
        return null;
    }
})();

function metaList(key, fallback) {
    const value = ZC_META && ZC_META[key];
    return Array.isArray(value) && value.length ? value : fallback;
}

// 资产状态（兜底同 ledger.INVENTORY_STATUSES）
const STATUS_OPTIONS = metaList('statuses', ['已录入', '未录入', '租赁', '借用', '入库', '无需录入', '报废']);

// 流转标签：领用类（入职/领用/更换）+ 在库类（入库）+ 弃用（兜底同 ledger.ALL_TAGS）
const TAG_OPTIONS = metaList('tags', ['入职', '领用', '更换', '入库', '弃用']);

// 资产状态徽章样式（index.css 的 .status-done / .status-pending / .status-none）
function getStatusClass(status) {
    if (status === '已录入') return 'status-done';
    if (['未录入', '租赁', '借用', '入库'].includes(status)) return 'status-pending';
    return 'status-none';
}

// 状态徽章 HTML（空状态显示「无状态」）
function statusBadgeHtml(status) {
    const text = status || '无状态';
    return `<span class="status-badge ${getStatusClass(status)}">${escapeHtml(text)}</span>`;
}

// 流转标签徽章：与 ledger 的 METRIC_TAGS / STOCK_TAGS 分组同口径
// （领用类绿 = 在用、在库类黄 = 库存、弃用灰）
const TAG_METRIC = ['入职', '领用', '更换'];
const TAG_STOCK = ['入库'];

function getTagClass(tag) {
    if (TAG_METRIC.includes(tag)) return 'status-done';
    if (TAG_STOCK.includes(tag)) return 'status-pending';
    return 'status-none';
}

function tagBadgeHtml(tag) {
    const text = tag || '无标签';
    return `<span class="status-badge ${getTagClass(tag)}">${escapeHtml(text)}</span>`;
}

// 部门下拉：首项为占位空值，其余来自后端词表（兜底同 ledger.DEPARTMENTS）
const DEPARTMENT_VALUES = metaList('departments', [
    'FIN', 'HR', 'SCM', 'STU', 'GMO', 'COM', 'CSG', 'PMD', 'IT', 'SMG', '证券事务部'
]);

// 单据新增页可选设备类型 + 自定义类型占位（兜底同 ledger.ORDER_DEVICE_TYPES / CUSTOM_TYPE_OPTION）
const ORDER_DEVICE_TYPES = metaList('order_device_types', ['显示器', '笔记本电脑', '台式主机']);
const CUSTOM_TYPE = (ZC_META && ZC_META.custom_type) || '其它';
// 必须填写硬件配置（CPU / 内存 / 硬盘 / 显卡）的设备类型（兜底同 ledger.CONFIG_TYPES）
const CONFIG_TYPES = metaList('config_types', ['笔记本电脑', '台式主机', '租赁台式主机']);

const DEPARTMENTS = [
    {value: '', text: '--请选择部门--'},
    ...DEPARTMENT_VALUES.map(dept => ({value: dept, text: dept})),
];

function deptOptionsHtml(selected) {
    return DEPARTMENTS.map(o =>
        `<option value="${escapeHtml(o.value)}"${selected === o.value ? ' selected' : ''}>${escapeHtml(o.text)}</option>`
    ).join('');
}
