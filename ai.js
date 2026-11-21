/* ===== AI 问答 · 检索增强（RAG） =====
 * 依赖：data.js（KB_DATA）、script.js（window.KB_mdToHtml）
 * 双模式：
 *   proxy  —— 走本地代理 /api/chat，密钥只在代理的环境变量里（演示推荐）
 *   direct —— 浏览器直连 OpenAI 兼容接口，密钥只存本机 localStorage
 * 密钥绝不写进本文件、data.js 或任何随网站发布的文件。
 */
(function () {
  "use strict";

  var LS_KEY = "kb_ai_cfg_v1";
  var DEFAULTS = { mode: "proxy", base: "https://api.deepseek.com/v1", model: "deepseek-chat", key: "" };

  var SYSTEM_PROMPT = [
    "你是企业会计知识库的问答助手。只依据下面提供的「知识库资料」回答问题，不得凭记忆补充资料以外的内容。",
    "要求：",
    "1. 中文作答，简洁、有条理，可用编号列表或小标题。",
    "2. 每个结论后用资料序号标注依据，例如 [1]、[1][3]。",
    "3. 资料不足以回答时，明确说「本站知识库暂未收录相关依据」，并建议用关键词搜索确认，不要编造。",
    "4. 结尾提醒「正式依据以官方文件原文为准」。"
  ].join("\n");

  var $ = function (id) { return document.getElementById(id); };
  var cfg = Object.assign({}, DEFAULTS, loadCfg());
  var history = [];
  var busy = false;
  var proxyHasKey = null;

  function loadCfg() { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; } }
  function saveCfg() { try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (e) {} }
  function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* ---------- 检索：中文二元切分 + 加权打分 ---------- */
  function tokenize(q) {
    var toks = [], seen = {};
    var words = q.toLowerCase().replace(/[^\u4e00-\u9fff a-z0-9]/g, " ").split(/\s+/).filter(Boolean);
    words.forEach(function (w) {
      if (/^[a-z0-9]+$/.test(w)) { if (w.length >= 2 && !seen[w]) { seen[w] = 1; toks.push(w); } return; }
      var cn = w.replace(/[^\u4e00-\u9fff]/g, "");
      if (cn.length === 1) { if (!seen[cn]) { seen[cn] = 1; toks.push(cn); } return; }
      for (var i = 0; i < cn.length - 1; i++) {
        var t = cn.slice(i, i + 2);
        if (!seen[t]) { seen[t] = 1; toks.push(t); }
      }
    });
    return toks;
  }

  function countHits(text, tok) {
    var n = 0, i = 0;
    while ((i = text.indexOf(tok, i)) !== -1) { n++; i += tok.length; if (n >= 8) break; }
    return n;
  }

  function retrieve(q, toks) {
    if (!toks.length) return [];
    var scored = [];
    (KB_DATA.entries || []).forEach(function (e, idx) {
      var title = (e.title || "").toLowerCase();
      var tags = (e.tags || []).join(" ").toLowerCase();
      var sum = (e.summary || "").toLowerCase();
      var cont = (e.content || "").slice(0, 4000).toLowerCase();
      var s = 0;
      toks.forEach(function (t) {
        s += countHits(title, t) * 6 + countHits(tags, t) * 3
          + countHits(sum, t) * 2 + Math.min(countHits(cont, t), 3);
      });
      if (s > 0) scored.push({ idx: idx, s: s });
    });
    scored.sort(function (a, b) { return b.s - a.s; });
    return scored.slice(0, 5);
  }

  function snippet(e, toks) {
    var c = e.content || "";
    if (!c) return e.summary || "";
    var lc = c.toLowerCase(), pos = -1;
    toks.forEach(function (t) {
      var p = lc.indexOf(t);
      if (p !== -1 && (pos === -1 || p < pos)) pos = p;
    });
    if (pos < 0) pos = 0;
    return c.slice(Math.max(0, pos - 120), pos + 900);
  }

  function buildContext(top, toks) {
    if (!top.length) return "（本次检索未在本站知识库中命中任何条目。）";
    return top.map(function (t, i) {
      var e = KB_DATA.entries[t.idx];
      return "[" + (i + 1) + "] 标题：" + (e.title || "")
        + "\n来源：" + (e.source || "")
        + (e.url ? "\n链接：" + e.url : "")
        + "\n摘录：" + snippet(e, toks) + "\n";
    }).join("\n");
  }

  function buildMessages(q, top, toks) {
    var user = "知识库资料：\n" + buildContext(top, toks)
      + "\n----------------\n问题：" + q;
    return [{ role: "system", content: SYSTEM_PROMPT }]
      .concat(history, [{ role: "user", content: user }]);
  }

  /* ---------- 模型调用 ---------- */
  async function callModel(messages) {
    var endpoint, headers = { "Content-Type": "application/json" }, body;
    if (cfg.mode === "proxy") {
      endpoint = "/api/chat";
      body = { messages: messages };
    } else {
      if (!cfg.key) throw new Error("NO_KEY");
      endpoint = cfg.base.replace(/\/+$/, "") + "/chat/completions";
      headers["Authorization"] = "Bearer " + cfg.key;
      body = { model: cfg.model || DEFAULTS.model, messages: messages, temperature: 0.2, stream: false };
    }
    var resp = await fetch(endpoint, { method: "POST", headers: headers, body: JSON.stringify(body) });
    if (!resp.ok) {
      var text = await resp.text();
      throw new Error("HTTP_" + resp.status + ":" + text.slice(0, 200));
    }
    var data = await resp.json();
    var content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error("EMPTY:" + JSON.stringify(data).slice(0, 200));
    return content;
  }

  function errorText(e) {
    var msg = String(e && e.message || e);
    if (msg === "NO_KEY") return "还没配置 API Key。点右上角「设置」填写，或改用「本地代理」模式。";
    if (msg.indexOf("Failed to fetch") !== -1 || msg.indexOf("NetworkError") !== -1 || msg.indexOf("TypeError") !== -1) {
      return cfg.mode === "proxy"
        ? "连不上本地代理。演示前请在项目文件夹运行 node 本地AI代理.js，并用 http://localhost:8787 打开本站。"
        : "请求被拒绝：可能是浏览器 CORS 拦截、API 地址不对或网络不通。可改用公司内网网关地址，或切回本地代理模式。";
    }
    if (msg.indexOf("HTTP_401") === 0 || msg.indexOf("HTTP_403") === 0) return "API Key 无效或没有权限（" + msg.slice(0, 12) + "）。";
    if (msg.indexOf("HTTP_429") === 0) return "调用过于频繁或额度不足，稍后再试。";
    if (msg.indexOf("HTTP_") === 0) return "接口返回错误：" + msg.slice(0, 160);
    if (msg.indexOf("EMPTY:") === 0) return "接口没有返回回答内容：" + msg.slice(6, 160);
    return "出错了：" + msg.slice(0, 160);
  }

  /* ---------- 渲染 ---------- */
  function addMsg(role, html, rawHtml) {
    var wrap = document.createElement("div");
    wrap.className = "ai-msg " + role;
    wrap.innerHTML = '<div class="ai-role">' + (role === "user" ? "我" : "AI 助手") + '</div>'
      + '<div class="ai-bubble">' + (rawHtml ? html : "<p>" + escHtml(html).replace(/\n/g, "<br>") + "</p>") + "</div>";
    $("aiMessages").appendChild(wrap);
    $("aiMessages").scrollTop = $("aiMessages").scrollHeight;
    return wrap.querySelector(".ai-bubble");
  }

  function sourceChipsHtml(top, q) {
    if (!top.length) return "";
    var chips = top.map(function (t) {
      var e = KB_DATA.entries[t.idx];
      return '<button class="ai-src-chip" data-idx="' + t.idx + '" data-q="' + escHtml(q || "")
        + '">' + escHtml(e.title) + "</button>";
    }).join("");
    return '<div class="ai-sources"><div class="ai-sources-title">参考条目（点击跳到原文命中处）</div>' + chips + "</div>";
  }

  function renderAnswer(answer, top, q) {
    var html = window.KB_mdToHtml ? window.KB_mdToHtml(answer)
      : "<p>" + escHtml(answer).replace(/\n/g, "<br>") + "</p>";
    return html + sourceChipsHtml(top, q);
  }

  function renderRetrievalOnly(bubble, top, q) {
    var html = "<p>当前未启用 AI 生成（未配置 API Key）。以下是本站知识库的检索结果：</p>";
    if (!top.length) html += "<p>没有命中条目，换个关键词试试。</p>";
    bubble.innerHTML = html + sourceChipsHtml(top, q);
  }

  /* ---------- 发送 ---------- */
  async function send() {
    if (busy) return;
    var q = $("aiInput").value.trim();
    if (!q) return;
    $("aiInput").value = "";
    addMsg("user", q);
    busy = true;
    $("aiSendBtn").disabled = true;
    var bubble = addMsg("assistant", '<span class="ai-thinking">正在检索知识库并生成回答…</span>', true);
    try {
      var toks = tokenize(q);
      var top = retrieve(q, toks);
      if (cfg.mode === "direct" && !cfg.key) {
        renderRetrievalOnly(bubble, top, q);
        return;
      }
      // 本地代理没配服务端密钥时，只给检索结果，不假装有 AI、也不报错
      if (cfg.mode === "proxy" && proxyHasKey === false) {
        renderRetrievalOnly(bubble, top, q);
        return;
      }
      var answer = await callModel(buildMessages(q, top, toks));
      bubble.innerHTML = renderAnswer(answer, top, q);
      history.push({ role: "user", content: q }, { role: "assistant", content: answer });
      if (history.length > 8) history = history.slice(-8);
    } catch (e) {
      bubble.innerHTML = "<p>" + escHtml(errorText(e)) + "</p>";
    } finally {
      busy = false;
      $("aiSendBtn").disabled = false;
      $("aiMessages").scrollTop = $("aiMessages").scrollHeight;
    }
  }

  /* ---------- 点出处跳回条目（优先用主站的高亮定位能力） ---------- */
  function jumpToEntry(idx, q) {
    closeDrawer();
    if (window.KB_openEntry) { window.KB_openEntry(idx, q); return; }
    var e = (KB_DATA.entries || [])[idx];
    if (!e) return;
    var allBtn = document.querySelector('.nav-item[data-cat="all"]');
    if (allBtn) allBtn.click();
    var input = $("searchInput");
    input.value = e.title;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    setTimeout(function () {
      var card = document.querySelector(".content .card");
      if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 220);
  }

  /* ---------- 面板与设置 ---------- */
  function openDrawer() {
    $("aiDrawer").classList.add("open");
    $("aiDrawer").setAttribute("aria-hidden", "false");
    var p = checkProxy();
    setTimeout(function () { $("aiInput").focus(); }, 260);
    return p;
  }
  function closeDrawer() {
    $("aiDrawer").classList.remove("open");
    $("aiDrawer").setAttribute("aria-hidden", "true");
  }

  async function checkProxy() {
    var sub = document.querySelector(".ai-sub");
    if (cfg.mode !== "proxy") {
      proxyHasKey = null;
      sub.textContent = "直连模式 · 密钥仅存本机浏览器";
      return false;
    }
    sub.textContent = "正在检测本地代理…";
    try {
      var r = await fetch("/api/health");
      var d = await r.json();
      proxyHasKey = !!(d && d.hasKey);
      sub.textContent = proxyHasKey ? "本地代理已连接（密钥在服务端）" : "本地代理已连接，但未检测到服务端密钥";
    } catch (e) {
      proxyHasKey = false;
      sub.textContent = "未检测到本地代理 · 可切「直连 API」或启动代理";
    }
    return proxyHasKey;
  }

  /* ---------- 首页场景卡片调用：打开面板并提问；没密钥时只给检索结果 ---------- */
  window.KB_askQuestion = async function (q) {
    var ready = openDrawer();
    $("aiInput").value = q;
    await ready;
    var canAI = cfg.mode === "proxy" ? proxyHasKey : !!cfg.key;
    if (canAI) send();
    else $("aiInput").focus();
  };

  function syncSettings() {
    $("aiMode").value = cfg.mode;
    $("aiBase").value = cfg.base || "";
    $("aiKey").value = cfg.key || "";
    $("aiModel").value = cfg.model || "";
    $("aiDirectFields").hidden = cfg.mode !== "direct";
  }

  function init() {
    syncSettings();

    $("aiEntryBtn").addEventListener("click", openDrawer);
    $("aiCloseBtn").addEventListener("click", closeDrawer);
    $("aiSettingsBtn").addEventListener("click", function () {
      var p = $("aiSettings");
      p.hidden = !p.hidden;
      if (!p.hidden) syncSettings();
    });
    $("aiMode").addEventListener("change", function () {
      $("aiDirectFields").hidden = this.value !== "direct";
    });
    $("aiSaveBtn").addEventListener("click", function () {
      cfg.mode = $("aiMode").value;
      cfg.base = $("aiBase").value.trim() || DEFAULTS.base;
      cfg.key = $("aiKey").value.trim();
      cfg.model = $("aiModel").value.trim() || DEFAULTS.model;
      saveCfg();
      $("aiSettings").hidden = true;
      checkProxy();
      addMsg("assistant", "设置已保存（" + (cfg.mode === "proxy" ? "本地代理模式" : "直连 API 模式") + "）。", true);
    });
    $("aiClearBtn").addEventListener("click", function () {
      cfg.key = "";
      $("aiKey").value = "";
      saveCfg();
      addMsg("assistant", "本机保存的密钥已清除。", true);
    });
    $("aiSendBtn").addEventListener("click", send);
    $("aiInput").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
      if (e.key === "Escape") closeDrawer();
    });
    $("aiMessages").addEventListener("click", function (e) {
      var chip = e.target.closest(".ai-src-chip");
      if (chip) jumpToEntry(parseInt(chip.getAttribute("data-idx"), 10), chip.getAttribute("data-q") || "");
    });

    addMsg("assistant", "你好。我会先在本站知识库里检索相关条目，再据此回答并标出出处。例如问：哪些交易需要提交股东会审议？", true);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
