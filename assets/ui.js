/* 共享 UI 助手：toast / 模态框 / DOM 构建（一律 textContent，防注入） */
(function () {
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  var toastTimer = null;
  function toast(msg, ms) {
    var t = document.getElementById('toast');
    if (!t) { t = el('div'); t.id = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, ms || 2600);
  }

  /* 模态框：openModal({title, body(HTMLElement), actions:[{label, primary, onClick}]})
     R8.6/8.7：语义化 dialog、Esc 取消、打开聚焦、关闭还焦、Tab 焦点不逃逸。 */
  var FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  var modalState = null;
  function openModal(opts) {
    closeModal();
    var prev = document.activeElement;
    var mask = el('div', 'modal-mask show');
    mask.setAttribute('role', 'dialog');
    mask.setAttribute('aria-modal', 'true');
    if (opts.title) mask.setAttribute('aria-label', opts.title);
    var box = el('div', 'modal');
    box.appendChild(el('h3', null, opts.title || ''));
    var body = el('div');
    if (typeof opts.body === 'string') body.textContent = opts.body;
    else if (opts.body) body.appendChild(opts.body);
    box.appendChild(body);
    var actions = el('div', 'actions');
    (opts.actions || []).forEach(function (a) {
      if (a.node) { actions.appendChild(a.node); return; }
      var b = el('button', 'btn' + (a.primary ? ' primary' : ''), a.label);
      b.onclick = function () { if (a.onClick) a.onClick(); if (a.close !== false) closeModal(); };
      actions.appendChild(b);
    });
    box.appendChild(actions);
    mask.appendChild(box);
    var onKey = function (e) {
      if (e.key === 'Escape' || e.key === 'Esc') { e.stopPropagation(); closeModal(); return; }
      if (e.key === 'Tab') {   // 焦点陷阱：Tab/Shift+Tab 在弹窗内循环
        var f = Array.prototype.slice.call(mask.querySelectorAll(FOCUSABLE)).filter(function (n) {
          return n.offsetWidth || n.offsetHeight || n === document.activeElement;
        });
        if (!f.length) { e.preventDefault(); return; }
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    modalState = { mask: mask, prev: prev, onKey: onKey };
    mask.addEventListener('click', function (e) { if (e.target === mask) closeModal(); });
    document.body.appendChild(mask);
    var f = mask.querySelector(FOCUSABLE);
    if (f) { try { f.focus(); } catch (e) {} }
    else { box.setAttribute('tabindex', '-1'); try { box.focus(); } catch (e2) {} }
    return box;
  }
  function closeModal() {
    if (modalState) {
      var st = modalState;
      modalState = null;
      document.removeEventListener('keydown', st.onKey, true);
      if (st.mask && st.mask.parentNode) st.mask.parentNode.removeChild(st.mask);
      if (st.prev && typeof st.prev.focus === 'function') { try { st.prev.focus(); } catch (e) {} }
      return;
    }
    var m = document.querySelector('.modal-mask');
    if (m) m.remove();
  }

  function starStr(n) {
    n = Math.max(0, Math.min(5, Number(n) || 0));
    var s = '';
    for (var i = 0; i < 5; i++) s += i < n ? '★' : '☆';
    return s;
  }
  function avatarText(name) {
    return String(name || '?').trim().charAt(0);
  }
  function fmtBookMeta(book) {
    return [book.grade, book.author && book.author.name, book.genre].filter(Boolean).join(' · ');
  }

  window.HXWUI = { el: el, clear: clear, toast: toast, openModal: openModal, closeModal: closeModal, starStr: starStr, avatarText: avatarText, fmtBookMeta: fmtBookMeta };
})();
