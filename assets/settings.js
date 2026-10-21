/* 模型配置页逻辑（settings.html）：
   Key / 默认模型 / 连接测试。存储与模型清单以 window.HXWGEN 为唯一源
   （generate.js 的 localStorage 键即权威，避免两处实现漂移）。
   设计约束：
   · Key 只写 localStorage，任何情况下不发起携带 Key 的跨域上传（测试接口除外，即 DeepSeek 本身）；
   · 本页面在 index/detail 构建产物里也会被内联，但无 settings.html 的 DOM 时 init() 必须静默跳过。 */
(function () {
  var DS_MODELS_URL = 'https://api.deepseek.com/models';

  function currentMode() {
    var G = window.HXWGEN;
    if (G.getDsKey()) {
      return { mode: 'direct', text: 'DeepSeek 直连（浏览器直调 api.deepseek.com，Key 存在本机）' };
    }
    if (G.proxyConfigured()) {
      return { mode: 'proxy', text: '云服务代理（本地开发内置配置，无需 Key）' };
    }
    return { mode: 'none', text: '未配置：AI 生成不可用（阅读 / 测试 / 错题本不受影响）' };
  }

  function maskKey(k) {
    k = String(k || '');
    if (k.length <= 10) return k ? '****（过短，请检查）' : '';
    return k.slice(0, 3) + '****' + k.slice(-4);
  }

  function defaultModelId() {
    return window.HXWGEN.getModelPref() || 'deepseek-chat';
  }

  /* 连接测试：GET /models 是最轻量的验活（带 Key，一次往返）。
     返回 Promise<string>（成功信息）；失败 reject 带可读原因。 */
  function testConnection(setMsg) {
    var G = window.HXWGEN;
    var key = G.getDsKey();
    if (!key) return Promise.reject(new Error('尚未保存 API Key：请先填写并保存（platform.deepseek.com 申请）'));
    var f = (typeof fetch === 'function') ? fetch : (globalThis.fetch && globalThis.fetch.bind(globalThis));
    if (!f) return Promise.reject(new Error('当前环境不支持 fetch，无法测试连接'));
    if (setMsg) setMsg('正在连接 api.deepseek.com …');
    return f(DS_MODELS_URL, { headers: { Authorization: 'Bearer ' + key } }).then(function (resp) {
      if (!resp.ok) {
        return resp.text().then(function (t) {
          var msg = '连接失败：HTTP ' + resp.status;
          try { var j = JSON.parse(t); if (j && j.error && j.error.message) msg += '：' + j.error.message; } catch (e) { if (t) msg += '：' + String(t).slice(0, 160); }
          if (resp.status === 401 || resp.status === 403) msg += '（Key 无效或无权限，请检查后重试）';
          throw new Error(msg);
        });
      }
      return resp.json().then(function (j) {
        var n = j && j.data ? j.data.length : 0;
        return '连接成功：Key 有效' + (n ? '，账号可用模型 ' + n + ' 个' : '');
      });
    });
  }

  function setMsgNode(node, msg, ok) {
    if (!node) return;
    node.textContent = msg;
    node.className = 'muted set-msg ' + (ok === true ? 'ok' : ok === false ? 'err' : '');
  }

  function renderModelSel(sel) {
    var U = window.HXWUI, G = window.HXWGEN;
    U.clear(sel);
    var saved = G.getModelPref();
    G.DS_MODELS.forEach(function (m) {
      var o = U.el('option');
      o.value = m.id;
      o.textContent = m.name + '（' + m.id + '）';
      sel.appendChild(o);
    });
    sel.value = G.DS_MODELS.some(function (m) { return m.id === saved; }) ? saved : defaultModelId();
  }

  function renderStatus() {
    var U = window.HXWUI, G = window.HXWGEN;
    var mode = currentMode();
    var modeNode = document.getElementById('dsMode');
    if (modeNode) { modeNode.textContent = mode.text; modeNode.className = 'set-mode set-mode-' + mode.mode; }
    var keyNode = document.getElementById('dsKeyState');
    if (keyNode) keyNode.textContent = G.getDsKey() ? '已保存：' + maskKey(G.getDsKey()) : '未保存';
    var modelNode = document.getElementById('dsModelNow');
    if (modelNode) modelNode.textContent = defaultModelId();
  }

  function init() {
    var U = window.HXWUI, G = window.HXWGEN;
    if (!U || !G) return;
    var page = document.getElementById('dsPage');
    if (!page) return;   // 非设置页（index/detail 也内联了本脚本）：静默跳过

    var keyInput = document.getElementById('dsKeyInput');
    var modelSel = document.getElementById('dsModelSel');
    var testBtn = document.getElementById('dsTestBtn');
    var testResult = document.getElementById('dsTestResult');

    if (keyInput) {
      keyInput.value = G.getDsKey();
      var toggle = document.getElementById('dsKeyToggle');
      if (toggle) {
        toggle.addEventListener('click', function () {
          var show = keyInput.type === 'password';
          keyInput.type = show ? 'text' : 'password';
          toggle.textContent = show ? '隐藏' : '显示';
        });
      }
      var saveBtn = document.getElementById('dsKeySave');
      if (saveBtn) {
        saveBtn.addEventListener('click', function () {
          var v = keyInput.value.trim();
          if (v && !/^sk-/.test(v)) { U.toast('Key 通常以 sk- 开头，请检查是否复制完整', 3600); return; }
          G.setDsKey(v);
          renderStatus();
          U.toast(v ? 'Key 已保存到本浏览器' : 'Key 已清除', 2400);
        });
      }
      var clearBtn = document.getElementById('dsKeyClear');
      if (clearBtn) {
        clearBtn.addEventListener('click', function () {
          keyInput.value = '';
          G.setDsKey('');
          renderStatus();
          setMsgNode(testResult, '尚未测试', null);
          U.toast('Key 已清除', 2400);
        });
      }
    }

    if (modelSel) {
      renderModelSel(modelSel);
      modelSel.addEventListener('change', function () {
        G.setModelPref(modelSel.value);
        renderStatus();
        U.toast('默认模型已设为 ' + modelSel.value, 2400);
      });
    }

    if (testBtn) {
      testBtn.addEventListener('click', function () {
        // 测试即当前输入框的值（空 = 清除后测试），保证「看到的」与「测的」一致
        var v = keyInput ? keyInput.value.trim() : '';
        G.setDsKey(v);
        renderStatus();
        testBtn.disabled = true;
        setMsgNode(testResult, '正在连接 api.deepseek.com …', null);
        testConnection(function (m) { setMsgNode(testResult, m, null); })
          .then(function (msg) { setMsgNode(testResult, msg, true); U.toast('连接成功', 2000); })
          .catch(function (e) { setMsgNode(testResult, e.message, false); })
          .then(function () { testBtn.disabled = false; });
      });
    }

    renderStatus();
  }

  window.HXWSET = {
    init: init,
    testConnection: testConnection,
    currentMode: currentMode,
    maskKey: maskKey,
    _test: { DS_MODELS_URL: DS_MODELS_URL, defaultModelId: defaultModelId }
  };
})();
