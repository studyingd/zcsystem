/**
 * 公共弹窗组件：Esc 关闭 / 点击遮罩关闭 / 焦点陷阱 / 焦点归还 / aria 标注 / 开关动效。
 *
 * 兼容两种既有实现（index.html 的 .custom-modal 与登记页的 .modal-overlay）：
 * 可见性统一用内联 display:flex / none 切换，因此页面原有的显隐代码无需改动。
 *
 * 用法：
 *   initModal(el, { onClose, closeOnBackdrop, closeOnEsc })   页面加载时注册一次
 *   openModal(el) / closeModal(el)
 *
 * closeOnBackdrop / closeOnEsc 默认 true（对话框惯例）；需要「只能点关闭按钮」
 * 的弹窗传 false，例如资产登记页的详情弹窗。
 */

const FOCUSABLE_SELECTOR = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])',
    'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(', ');

// 已注册的弹窗 -> { onClose, lastFocused, keyHandler }
const _modalRegistry = new WeakMap();

function _focusableIn(modal) {
    return Array.from(modal.querySelectorAll(FOCUSABLE_SELECTOR))
        .filter(el => el.offsetParent !== null || el === document.activeElement);
}

function _trapFocus(modal, event) {
    const items = _focusableIn(modal);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

function initModal(modal, options = {}) {
    if (!modal || _modalRegistry.has(modal)) return;

    const state = {
        onClose: options.onClose || null,
        closeOnBackdrop: options.closeOnBackdrop !== false,
        closeOnEsc: options.closeOnEsc !== false,
        lastFocused: null,
    };

    // 无障碍标注：role=dialog 由模板给出，这里补齐运行时属性
    modal.setAttribute('aria-hidden', 'true');
    if (!modal.getAttribute('aria-labelledby') && !modal.getAttribute('aria-label')) {
        const title = modal.querySelector('.modal-header-title, .modal-header h3, h3');
        if (title) {
            if (!title.id) title.id = `${modal.id}-title`;
            modal.setAttribute('aria-labelledby', title.id);
        }
    }

    state.keyHandler = (event) => {
        // 弹窗隐藏时焦点不可能落在内部，这里再兜一层，避免误关闭
        if (modal.style.display !== 'flex') return;
        if (event.key === 'Escape') {
            if (!state.closeOnEsc) return;
            event.stopPropagation();
            closeModal(modal);
        } else if (event.key === 'Tab') {
            _trapFocus(modal, event);
        }
    };
    modal.addEventListener('keydown', state.keyHandler);

    // 点击遮罩（而不是内容区）关闭；可用 closeOnBackdrop:false 禁用
    modal.addEventListener('mousedown', (event) => {
        if (event.target === modal && state.closeOnBackdrop) closeModal(modal);
    });

    // 关闭按钮：约定 class 以 modal-close 开头
    modal.querySelectorAll('.modal-close, .modal-close-btn, [data-modal-close]')
        .forEach(btn => btn.addEventListener('click', () => closeModal(modal)));

    _modalRegistry.set(modal, state);
}

function openModal(modal) {
    if (!modal) return;
    if (!_modalRegistry.has(modal)) initModal(modal);
    const state = _modalRegistry.get(modal);

    state.lastFocused = document.activeElement;
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    // 动效：display 切换后加类，触发一次入场动画
    modal.classList.remove('modal-open');
    void modal.offsetWidth;
    modal.classList.add('modal-open');

    const items = _focusableIn(modal);
    (items[0] || modal).focus();
    document.body.classList.add('modal-lock');
}

function closeModal(modal) {
    if (!modal) return;
    const state = _modalRegistry.get(modal);
    if (modal.style.display === 'none') return;

    modal.style.display = 'none';
    modal.classList.remove('modal-open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-lock');

    if (state && state.lastFocused && document.contains(state.lastFocused)) {
        state.lastFocused.focus();
    }
    if (state && typeof state.onClose === 'function') state.onClose();
}

/** 绑定页面内所有弹窗（data-modal 或已知 class），返回元素列表。 */
function initModals(root = document) {
    const modals = Array.from(root.querySelectorAll('.modal-overlay, .custom-modal, [data-modal]'));
    modals.forEach(modal => initModal(modal));
    return modals;
}
