/* 数据层：内置书目 + 本地用户书目 + 学习状态。全部经 window.HXW 命名空间暴露。 */
(function () {
  var LS_USER_BOOKS = 'hxw_user_books';
  var LS_PROGRESS = 'hxw_progress';

  function storageOk() {
    try { var k = '__hxw_probe__'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return true; }
    catch (e) { return false; }
  }
  function readJSON(key, def) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : def; }
    catch (e) { return def; }   // 解析失败 / 存储不可用：安全降级到默认值，不崩页
  }
  // 返回是否写入成功；静默失败只告警不抛，保证阅读不中断（关键保存由调用方检查返回值）
  function writeJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) {
      try { console.warn('[名著] 本地存储写入失败：', e); } catch (ignore) {}
      return false;
    }
  }

  function bundled() { return (window.HXW_BOOKS || []).slice(); }

  /* R4：用户书目来自 localStorage（AI 保存 / JSON 导入），读取时清洗，坏书与坏条不进页面。
     schema.js 未加载时安全透传。 */
  function cleanOne(book) {
    var SC = window.HXWSCHEMA;
    if (!SC) return book;
    var r = SC.sanitizeBook(book);
    return r.ok ? r.book : null;
  }
  function userBooks() {
    var raw = readJSON(LS_USER_BOOKS, []);
    if (!Array.isArray(raw)) return [];
    var SC = window.HXWSCHEMA, out = [];
    if (!SC) return raw.slice();
    raw.forEach(function (b) {
      var r = SC.sanitizeBook(b);
      if (r.ok) out.push(r.book);
    });
    return out;
  }

  function allBooks() {
    var seen = {}, out = [];
    userBooks().forEach(function (b) { if (b && b.id && !seen[b.id]) { seen[b.id] = 1; out.push(b); } });
    bundled().forEach(function (b) { if (b && b.id && !seen[b.id]) { seen[b.id] = 1; out.push(b); } });
    return out;
  }

  function getBook(id) {
    var list = allBooks();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function normalize(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, '');
  }

  function searchIndex(book) {
    var parts = [book.title].concat(book.aliases || [])
      .concat([book.author && book.author.name])
      .concat([book.genre, book.grade])
      .concat((book.modules && book.modules.characters || []).map(function (c) { return c.name; }))
      .concat((book.modules && book.modules.characters || []).reduce(function (acc, c) {
        return acc.concat(c.keywords || []);
      }, []));
    return normalize(parts.join(' '));
  }

  function search(q) {
    var all = allBooks();
    q = normalize(q);
    if (!q) return all.slice();   // R9.1 空搜索恢复完整书库列表
    var scored = [];
    all.forEach(function (b, i) {
      var idx = searchIndex(b);
      var score = 0;
      if (normalize(b.title).indexOf(q) === 0) score += 100;
      else if (normalize(b.title).indexOf(q) > -1) score += 60;
      (b.aliases || []).forEach(function (a) {
        if (normalize(a).indexOf(q) > -1) score += 40;
      });
      if (normalize(b.author && b.author.name).indexOf(q) > -1) score += 30;
      if (idx.indexOf(q) > -1) score += 15;
      if (score > 0) scored.push({ book: b, score: score, i: i });
    });
    // R9.3 稳定排序：分数降序；同分保留 allBooks 中的确定性原序，刷新不跳动
    scored.sort(function (a, b) { return (b.score - a.score) || (a.i - b.i); });
    return scored.map(function (s) { return s.book; });
  }

  /* ---------- 学习状态 ---------- */
  function defaultProgress() {
    return { checks: [], checksMap: {}, wrong: [], quizBest: 0, quizCount: 0, lastVisit: '', lastModule: 'basic' };
  }
  function progress(id) {
    var all = readJSON(LS_PROGRESS, {});
    if (!all[id] || typeof all[id] !== 'object') all[id] = defaultProgress();
    var p = all[id];
    // 兼容旧记录：补齐缺失字段，纠正错误类型
    if (!Array.isArray(p.checks)) p.checks = [];
    if (!p.checksMap || typeof p.checksMap !== 'object') p.checksMap = {};
    if (!Array.isArray(p.wrong)) p.wrong = [];
    else {
      // 迁移旧版错题（无 qid）：依据 type+question 补稳定标识，并补齐复习/答案字段（仅内存规整）
      p.wrong = p.wrong.map(function (w) {
        if (w && typeof w === 'object') {
          if (!w.qid) w.qid = (w.type || '') + '|' + (w.question || '');
          if (!('reviewed' in w)) w.reviewed = false;
          if (!('correct' in w)) w.correct = null;
          return w;
        }
        return null;
      }).filter(Boolean);
    }
    if (typeof p.quizBest !== 'number' || p.quizBest < 0) p.quizBest = 0;
    if (typeof p.quizCount !== 'number' || p.quizCount < 0) p.quizCount = 0;
    if (typeof p.lastModule !== 'string' || !p.lastModule) p.lastModule = 'basic';
    if (typeof p.lastVisit !== 'string') p.lastVisit = '';
    return p;
  }
  function saveProgress(id, p) {
    var all = readJSON(LS_PROGRESS, {});
    all[id] = p;
    return writeJSON(LS_PROGRESS, all);
  }
  // 掌握度稳定键：四层级固定且唯一；即便书目内顺序调整也不错位（R6.1）
  function masteryKey(m, i) {
    var lv = m && m.level ? String(m.level) : '';
    return lv || ('idx-' + i);
  }
  // 读取勾选：优先稳定键映射，回退旧版按索引数组（兼容历史进度）
  function masteryCheck(p, m, i) {
    var key = masteryKey(m, i);
    if (p && p.checksMap && Object.prototype.hasOwnProperty.call(p.checksMap, key)) return !!p.checksMap[key];
    return !!(p && p.checks || [])[i];
  }
  function setMasteryCheck(p, m, i, val) {
    var key = masteryKey(m, i);
    p.checksMap = (p.checksMap && typeof p.checksMap === 'object') ? p.checksMap : {};
    p.checksMap[key] = !!val;
    p.checks = Array.isArray(p.checks) ? p.checks : []; // 同步旧结构，保持向后兼容
    p.checks[i] = !!val;
  }
  function masteryPercent(book, p) {
    var items = (book.modules && book.modules.mastery) || [];
    var total = items.length;
    if (!total) return 0;                       // 无掌握度数据：安全值，不除以零（R6.2）
    var done = 0;
    for (var i = 0; i < total; i++) { if (masteryCheck(p, items[i], i)) done++; }
    return Math.min(100, Math.round(done / total * 100));
  }
  function touchVisit(id, module) {
    var p = progress(id);
    p.lastVisit = new Date().toISOString().slice(0, 10);
    if (module) p.lastModule = module;
    saveProgress(id, p);
  }

  /* ---------- 用户书目 ---------- */
  function saveUserBook(book) {
    var clean = cleanOne(book);
    if (!clean) throw new Error('书目数据未通过结构校验，未保存');
    clean.fromAI = true;
    var list = userBooks().filter(function (b) { return b.id !== clean.id; });
    list.push(clean);
    writeJSON(LS_USER_BOOKS, list);
    return clean;
  }
  function deleteUserBook(id) {
    var remain = userBooks().filter(function (b) { return b.id !== id; });
    var ok1 = writeJSON(LS_USER_BOOKS, remain);
    // 级联清理该书学习进度（含错题），避免残留无法管理的数据 / 死链（R7.5、R6.6）
    var all = readJSON(LS_PROGRESS, {});
    var had = Object.prototype.hasOwnProperty.call(all, id);
    if (had) { delete all[id]; var ok2 = writeJSON(LS_PROGRESS, all); return ok1 && ok2; }
    return ok1;
  }

  /* ---------- 备份 / 导入 ---------- */
  var EXPORT_VERSION = 2;
  function exportAll() {
    return JSON.stringify({
      app: '名著学习工作台',
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      books: userBooks(),
      progress: readJSON(LS_PROGRESS, {})
    }, null, 2);
  }

  function builtInIds() {
    var ids = {};
    bundled().forEach(function (b) { if (b && b.id) ids[b.id] = 1; });
    return ids;
  }

  /* 原子导入（R7.2/7.3）。
     mode='skip'（默认）：与内置或现有用户书同 id 一律跳过，绝不覆盖；
     mode='overwrite'：仅覆盖同 id 的用户书，内置书永远保留、不可覆盖。
     先做完全量解析与校验，再一次性提交；任何失败都回滚，不留半导入状态。
     返回 { imported:n, skipped:[{id,reason}] }。 */
  function importAll(jsonText, mode) {
    mode = mode === 'overwrite' ? 'overwrite' : 'skip';
    var data;
    try { data = JSON.parse(jsonText); }
    catch (e) { throw new Error('文件不是合法 JSON，未导入任何数据'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('文件格式不正确：根节点应为对象');
    if (!Array.isArray(data.books)) throw new Error('文件格式不正确：缺少 books 数组');
    if (data.progress !== undefined && (typeof data.progress !== 'object' || Array.isArray(data.progress) || data.progress === null)) {
      throw new Error('文件格式不正确：progress 应为对象');
    }

    // 1) 全量校验：每本书都必须通过结构校验，否则整体放弃
    var SC = window.HXWSCHEMA;
    var incoming = [];
    for (var i = 0; i < data.books.length; i++) {
      var raw = data.books[i];
      if (SC) {
        var r = SC.sanitizeBook(raw);
        if (!r.ok) throw new Error('第 ' + (i + 1) + ' 本书校验未通过：' + r.errors.join('；') + '（已取消导入，未改动现有数据）');
        incoming.push(r.book);
      } else {
        if (!raw || typeof raw !== 'object' || !raw.id || !raw.title) {
          throw new Error('第 ' + (i + 1) + ' 本书缺少 id/title（已取消导入）');
        }
        incoming.push(raw);
      }
    }

    // 2) 计算冲突与最终结果（仅内存，先不写入）
    var builtin = builtInIds();
    var existing = userBooks();
    var exMap = {};
    existing.forEach(function (b) { exMap[b.id] = b; });

    var merged = existing.slice();
    var mergedIndex = {};
    merged.forEach(function (b, idx) { mergedIndex[b.id] = idx; });
    var skipped = [];
    var importedIds = {};
    incoming.forEach(function (b) {
      if (builtin[b.id]) { skipped.push({ id: b.id, reason: '内置书目不可覆盖' }); return; }
      if (Object.prototype.hasOwnProperty.call(mergedIndex, b.id)) {
        if (mode === 'overwrite') { merged[mergedIndex[b.id]] = b; importedIds[b.id] = 1; }
        else skipped.push({ id: b.id, reason: '已存在同 ID 书目' });
      } else {
        mergedIndex[b.id] = merged.length;
        merged.push(b);
        importedIds[b.id] = 1;
      }
    });

    // 3) 学习状态：当前为底，叠加导入；不恢复被跳过用户书的进度（内置书进度允许恢复）
    var finalProgress = readJSON(LS_PROGRESS, {});
    if (data.progress && typeof data.progress === 'object') {
      Object.keys(data.progress).forEach(function (pid) {
        if (importedIds[pid] || builtin[pid] || mode === 'overwrite') finalProgress[pid] = data.progress[pid];
      });
    }

    // 4) 一次性提交 + 失败回滚（尽量原子）
    var oldBooks = readJSON(LS_USER_BOOKS, []);
    var oldProgress = readJSON(LS_PROGRESS, {});
    var okB = writeJSON(LS_USER_BOOKS, merged);
    if (!okB) { throw new Error('本地存储写入失败（可能已满或不可用），未改动现有数据'); }
    var okP = writeJSON(LS_PROGRESS, finalProgress);
    if (!okP) {
      writeJSON(LS_USER_BOOKS, oldBooks); // 回滚书目
      throw new Error('学习状态写入失败，已回滚，未改动现有数据');
    }
    return { imported: Object.keys(importedIds).length, skipped: skipped };
  }

  function clearLocal() {
    try {
      localStorage.removeItem(LS_USER_BOOKS);
      localStorage.removeItem(LS_PROGRESS);
      return true;
    } catch (e) { return false; }
  }

  function init() {
    if (window.HXWLoader) return window.HXWLoader.init();
    return Promise.resolve(allBooks());
  }
  function ready(cb) {
    if (window.HXW_BOOKS && window.HXW_BOOKS.length) { cb(); return; }
    document.addEventListener('hxw:ready', function () { cb(); }, { once: true });
  }

  window.HXW = {
    allBooks: allBooks,
    getBook: getBook,
    search: search,
    progress: progress,
    saveProgress: saveProgress,
    masteryPercent: masteryPercent,
    masteryCheck: masteryCheck,
    setMasteryCheck: setMasteryCheck,
    masteryKey: masteryKey,
    touchVisit: touchVisit,
    saveUserBook: saveUserBook,
    deleteUserBook: deleteUserBook,
    isBuiltin: function (id) { return !!builtInIds()[id]; },
    exportAll: exportAll,
    importAll: importAll,
    clearLocal: clearLocal,
    storageOk: storageOk,
    init: init,
    ready: ready,
    source: function () { return window.HXW_SOURCE || 'empty'; },
    _test: { readJSON: readJSON, writeJSON: writeJSON, defaultProgress: defaultProgress, builtInIds: builtInIds, EXPORT_VERSION: EXPORT_VERSION }
  };
})();
