/**
 * 部门领用总览（deptUsage 弹窗）：区间选择 -> 部门 × 类型矩阵 -> 三标签明细。
 *
 * 从 dashboard_orders.js 拆出（原单文件 ~1300 行难维护）。依赖通过
 * init(deps) 由 dashboard_orders.js 注入，避免全局命名空间污染；
 * TAG_METRIC 等常量仍来自全局 utils.js。
 *
 * 加载顺序：utils.js -> 本文件 -> dashboard_orders.js（后者 init 时调用
 * DashboardDeptUsage.init(deps) 完成依赖注入与事件绑定）。
 */
window.DashboardDeptUsage = (function () {
    'use strict';

    // 由 init(deps) 注入的宿主能力
    let $, getJson, escapeHtml, loadingHtml, showModal;

    let DEPT_USAGE = null;
    let DU_FROM = '';
    let DU_TO = '';

    const duMonthLabel = ym => `${ym.slice(0, 4)}年${Number(ym.slice(5, 7))}月`;

    function currentYM() {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }

    function shiftYM(ym, delta) {
        const [y, m] = ym.split('-').map(Number);
        const d = new Date(y, m - 1 + delta, 1);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }

    function duQuery() {
        return `?from=${encodeURIComponent(DU_FROM)}&to=${encodeURIComponent(DU_TO)}`;
    }

    function usageTotal(cells, dept, type) {
        const cell = (cells[dept] || {})[type];
        return cell ? cell.total : 0;
    }

    function openDeptUsage() {
        // 默认当月；后续选择会保留，重开弹窗不回跳
        if (!DU_FROM || !DU_TO) {
            DU_FROM = currentYM();
            DU_TO = currentYM();
        }
        showModal('deptUsageModal');
        loadDeptUsageData();
    }

    function loadDeptUsageData() {
        $('deptUsageBody').innerHTML = loadingHtml();
        getJson('/api/orders/dept_usage' + duQuery()).then(res => {
            if (res.status !== 'success') {
                $('deptUsageBody').innerHTML = `<div class="modal-error">${escapeHtml(res.message || '加载失败')}</div>`;
                return;
            }
            DEPT_USAGE = res;
            renderUsageMatrix();
        });
    }

    /** 一级：口径工具栏 + KPI + 部门 × 类型矩阵 */
    function renderUsageMatrix() {
        const { types, departments, cells, month_from: from, month_to: to, months } = DEPT_USAGE;
        $('deptUsageTitle').textContent = '部门领用总览';
        // 后端 months 只含有记录的月份，选项缺失会导致下拉框显示与实际查询口径错位
        const monthPool = (months && months.length ? months.slice() : [currentYM()]);
        [from, to].forEach(m => { if (m && !monthPool.includes(m)) monthPool.push(m); });
        monthPool.sort();
        monthPool.reverse();
        const monthOptions = monthPool.map(m => `<option value="${m}">${duMonthLabel(m)}</option>`).join('');
        const rangeBar = `
            <div class="du-range">
                <label class="du-range-field">从
                    <select id="duFrom" aria-label="起始月份">${monthOptions}</select>
                </label>
                <label class="du-range-field">至
                    <select id="duTo" aria-label="结束月份">${monthOptions}</select>
                </label>
                <div class="du-presets" role="group" aria-label="快捷区间">
                    <button type="button" class="du-preset" data-action="du-preset" data-preset="this">当月</button>
                    <button type="button" class="du-preset" data-action="du-preset" data-preset="last">上月</button>
                    <button type="button" class="du-preset" data-action="du-preset" data-preset="half">半年</button>
                    <button type="button" class="du-preset" data-action="du-preset" data-preset="year">全年</button>
                </div>
            </div>`;

        let grand = 0;
        const deptTotals = departments.map(d => {
            const s = types.reduce((acc, t) => acc + usageTotal(cells, d, t), 0);
            grand += s;
            return [d, s];
        });
        const top = deptTotals.slice().sort((a, b) => b[1] - a[1])[0];
        const typeTotals = types.map(t => departments.reduce((acc, d) => acc + usageTotal(cells, d, t), 0));
        const topTypeIdx = typeTotals.indexOf(Math.max(...typeTotals, 0));
        const period = from === to
            ? `${duMonthLabel(from)} · 流转次数`
            : `${duMonthLabel(from)} ~ ${duMonthLabel(to)} · 累计流转次数`;
        const kpis = `
            <div class="du-kpis">
                <div class="du-kpi"><span class="du-kpi-label">领用总数</span><strong class="du-kpi-value">${grand}</strong><span class="du-kpi-sub">${escapeHtml(period)}</span></div>
                <div class="du-kpi"><span class="du-kpi-label">覆盖部门</span><strong class="du-kpi-value">${departments.length}</strong><span class="du-kpi-sub">${top && top[1] ? `最多 ${escapeHtml(top[0])} ${top[1]}` : '—'}</span></div>
                <div class="du-kpi"><span class="du-kpi-label">设备类型</span><strong class="du-kpi-value">${types.length}</strong><span class="du-kpi-sub">${grand ? `最多 ${escapeHtml(types[topTypeIdx])} ${typeTotals[topTypeIdx]}` : '—'}</span></div>
            </div>`;

        let max = 0;
        departments.forEach(d => types.forEach(t => { max = Math.max(max, usageTotal(cells, d, t)); }));
        const heat = v => (v && max) ? ` style="background:rgba(37, 99, 235, ${(0.07 + 0.33 * (v / max)).toFixed(2)})"` : '';
        const head = `<tr><th scope="col">部门</th>${types.map(t => `<th scope="col" class="num">${escapeHtml(t)}</th>`).join('')}<th scope="col" class="num">合计</th></tr>`;
        const footSum = types.map(() => 0);
        const body = departments.map(dept => {
            let rowTotal = 0;
            const tds = types.map((t, i) => {
                const v = usageTotal(cells, dept, t);
                rowTotal += v;
                footSum[i] += v;
                const cellHtml = v
                    ? `<button type="button" class="matrix-cell" data-action="matrix-cell" data-dept="${escapeHtml(dept)}" data-type="${escapeHtml(t)}"${heat(v)}
                        title="查看 ${escapeHtml(dept)} · ${escapeHtml(t)} 的入职/领用/更换明细">${v}</button>`
                    : '<span class="du-zero">0</span>';
                return `<td class="num">${cellHtml}</td>`;
            }).join('');
            return `<tr><th scope="row">${escapeHtml(dept)}</th>${tds}<td class="num du-total">${rowTotal}</td></tr>`;
        }).join('');
        const foot = footSum.map(s => `<td class="num du-total">${s}</td>`).join('');
        const legend = max ? `
            <p class="du-legend"><span>少</span>
                <span class="du-legend-scale" aria-hidden="true"><i style="background:rgba(37, 99, 235, 0.07)"></i><i style="background:rgba(37, 99, 235, 0.18)"></i><i style="background:rgba(37, 99, 235, 0.29)"></i><i style="background:rgba(37, 99, 235, 0.40)"></i></span>
                <span>多 · 格内数字为领用台数，点击下钻</span></p>` : '';
        const table = departments.length ? `
            <div class="du-table-wrap">
                <table class="du-table">
                    <caption class="sr-only">部门 × 设备类型领用矩阵，点击格内数字查看入职/领用/更换明细</caption>
                    <thead>${head}</thead>
                    <tbody>${body}</tbody>
                    <tfoot><tr><th scope="row">合计</th>${foot}<td class="num du-total">${grand}</td></tr></tfoot>
                </table>
            </div>${legend}`
            : '<div class="du-empty">该口径下暂无领用记录</div>';

        const note = '口径：按流转发生次数统计，区间内每条「入职 / 领用 / 更换」记录计 1 次；同一资产区间内多次流转计多次；部门取流转记录中的使用部门。';
        $('deptUsageBody').innerHTML = `
            <div class="du-toolbar">${rangeBar}</div>
            ${kpis}
            <p class="usage-note">${note}</p>
            ${table}`;
        $('duFrom').value = from;
        $('duTo').value = to;
    }

    /** 二级：某部门 × 某类型的入职/领用/更换三卡明细 */
    function renderDeptTypeUsage(dept, type) {
        const { month_from: from, month_to: to } = DEPT_USAGE;
        const period = from === to ? duMonthLabel(from) : `${duMonthLabel(from)} ~ ${duMonthLabel(to)}`;
        $('deptUsageTitle').textContent = `${dept} · ${type}`;
        const list = (DEPT_USAGE.details || {})[`${dept}|${type}`] || [];
        const cards = TAG_METRIC.map(tag => {
            const items = list.filter(item => item.tag === tag);
            const rows = items.map(item => `
                <li class="du-item">
                    <button type="button" class="du-item-number" data-action="asset-detail" data-number="${escapeHtml(item.number)}"
                        title="查看 ${escapeHtml(item.number)} 的设备配置与流转情况">${escapeHtml(item.number)}</button>
                    <span class="du-item-name">${escapeHtml(item.name) || '-'}</span>
                    <span class="du-item-date">${escapeHtml(item.date) || '-'}</span>
                </li>`).join('');
            return `
                <section class="du-tagcard" aria-label="${escapeHtml(tag)} ${items.length} 条">
                    <header class="du-tagcard-head">
                        <span class="du-tagchip du-tag-${escapeHtml(tag)}">${escapeHtml(tag)}</span>
                        <strong class="du-tagcard-count">${items.length}</strong>
                    </header>
                    ${items.length ? `<ul class="du-list">${rows}</ul>` : '<p class="du-tagcard-empty">该标签下无记录</p>'}
                </section>`;
        }).join('');
        $('deptUsageBody').innerHTML = `
            <nav class="du-crumb" aria-label="面包屑">
                <button type="button" class="du-back" data-action="back-matrix">&larr; 部门领用总览</button>
                <span class="du-crumb-sep" aria-hidden="true">/</span>
                <span class="du-crumb-current">${escapeHtml(dept)} · ${escapeHtml(type)}</span>
                <span class="du-crumb-period">${escapeHtml(period)}</span>
            </nav>
            <div class="du-tagcards">${cards}</div>`;
    }

    /** 点击动作（由 dashboard_orders.js 的统一事件委托转发）。
     *  返回 true 表示已处理；未知动作返回 false 由调用方继续兜底。 */
    function handleAction(action, btn) {
        if (action === 'matrix-cell') {
            renderDeptTypeUsage(btn.dataset.dept, btn.dataset.type);
            return true;
        }
        if (action === 'back-matrix') { renderUsageMatrix(); return true; }
        if (action === 'du-preset') {
            const cur = currentYM();
            if (btn.dataset.preset === 'this') { DU_FROM = cur; DU_TO = cur; }
            else if (btn.dataset.preset === 'last') {
                // 以当前查看区间的末端为基准往前推一个月：连续点击可持续前翻
                // （9月→8月→7月…），而不是每次都基于真实当前月固定跳到同一个月
                const base = DU_TO || cur;
                DU_FROM = shiftYM(base, -1);
                DU_TO = DU_FROM;
            }
            else if (btn.dataset.preset === 'half') { DU_FROM = shiftYM(cur, -5); DU_TO = cur; }
            else { DU_FROM = `${cur.slice(0, 4)}-01`; DU_TO = `${cur.slice(0, 4)}-12`; }
            loadDeptUsageData();
            return true;
        }
        return false;
    }

    function bindRangeSelects() {
        // 月份区间 select 在弹窗内重建，用委托监听 change
        document.addEventListener('change', (e) => {
            if (e.target.id !== 'duFrom' && e.target.id !== 'duTo') return;
            DU_FROM = $('duFrom').value;
            DU_TO = $('duTo').value;
            if (DU_FROM > DU_TO) [DU_FROM, DU_TO] = [DU_TO, DU_FROM];
            loadDeptUsageData();
        });
    }

    /** 宿主注入依赖并完成事件绑定（幂等：只允许初始化一次）。 */
    function init(deps) {
        if ($) return;
        $ = deps.$;
        getJson = deps.getJson;
        escapeHtml = deps.escapeHtml;
        loadingHtml = deps.loadingHtml;
        showModal = deps.showModal;
        bindRangeSelects();
    }

    return { init, openDeptUsage, handleAction };
})();
