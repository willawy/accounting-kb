/* ===== 会计知识库 · 逻辑 =====
 * 数据在 data.js（KB_DATA），本文件只负责渲染和搜索，不用改。
 */

(function () {
  var entries = KB_DATA.entries || [];
  var catNames = {
    cas: "中国企业会计准则", ifrs: "IFRS", usgaap: "US GAAP",
    guide: "应用指南", listing: "上市监管与披露", tax: "税务专区",
    case: "监管处罚案例", faq: "常见问题库", weekly: "监管周报",
    industry: "行业与财报分析"
  };

  var state = { cat: "all", q: "" };

  /* ---------- 相关度检索：MiniSearch + 中文二元切分 ----------
   * 中文没有空格，默认分词会把整句当成一个词，所以自定义二元切分。
   * 索引只收短字段 + 正文前 1500 字（约 8 万 token，浏览器可承受），
   * 正文更深处靠下面的 indexOf 全文兜底，两边结果合并排序。
   */
  function kbTokenize(s) {
    var out = [];
    var words = String(s).toLowerCase().replace(/[^\u4e00-\u9fff a-z0-9]/g, " ").split(/\s+/).filter(Boolean);
    words.forEach(function (w) {
      if (/^[a-z0-9]+$/.test(w)) { if (w.length >= 2) out.push(w); return; }
      var cn = w.replace(/[^\u4e00-\u9fff]/g, "");
      if (cn.length === 1) { out.push(cn); return; }
      for (var i = 0; i < cn.length - 1; i++) out.push(cn.slice(i, i + 2));
    });
    return out;
  }

  var mini = null;
  function initSearchIndex() {
    if (typeof MiniSearch === "undefined") return;
    try {
      mini = new MiniSearch({
        fields: ["title", "summary", "tags", "source", "content"],
        tokenize: kbTokenize,
        searchOptions: {
          boost: { title: 5, tags: 3, summary: 2 },
          prefix: true, fuzzy: 0.2, combineWith: "OR"
        }
      });
      mini.addAll(entries.map(function (e, i) {
        return {
          id: i,
          title: e.title || "",
          summary: e.summary || "",
          tags: (e.tags || []).join(" "),
          source: e.source || "",
          content: (e.content || "").slice(0, 1500)
        };
      }));
    } catch (err) {
      mini = null;
    }
  }

  var $ = function (id) { return document.getElementById(id); };
  var contentEl = $("content");
  var inputEl = $("searchInput");

  // 长 content 阈值：超过该字符数默认只渲染前 N 字符预览，需点开看全文
  var CONTENT_PREVIEW = 1500;

  /* ---------- 侧栏计数 ---------- */
  function initCounts() {
    var counts = {};
    entries.forEach(function (e) { counts[e.cat] = (counts[e.cat] || 0) + 1; });
    var all = 0;
    for (var k in counts) all += counts[k];
    $("count-all").textContent = all;
    ["cas", "ifrs", "usgaap", "guide", "listing", "tax", "case", "faq", "weekly", "industry"].forEach(function (k) {
      if ($("count-" + k)) $("count-" + k).textContent = counts[k] || 0;
    });
  }

  /* ---------- 导航点击 ---------- */
  var navEl = $("nav");
  navEl.addEventListener("click", function (ev) {
    var btn = ev.target.closest(".nav-item");
    if (!btn) return;
    navEl.querySelectorAll(".nav-item").forEach(function (b) { b.classList.remove("active"); });
    btn.classList.add("active");
    state.cat = btn.getAttribute("data-cat");
    render();
    updateAllGroupCurrent();
  });

  /* ---------- 导航分组：展开 / 折叠（会计政策、监管与合规） ---------- */
  var GROUP_CATS = {
    policy: { cas: "中国企业会计准则", ifrs: "IFRS", usgaap: "US GAAP" },
    reg: { listing: "上市监管与披露", case: "监管处罚案例", weekly: "监管周报" }
  };
  var groups = {};

  function groupStorageKey(key) {
    // 会计政策沿用旧 key，保留用户此前设过的折叠状态
    return key === "policy" ? "kb_nav_policy_collapsed" : "kb_nav_collapsed_" + key;
  }
  function updateGroupCurrent(key) {
    var g = groups[key];
    if (!g || !g.current) return;
    var label = GROUP_CATS[key] && GROUP_CATS[key][state.cat];
    g.current.textContent = (g.collapsed && label) ? "· " + label : "";
  }
  function updateAllGroupCurrent() {
    Object.keys(groups).forEach(updateGroupCurrent);
  }
  function setGroupCollapsed(key, collapsed, save) {
    var g = groups[key];
    if (!g) return;
    g.collapsed = collapsed;
    navEl.classList.toggle("collapse-" + key, collapsed);
    g.btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    var arrow = g.btn.querySelector(".nav-group-arrow");
    if (arrow) arrow.textContent = collapsed ? "▸" : "▾";
    g.btn.title = (collapsed ? "展开" : "折叠") + (g.btn.getAttribute("data-label") || "") + "子栏目";
    updateGroupCurrent(key);
    if (save) { try { localStorage.setItem(groupStorageKey(key), collapsed ? "1" : "0"); } catch (e) {} }
  }
  navEl.querySelectorAll(".nav-group").forEach(function (btn) {
    var key = btn.getAttribute("data-group");
    groups[key] = { btn: btn, current: btn.querySelector(".nav-group-current"), collapsed: false };
    var saved = null;
    try { saved = localStorage.getItem(groupStorageKey(key)); } catch (e) {}
    setGroupCollapsed(key, saved === "1", false); // 默认展开；上次折叠过则记住
    btn.addEventListener("click", function () {
      setGroupCollapsed(key, !groups[key].collapsed, true);
    });
  });

  /* ---------- 搜索 ---------- */
  var timer = null;
  inputEl.addEventListener("input", function () {
    clearTimeout(timer);
    timer = setTimeout(function () {
      state.q = inputEl.value.trim().toLowerCase();
      render();
    }, 120);
  });

  function entryText(e) {
    return [e.title, e.summary, e.content, e.source, (e.tags || []).join(" ")].join(" ").toLowerCase();
  }

  function filter() {
    var pool = entries.filter(function (e) {
      return state.cat === "all" || e.cat === state.cat;
    });
    if (!state.q) return pool;

    var scored = {}, order = [];
    if (mini) {
      try {
        mini.search(state.q).forEach(function (r) {
          if (scored[r.id] === undefined) { scored[r.id] = r.score; order.push(r.id); }
          else scored[r.id] = Math.max(scored[r.id], r.score);
        });
      } catch (e) {}
    }
    // 全文兜底：MiniSearch 只索引了正文前 1500 字，深处命中靠这里补
    pool.forEach(function (e) {
      if (entryText(e).indexOf(state.q) === -1) return;
      var idx = entries.indexOf(e);
      if (scored[idx] === undefined) { scored[idx] = 1; order.push(idx); }
      else scored[idx] += 1;
    });

    return order
      .map(function (idx) { return { e: entries[idx], s: scored[idx] }; })
      .filter(function (x) { return pool.indexOf(x.e) !== -1; })
      .sort(function (a, b) { return b.s - a.s; })
      .map(function (x) { return x.e; });
  }

  /* ---------- 迷你 markdown 渲染（标题/列表/表格/引用/加粗/链接） ---------- */
  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function inline(s) {
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    return s;
  }
  function mdToHtml(md) {
    var lines = String(md).split(/\r?\n/);
    var out = [], i = 0;
    while (i < lines.length) {
      var line = lines[i];

      if (/^\s*$/.test(line)) { i++; continue; }

      if (/^---+\s*$/.test(line)) { out.push("<hr>"); i++; continue; }

      var h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        var lv = Math.min(h[1].length + 2, 6);
        out.push("<h" + lv + ">" + inline(esc(h[2])) + "</h" + lv + ">");
        i++; continue;
      }

      if (/^\|/.test(line)) {
        var rows = [];
        while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++; }
        var html = "<table><thead><tr>";
        var cells0 = splitRow(rows[0]);
        cells0.forEach(function (c) { html += "<th>" + inline(esc(c.trim())) + "</th>"; });
        html += "</tr></thead><tbody>";
        for (var r = 1; r < rows.length; r++) {
          if (/^[|:\-\s]+$/.test(rows[r])) continue;
          html += "<tr>";
          splitRow(rows[r]).forEach(function (c) { html += "<td>" + inline(esc(c.trim())) + "</td>"; });
          html += "</tr>";
        }
        html += "</tbody></table>";
        out.push(html);
        continue;
      }

      if (/^>\s?/.test(line)) {
        var quote = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, "")); i++; }
        out.push("<blockquote>" + inline(esc(quote.join(" "))) + "</blockquote>");
        continue;
      }

      if (/^[-*]\s+/.test(line)) {
        var items = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^[-*]\s+/, "")); i++; }
        out.push("<ul>" + items.map(function (t) {
          if (/借[：:]/.test(t) && /贷[：:]/.test(t)) return "<li>" + splitParagraphWithJournal(t) + "</li>";
          return "<li>" + inline(esc(t)) + "</li>";
        }).join("") + "</ul>");
        continue;
      }

      if (/^\d+[.、]\s*/.test(line)) {
        var ol = [];
        while (i < lines.length && /^\d+[.、]\s*/.test(lines[i])) { ol.push(lines[i].replace(/^\d+[.、]\s*/, "")); i++; }
        out.push("<ol>" + ol.map(function (t) {
          if (/借[：:]/.test(t) && /贷[：:]/.test(t)) return "<li>" + splitParagraphWithJournal(t) + "</li>";
          return "<li>" + inline(esc(t)) + "</li>";
        }).join("") + "</ol>");
        continue;
      }

      // 数据层已按语义拆段（例题/分录/编号项/步骤符各占一行），
      // 渲染时这些行不得被并进上一段——遇到就是新段
      var SEMANTIC_START = /^(【例|借[：:]|[①②③④⑤⑥⑦⑧⑨⑩]|[（(]\d{1,2}[）)]|2×2\d)/;
      var para = [line];
      i++;
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|[-*]\s|\d+[.、]|>|\||---+\s*$)/.test(lines[i])
             && !SEMANTIC_START.test(lines[i])) {
        para.push(lines[i]); i++;
      }
      var paraText = para.join(" ");
      if (/借[：:]/.test(paraText) && /贷[：:]/.test(paraText)) {
        out.push(splitParagraphWithJournal(paraText));
      } else {
        out.push("<p>" + inline(esc(paraText)) + "</p>");
      }
    }
    return out.join("\n");
  }
  function splitRow(row) {
    return row.replace(/^\|/, "").replace(/\|\s*$/, "").split("|");
  }

  /* ---------- 会计分录：从 OCR 粘连文本还原「一行一科目」的财务习惯排版 ---------- */

  // 金额规范化：修 OCR 数字噪声
  //   C/O 误读为 0（"1 500 C00" → 1 500 000）；点当千分位（"12.000000" → 12 000 000）
  //   纯数字 ≥4 位重新按千分位插空格（"350000000" → 350 000 000）
  function normAmt(a) {
    a = a.replace(/[CO]/g, "0");
    // 点当千分位：点后数字串长度是 3 的倍数 → 点换空格（"12.000000"→12 000 000）
    // 真小数（"7.5"、"3.14159"）点后位数不是 3 的倍数 → 保留
    a = a.replace(/(\d)\.(\d+)/g, function (m, d, run) {
      return (run.length % 3 === 0) ? d + " " + run : m;
    });
    var d = a.replace(/\s/g, "");
    if (/^\d{4,}$/.test(d)) return d.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    return a.replace(/\s+/g, " ").trim();
  }

  // 从右往左拆 (科目, 金额) 对。
  // 例："主营业务收入100 000应交税费——应交增值税（销项税额）13 000"
  //   → [{acct:"主营业务收入", amt:"100 000"}, {acct:"应交税费——应交增值税（销项税额）", amt:"13 000"}]
  function splitPairs(s) {
    var pairs = [];
    var i = s.length;
    while (i > 0) {
      while (i > 0 && /\s/.test(s[i - 1])) i--;      // 跳过末尾空白
      if (i === 0 || !/[\dCO]/.test(s[i - 1])) break; // 末尾必须是金额数字，否则到头
      var j = i;
      while (j > 0 && /[\d\s,.CO]/.test(s[j - 1])) j--; // 吃金额（含千分位空格/逗号/点和 C/O 噪声）
      var k = j;
      while (k > 0 && !/[\dCO]/.test(s[k - 1])) k--;   // 吃科目（非数字序列）
      var amt = s.slice(j, i).replace(/\s+/g, " ").trim();
      var acct = s.slice(k, j).trim();
      if (!acct) break;                              // 无科目名（纯数字残留）→ 中止防死循环
      pairs.push({ acct: acct, amt: amt });
      i = k;
    }
    return pairs.reverse();
  }

  // 解析一段分录文本（以"借："开头，通常含"贷："），返回 journal div HTML；解析不了返回 null
  function journalHtml(text) {
    var m = text.match(/^借[：:]/);
    if (!m) return null;
    var notes = [];
    var rest = text.slice(m[0].length).replace(/[。]\s*$/, "");
    // 剥离金额注记：括号内以数字/运算符为主（"（300000000×1/2）"、"(15 000 000 -12 000 000)"）
    // 科目名里的括号（"（销项税额）"、"（在建）"）以汉字为主，保留
    rest = rest.replace(/[（(][^（）()]*[）)]/g, function (x) {
      var inner = x.slice(1, -1).replace(/^\s+|\s+$/g, "");
      var sig = inner.replace(/\s/g, "").length;
      var digits = (inner.match(/[\d×*+\-\/=]/g) || []).length;
      if (sig > 0 && digits * 2 >= sig) { notes.push(inner); return " "; }
      return x;
    });
    var lendMatch = rest.match(/贷[：:]/);
    var debitPart = lendMatch ? rest.slice(0, lendMatch.index) : rest;
    var creditPart = lendMatch ? rest.slice(lendMatch.index + lendMatch[0].length) : "";
    // 残缺括号清理：OCR 丢了右括号的 "（上册" 挂在借贷部末尾会卡死解析
    //   数字/运算为主的 → 当注记；纯文字残片 → 丢弃；混文字的科目注记 → 保留
    [debitPart, creditPart].forEach(function (p, pi, arr) {
      var fixed = p.replace(/[（(][^（）()]*$/, function (x) {
        var inner = x.slice(1);
        var sig = inner.replace(/\s/g, "").length;
        var digits = (inner.match(/[\d×*+\-\/=%]/g) || []).length;
        if (sig > 0 && digits * 2 >= sig) { notes.push(inner); return " "; }
        if (digits === 0) return " ";
        return x;
      });
      if (pi === 0) { debitPart = fixed; } else { creditPart = fixed; }
    });
    var debitPairs = splitPairs(debitPart);
    var creditPairs = splitPairs(creditPart);
    if (!debitPairs.length && !creditPairs.length) return null;
    // 完整度校验：拆完后残留字符应 ≤ 3（容忍 OCR 噪声），否则说明结构识别失败
    function leftover(pairs, src) {
      var used = pairs.reduce(function (a, p) { return a + p.acct.length + p.amt.length; }, 0);
      return src.replace(/\s/g, "").length - used;
    }
    if (leftover(debitPairs, debitPart) > 3 || leftover(creditPairs, creditPart) > 3) return null;
    var html = '<div class="journal">';
    debitPairs.forEach(function (p, n) {
      var cls = "jrow" + (n > 0 ? " jextra" : "");
      html += '<div class="' + cls + '"><span class="jacct">' + (n === 0 ? "借：" : "")
        + inline(esc(p.acct)) + '</span><span class="jamt">' + esc(normAmt(p.amt)) + "</span></div>";
    });
    creditPairs.forEach(function (p, n) {
      var cls = "jrow jcredit" + (n > 0 ? " jextra" : "");
      html += '<div class="' + cls + '"><span class="jacct">' + (n === 0 ? "贷：" : "")
        + inline(esc(p.acct)) + '</span><span class="jamt">' + esc(normAmt(p.amt)) + "</span></div>";
    });
    if (notes.length) html += '<div class="jnote">注：' + esc(notes.join("；")) + "</div>";
    return html + "</div>";
  }

  // 段落内含分录 → 拆成「叙述 p + journal div」序列（一个段落里可能有多个分录）
  function splitParagraphWithJournal(text) {
    var re = /借[：:][^。借]*?贷[：:][^。借]*(?:[。]|(?=借[：:])|$)/g;
    var out = "";
    var last = 0, m;
    while ((m = re.exec(text)) !== null) {
      var before = text.slice(last, m.index);
      if (before) out += "<p>" + inline(esc(before)) + "</p>";
      var jHtml = journalHtml(m[0]);
      out += jHtml ? jHtml : "<p>" + inline(esc(m[0])) + "</p>";
      last = re.lastIndex;
    }
    var after = text.slice(last);
    if (after) out += "<p>" + inline(esc(after)) + "</p>";
    return out;
  }

  /* ---------- 搜索命中：片段提取 / DOM 高亮 / 命中跳转 ---------- */

  // 从 content 中提取所有命中位置，合并近距离命中成片段，返回 { total, segCount, html }
  // html 里的关键词用 <mark> 包裹（分片转义，无 XSS 风险）
  function buildSnippets(e, q) {
    var text = e.content || "";
    if (!q || !text) return null;
    var lower = text.toLowerCase();
    var positions = [];
    var p = lower.indexOf(q);
    while (p !== -1) { positions.push(p); p = lower.indexOf(q, p + q.length); }
    if (!positions.length) return { total: 0, segCount: 0, html: "" };
    var segments = [];
    positions.forEach(function (pos) {
      var segStart = Math.max(0, pos - 40);
      var segEnd = Math.min(text.length, pos + q.length + 60);
      var last = segments[segments.length - 1];
      if (last && segStart <= last.end + 30) {
        last.end = Math.max(last.end, segEnd);
        last.hits.push(pos);
      } else {
        segments.push({ start: segStart, end: segEnd, hits: [pos] });
      }
    });
    var htmlParts = segments.slice(0, 3).map(function (seg) {
      var html = seg.start > 0 ? "…" : "";
      var cursor = seg.start;
      seg.hits.forEach(function (hp) {
        html += esc(text.slice(cursor, hp));
        html += '<mark>' + esc(text.slice(hp, hp + q.length)) + "</mark>";
        cursor = hp + q.length;
      });
      html += esc(text.slice(cursor, seg.end));
      if (seg.end < text.length) html += "…";
      return html;
    });
    return { total: positions.length, segCount: segments.length, html: htmlParts.join("<br>") };
  }

  // 对 rootEl 内所有文本节点做关键词高亮（安全：只处理文本节点，不碰标签属性）
  function highlightInDom(rootEl, q) {
    if (!q) return 0;
    var lowerQ = q.toLowerCase();
    var walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null, false);
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    var count = 0;
    nodes.forEach(function (n) {
      var text = n.nodeValue;
      var lower = text.toLowerCase();
      if (lower.indexOf(lowerQ) === -1) return;
      var frag = document.createDocumentFragment();
      var i = 0, idx;
      while ((idx = lower.indexOf(lowerQ, i)) !== -1) {
        if (idx > i) frag.appendChild(document.createTextNode(text.slice(i, idx)));
        var m = document.createElement("mark");
        m.textContent = text.slice(idx, idx + lowerQ.length);
        frag.appendChild(m);
        i = idx + lowerQ.length;
        count++;
      }
      if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)));
      n.parentNode.replaceChild(frag, n);
    });
    return count;
  }

  // 「下一处命中」：跳到下一个 mark 并滚动定位（循环）
  function jumpToNextHit(detailEl, btn) {
    var marks = detailEl.querySelectorAll("mark");
    if (!marks.length) return;
    var nextIdx = 0;
    for (var i = 0; i < marks.length; i++) {
      if (marks[i].classList.contains("hit-focus")) { nextIdx = (i + 1) % marks.length; break; }
    }
    for (var j = 0; j < marks.length; j++) marks[j].classList.remove("hit-focus");
    var target = marks[nextIdx];
    target.classList.add("hit-focus");
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    btn.textContent = "下一处 ↓ " + (nextIdx + 1) + "/" + marks.length;
  }

  /* ---------- 卡片渲染 ---------- */
  function sourceHtml(e) {
    if (e.url) {
      return '来源：<a href="' + e.url + '" target="_blank" rel="noopener">' + esc(e.source) + "</a>";
    }
    return "来源：" + esc(e.source);
  }

  // 把内容渲染为 detail-html：有内容则返回 mdToHtml，否则空
  function renderDetail(e, mode, idx) {
    if (!e.content) return "";
    if (e.content.indexOf("[[待OCR填充]]") !== -1) {
      return '<p class="muted">⏳ OCR 全文识别尚未完成，本章内容稍后补全。可到 <code>会计知识文档/企业会计准则应用指南汇编2024 上册.pdf</code>（或下册）查看原文对应章节。</p>';
    }
    if (mode === "full" || e.content.length <= CONTENT_PREVIEW) {
      return mdToHtml(e.content);
    }
    // preview：长 content 只显示前 N 字符预览 + 内层 展开全文 按钮
    return mdToHtml(e.content.slice(0, CONTENT_PREVIEW))
      + '<div class="card-detail-foot">已显示前 ' + CONTENT_PREVIEW + ' 字符（共 ' + e.content.length + '）'
      + '<button class="full-toggle" data-idx="' + idx + '">展开全文 ▾</button>'
      + '</div>';
  }

  function cardHtml(e, idx) {
    var tags = (e.tags || []).map(function (t) { return '<span class="tag">' + esc(t) + "</span>"; }).join("");
    var hasDetail = e.content && e.content.trim().length > 0;

    // 搜索时：content 有命中 → 用片段替代 summary；无命中 → 保持 summary
    var bodyHtml;
    if (state.q) {
      var snip = buildSnippets(e, state.q);
      if (snip && snip.total > 0) {
        bodyHtml = '<div class="card-snippet">' + snip.html + "</div>"
          + '<div class="hit-count">content 中共 ' + snip.total + " 处命中"
          + (snip.segCount > 3 ? "，以下为前 3 处" : "") + "</div>";
      } else {
        bodyHtml = e.summary ? '<p class="card-summary">' + esc(e.summary) + "</p>" : "";
      }
    } else {
      bodyHtml = e.summary ? '<p class="card-summary">' + esc(e.summary) + "</p>" : "";
    }

    var detailBtn = hasDetail ? '<button class="toggle-btn" data-idx="' + idx + '">展开全文 ▾</button>' : "";
    var detail = hasDetail
      ? '<div class="card-detail" data-idx="' + idx + '" data-mode="preview">' + renderDetail(e, "preview", idx) + "</div>"
      : "";

    return '<article class="card" data-idx="' + idx + '">'
      + '<div class="card-top"><span class="card-title">' + esc(e.title) + "</span></div>"
      + '<div class="card-meta"><span>' + (catNames[e.cat] || e.cat) + "</span>"
      + "<span>" + esc(e.date || "") + "</span>"
      + "<span>" + sourceHtml(e) + "</span></div>"
      + bodyHtml
      + (tags ? '<div class="tags">' + tags + "</div>" : "")
      + detailBtn + detail + "</article>";
  }

  /* ---------- 首页统计面板 ---------- */
  function renderStats() {
    var el = $("statsPanel");
    if (!el) return;
    if (state.cat !== "all" || state.q) { el.hidden = true; return; }
    el.hidden = false;
    var byCat = {};
    entries.forEach(function (e) { byCat[e.cat] = (byCat[e.cat] || 0) + 1; });
    var dates = entries.map(function (e) { return e.date || ""; }).filter(Boolean).sort();
    var chips = Object.keys(byCat).sort(function (a, b) { return byCat[b] - byCat[a]; }).map(function (c) {
      return '<button class="stat-chip" data-cat="' + c + '">' + esc(catNames[c] || c)
        + ' <b>' + byCat[c] + "</b></button>";
    }).join("");
    el.innerHTML = '<div class="stats-head"><strong>' + entries.length + '</strong> 条知识条目 · <strong>'
      + Object.keys(byCat).length + '</strong> 个栏目 · 最近更新 ' + esc(dates[dates.length - 1] || "—")
      + '</div><div class="stats-chips">' + chips + "</div>";
  }

  /* ---------- 首页场景化入口：把业务问题变成一键可达 ---------- */
  var SCENES = [
    { q: "资金占用怎么认定？", kw: "资金占用", desc: "关联方资金往来与披露口径" },
    { q: "哪些交易要提交股东会审议？", kw: "股东会", desc: "审议权限与披露门槛" },
    { q: "存货跌价准备怎么计提？", kw: "存货跌价", desc: "资产减值与常见差错" },
    { q: "关联交易怎么披露？", kw: "关联交易", desc: "累计计算与防止非关联化" },
    { q: "哪些情形触发退市风险警示？", kw: "风险警示", desc: "财务类与规范类指标" },
    { q: "财务造假会被怎么处罚？", kw: "财务造假", desc: "处罚案例与责任认定" }
  ];
  function countSceneHits(kw) {
    // 用与真实搜索完全相同的 filter() 口径计数，避免卡片数字与点进去的结果对不上
    var savedQ = state.q, savedCat = state.cat;
    state.q = kw.toLowerCase();
    state.cat = "all";
    var n = filter().length;
    state.q = savedQ;
    state.cat = savedCat;
    return n;
  }
  function renderScenes() {
    var el = $("scenePanel");
    if (!el) return;
    if (state.cat !== "all" || state.q) { el.hidden = true; return; }
    el.hidden = false;
    var cards = SCENES.map(function (s) {
      return '<button class="scene-card" data-kw="' + esc(s.kw) + '" data-q="' + esc(s.q) + '">'
        + '<span class="scene-q">' + esc(s.q) + '</span>'
        + '<span class="scene-desc">' + esc(s.desc) + '</span>'
        + '<span class="scene-actions"><span class="scene-hit">' + countSceneHits(s.kw)
        + ' 条结果</span><span class="scene-ai">问 AI ▸</span></span></button>';
    }).join("");
    el.innerHTML = '<div class="scene-head">常见业务场景 · 点卡片直接查，点「问 AI」交给助手</div>'
      + '<div class="scene-grid">' + cards + '</div>';
  }
  var sceneEl = $("scenePanel");
  if (sceneEl) sceneEl.addEventListener("click", function (ev) {
    var card = ev.target.closest(".scene-card");
    if (!card) return;
    if (ev.target.closest(".scene-ai")) {
      if (window.KB_askQuestion) window.KB_askQuestion(card.getAttribute("data-q"));
      return;
    }
    var allBtn = navEl.querySelector('.nav-item[data-cat="all"]');
    if (allBtn && state.cat !== "all") allBtn.click();
    var kw = card.getAttribute("data-kw");
    inputEl.value = kw;
    state.q = kw.toLowerCase();
    render();
  });

  /* ---------- 右侧本页目录：按当前结果原有顺序列出，> 5 条才出现 ---------- */
  var tocEl = $("tocPanel");
  var tocCards = [], tocItems = [];
  var tocTicking = false;

  function renderToc(list) {
    if (!tocEl) return;
    var rightBar = document.querySelector('.resizer[data-side="right"]');
    if (list.length <= 5) {
      tocEl.hidden = true;
      tocEl.innerHTML = "";
      tocCards = []; tocItems = [];
      if (rightBar) rightBar.style.display = "none";
      return;
    }
    tocEl.hidden = false;
    if (rightBar) rightBar.style.display = "";
    tocEl.innerHTML = '<div class="toc-head">本页目录 <span>' + list.length + ' 条</span></div>'
      + '<div class="toc-list">' + list.map(function (e, i) {
        var t = esc(e.title).replace(/"/g, "&quot;");
        return '<button class="toc-item" data-n="' + i + '" title="' + t + '">' + t + '</button>';
      }).join("") + '</div>';
    tocCards = contentEl.querySelectorAll(".card");
    tocItems = tocEl.querySelectorAll(".toc-item");
    updateTocActive();
  }

  function updateTocActive() {
    if (!tocItems.length) return;
    var best = 0;
    for (var i = 0; i < tocCards.length; i++) {
      if (tocCards[i].getBoundingClientRect().top <= 160) best = i;
      else break;
    }
    tocItems.forEach(function (it, i) { it.classList.toggle("active", i === best); });
    // 只滚目录自身，不带动页面滚动
    var act = tocItems[best];
    if (!act) return;
    var listEl = tocEl.querySelector(".toc-list");
    if (!listEl) return;
    var ar = act.getBoundingClientRect(), lr = listEl.getBoundingClientRect();
    if (ar.top < lr.top) listEl.scrollTop -= (lr.top - ar.top);
    else if (ar.bottom > lr.bottom) listEl.scrollTop += (ar.bottom - lr.bottom);
  }

  if (tocEl) {
    tocEl.addEventListener("click", function (ev) {
      var it = ev.target.closest(".toc-item");
      if (!it) return;
      var card = tocCards[parseInt(it.getAttribute("data-n"), 10)];
      if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    window.addEventListener("scroll", function () {
      if (tocTicking) return;
      tocTicking = true;
      requestAnimationFrame(function () { updateTocActive(); tocTicking = false; });
    }, { passive: true });
  }

  /* ---------- 左右栏宽度拖拽调节（宽度记在本机） ---------- */
  var SB_KEY = "kb_sidebar_w", TOC_KEY = "kb_toc_w";
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function getVar(name, def) {
    return parseInt(getComputedStyle(document.documentElement).getPropertyValue(name), 10) || def;
  }
  (function applySavedWidths() {
    try {
      var sw = parseInt(localStorage.getItem(SB_KEY), 10);
      if (sw) document.documentElement.style.setProperty("--sidebar-w", clamp(sw, 200, 480) + "px");
      var tw = parseInt(localStorage.getItem(TOC_KEY), 10);
      if (tw) document.documentElement.style.setProperty("--toc-w", clamp(tw, 180, 420) + "px");
    } catch (e) {}
  })();

  document.querySelectorAll(".resizer").forEach(function (bar) {
    bar.addEventListener("mousedown", function (ev) {
      ev.preventDefault();
      var side = bar.getAttribute("data-side");
      var varName = side === "left" ? "--sidebar-w" : "--toc-w";
      var startX = ev.clientX;
      var startW = getVar(varName, side === "left" ? 260 : 236);
      var pending = startW;
      document.body.classList.add("resizing");
      bar.classList.add("active");
      function move(e) {
        // 按相对位移算，避免手柄自身宽度带来的偏差
        var w = side === "left"
          ? clamp(startW + (e.clientX - startX), 200, 480)
          : clamp(startW - (e.clientX - startX), 180, 420);
        document.documentElement.style.setProperty(varName, w + "px");
        pending = w;
      }
      function up() {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        document.body.classList.remove("resizing");
        bar.classList.remove("active");
        try { localStorage.setItem(side === "left" ? SB_KEY : TOC_KEY, String(pending)); } catch (e) {}
      }
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  });

  function render() {
    var list = filter();
    var info = "共 " + list.length + " 条";
    if (state.cat !== "all") info += " · " + (catNames[state.cat] || state.cat);
    if (state.q) info += ' · 关键词「' + state.q + "」" + (mini ? " · 按相关度排序" : "");
    $("resultInfo").textContent = info;
    renderStats();
    renderScenes();
    focusIdx = -1;

    if (!list.length) {
      contentEl.innerHTML = '<div class="empty">没有匹配的条目。<br>换个关键词试试，或等每周更新后再来。</div>';
      renderToc([]);
      return;
    }
    contentEl.innerHTML = list.map(function (e) { return cardHtml(e, entries.indexOf(e)); }).join("");
    renderToc(list);

    // 搜索时：对所有 detail（含未展开的 preview）做关键词高亮，展开后即可见
    if (state.q) {
      contentEl.querySelectorAll(".card-detail").forEach(function (d) {
        highlightInDom(d, state.q);
      });
    }
  }

  /* ---------- 展开/收起 ---------- */
  contentEl.addEventListener("click", function (ev) {
    var btn = ev.target.closest(".toggle-btn");
    var fullBtn = ev.target.closest(".full-toggle");
    var hitBtn = ev.target.closest(".hit-toggle");

    // 「下一处命中 ↓」按钮（仅在搜索状态 + 全文展开后出现）
    if (hitBtn) {
      ev.stopPropagation();
      jumpToNextHit(hitBtn.closest(".card-detail"), hitBtn);
      return;
    }

    // 内层「展开全文 / 收起」按钮（针对长 content 的第二层切换）
    if (fullBtn && !btn) {
      ev.stopPropagation();
      var idx = parseInt(fullBtn.getAttribute("data-idx"), 10);
      var detailEl = fullBtn.closest(".card-detail");
      var e = entries[idx];
      if (!e || !e.content) return;
      if (detailEl.getAttribute("data-mode") === "full") {
        // 当前是全文 → 收起回预览，并滚回章节首部让用户看清已收起
        detailEl.setAttribute("data-mode", "preview");
        detailEl.innerHTML = renderDetail(e, "preview", idx);
        if (state.q) highlightInDom(detailEl, state.q);
        detailEl.closest(".card").scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        // 当前是预览 → 展开全文
        detailEl.setAttribute("data-mode", "full");
        detailEl.innerHTML = mdToHtml(e.content)
          + '<div class="card-detail-foot">共 ' + e.content.length + ' 字符'
          + '<button class="full-toggle" data-idx="' + idx + '">收起 ▴</button>'
          + '</div>';
        if (state.q) {
          highlightInDom(detailEl, state.q);
          var marks = detailEl.querySelectorAll("mark");
          if (marks.length) {
            var foot = detailEl.querySelector(".card-detail-foot");
            var jb = document.createElement("button");
            jb.className = "hit-toggle";
            jb.textContent = "下一处 ↓ 0/" + marks.length;
            foot.insertBefore(jb, foot.firstChild);
          }
        }
      }
      return;
    }

    // 外层「展开全文/收起」按钮
    if (!btn) return;
    var card = btn.closest(".card");
    var open = card.classList.toggle("open");
    btn.textContent = open ? "收起 ▴" : "展开全文 ▾";

    var detail = card.querySelector(".card-detail");
    if (!detail) return;
    var idx = parseInt(btn.getAttribute("data-idx"), 10);
    var e = entries[idx];

    if (open && detail.getAttribute("data-mode") === "preview") {
      // 如果该条目还没渲染全文，先按 preview 渲染（renderDetail 已经做过）
      // 这里不用再做什么，detail 在 cardHtml 时已渲染过 preview
    }
    if (!open) {
      // 收起时，detail 的内容保持在内存中（其实还在 DOM 里，只是不显示）
      // 这里保留不动，因为 display:none 已经隐藏了
    }
  });

  /* ---------- 键盘：Ctrl+K 定位 / ↑↓ 选择 / Enter 展开 / Esc 清空 ---------- */
  var focusIdx = -1;
  function setFocus(n) {
    var cards = contentEl.querySelectorAll(".card");
    if (!cards.length) return;
    focusIdx = (n + cards.length) % cards.length;
    cards.forEach(function (c, i) { c.classList.toggle("card-focus", i === focusIdx); });
    cards[focusIdx].scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  document.addEventListener("keydown", function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "k") {
      ev.preventDefault(); inputEl.focus(); inputEl.select(); return;
    }
    if (ev.key === "Escape" && document.activeElement === inputEl) {
      inputEl.value = ""; state.q = ""; render(); return;
    }
    if (document.activeElement !== inputEl) return;
    if (ev.key === "ArrowDown") { ev.preventDefault(); setFocus(focusIdx + 1); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); setFocus(focusIdx - 1); }
    else if (ev.key === "Enter") {
      var cards = contentEl.querySelectorAll(".card");
      if (focusIdx >= 0 && cards[focusIdx]) {
        var b = cards[focusIdx].querySelector(".toggle-btn");
        if (b) b.click();
      }
    }
  });

  /* ---------- 统计面板点击 → 切换栏目 ---------- */
  var statsEl = $("statsPanel");
  if (statsEl) statsEl.addEventListener("click", function (ev) {
    var chip = ev.target.closest(".stat-chip");
    if (!chip) return;
    var btn = navEl.querySelector('.nav-item[data-cat="' + chip.getAttribute("data-cat") + '"]');
    if (!btn) return;
    // 目标栏目若在被折叠的分组里，先展开，免得点了看不到导航高亮
    var gkey = btn.getAttribute("data-group");
    if (gkey && groups[gkey] && groups[gkey].collapsed) setGroupCollapsed(gkey, false, true);
    btn.click();
  });

  /* ---------- 供 AI 出处按钮调用：跳到条目、展开全文、定位命中片段 ---------- */
  function countOcc(s, t) {
    var n = 0, i = 0;
    while ((i = s.indexOf(t, i)) !== -1) { n++; i += t.length; }
    return n;
  }
  window.KB_openEntry = function (idx, q) {
    var e = entries[idx];
    if (!e) return;
    var allBtn = navEl.querySelector('.nav-item[data-cat="all"]');
    if (allBtn) allBtn.click();
    inputEl.value = e.title;
    state.q = e.title.toLowerCase();
    render();
    var card = contentEl.querySelector(".card");
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "start" });
    var detail = card.querySelector(".card-detail");
    if (!detail || !e.content) return;
    card.classList.add("open");
    var tb = card.querySelector(".toggle-btn");
    if (tb) tb.textContent = "收起 ▴";
    detail.setAttribute("data-mode", "full");
    detail.innerHTML = mdToHtml(e.content);
    // 取问题里「在该条目正文出现次数最少」的二元词：定位最准，mark 数量也最少
    var toks = kbTokenize(q || "").filter(function (t) {
      return (e.content || "").indexOf(t) !== -1;
    }).sort(function (a, b) { return countOcc(e.content, a) - countOcc(e.content, b); });
    if (toks.length) highlightInDom(detail, toks[0]);
    var first = detail.querySelector("mark");
    if (first) setTimeout(function () { first.scrollIntoView({ behavior: "smooth", block: "center" }); }, 150);
  };

  // 供 AI 问答面板复用同一套 markdown 渲染（答案富文本展示）
  window.KB_mdToHtml = mdToHtml;

  initSearchIndex();
  initCounts();
  render();
})();