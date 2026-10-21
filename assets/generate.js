/* AI 生成新书：云服务 LLM → 结构化 JSON → 校验 → 预览 → 保存到本地 markdown
   保存策略（满足「点击保存，可保存在本地」）：
     1) 优先 File System Access API：写入 books/<id>.md 并刷新 manifest（需通过 localhost 打开以获安全上下文）
     2) 不支持时触发下载 .md 文件（手动放入 books/ 即可）
     3) 始终写入浏览器 localStorage 缓存，确保立即可用 */
(function () {
  /* SDK 仅使用本地内置副本（架构红线：禁 CDN、SDK 本地内置）。
     · 自包含构建产物已把 vendor SDK 内联，window.WorkBuddyCloud 直接就绪，本列表不会被执行；
     · 外部 assets 形态也只加载本地 vendor，本地缺失即报错并引导本地服务/手动录入，绝不外联公共 CDN。 */
  var SDK_SOURCES = [
    { url: 'assets/vendor/workbuddy-cloud-sdk.js', label: '本地内置' }
  ];
  var cloudPromise = null;
  var lastGenAt = 0;

  function status(set, msg) { if (set) set(msg); }

  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url;
      s.async = true;
      var done = false;
      var ok = function () { if (!done) { done = true; window.WorkBuddyCloud ? resolve() : reject(new Error('加载后未暴露 WorkBuddyCloud')); } };
      var bad = function () { if (!done) { done = true; reject(new Error('无法加载 ' + url)); } };
      s.onload = ok;
      s.onerror = bad;
      document.head.appendChild(s);
      // 兜底超时：某些环境 script 事件不触发
      setTimeout(function () {
        if (window.WorkBuddyCloud) ok(); else bad();
      }, 9000);
    });
  }

  function ensureSDK(set) {
    if (window.WorkBuddyCloud) return Promise.resolve();
    var i = 0;
    function next() {
      if (i >= SDK_SOURCES.length) {
        return Promise.reject(new Error(
          '本地内置云服务 SDK 未加载成功（本项目不使用公共 CDN）。请用本地服务打开：' +
          'cd 应用目录 && python3 -m http.server 8000，再访问 http://localhost:8000/；' +
          '离线时仍可用「手动录入 JSON」。'
        ));
      }
      var src = SDK_SOURCES[i++];
      status(set, '正在加载云服务 SDK（' + src.label + '）…');
      return loadScript(src.url).catch(function () {
        if (window.WorkBuddyCloud) return undefined;
        return next();
      });
    }
    return next();
  }

  /* ---------- DeepSeek 直连模式（公网静态部署形态） ----------
     公网仓库不能内置任何服务端密钥：用户把自己的 DeepSeek API Key 粘贴进页面，
     仅存本浏览器 localStorage，由浏览器直接调用 api.deepseek.com（已实测 CORS 放行）。
     本地/代理形态（config.js 配了 endpoint+publishableKey）仍走原 WorkBuddy 云服务。 */
  var DS_KEY_STORE = 'hxw_deepseek_key';
  var DS_ENDPOINT = 'https://api.deepseek.com';
  function getDsKey() {
    try { return (localStorage.getItem(DS_KEY_STORE) || '').trim(); } catch (e) { return ''; }
  }
  function setDsKey(k) {
    try { k ? localStorage.setItem(DS_KEY_STORE, k) : localStorage.removeItem(DS_KEY_STORE); } catch (e) {}
  }
  function proxyConfigured() {
    var cfg = window.HXW_PUBLIC_CONFIG || {};
    return !!(cfg.endpoint && cfg.publishableKey);
  }
  // DeepSeek 官方模型（直连模式无列表接口，用静态清单；默认 chat：快且稳，reasoner 为深度推理）
  var DS_MODELS = [
    { id: 'deepseek-chat', name: 'DeepSeek Chat · 快' },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner · 慢（深度推理）' }
  ];

  // 直连 DeepSeek：fetch + SSE 流式，输出与 SDK 一致的 OpenAI 风格 chunk（供 streamBook 复用）
  function dsCreate(req) {
    var headers = { 'Content-Type': 'application/json' };
    var key = getDsKey();
    if (key) headers['Authorization'] = 'Bearer ' + key;
    var body = { model: req.model, messages: req.messages, stream: true, temperature: req.temperature };
    // reasoner 不支持 json_object 响应格式，仅对非推理模型下发
    if (req.response_format && !/reasoner/i.test(req.model)) body.response_format = req.response_format;
    var f = (typeof fetch === 'function') ? fetch : (globalThis.fetch && globalThis.fetch.bind(globalThis));
    if (!f) return Promise.reject(new Error('当前环境不支持 fetch，无法调用 DeepSeek'));
    return f(DS_ENDPOINT + '/chat/completions', {
      method: 'POST', headers: headers, body: JSON.stringify(body)
    }).then(function (resp) {
      if (!resp.ok) {
        return resp.text().then(function (t) {
          var msg = 'DeepSeek 接口错误 ' + resp.status;
          try { var j = JSON.parse(t); if (j && j.error && j.error.message) msg += '：' + j.error.message; } catch (e) { if (t) msg += '：' + String(t).slice(0, 200); }
          if (resp.status === 401) msg += '（Key 无效或未填写，请检查）';
          throw new Error(msg);
        });
      }
      var reader = resp.body.getReader();
      var dec = new TextDecoder();
      var buf = '';
      var queue = [];   // 已解析、待消费的 chunk：一次 read 可能含多行，须跨 next() 调用保留
      var iterable = {};
      iterable[Symbol.asyncIterator] = function () {
        return {
          next: function () {
            if (queue.length) return Promise.resolve({ done: false, value: queue.shift() });
            function pump() {
              return reader.read().then(function (r) {
                if (r.done) {
                  return queue.length ? { done: false, value: queue.shift() } : { done: true, value: undefined };
                }
                buf += dec.decode(r.value, { stream: true });
                var lines = buf.split('\n');
                buf = lines.pop();
                for (var i = 0; i < lines.length; i++) {
                  var s = lines[i].trim();
                  if (s.indexOf('data:') !== 0) continue;
                  var d = s.slice(5).trim();
                  if (!d || d === '[DONE]') continue;
                  try {
                    var j = JSON.parse(d);
                    var delta = j.choices && j.choices[0] && j.choices[0].delta;
                    if (delta && delta.content) queue.push({ choices: [{ delta: { content: delta.content } }] });
                  } catch (e) { /* 半行或心跳，跳过 */ }
                }
                return queue.length ? { done: false, value: queue.shift() } : pump();
              });
            }
            return pump();
          }
        };
      };
      return iterable;
    });
  }

  function createDirectCloud() {
    return {
      direct: true,
      llm: {
        models: { list: function () { return Promise.resolve(DS_MODELS.slice()); } },
        chat: { completions: { create: function (req) { return dsCreate(req); } } }
      }
    };
  }

  function getCloud(set) {
    if (cloudPromise) return cloudPromise;
    // 直连模式优先：用户粘贴了自己的 DeepSeek Key 就走浏览器直连（公网部署形态）
    if (getDsKey()) {
      cloudPromise = Promise.resolve(createDirectCloud());
      return cloudPromise;
    }
    var cfg0 = window.HXW_PUBLIC_CONFIG || {};
    if (!cfg0.endpoint || !cfg0.publishableKey) {
      return Promise.reject(new Error('未配置 AI 服务：请先粘贴 DeepSeek API Key（弹窗内填写，仅存本浏览器）'));
    }
    cloudPromise = ensureSDK(set).then(function () {
      var cfg = window.HXW_PUBLIC_CONFIG || {};
      if (!cfg.endpoint || !cfg.publishableKey) {
        throw new Error('未配置云服务公共参数，AI 生成不可用；请使用手动录入');
      }
      return window.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: cfg.endpoint,
        publishableKey: cfg.publishableKey
      });
    }).catch(function (e) { cloudPromise = null; throw e; });
    return cloudPromise;
  }

  function pickModel(cloud, set, preferId) {
    status(set, '正在获取可用模型…');
    return cloud.llm.models.list().then(function (models) {
      var m = chooseModel(models || [], preferId);
      if (!m) throw new Error('当前没有可用的模型');
      status(set, '使用模型：' + (m.name || m.id));
      return m;
    });
  }

  // 用户在生成弹窗里选择的模型（仅存本地，不随书目导出）
  var MODEL_PREF_KEY = 'hxw_gen_model';
  function getModelPref() {
    try { return localStorage.getItem(MODEL_PREF_KEY) || ''; } catch (e) { return ''; }
  }
  function setModelPref(id) {
    try { id ? localStorage.setItem(MODEL_PREF_KEY, id) : localStorage.removeItem(MODEL_PREF_KEY); } catch (e) {}
  }
  // 文本任务默认优先的 DeepSeek 模型顺序。
  // 实测：一本完整书 JSON 很大，pro 为深度推理模型、单次要 60s+，超长流式连接在浏览器里
  // 易被网关/网络中途重置（表现为 network error）；flash 约 10s 完成且稳定，故默认 flash 优先，
  // pro 保留供在下拉中手动选择（质量优先、耗时较长）。都不可用再回退任意 deepseek* / 其他文本模型。
  var DEEPSEEK_PREF = ['deepseek-v4-flash', 'deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-v3-2-volc'];
  // 纯选择逻辑（便于离线测试）：
  //  1) 用户显式选择且仍可用 → 用它；
  //  2) 否则按 DEEPSEEK_PREF 选 DeepSeek，再退而求其次选任意可用 deepseek*；
  //  3) 再否则取首个可用文本模型；无可用模型返回 null（由调用方报错，保持原行为）。
  function chooseModel(models, preferId) {
    var usable = models.filter(function (x) {
      return x && x.id && x.disabled !== true && !/image/i.test(x.id);
    });
    if (!usable.length) return null;
    var byId = {};
    usable.forEach(function (x) { byId[x.id] = x; });
    if (preferId && byId[preferId]) return byId[preferId];
    for (var i = 0; i < DEEPSEEK_PREF.length; i++) {
      if (byId[DEEPSEEK_PREF[i]]) return byId[DEEPSEEK_PREF[i]];
    }
    var anyDs = usable.filter(function (x) { return /deepseek/i.test(x.id); })[0];
    return anyDs || usable[0];
  }

  var SYSTEM_PROMPT = [
    '你是初中语文名著备考资料整理专家，熟悉统编版初中语文教材与中考名著阅读考查。',
    '纪律：只依据可靠的公开资料与教材通行说法整理；凡不能确认的内容（具体回目、引文、年份），',
    '一律放入 todo 字段并标注【待核实】，严禁编造。输出为且仅为一个 JSON 对象，不要输出多余文字。'
  ].join('');

  function buildUserPrompt(name, hint) {
    return [
      '请为《' + name + '》' + (hint ? '（补充信息：' + hint + '）' : '') + '整理结构化名著学习资料。',
      '严格按下列 JSON 结构输出，所有数组元素数量按下限要求，内容面向初中生备考：',
      JSON.stringify({
        id: '英文slug（小写连字符）',
        title: '书名',
        aliases: ['又名/译名，至少1个，没有就给空数组'],
        grade: '七上/七下/八上/八下/九上/九下/自主阅读',
        author: { name: '作者', country: '国别', role: '身份', bio: '一句话生平' },
        genre: '体裁题材',
        era: '创作/故事时代',
        place: '地点',
        background: '创作背景2-3句',
        pubInfo: '出版信息',
        status: '文学地位一句话',
        curriculum: '教材位置（统编版册次单元）',
        modules: {
          timeline: '12条以上，每条{time,event,chapter(回目或篇，无则"—"),level(1或2),type("书中事件"/"作者生平"/"创作背景"/"历史背景")}',
          characters: '6位以上，每位{name,title(职位/身份，无则""),stars(1-5重要度),keywords[3个],intro(一句话),events[2个以上书中具体事件],quote(书中原句，无则"")}',
          fishbone: '{head(核心问题),spine(明线描述),bones[3-5条{name,desc,chapter}]}',
          analyses: '5位以上人物，每位{person,points[{view(观点),evidence(书中具体事例),spirit(精神概括)}]}',
          examPoints: '6条以上{point,questionType("识记匹配"/"内容理解"/"鉴赏探究"/"开放感悟"),template(答题模板),scoring(采分点)}',
          mastery: '固定4条{level("识记"/"理解"/"应用"/"评价"),requirement,check}',
          quiz: '10题以上，单选{type:"单选",question,options[4],answer(0-3索引),explain}与简答{type:"简答",question,reference(参考答案),scoring}混合',
          quotes: '4条以上{front(提示),back(原文+出处)}',
          chapters: '章节目录[{no,title,gist}]，散文集等给篇目',
          method: '3条以上读书方法'
        },
        sources: ['资料出处'],
        todo: ['待核实项']
      }, null, 0).replace(/\n/g, ''),
      '注意：id 用拼音或英文，例如 "shuihuzhuan"；引文必须逐字准确，不能确认就不要给 quote。'
    ].join('\n');
  }

  function extractJSON(text) {
    var t = String(text || '').trim();
    t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    var start = t.indexOf('{'), end = t.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('模型输出中未找到 JSON');
    return JSON.parse(t.slice(start, end + 1));
  }

  // 校验并规范化 AI / 手动录入结果（R5）。
  // 返回 {book, full, missing}：结构致命错误直接 throw（调用方提示，且不进入预览、不保存）；
  // 默认按草稿处理 skeleton:true，仅当满足 §3.3 才置 false，绝不伪装成完整书。
  function validate(raw, name) {
    var SC = window.HXWSCHEMA;
    if (!SC) throw new Error('数据校验模块未就绪，请刷新后重试');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('内容不是 JSON 对象');
    if (!raw.title) raw.title = name;

    var r = SC.sanitizeBook(raw);
    if (!r.ok) throw new Error(r.errors.join('；'));
    var b = r.book;

    var std = SC.meetsFullStandard(b);
    b.fromAI = true;
    b.skeleton = !std.full;                 // 默认草稿，达标才完整
    if (!b.sources.length) b.sources = ['AI 生成 · 待人工复核'];
    if (!b.todo.length) b.todo = ['AI 生成内容请逐项人工复核'];
    return { book: b, full: std.full, missing: std.missing, warnings: r.warnings };
  }

  function errText(e) {
    var code = e && e.error && e.error.code;
    if (code) {
      if (code.indexOf('auth_') === 0) return '鉴权失败：' + (e.error.message || code) + '（可能是网络域不被允许，建议通过本地服务打开）';
      if (code.indexOf('quota_') === 0) return '配额受限：' + (e.error.message || code);
      if (code.indexOf('request_') === 0) return '请求参数问题：' + (e.error.message || code);
      if (code.indexOf('gateway_') === 0 || code.indexOf('model_') === 0) return '模型服务暂不可用，请稍后重试';
      if (code.indexOf('internal_') === 0) return '服务内部错误，请稍后重试';
    }
    return (e && e.message) || String(e);
  }

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // 仅对“连接/网关类”瞬时故障重试；鉴权、配额、参数类错误立即上抛、绝不重试。
  function isRetryableNetwork(e) {
    var code = (e && e.error && e.error.code) || '';
    if (/auth_|quota_|request_invalid|request_parameter|invalid/.test(code)) return false;
    if (/^gateway_|^internal_/.test(code)) return true;
    var msg = String((e && e.message) || e || '').toLowerCase();
    if (/auth|鉴权|quota|配额|参数/.test(msg)) return false;
    return /network|failed to fetch|load failed|socket|timeout|timed out|err_/.test(msg)
      || (e && e.name === 'TypeError');   // 浏览器 fetch 断连常抛 TypeError: network error
  }

  // 发起一次流式生成并汇总为完整文本；网络中断时最多重试 2 次（共 3 次），指数退避。
  // 生成内容在进入预览/保存前不会落库，重试幂等、无副作用。
  function streamBook(cloud, model, name, hintText, setStatus) {
    var MAX_ATTEMPTS = 3, attempt = 0, slow = /pro|thinking|reasoner|hy\d/i.test(model.id);
    function once() {
      setStatus(attempt === 0
        ? (slow ? '模型整理中（质量模型较慢，约 1 分钟，请勿关闭窗口）…' : '模型整理中（流式返回，约 10—30 秒）…')
        : '网络中断，正在重新生成（第 ' + attempt + ' / ' + (MAX_ATTEMPTS - 1) + ' 次重试）…');
      var p = cloud.llm.chat.completions.create({
        model: model.id,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(name, hintText) }
        ],
        stream: true,
        response_format: { type: 'json_object' },
        temperature: 0.3
      });
      return Promise.resolve(p).then(function (stream) {
        var iterable = stream && typeof stream[Symbol.asyncIterator] === 'function' ? stream : null;
        if (!iterable) throw new Error('SDK 返回异常');
        var acc = '';
        return (async function loop() {
          for await (var chunk of iterable) {
            var delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
            if (delta && delta.content) acc += delta.content;
          }
          return acc;
        })();
      });
    }
    function go() {
      attempt += 1;
      return once().catch(function (e) {
        if (attempt < MAX_ATTEMPTS && isRetryableNetwork(e)) {
          setStatus('连接中断（' + ((e && e.message) || 'network error') + '），'
            + (attempt === 1 ? '2' : '3') + ' 秒后自动重试…');
          return delay(attempt === 1 ? 2000 : 3000).then(go);
        }
        throw e;
      });
    }
    return go();
  }

  /* ---------- 本地保存：markdown 文件 ---------- */
  function buildBody(book) {
    var m = book.modules || {};
    var lines = ['# ' + (book.title || '未命名') + ' · 内容导读', '', '（本书由 AI 生成，请逐项人工复核后再用于备考）', ''];
    if (book.status) lines.push(book.status, '');
    if (m.chapters && m.chapters.length) {
      lines.push('## 章节速览');
      m.chapters.forEach(function (c) { lines.push('- 第' + (c.no || '?') + '篇 《' + (c.title || '') + '》：' + (c.gist || '')); });
      lines.push('');
    }
    if (m.method && m.method.length) {
      lines.push('## 读书方法');
      m.method.forEach(function (x, i) { lines.push((i + 1) + '. ' + x); });
      lines.push('');
    }
    if (m.quotes && m.quotes.length) {
      lines.push('## 名句积累');
      m.quotes.forEach(function (q) { lines.push('- **' + (q.front || '') + '**：' + (q.back || '')); });
      lines.push('');
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  function bookToMarkdown(book) {
    var body = buildBody(book);
    var fm = JSON.parse(JSON.stringify(book));
    delete fm.body;
    return '---\n' + JSON.stringify(fm, null, 2) + '\n---\n\n' + body;
  }

  /* IndexedDB 持久化目录句柄，避免每次重新选目录 */
  function idbRun(mode, key, val) {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('hxw_fs');
      req.onupgradeneeded = function () { req.result.createObjectStore('handles'); };
      req.onsuccess = function () {
        var db = req.result, tx = db.transaction('handles', mode), st = tx.objectStore('handles');
        var op = mode === 'readwrite' ? st.put(val, key) : st.get(key);
        op.onsuccess = function () { resolve(op.result); };
        op.onerror = function () { reject(op.error); };
      };
      req.onerror = function () { reject(req.error); };
    });
  }

  function writeViaFsa(book, md) {
    if (!window.showDirectoryPicker) throw new Error('no_fsa');
    return idbRun('readonly', 'books_dir', null).then(function (dir) {
      return dir ? dir : window.showDirectoryPicker({ id: 'hxwBooks', mode: 'readwrite' }).then(function (d) {
        return idbRun('readwrite', 'books_dir', d).then(function () { return d; });
      });
    }).then(function (dir) {
      return dir.getFileHandle((book.id || 'book') + '.md', { create: true }).then(function (fh) {
        return fh.createWritable().then(function (w) { return w.write(md).then(function () { return w.close(); }).then(function () { return fh; }); });
      }).then(function () {
        // 尝试刷新 manifest（不存在则忽略，下次 build 会补齐）
        return dir.getFileHandle('manifest.json', { create: false }).then(function (mh) {
          return mh.getFile().then(function (f) { return f.text(); }).then(function (txt) {
            var man = JSON.parse(txt);
            if (!man.books.some(function (b) { return b.id === book.id; })) {
              man.books.push({ id: book.id, title: book.title, file: 'books/' + book.id + '.md', grade: book.grade || '', status: book.skeleton ? 'skeleton' : 'full' });
              return mh.createWritable().then(function (w) { return w.write(JSON.stringify(man, null, 2)).then(function () { return w.close(); }); });
            }
          });
        }).catch(function () { /* manifest 缺失，忽略 */ });
      }).then(function () { return true; });
    });
  }

  function downloadMd(book, md) {
    var blob = new Blob([md], { type: 'text/markdown' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = (book.id || 'book') + '.md';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  // 保存新书。关键原则：先“入库”（localStorage），让书一定出现在首页列表与搜索中；
  // 文件导出（FSA 写盘 / 下载 .md）只是附加动作，成功与否都不能影响入库，也不能把流程卡住。
  // file:// 下系统目录选择器在内置浏览器里可能不弹出/一直挂起，故该协议直接走下载，不调用 FSA。
  // 返回始终 resolve 的 {via, msg}；via: fsa | download | cache
  function saveBookLocally(book) {
    book.body = buildBody(book);
    var md = bookToMarkdown(book);

    var cacheErr = '';
    try { window.HXW.saveUserBook(book); }
    catch (e) { cacheErr = errText(e); }
    var savedMsg = cacheErr
      ? '（写入浏览器书库失败：' + cacheErr + '）'
      : '已加入书库，首页列表与搜索中可见';

    function result(via, msg) { return { via: via, msg: msg }; }

    // file:// 或不支持 FSA：直接下载 .md，避免目录选择器挂起导致“点了没反应”
    if (location.protocol === 'file:' || !window.showDirectoryPicker) {
      try {
        downloadMd(book, md);
        return Promise.resolve(result('download',
          savedMsg + '；并已下载 ' + book.id + '.md（file:// 无法直接写入项目目录，可手动放入 books/）'));
      } catch (e) {
        return Promise.resolve(result('cache', savedMsg + '；文件下载失败，内容已存入浏览器书库'));
      }
    }

    // http(s)：尝试 FSA 直接写所选文件夹（首次需用户选目录）；任何失败/取消都回退下载，书已入库不丢
    return writeViaFsa(book, md).then(function () {
      return result('fsa', savedMsg + '；文件已写入所选文件夹并更新清单');
    }).catch(function () {
      try {
        downloadMd(book, md);
        return result('download', savedMsg + '；目录写入未完成，已改为下载 ' + book.id + '.md');
      } catch (e2) {
        return result('cache', savedMsg);
      }
    });
  }

  /* ---------- ID 冲突（R5.2）与保存确认（R5.6） ---------- */
  function takenBook(id) {
    var list = (window.HXW.allBooks && window.HXW.allBooks()) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function nextId(id) {
    var i = 2, cand;
    do { cand = id + '-' + i; i++; } while (takenBook(cand));
    return cand;
  }
  // 已被占用则让用户「换新 ID / 取消」；不冲突直接通过。返回 Promise<book|null>
  function resolveId(book) {
    var occ = takenBook(book.id);
    if (!occ) return Promise.resolve(book);
    return new Promise(function (resolve) {
      var U = window.HXWUI;
      var body = U.el('div');
      body.appendChild(U.el('div', null, 'ID「' + book.id + '」已被《' + (occ.title || book.id) + '》占用。'));
      body.appendChild(U.el('div', 'muted', '为避免覆盖已有书目（含内置书目），可更换为新 ID，或取消本次保存。'));
      var cand = nextId(book.id);
      U.openModal({
        title: 'ID 冲突',
        body: body,
        actions: [
          { label: '取消', onClick: function () { resolve(null); } },
          {
            label: '更换为「' + cand + '」', primary: true,
            onClick: function () { book.id = cand; resolve(book); }
          }
        ]
      });
    });
  }
  // 保存前让用户确认书名、ID、完整/草稿状态（R5.6）。Promise<boolean>
  function confirmSave(book, act) {
    return new Promise(function (resolve) {
      var U = window.HXWUI;
      var body = U.el('div');
      body.appendChild(U.el('div', null, '书名：' + book.title));
      body.appendChild(U.el('div', null, 'ID：' + book.id));
      body.appendChild(U.el('div', null, '状态：' + (book.skeleton ? '草稿 / 待补全' : '完整书')));
      body.appendChild(U.el('div', 'note', 'AI 生成内容，发布前请逐项核实；存疑事项见书中「待核实」。'));
      U.openModal({
        title: '确认' + act,
        body: body,
        actions: [
          { label: '取消', onClick: function () { resolve(false); } },
          { label: '确认' + act, primary: true, onClick: function () { resolve(true); } }
        ]
      });
    });
  }
  // 校验通过后的统一入口：先解决 ID 冲突，再进入预览；任何失败都不自动保存（R5.1/5.2）
  function presentResult(raw, name, setStatus) {
    var U = window.HXWUI;
    var v;
    try { v = validate(raw, name); }
    catch (e) {
      U.toast('结构校验未通过，未保存：' + e.message, 5200);
      if (setStatus) setStatus('失败：' + e.message);
      return;
    }
    resolveId(v.book).then(function (book) {
      if (!book) { U.toast('已取消：ID 冲突未解决，内容未保存'); return; }
      showPreview(book, v.full, v.missing);
    });
  }

  /* ---------- 预览 + 保存 UI ---------- */
  function showPreview(book, full, missing) {
    var U = window.HXWUI;
    var body = U.el('div');
    body.appendChild(U.el('div', 'note', 'AI 生成内容，发布前请逐项核实。确认无误后可保存为 books/<id>.md，或先仅存浏览器查看；不会覆盖已有书目。'));

    var statusLine = full
      ? U.el('div', 'gen-status full', '状态：完整书（达到 §3.3 内容门槛）')
      : U.el('div', 'gen-status draft', '状态：草稿 / 待补全（未达到完整书门槛，保存后会明确标注，不与完整书混淆）');
    body.appendChild(statusLine);

    var summary = U.el('div', 'gen-summary');
    summary.appendChild(U.el('div', null, '书名：' + (book.title || '') + (book.grade ? '（' + book.grade + '）' : '')));
    summary.appendChild(U.el('div', null, 'ID：' + book.id));
    summary.appendChild(U.el('div', null, '作者：' + ((book.author && book.author.name) || '待核实') + ' · 体裁：' + (book.genre || '—')));
    summary.appendChild(U.el('div', 'muted', '时间线 ' + book.modules.timeline.length + ' 条 · 人物 ' + book.modules.characters.length + ' 位 · 题目 ' + book.modules.quiz.length + ' 道'));
    body.appendChild(summary);

    if (!full && missing && missing.length) {
      body.appendChild(U.el('div', 'gen-missing', '待补全项：'));
      var ul = U.el('ul');
      missing.forEach(function (mm) { ul.appendChild(U.el('li', null, mm)); });
      body.appendChild(ul);
    }

    var ta = U.el('textarea'); ta.readOnly = true; ta.value = JSON.stringify(book, null, 1);
    body.appendChild(ta);

    function go() { location.href = 'detail.html?id=' + encodeURIComponent(book.id); }
    // 主按钮统一为「保存为图书」：无论 file:// 还是本地服务器，语义都是把这本书加入书库
    var saveLabel = '保存为图书';

    U.openModal({
      title: '生成结果预览 · 保存为图书',
      body: body,
      actions: [
        {
          label: '仅存浏览器并查看', close: false,
          onClick: function () {
            confirmSave(book, '存入浏览器').then(function (ok) {
              if (!ok) { showPreview(book, full, missing); return; }
              try { window.HXW.saveUserBook(book); go(); }
              catch (e) { U.toast('保存失败：' + errText(e), 4200); }
            });
          }
        },
        { label: '仅下载 .md', onClick: function () { var md = bookToMarkdown(book); downloadMd(book, md); U.toast('已下载 ' + book.id + '.md'); } },
        {
          label: saveLabel, primary: true, close: false,
          onClick: function () {
            var btn = document.querySelector('.modal .actions .btn.primary');
            confirmSave(book, '保存为图书').then(function (ok) {
              if (!ok) { showPreview(book, full, missing); return; }
              if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
              saveBookLocally(book).then(function (res) {
                U.toast(res.msg, 4600);
                go();
              }).catch(function (e) {
                U.toast('保存失败：' + errText(e), 4200);
                if (btn) { btn.disabled = false; btn.textContent = saveLabel; }
              });
            });
          }
        }
      ]
    });
  }

  /* ---------- 主流程 ---------- */
  function openGenerator() {
    var U = window.HXWUI;
    var body = U.el('div');

    var f0 = U.el('div', 'field');
    f0.appendChild(U.el('label', null, 'DeepSeek API Key（仅存本浏览器，不上传；到 platform.deepseek.com 申请充值）'));
    var keyInput = U.el('input');
    keyInput.type = 'password';
    keyInput.value = getDsKey();
    keyInput.placeholder = 'sk-…（留空则使用本地代理模式）';
    keyInput.addEventListener('change', function () {
      setDsKey(this.value.trim());
      loadModels();
    });
    f0.appendChild(keyInput);
    var cfgLink = U.el('a', 'btn ghost', '前往「模型配置」页管理 Key 与默认模型 →');
    cfgLink.href = 'settings.html';
    f0.appendChild(cfgLink);
    body.appendChild(f0);

    var f1 = U.el('div', 'field');
    f1.appendChild(U.el('label', null, '书名（必填）'));
    var input = U.el('input'); input.type = 'text'; input.placeholder = '如：骆驼祥子 / 昆虫记 / 简·爱';
    f1.appendChild(input);
    body.appendChild(f1);

    var f2 = U.el('div', 'field');
    f2.appendChild(U.el('label', null, '补充信息（选填：作者、年级、版本等，帮助模型定位）'));
    var hint = U.el('input'); hint.type = 'text'; hint.placeholder = '如：老舍，七下，统编版';
    f2.appendChild(hint);
    body.appendChild(f2);

    var f3 = U.el('div', 'field');
    f3.appendChild(U.el('label', null, '模型（默认 DeepSeek，可换用云端其他模型）'));
    var modelSel = U.el('select');
    var optAuto = U.el('option');
    optAuto.value = ''; optAuto.textContent = '默认（DeepSeek Chat，快且稳）'; modelSel.appendChild(optAuto);
    modelSel.disabled = true;
    modelSel.addEventListener('change', function () { setModelPref(modelSel.value); });
    f3.appendChild(modelSel);
    body.appendChild(f3);

    var steps = U.el('ul', 'gen-steps');
    body.appendChild(steps);

    function setStatus(msg) { steps.appendChild(U.el('li', null, msg)); }

    // 打开弹窗后异步拉取模型填充下拉；失败不阻塞（开始生成时再按默认/报错处理）
    function loadModels() {
      getCloud(function () {}).then(function (cloud) {
        return cloud.llm.models.list();
      }).then(function (models) {
        var usable = (models || []).filter(function (x) {
          return x && x.id && x.disabled !== true && !/image/i.test(x.id);
        });
        usable.sort(function (a, b) {
          var da = /deepseek/i.test(a.id) ? 0 : 1, db = /deepseek/i.test(b.id) ? 0 : 1;
          return da - db;
        });
        U.clear(modelSel);
        modelSel.appendChild(optAuto);
        usable.forEach(function (m) {
          var o = U.el('option');
          o.value = m.id;
          var tag = /pro|thinking/i.test(m.id) ? ' · 较慢' : (/flash/i.test(m.id) ? ' · 快' : '');
          o.textContent = (m.name || m.id) + tag + '（' + m.id + '）';
          modelSel.appendChild(o);
        });
        var saved = getModelPref();
        var def = chooseModel(usable, saved) || { id: '' };
        modelSel.value = saved && saved === def.id ? saved : def.id;
        modelSel.disabled = false;
      }).catch(function () { /* 保持默认占位，run 时会给出真实错误 */ });
    }
    loadModels();

    var running = false;
    function run() {
      var name = input.value.trim();
      if (!name) { U.toast('请先输入书名'); return; }
      var k = keyInput.value.trim();
      if (k) setDsKey(k);
      if (!getDsKey() && !proxyConfigured()) {
        U.toast('请先粘贴 DeepSeek API Key（platform.deepseek.com 申请，仅存本浏览器）', 4600);
        return;
      }
      if (running) return;
      var now = Date.now();
      if (now - lastGenAt < 5000) { U.toast('生成较慢，请稍等几秒再试'); return; }
      lastGenAt = now;
      running = true;
      U.clear(steps);
      var startBtn = document.getElementById('genStartBtn');
      if (startBtn) { startBtn.disabled = true; startBtn.textContent = '生成中…'; }
      getCloud(setStatus)
        .then(function (cloud) {
          return pickModel(cloud, setStatus, modelSel.disabled ? getModelPref() : modelSel.value)
            .then(function (model) { return { cloud: cloud, model: model }; });
        })
        .then(function (ctx) {
          return streamBook(ctx.cloud, ctx.model, name, hint.value.trim(), setStatus);
        })
        .then(function (text) {
          setStatus('生成完成，正在解析与校验…');
          presentResult(extractJSON(text), name, setStatus);
        })
        .catch(function (e) {
          setStatus('失败：' + errText(e));
          U.toast('生成失败：' + errText(e), 4200);
        })
        .then(function () {
          running = false;
          if (startBtn) { startBtn.disabled = false; startBtn.textContent = '开始生成'; }
        });
    }

    function openManual() {
      var mb = U.el('div');
      mb.appendChild(U.el('div', 'muted', '按数据模型粘贴一本书的 JSON（可用导出的文件格式），保存后进入详情页。'));
      var ta = U.el('textarea');
      ta.placeholder = '{ "id": "...", "title": "...", "modules": { ... } }';
      mb.appendChild(ta);
      U.openModal({
        title: '手动录入 / 粘贴 JSON',
        body: mb,
        actions: [
          { label: '取消' },
          {
            label: '校验并保存', primary: true, onClick: function () {
              var raw;
              try { raw = JSON.parse(ta.value); }
              catch (e) { U.toast('JSON 解析失败：' + e.message, 3600); return; }
              presentResult(raw, (raw && raw.title) || '未命名书目', null);
            }
          }
        ]
      });
    }

    var startBtn = U.el('button', 'btn primary', '开始生成');
    startBtn.id = 'genStartBtn';
    startBtn.onclick = run;
    var manualBtn = U.el('button', 'btn', '手动录入 JSON');
    manualBtn.onclick = openManual;

    U.openModal({
      title: 'AI 生成新书资料',
      body: body,
      actions: [
        { label: '关闭', close: true },
        { node: manualBtn },
        { node: startBtn }
      ]
    });
  }

  window.HXWGEN = {
    openGenerator: openGenerator,
    bookToMarkdown: bookToMarkdown,
    // 公开存储 API（settings.html 模型配置页复用，保证 localStorage 键单一来源）
    getDsKey: getDsKey, setDsKey: setDsKey,
    getModelPref: getModelPref, setModelPref: setModelPref,
    proxyConfigured: proxyConfigured, DS_MODELS: DS_MODELS,
    _test: { buildUserPrompt: buildUserPrompt, extractJSON: extractJSON, validate: validate, SYSTEM_PROMPT: SYSTEM_PROMPT, chooseModel: chooseModel, DEEPSEEK_PREF: DEEPSEEK_PREF, isRetryableNetwork: isRetryableNetwork, streamBook: streamBook,
      createDirectCloud: createDirectCloud, getDsKey: getDsKey, setDsKey: setDsKey, proxyConfigured: proxyConfigured, DS_MODELS: DS_MODELS, dsCreate: dsCreate, getCloud: getCloud }
  };
})();
