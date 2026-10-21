/* 书籍加载层：优先 http 拉取 books/manifest.json + books/<id>.md（实时解析本地 markdown），
   失败（如 file:// 双击打开）则回退到 assets/books.bundle.js。
   解析统一产出与旧 JSON 同构的 book 对象（含 book.modules.* 与 book.body）。 */
(function () {
  window.HXW_BOOKS = window.HXW_BOOKS || [];
  window.HXW_SOURCE = 'empty'; // http | bundle | empty

  var FM_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

  function parseMd(txt) {
    var m = FM_RE.exec(txt);
    if (!m) return null;
    var fm;
    try { fm = JSON.parse(m[1]); } catch (e) { return null; }
    fm.body = (m[2] || '').trim();
    return fm;
  }

  function loadFromHttp() {
    return fetch('books/manifest.json', { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('manifest ' + r.status); return r.json(); })
      .then(function (man) {
        var files = (man.books || []).map(function (b) { return b.file || ('books/' + b.id + '.md'); });
        return Promise.all(files.map(function (f) {
          return fetch(f, { cache: 'no-cache' })
            .then(function (r) { if (!r.ok) throw new Error(f + ' ' + r.status); return r.text(); })
            .then(parseMd)
            .catch(function () { return null; });
        }));
      })
      .then(function (list) { return list.filter(Boolean); });
  }

  function ensureBundle() {
    if (window.HXW_BOOKS_BUNDLE) return Promise.resolve();
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = 'assets/books.bundle.js';
      s.onload = function () { resolve(); };
      s.onerror = function () { resolve(); };
      document.head.appendChild(s);
    });
  }

  function loadFromBundle() {
    return ensureBundle().then(function () {
      return (window.HXW_BOOKS_BUNDLE || []).map(function (b) {
        var x = {}; for (var k in b) x[k] = b[k];
        x.body = (x.body || '').trim();
        return x;
      });
    });
  }

  var _ready = null;

  /* R4：对解析出的书库统一做 schema 清洗——坏书丢弃、坏条局部降级。
     schema.js 因故未加载时安全透传，绝不让校验层缺失导致白屏。 */
  function sanitize(list) {
    var SC = window.HXWSCHEMA;
    if (!SC) return list || [];
    var r = SC.validateBookList(list || []);
    if (r.dropped || (r.errors && r.errors.length) || (r.warnings && r.warnings.length)) {
      window.HXW_DATA_DIAG = { dropped: r.dropped, errors: r.errors, warnings: r.warnings };
      try { console.warn('[名著] 数据校验：', r); } catch (e) {}
    }
    return r.books;
  }

  function init() {
    if (_ready) return _ready;
    _ready = (async function () {
      var books = null;
      try { books = await loadFromHttp(); } catch (e) { books = null; }
      if (books && books.length) {
        window.HXW_SOURCE = 'http';
        books = sanitize(books);
      } else {
        try {
          books = sanitize(await loadFromBundle());
          window.HXW_SOURCE = books.length ? 'bundle' : 'empty';
        } catch (e) { books = []; window.HXW_SOURCE = 'empty'; }
      }
      window.HXW_BOOKS = books || [];
      document.dispatchEvent(new Event('hxw:ready'));
      return window.HXW_BOOKS;
    })();
    return _ready;
  }

  window.HXWLoader = { init: init, parseMd: parseMd };
})();
