/* 轻量数据校验 / 清洗层（无 DOM、无依赖，ES5）。
   目的（需求 R4）：手工 MD、AI 结果、JSON 导入都可能带缺字段 / 错类型 / 坏题目，
   不能让单条坏数据或单本坏书拖垮整页。
   策略：
     · 结构致命错误（不是对象 / 无 title / modules 非对象）→ 该书 ok:false，由调用方丢弃；
     · 数组中单条异常 → 仅剔除该条并记录，保留其余条目（局部降级）；
     · 字符串字段 → 统一类型并按上限截断，记录 warning，绝不抛异常；
     · 不丢弃未知顶层字段，避免丢失 curriculum / sources / todo / fromAI 等。
   另提供 meetsFullStandard() 复现 §3.3 完整书门槛，供 AI 生成（R5）判定 skeleton。 */
(function () {
  /* ---- 上限：以现有四本书实测最大值的 5 倍以上为余量，正常书不会被截断 ---- */
  var LIM = {
    id: 64,
    short: 200,      // 书名、姓名、时间、回目、体裁等短字段
    text: 1000,      // 事件、观点、证据、参考答案、概述等长文本（实测最长 193）
    option: 100,     // 单选项文本
    item: 300,       // 读书方法、别名、来源、待核实等列表项
    arr: {
      aliases: 30, keywords: 10, events: 40,
      timeline: 300, characters: 80, analyses: 80, examPoints: 100,
      mastery: 8, quiz: 400, quotes: 200, chapters: 400, method: 40,
      bones: 8, points: 12
    }
  };

  var TIMELINE_TYPES = ['书中事件', '作者生平', '创作背景', '历史背景'];
  var EXAM_TYPES = ['识记匹配', '内容理解', '鉴赏探究', '开放感悟'];
  var MASTERY_LEVELS = ['识记', '理解', '应用', '评价'];

  function isStr(v) { return typeof v === 'string'; }
  function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
  function isObj(v) { return v !== null && typeof v === 'object' && !isArr(v); }

  function hash36(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = (((h << 5) + h) + str.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
  function slug(name) {
    var raw = String(name == null ? '' : name);
    var s = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (s) return s.slice(0, LIM.id);
    /* 中文等无可转写字符的书名：用稳定哈希兜底，保证同书名得到同 id */
    return 'book-' + hash36(raw);
  }
  function validId(s) { return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(s); }

  function Ctx() { this.warnings = []; this.errors = []; }
  Ctx.prototype.warn = function (msg) { this.warnings.push(msg); };
  Ctx.prototype.err = function (msg) { this.errors.push(msg); };

  /* 安全字符串：非字符串尽量转字符串（对象/数组→''），超长截断并记录 */
  function s(ctx, where, v, max) {
    if (v == null) return '';
    if (typeof v === 'string') {
      if (v.length > max) { ctx.warn(where + ' 超出 ' + max + ' 字，已截断'); return v.slice(0, max); }
      return v;
    }
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    ctx.warn(where + ' 类型非文本，已置空'); return '';
  }

  function arr(ctx, where, v, max) {
    if (!isArr(v)) { ctx.warn(where + ' 应为数组，已置空'); return []; }
    if (v.length > max) { ctx.warn(where + ' 超过 ' + max + ' 条，已截断多余项'); return v.slice(0, max); }
    return v;
  }

  /* 字符串数组（aliases / keywords / events / method / sources / todo） */
  function strList(ctx, where, v, max, itemMax) {
    var out = [];
    arr(ctx, where, v, max).forEach(function (x, i) {
      var t = s(ctx, where + '[' + i + ']', x, itemMax);
      if (t) out.push(t);
    });
    return out;
  }

  function cleanTimeline(ctx, list) {
    var out = [];
    arr(ctx, 'modules.timeline', list, LIM.arr.timeline).forEach(function (x, i) {
      if (!isObj(x)) { ctx.warn('timeline[' + i + '] 不是对象，已剔除'); return; }
      var time = s(ctx, 'timeline[' + i + '].time', x.time, LIM.short);
      var event = s(ctx, 'timeline[' + i + '].event', x.event, LIM.text);
      if (!time || !event) { ctx.warn('timeline[' + i + '] 缺 time/event，已剔除'); return; }
      var level = x.level === 2 ? 2 : 1;
      var type = TIMELINE_TYPES.indexOf(x.type) >= 0 ? x.type : '书中事件';
      out.push({ time: time, event: event, chapter: s(ctx, 'timeline[' + i + '].chapter', x.chapter, LIM.short), level: level, type: type });
    });
    return out;
  }

  function cleanCharacters(ctx, list) {
    var out = [];
    arr(ctx, 'modules.characters', list, LIM.arr.characters).forEach(function (x, i) {
      if (!isObj(x)) { ctx.warn('characters[' + i + '] 不是对象，已剔除'); return; }
      var name = s(ctx, 'characters[' + i + '].name', x.name, LIM.short);
      if (!name) { ctx.warn('characters[' + i + '] 缺 name，已剔除'); return; }
      var st = Number(x.stars);
      out.push({
        name: name,
        title: s(ctx, 'characters[' + i + '].title', x.title, LIM.short),
        stars: (st >= 1 && st <= 5) ? Math.round(st) : 0,
        keywords: strList(ctx, 'characters[' + i + '].keywords', x.keywords, LIM.arr.keywords, LIM.short),
        intro: s(ctx, 'characters[' + i + '].intro', x.intro, LIM.text),
        events: strList(ctx, 'characters[' + i + '].events', x.events, LIM.arr.events, LIM.text),
        quote: s(ctx, 'characters[' + i + '].quote', x.quote, LIM.text)
      });
    });
    return out;
  }

  function cleanFishbone(ctx, fb) {
    var d = { head: '', spine: '', bones: [] };
    if (!isObj(fb)) { ctx.warn('modules.fishbone 不是对象，已用空结构替代'); return d; }
    d.head = s(ctx, 'fishbone.head', fb.head, LIM.text);
    d.spine = s(ctx, 'fishbone.spine', fb.spine, LIM.text);
    var bones = [];
    arr(ctx, 'fishbone.bones', fb.bones, LIM.arr.bones).forEach(function (x, i) {
      if (!isObj(x)) { ctx.warn('fishbone.bones[' + i + '] 不是对象，已剔除'); return; }
      var name = s(ctx, 'bones[' + i + '].name', x.name, LIM.short);
      if (!name) { ctx.warn('fishbone.bones[' + i + '] 缺 name，已剔除'); return; }
      bones.push({
        name: name,
        desc: s(ctx, 'bones[' + i + '].desc', x.desc, LIM.text),
        chapter: s(ctx, 'bones[' + i + '].chapter', x.chapter, LIM.short)
      });
    });
    d.bones = bones;
    return d;
  }

  function cleanAnalyses(ctx, list) {
    var out = [];
    arr(ctx, 'modules.analyses', list, LIM.arr.analyses).forEach(function (x, i) {
      if (!isObj(x)) { ctx.warn('analyses[' + i + '] 不是对象，已剔除'); return; }
      var person = s(ctx, 'analyses[' + i + '].person', x.person, LIM.short);
      if (!person) { ctx.warn('analyses[' + i + '] 缺 person，已剔除'); return; }
      var points = [];
      arr(ctx, 'analyses[' + i + '].points', x.points, LIM.arr.points).forEach(function (p, j) {
        if (!isObj(p)) { ctx.warn('analyses[' + i + '].points[' + j + '] 不是对象，已剔除'); return; }
        var view = s(ctx, 'points[' + j + '].view', p.view, LIM.text);
        var evidence = s(ctx, 'points[' + j + '].evidence', p.evidence, LIM.text);
        var spirit = s(ctx, 'points[' + j + '].spirit', p.spirit, LIM.text);
        if (!view || !evidence || !spirit) { ctx.warn('analyses[' + i + '].points[' + j + '] 三段式不全，已剔除'); return; }
        points.push({ view: view, evidence: evidence, spirit: spirit });
      });
      if (!points.length) { ctx.warn('analyses[' + i + ']（' + person + '）无有效观点，已剔除'); return; }
      out.push({ person: person, points: points });
    });
    return out;
  }

  function cleanExam(ctx, list) {
    var out = [];
    arr(ctx, 'modules.examPoints', list, LIM.arr.examPoints).forEach(function (x, i) {
      if (!isObj(x)) { ctx.warn('examPoints[' + i + '] 不是对象，已剔除'); return; }
      var point = s(ctx, 'examPoints[' + i + '].point', x.point, LIM.text);
      if (!point) { ctx.warn('examPoints[' + i + '] 缺 point，已剔除'); return; }
      out.push({
        point: point,
        questionType: EXAM_TYPES.indexOf(x.questionType) >= 0 ? x.questionType : '内容理解',
        template: s(ctx, 'examPoints[' + i + '].template', x.template, LIM.text),
        scoring: s(ctx, 'examPoints[' + i + '].scoring', x.scoring, LIM.short)
      });
    });
    return out;
  }

  function cleanMastery(ctx, list) {
    var out = [];
    arr(ctx, 'modules.mastery', list, LIM.arr.mastery).forEach(function (x, i) {
      if (!isObj(x)) { ctx.warn('mastery[' + i + '] 不是对象，已剔除'); return; }
      if (MASTERY_LEVELS.indexOf(x.level) < 0) { ctx.warn('mastery[' + i + '].level 非法，已剔除'); return; }
      out.push({
        level: x.level,
        requirement: s(ctx, 'mastery[' + i + '].requirement', x.requirement, LIM.text),
        check: s(ctx, 'mastery[' + i + '].check', x.check, LIM.text)
      });
    });
    return out;
  }

  function cleanQuiz(ctx, list) {
    var out = [];
    arr(ctx, 'modules.quiz', list, LIM.arr.quiz).forEach(function (x, i) {
      if (!isObj(x)) { ctx.warn('quiz[' + i + '] 不是对象，已剔除'); return; }
      var q = s(ctx, 'quiz[' + i + '].question', x.question, LIM.text);
      if (!q) { ctx.warn('quiz[' + i + '] 缺 question，已剔除'); return; }
      if (x.type === '单选') {
        if (!isArr(x.options) || x.options.length !== 4) { ctx.warn('quiz[' + i + '] 单选 options 非 4 项，已剔除'); return; }
        var opts = x.options.map(function (o, k) { return s(ctx, 'quiz[' + i + '].options[' + k + ']', o, LIM.option); });
        if (opts.some(function (o) { return !o; })) { ctx.warn('quiz[' + i + '] 存在空选项，已剔除'); return; }
        var ans = x.answer;
        if (typeof ans !== 'number' || !isFinite(ans) || (ans | 0) !== ans || ans < 0 || ans > 3) {
          ctx.warn('quiz[' + i + '] answer 索引非法，已剔除'); return;
        }
        out.push({ type: '单选', question: q, options: opts, answer: ans, explain: s(ctx, 'quiz[' + i + '].explain', x.explain, LIM.text) });
      } else if (x.type === '简答') {
        var ref = s(ctx, 'quiz[' + i + '].reference', x.reference, LIM.text);
        if (!ref) { ctx.warn('quiz[' + i + '] 简答缺 reference，已剔除'); return; }
        out.push({ type: '简答', question: q, reference: ref, scoring: s(ctx, 'quiz[' + i + '].scoring', x.scoring, LIM.short) });
      } else {
        ctx.warn('quiz[' + i + '] type 非「单选/简答」，已剔除');
      }
    });
    return out;
  }

  function cleanQuotes(ctx, list) {
    var out = [];
    arr(ctx, 'modules.quotes', list, LIM.arr.quotes).forEach(function (x, i) {
      if (!isObj(x)) { ctx.warn('quotes[' + i + '] 不是对象，已剔除'); return; }
      var front = s(ctx, 'quotes[' + i + '].front', x.front, LIM.text);
      var back = s(ctx, 'quotes[' + i + '].back', x.back, LIM.text);
      if (!front || !back) { ctx.warn('quotes[' + i + '] 缺 front/back，已剔除'); return; }
      out.push({ front: front, back: back });
    });
    return out;
  }

  function cleanChapters(ctx, list) {
    var out = [];
    arr(ctx, 'modules.chapters', list, LIM.arr.chapters).forEach(function (x, i) {
      if (!isObj(x)) { ctx.warn('chapters[' + i + '] 不是对象，已剔除'); return; }
      var title = s(ctx, 'chapters[' + i + '].title', x.title, LIM.short);
      if (!title) { ctx.warn('chapters[' + i + '] 缺 title，已剔除'); return; }
      var no = (typeof x.no === 'number' || typeof x.no === 'string') ? x.no : '';
      out.push({ no: no, title: title, gist: s(ctx, 'chapters[' + i + '].gist', x.gist, LIM.text) });
    });
    return out;
  }

  /* 清洗单本书。返回 {ok, book?, errors, warnings}；不抛异常。 */
  function sanitizeBook(raw) {
    var ctx = new Ctx();
    if (!isObj(raw)) return { ok: false, book: null, errors: ['书目不是对象'], warnings: [] };

    var id = s(ctx, 'id', raw.id, LIM.id);
    var title = s(ctx, 'title', raw.title, LIM.short);
    if (!title) return { ok: false, book: null, errors: ['缺少 title'], warnings: ctx.warnings };
    if (!id || !validId(id)) {
      id = slug(title);
      if (!validId(id)) return { ok: false, book: null, errors: ['id 非法且无法由书名生成'], warnings: ctx.warnings };
      ctx.warn('id 非法，已由书名生成：' + id);
    }
    if (!isObj(raw.modules)) return { ok: false, book: null, errors: ['modules 不是对象（《' + title + '》）'], warnings: ctx.warnings };

    /* 以原对象为基拷贝，保留未知顶层字段；再规范化已知字段 */
    var b = {};
    for (var k in raw) b[k] = raw[k];

    b.id = id;
    b.title = title;
    b.aliases = strList(ctx, 'aliases', raw.aliases, LIM.arr.aliases, LIM.short);
    b.grade = s(ctx, 'grade', raw.grade, LIM.short);
    b.author = isObj(raw.author) ? {
      name: s(ctx, 'author.name', raw.author.name, LIM.short),
      country: s(ctx, 'author.country', raw.author.country, LIM.short),
      role: s(ctx, 'author.role', raw.author.role, LIM.short),
      bio: s(ctx, 'author.bio', raw.author.bio, LIM.text)
    } : { name: '', country: '', role: '', bio: '' };
    ['genre', 'era', 'place', 'background', 'pubInfo', 'status', 'curriculum'].forEach(function (f) {
      b[f] = s(ctx, f, raw[f], LIM.text);
    });
    b.skeleton = typeof raw.skeleton === 'boolean' ? raw.skeleton : false;
    if (typeof raw.skeleton !== 'boolean') ctx.warn('skeleton 非布尔，已置 false');

    b.modules = {
      timeline: cleanTimeline(ctx, raw.modules.timeline),
      characters: cleanCharacters(ctx, raw.modules.characters),
      fishbone: cleanFishbone(ctx, raw.modules.fishbone),
      analyses: cleanAnalyses(ctx, raw.modules.analyses),
      examPoints: cleanExam(ctx, raw.modules.examPoints),
      mastery: cleanMastery(ctx, raw.modules.mastery),
      quiz: cleanQuiz(ctx, raw.modules.quiz),
      quotes: cleanQuotes(ctx, raw.modules.quotes),
      chapters: cleanChapters(ctx, raw.modules.chapters),
      method: strList(ctx, 'modules.method', raw.modules.method, LIM.arr.method, LIM.item)
    };
    b.sources = strList(ctx, 'sources', raw.sources, 30, LIM.item);
    b.todo = strList(ctx, 'todo', raw.todo, 100, LIM.item);
    /* body 由 loader/generate 另行管理：字符串则保留，否则移除 */
    if (typeof raw.body === 'string') b.body = raw.body; else delete b.body;

    return { ok: true, book: b, errors: ctx.errors, warnings: ctx.warnings };
  }

  /* 清洗书库数组：坏书丢弃、坏条局部降级，聚合诊断。 */
  function validateBookList(list) {
    var books = [], errors = [], warnings = [], dropped = 0;
    if (!isArr(list)) return { books: [], errors: ['书库不是数组'], warnings: [], dropped: 0 };
    list.forEach(function (raw, i) {
      var r = sanitizeBook(raw);
      if (r.ok) {
        books.push(r.book);
        warnings = warnings.concat(r.warnings.map(function (w) { return '#' + i + ' ' + w; }));
      } else {
        dropped++;
        errors.push('丢弃第 ' + (i + 1) + ' 本书：' + r.errors.join('；'));
      }
    });
    return { books: books, errors: errors, warnings: warnings, dropped: dropped };
  }

  function nonEmpty(x) { return x && x.length > 0; }

  /* §3.3 完整书门槛。返回 {full, missing:[中文缺项]}，供 AI 判定 skeleton / 草稿。 */
  function meetsFullStandard(b) {
    var missing = [];
    var m = (b && b.modules) || {};
    if (!nonEmpty(m.timeline) || m.timeline.length < 12) missing.push('时间线至少 12 条（当前 ' + (m.timeline ? m.timeline.length : 0) + '）');
    if (!nonEmpty(m.characters) || m.characters.length < 6) missing.push('主要人物至少 6 位（当前 ' + (m.characters ? m.characters.length : 0) + '）');
    else if (m.characters.some(function (c) { return (c.events || []).length < 2; })) missing.push('每位人物至少 2 个事件');
    var bones = (m.fishbone && m.fishbone.bones) || [];
    if (bones.length < 3 || bones.length > 5) missing.push('鱼骨图应含 3—5 根刺（当前 ' + bones.length + '）');
    if (!nonEmpty(m.analyses) || m.analyses.length < 5) missing.push('人物分析至少 5 位（当前 ' + (m.analyses ? m.analyses.length : 0) + '）');
    if (!nonEmpty(m.examPoints) || m.examPoints.length < 6) missing.push('核心考点至少 6 条（当前 ' + (m.examPoints ? m.examPoints.length : 0) + '）');
    var lv = (m.mastery || []).map(function (x) { return x.level; }).sort().join(',');
    if (lv !== '应用,理解,评价,识记') missing.push('掌握度需含识记/理解/应用/评价四项');
    if (!nonEmpty(m.quiz) || m.quiz.length < 10) missing.push('检测题至少 10 道（当前 ' + (m.quiz ? m.quiz.length : 0) + '）');
    else {
      if (!m.quiz.some(function (q) { return q.type === '单选'; })) missing.push('检测题需含单选题');
      if (!m.quiz.some(function (q) { return q.type === '简答'; })) missing.push('检测题需含简答题');
    }
    if (!nonEmpty(m.quotes) || m.quotes.length < 4) missing.push('名句至少 4 条（当前 ' + (m.quotes ? m.quotes.length : 0) + '）');
    if (!nonEmpty(m.chapters)) missing.push('章节目录不能为空');
    if (!nonEmpty(m.method) || m.method.length < 3) missing.push('读书方法至少 3 条（当前 ' + (m.method ? m.method.length : 0) + '）');
    if (!nonEmpty(b.sources)) missing.push('资料来源至少 1 条');
    return { full: missing.length === 0, missing: missing };
  }

  window.HXWSCHEMA = {
    LIMITS: LIM,
    sanitizeBook: sanitizeBook,
    validateBookList: validateBookList,
    meetsFullStandard: meetsFullStandard,
    slug: slug,
    validId: validId
  };
})();
