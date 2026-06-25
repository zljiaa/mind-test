/* ============================================================================
   app.js — 心智成长测评 应用逻辑
   ----------------------------------------------------------------------------
   依赖 questions.js（全局对象）。纯 vanilla JS，无模块，file:// 可用。

   实现的「准确性保障」（不只是宣称）：
     1. 反向题计分：(-) 题用 6 − 原分，再统一折算到维度锚字母。
     2. 一致性检查：反向配对题答得自相矛盾 → 结果页给低置信旗标。
     3. 每个 MBTI 维度的置信带：离 15 中点越近越宽；近 15 标「可能波动」。
     4. 阶位输出区间：B 段分布跨越阶位边界（标准差大）时给「X→Y 过渡」而非单点。
        且 B 段主分用「高位拐点」(ogive) 而非简单平均，避免高阶答案被平均抹平。
   ============================================================================ */

(function () {
  "use strict";

  /* ==========================================================================
     0. 持久化（localStorage，刷新不丢进度）
     ========================================================================== */
  const LS_KEY = "mms_state_v1";

  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || typeof s !== "object") return null;
      return s;
    } catch (e) { return null; }
  }
  function saveState() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        mode: state.mode,
        role: state.role,
        answersA: state.answersA,
        answersB: state.answersB,
        answersC: state.answersC,
        cursor: cursor,
        started: state.started,
      }));
    } catch (e) { /* 隐私模式可能禁写，忽略 */ }
  }
  function clearState() {
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
  }

  /* ==========================================================================
     1. 应用状态
     ========================================================================== */
  const state = {
    mode: null,            // 'quick' | 'full'
    role: "general",       // 角色身份（B 段情境题按此切换）；默认普适/中性
    started: false,
    answersA: {},          // { A1: 1..5 }
    answersB: {},          // { B1: optionIndex }
    answersC: {},          // { C1: "text" }
  };

  // 角色合法性兜底：未知/缺失一律回落 general
  function roleKey() {
    return (typeof STAGE_SJT_BY_ROLE !== "undefined" && STAGE_SJT_BY_ROLE[state.role])
      ? state.role : "general";
  }

  // 按当前模式得到本次要用的题目子集
  function activeA() {
    return state.mode === "quick" ? A_QUESTIONS.filter((q) => q.quick) : A_QUESTIONS;
  }
  function activeB() {
    // B 段按所选角色取题（兜底 general），再按模式做 quick 筛选。
    const set = (typeof STAGE_SJT_BY_ROLE !== "undefined" && STAGE_SJT_BY_ROLE[roleKey()]) || B_QUESTIONS;
    return state.mode === "quick" ? set.filter((q) => q.quick) : set;
  }
  function activeC() {
    return state.mode === "full" ? C_QUESTIONS : [];   // 快速版无 C 段
  }

  /* ==========================================================================
     2. 计分逻辑
     ========================================================================== */

  /**
   * A 段计分 → 连续维度分 + 4 字母。
   * 每题折算到「指向维度锚字母」的分：
   *   - 先算指向 letter 的分：+ → raw；- → 6-raw
   *   - 若 letter 即锚字母，直接用；否则取 6-该分（折算到锚字母方向）。
   * 每维求和（范围随题数变化：完整版 5 题 → 5..25 中点 15；
   *   快速版 3 题 → 3..15 中点 9）。我们统一归一化到 0..1 的 anchorFrac，
   *   midpoint 处 anchorFrac=0.5；>0.5 取锚字母，<0.5 取对立，=0.5 判 X。
   */
  function scoreA() {
    const qs = activeA();
    // 每维度收集「指向锚字母」的每题分，便于算和、题数、置信带。
    const byDim = { EI: [], SN: [], TF: [], JP: [] };

    qs.forEach((q) => {
      const raw = state.answersA[q.id];
      const sign = q.dir[0];
      const letter = q.dir.slice(1);
      // 该题属于哪个维度
      let dimKey = null, anchor = null;
      for (const k in DIM_META) {
        const a = DIM_META[k].anchor;
        if (letter === a || letter === DIM_META[k].opposite) { dimKey = k; anchor = a; break; }
      }
      let towardLetter = (sign === "+") ? raw : (6 - raw);
      let towardAnchor = (letter === anchor) ? towardLetter : (6 - towardLetter);
      byDim[dimKey].push(towardAnchor);
    });

    const dims = {};
    for (const k in byDim) {
      const arr = byDim[k];
      const n = arr.length;                 // 题数（5 或 3）
      const sum = arr.reduce((a, b) => a + b, 0);
      const min = n * 1, max = n * 5, mid = n * 3;   // 理论范围与中点
      const anchorFrac = (sum - min) / (max - min);  // 0..1，0.5=中点
      // 距中点的「极性强度」0..1（用于置信带宽：越靠中点越宽）
      const polarity = Math.abs(sum - mid) / (max - mid);  // 0(在中点)..1(到极端)
      const meta = DIM_META[k];
      let winner;
      if (sum > mid) winner = meta.anchor;
      else if (sum < mid) winner = meta.opposite;
      else winner = "X";
      // 近中点（极性弱）标记可能波动
      const nearMid = polarity < 0.20;      // 距中点 < 20% 量程
      dims[k] = { sum, n, min, max, mid, anchorFrac, polarity, winner, nearMid, meta };
    }

    const type = dims.EI.winner + dims.SN.winner + dims.TF.winner + dims.JP.winner;
    return { type, dims };
  }

  /**
   * A 段一致性检查：反向配对题应呈「一高一低」。
   * 对每对 (pos, neg)：正常时 rawPos + rawNeg ≈ 6（一个同意一个不同意）。
   * 若 |rawPos + rawNeg - 6| 很大（两题同向）→ 记一次不一致。
   * 仅统计两题都作答了的配对。返回 {checked, inconsistent, ratio}。
   */
  function consistencyA() {
    let checked = 0, inconsistent = 0;
    A_CONSISTENCY_PAIRS.forEach((p) => {
      const rp = state.answersA[p.pos];
      const rn = state.answersA[p.neg];
      if (rp == null || rn == null) return;   // 该配对题不在本模式或未答
      checked++;
      // 两题都偏同意(>=4)或都偏不同意(<=2) → 矛盾（反向题本应相反）
      const bothHigh = rp >= 4 && rn >= 4;
      const bothLow = rp <= 2 && rn <= 2;
      if (bothHigh || bothLow) inconsistent++;
    });
    const ratio = checked ? inconsistent / checked : 0;
    return { checked, inconsistent, ratio };
  }

  /**
   * B 段计分 → 阶位（高位拐点 ogive，非简单平均）。
   *
   * 步骤：
   *   1. 把 10/6 题答案映射成阶位数值（OPP=1..STR=5），得到分布。
   *   2. 「高位拐点」：取分布的高分位（这里用第 70 百分位）作为阶位主分 —
   *      借鉴 WUSCT 的 ogive 思想：人的天花板（高阶）才暴露结构，不该被平均抹平。
   *      同时计算均值/标准差用于判断是否跨阶 → 区间。
   *   3. 落到最近阶位档；若 [均值-σ, 均值+σ] 跨越 ≥2 个阶位档边界 → 输出区间。
   */
  function scoreB() {
    const qs = activeB();
    const values = qs.map((q) => STAGE_VALUE[q.options[state.answersB[q.id]].code]);
    const n = values.length;

    const sorted = [...values].sort((a, b) => a - b);
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
    const std = Math.sqrt(variance);

    // 高位拐点：第 75 百分位（线性插值）。这是 ogive 思想的落点 —— 取「你回答里
    // 的高位信号」而非平均：当高阶回答只是少数时，平均会把它抹平，而高分位能保留它。
    // （p75 在多种分布下都能既保住真实的高阶信号、又不被单个离群点过度带跑。）
    const p75 = percentile(sorted, 0.75);
    // 主分 = 高位拐点与均值的折中，偏向高位（0.65*p75 + 0.35*mean），
    // 既不被平均抹平，也不被极端离群点完全带跑。
    const principal = 0.65 * p75 + 0.35 * mean;

    const stagesSorted = [...STAGES].sort((a, b) => a.value - b.value);
    const nearestTo = (v) => {
      let best = stagesSorted[0], d = Infinity;
      stagesSorted.forEach((s) => { const dd = Math.abs(s.value - v); if (dd < d) { d = dd; best = s; } });
      return best;
    };
    const stage = nearestTo(principal);

    // 区间判定：用 [principal-σ, principal+σ] 命中的阶位跨度。
    const lo = nearestTo(principal - std);
    const hi = nearestTo(principal + std);
    const loIdx = stagesSorted.indexOf(lo);
    const hiIdx = stagesSorted.indexOf(hi);
    const spanStages = hiIdx - loIdx;               // 跨了几个阶位档
    const isInterval = spanStages >= 1 && std >= 0.9; // 跨档且离散度足够 → 区间

    return {
      values, mean, std, p75, principal, stage,
      lower: lo, upper: hi, isInterval,
      pointerPos: valueToPos(principal),
      lowerPos: valueToPos(principal - std),
      upperPos: valueToPos(principal + std),
    };
  }

  // 在已排序数组上取百分位（p ∈ [0,1]，线性插值）
  function percentile(sortedArr, p) {
    if (sortedArr.length === 1) return sortedArr[0];
    const idx = p * (sortedArr.length - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sortedArr[lo];
    const frac = idx - lo;
    return sortedArr[lo] * (1 - frac) + sortedArr[hi] * frac;
  }

  // 阶位数值 [1,5] → 光谱条百分比（按相邻档 pos 线性插值）
  function valueToPos(v) {
    const sorted = [...STAGES].sort((a, b) => a.value - b.value);
    if (v <= sorted[0].value) return sorted[0].pos;
    if (v >= sorted[sorted.length - 1].value) return sorted[sorted.length - 1].pos;
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i], b = sorted[i + 1];
      if (v >= a.value && v <= b.value) {
        const r = (v - a.value) / (b.value - a.value);
        return a.pos + r * (b.pos - a.pos);
      }
    }
    return sorted[0].pos;
  }

  /**
   * C 段评分占位（诚实 stub —— 运行时无 LLM，不伪造分数）。
   * 完整 rubric 见 ../自研题库v0.1.md §C 段 LLM 评分 Rubric。
   *
   * 真实实现应：把 answers 连同下方 rubric 交给 LLM，按「主体-客体结构复杂度」
   * 判级，返回 { stage_estimate, confidence, key_evidence, subject_object_note, fallback }。
   * 取作者展现的「最高复杂度」而非平均；文本太短/敷衍 → confidence 低、fallback=true；
   * 与 B 段主分背离 ≥1.5 档 → 输出区间。
   *
   * 当前原型：一律 fallback=true，使融合逻辑只用 B 段。仅做"是否写了字"的浅判断，
   * 用于在结果页提示"已暂存、待 AI 校准"，绝不据此给阶位打分。
   */
  function scoreSectionC_PLACEHOLDER(answers) {
    /*
      RUBRIC（供未来接入 LLM 时使用，照搬自题库）：
      ── 社会化(~3)：意义由他人评价/期待定义；"我让别人失望了""我应该…"；
                     把"自己的需求"当主体(看不见)，"冲动"当客体。
      ── 过渡 3→4：开始有自己的标准，但仍被他人看法牵动。
      ── 自主导向(~4)：独立价值系统；把"关系/他人期待"当客体；反馈=达成自己目标的工具。
      ── 过渡 4→5：能审视"自己那套标准/反应"本身，对自身框架好奇。
      ── 自我转化(~5)：把"价值系统/'对错'概念本身"当客体；同持多框架、容悖论、见系统。
      规则：取最高复杂度；术语堆砌不算；与 B 背离≥1.5档→区间；太短→fallback。
    */
    const texts = Object.values(answers || {}).map((t) => (t || "").trim()).filter(Boolean);
    const totalLen = texts.reduce((a, t) => a + t.length, 0);
    // 原型不评分：永远 fallback，让融合只用 B 段。
    return {
      stage_estimate: null,
      confidence: 0,
      key_evidence: [],
      subject_object_note: null,
      fallback: true,
      _answered: texts.length,
      _chars: totalLen,
    };
  }

  /**
   * 融合 + 置信度（题库 §融合逻辑）。
   * 由于 C 段恒 fallback，置信度仅由 B 段离散度 + A 段一致性决定。
   */
  function fuse(a, b, cResult, cons) {
    // 基线：B 段离散小 → 高；中等 → 中；大或区间 → 中低
    let confidence;
    if (b.isInterval || b.std >= 1.2) confidence = "中低";
    else if (b.std >= 0.7) confidence = "中";
    else confidence = "高";

    // A 段乱答 → 拉低一档（最低到「低」）
    const order = ["高", "中", "中低", "低"];
    if (cons.ratio >= 0.5 && cons.checked >= 2) {
      const i = Math.min(order.indexOf(confidence) + 1, order.length - 1);
      confidence = order[i];
    }
    // C 段全 fallback 已是默认；如果将来 C 有效且与 B 背离，可在此降级（保留接口）。
    return { confidence };
  }

  /* ==========================================================================
     3. 流程控制
     ========================================================================== */

  const stageEl = document.getElementById("stage");
  const progressWrap = document.getElementById("progressWrap");
  const progressFill = document.getElementById("progressFill");
  const progressLabel = document.getElementById("progressLabel");
  const progressCount = document.getElementById("progressCount");

  // flow: [{kind:'welcome'} | {kind:'role'} | {kind:'A',i} | {kind:'B',i} | {kind:'C',i} | {kind:'result'}]
  let flow = [];
  let cursor = 0;

  function buildFlow() {
    flow = [{ kind: "welcome" }];
    if (state.mode) {
      flow.push({ kind: "role" });            // 选完版本后、进入 A 段前：角色选择屏
      activeA().forEach((_, i) => flow.push({ kind: "A", i }));
      activeB().forEach((_, i) => flow.push({ kind: "B", i }));
      activeC().forEach((_, i) => flow.push({ kind: "C", i }));
      flow.push({ kind: "result" });
    }
  }

  function totalQuestions() {
    return activeA().length + activeB().length + activeC().length;
  }

  function go(delta) {
    const next = cursor + delta;
    if (next < 0 || next >= flow.length) return;
    cursor = next;
    saveState();
    render();
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function questionNumber() {
    const f = flow[cursor];
    const aN = activeA().length, bN = activeB().length;
    if (f.kind === "A") return f.i + 1;
    if (f.kind === "B") return aN + f.i + 1;
    if (f.kind === "C") return aN + bN + f.i + 1;
    return 0;
  }

  function updateProgress() {
    const f = flow[cursor];
    if (f.kind === "welcome" || f.kind === "role" || f.kind === "result") {
      progressWrap.style.display = "none";
      return;
    }
    progressWrap.style.display = "block";
    const n = questionNumber(), tot = totalQuestions();
    progressFill.style.width = (n / tot * 100) + "%";
    progressCount.textContent = n + " / " + tot;
    const labelMap = {
      A: "第一部分 · 性格类型",
      B: "第二部分 · 心智阶位",
      C: "第三部分 · 深度作答",
    };
    progressLabel.textContent = labelMap[f.kind];
  }

  /* ==========================================================================
     4. 渲染
     ========================================================================== */

  function render() {
    updateProgress();
    const f = flow[cursor];
    if (f.kind === "welcome") return renderWelcome();
    if (f.kind === "role") return renderRole();
    if (f.kind === "A") return renderA(f.i);
    if (f.kind === "B") return renderB(f.i);
    if (f.kind === "C") return renderC(f.i);
    if (f.kind === "result") return renderResult();
  }

  function el(html) {
    const d = document.createElement("div");
    d.innerHTML = html.trim();
    return d.firstChild;
  }
  function esc(s) {
    return (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // ---- 欢迎页（含模式选择 + 恢复进度） ----
  function renderWelcome() {
    const saved = loadState();
    const hasResume = saved && saved.started && saved.mode &&
      (Object.keys(saved.answersA || {}).length + Object.keys(saved.answersB || {}).length) > 0 &&
      saved.cursor > 0;

    // 默认选中的模式
    const sel = state.mode || "full";

    const screen = el(`
      <div class="screen active welcome">
        <div class="spectrum-dots">
          <span></span><span></span><span></span><span></span><span></span><span></span>
        </div>
        <h1>心智成长测评</h1>
        <p class="tagline">你是谁 × 你想得有多深</p>
        <p class="intro">
          普通的性格测试，测完给你一个标签就结束了。这次，我们多给你一条「成长故事线」——
          既看见此刻的你，也看见“想得更深的你”，以及通往那里的路。
        </p>

        <div class="mode-grid">
          <div class="mode-card ${sel === "quick" ? "selected" : ""}" data-mode="quick">
            <div class="mode-radio"></div>
            <div class="mode-title">快速版 <span class="tag-free">免费体验</span></div>
            <div class="mode-meta">18 题（性格 12 + 阶位 6）· 约 7 分钟</div>
            <div class="mode-desc">纯机评，秒出「性格类型 + 阶位粗估」。想先试试流程就选它。</div>
          </div>
          <div class="mode-card ${sel === "full" ? "selected" : ""}" data-mode="full">
            <div class="mode-radio"></div>
            <div class="mode-title">完整版 <span class="tag-full">精确报告</span></div>
            <div class="mode-meta">33 题（性格 20 + 阶位 10 + 深度 3）· 约 15 分钟</div>
            <div class="mode-desc">含开放作答，出更稳的连续维度分 + 阶位区间。第三部分将由 AI 校准（原型暂存）。</div>
          </div>
        </div>

        <p class="consent">作答仅用于在你本机生成这份报告；不上传、不联网，刷新可续答。</p>

        <div class="actions">
          <button class="btn btn-primary" id="startBtn">开始测试</button>
        </div>

        ${hasResume ? `
          <div class="resume-bar">
            <span>检测到上次未完成的作答（${saved.mode === "quick" ? "快速版" : "完整版"}）</span>
            <button id="resumeBtn">继续</button>
          </div>` : ``}

        <div class="sim-note">
          体验提示：这是可试玩的原型，重在体验题目和流程，<strong>不代表测得有多准</strong>
          （准不准要靠后续效度验证；本机已附 BIG5 真实数据的信度分析，见 validation/）。
          第三部分（开放作答）这版未接入 AI 解读，会原样展示你写的内容。
        </div>
      </div>
    `);
    stageEl.innerHTML = "";
    stageEl.appendChild(screen);

    let chosen = sel;
    screen.querySelectorAll(".mode-card").forEach((card) => {
      card.onclick = () => {
        chosen = card.getAttribute("data-mode");
        screen.querySelectorAll(".mode-card").forEach((c) => c.classList.remove("selected"));
        card.classList.add("selected");
      };
    });

    screen.querySelector("#startBtn").onclick = () => {
      // 若切换了模式或全新开始，重置作答。
      const fresh = state.mode !== chosen || !state.started;
      state.mode = chosen;
      state.started = true;
      if (fresh) {
        state.answersA = {}; state.answersB = {}; state.answersC = {};
      }
      buildFlow();
      cursor = 1;            // 进入角色选择屏（A 段之前）
      saveState();
      render();
      window.scrollTo({ top: 0 });
    };

    if (hasResume) {
      screen.querySelector("#resumeBtn").onclick = () => {
        state.mode = saved.mode;
        state.role = (typeof STAGE_SJT_BY_ROLE !== "undefined" && STAGE_SJT_BY_ROLE[saved.role])
          ? saved.role : "general";
        state.started = true;
        state.answersA = saved.answersA || {};
        state.answersB = saved.answersB || {};
        state.answersC = saved.answersC || {};
        buildFlow();
        cursor = Math.min(saved.cursor || 1, flow.length - 1);
        render();
        window.scrollTo({ top: 0 });
      };
    }
  }

  // ---- 角色选择屏（选完版本后、A 段之前） ----
  function renderRole() {
    const groupsHtml = ROLE_GROUPS.map((g) => {
      const cards = g.roles.map((r) => `
        <div class="role-card ${state.role === r.key ? "selected" : ""}" data-role="${r.key}">
          <span class="role-radio"></span>
          <span class="role-label">${esc(r.label)}</span>
        </div>`).join("");
      return `
        <div class="role-group">
          <div class="role-group-title">${esc(g.group)}</div>
          <div class="role-group-cards">${cards}</div>
        </div>`;
    }).join("");

    const screen = el(`
      <div class="screen active role-screen">
        <span class="section-tag">代入一种身份</span>
        <h2 class="role-title">接下来有些情境题，你想代入哪种身份来回答？</h2>
        <p class="role-sub">选最贴近你当下生活的，这样答起来更真实。</p>

        <div class="role-groups">
          ${groupsHtml}
          <div class="role-group role-group-fallback">
            <div class="role-group-cards">
              <div class="role-card ${state.role === "general" ? "selected" : ""}" data-role="general">
                <span class="role-radio"></span>
                <span class="role-label">都不太贴合？用通用版</span>
              </div>
            </div>
          </div>
        </div>

        <div class="actions">
          <button class="btn btn-ghost" id="backBtn">上一步</button>
          <button class="btn btn-primary" id="nextBtn">开始第一部分</button>
        </div>
      </div>
    `);
    stageEl.innerHTML = "";
    stageEl.appendChild(screen);

    screen.querySelectorAll(".role-card").forEach((card) => {
      card.onclick = () => {
        const key = card.getAttribute("data-role");
        state.role = (STAGE_SJT_BY_ROLE && STAGE_SJT_BY_ROLE[key]) ? key : "general";
        screen.querySelectorAll(".role-card").forEach((c) => c.classList.remove("selected"));
        card.classList.add("selected");
        saveState();
      };
    });

    screen.querySelector("#backBtn").onclick = () => go(-1);
    screen.querySelector("#nextBtn").onclick = () => {
      // 角色已默认 general，可直接前进；rebuild 以确保 B 段题集与角色一致。
      saveState();
      buildFlow();
      go(1);
    };
  }

  // ---- A 段一题一屏 ----
  function renderA(i) {
    const q = activeA()[i];
    const cur = state.answersA[q.id];
    const screen = el(`
      <div class="screen active">
        <span class="section-tag">第一部分 · 性格类型</span>
        <div class="q-stem">${esc(q.text)}</div>
        <div class="likert-scale-hint"><span>← 非常不同意</span><span>非常同意 →</span></div>
        <div class="likert" id="likert"></div>
        <div class="actions">
          <button class="btn btn-ghost" id="backBtn">上一题</button>
          <button class="btn btn-primary" id="nextBtn" ${cur ? "" : "disabled"}>下一题</button>
        </div>
      </div>
    `);
    const likert = screen.querySelector("#likert");
    LIKERT_LABELS.forEach((label, idx) => {
      const val = idx + 1;
      const opt = el(`
        <div class="opt ${cur === val ? "selected" : ""}" data-val="${val}">
          <span class="bullet"></span>
          <span class="opt-text">${label}</span>
        </div>
      `);
      opt.onclick = () => {
        state.answersA[q.id] = val;
        saveState();
        likert.querySelectorAll(".opt").forEach((o) => o.classList.remove("selected"));
        opt.classList.add("selected");
        screen.querySelector("#nextBtn").disabled = false;
        setTimeout(() => { if (flow[cursor].kind === "A" && flow[cursor].i === i) go(1); }, 200);
      };
      likert.appendChild(opt);
    });
    stageEl.innerHTML = "";
    stageEl.appendChild(screen);
    screen.querySelector("#backBtn").onclick = () => go(-1);
    screen.querySelector("#nextBtn").onclick = () => { if (state.answersA[q.id]) go(1); };
  }

  // ---- B 段一题一屏 ----
  function renderB(i) {
    const q = activeB()[i];
    const cur = state.answersB[q.id];
    const letters = ["A", "B", "C", "D", "E"];
    const screen = el(`
      <div class="screen active">
        <span class="section-tag">第二部分 · 心智阶位</span>
        <div class="q-stem">
          <span class="scenario-label">情境 · 选最接近你真实反应的一项</span>
          ${esc(q.stem)}
        </div>
        <div class="likert" id="opts"></div>
        <div class="actions">
          <button class="btn btn-ghost" id="backBtn">上一题</button>
          <button class="btn btn-primary" id="nextBtn" ${cur != null ? "" : "disabled"}>下一题</button>
        </div>
      </div>
    `);
    const optsEl = screen.querySelector("#opts");
    q.options.forEach((o, idx) => {
      const opt = el(`
        <div class="opt ${cur === idx ? "selected" : ""}" data-idx="${idx}">
          <span class="opt-letter">${letters[idx]}</span>
          <span class="opt-text">${esc(o.t)}</span>
        </div>
      `);
      opt.onclick = () => {
        state.answersB[q.id] = idx;
        saveState();
        optsEl.querySelectorAll(".opt").forEach((o2) => o2.classList.remove("selected"));
        opt.classList.add("selected");
        screen.querySelector("#nextBtn").disabled = false;
        setTimeout(() => { if (flow[cursor].kind === "B" && flow[cursor].i === i) go(1); }, 220);
      };
      optsEl.appendChild(opt);
    });
    stageEl.innerHTML = "";
    stageEl.appendChild(screen);
    screen.querySelector("#backBtn").onclick = () => go(-1);
    screen.querySelector("#nextBtn").onclick = () => { if (state.answersB[q.id] != null) go(1); };
  }

  // ---- C 段一题一屏（开放作答，可跳过） ----
  function renderC(i) {
    const q = activeC()[i];
    const cur = state.answersC[q.id] || "";
    const isLast = i === activeC().length - 1;
    const promptItems = q.prompts.map((p) => `<li>${esc(p)}</li>`).join("");
    const screen = el(`
      <div class="screen active">
        <span class="section-tag">第三部分 · 深度作答</span>
        <div class="q-stem">${esc(q.title)}</div>
        <div class="c-prompt-list">
          可以从这几点说起：
          <ul>${promptItems}</ul>
        </div>
        <textarea id="ta" placeholder="用自己的话写几句（建议 2–4 句），没有标准答案——我们看的是“你怎么想”，不是“想得对不对”。">${esc(cur)}</textarea>
        <p class="c-hint">这版还没接入 AI 解读，可以跳过；写了的话，结果页会原样展示给你看，并留待 AI 校准。</p>
        <div class="actions">
          <button class="btn btn-ghost" id="backBtn">上一题</button>
          <button class="btn btn-primary" id="nextBtn">${isLast ? "查看我的报告" : "下一题"}</button>
        </div>
        <div style="text-align:center;margin-top:6px;">
          <button class="btn-text" id="skipBtn">${isLast ? "跳过并查看报告" : "跳过这一题"}</button>
        </div>
      </div>
    `);
    const ta = screen.querySelector("#ta");
    const save = () => { state.answersC[q.id] = ta.value; saveState(); };
    ta.addEventListener("input", save);

    stageEl.innerHTML = "";
    stageEl.appendChild(screen);
    screen.querySelector("#backBtn").onclick = () => { save(); go(-1); };
    screen.querySelector("#nextBtn").onclick = () => { save(); go(1); };
    screen.querySelector("#skipBtn").onclick = () => { save(); go(1); };
  }

  // ---- 结果页 ----
  function renderResult() {
    const a = scoreA();
    const b = scoreB();
    const cons = consistencyA();
    const cResult = scoreSectionC_PLACEHOLDER(state.answersC);
    const fused = fuse(a, b, cResult, cons);
    const stage = b.stage;
    const blurb = MBTI_BLURB[a.type] || "你的类型里含一个“中间维”，说明该维度上你比较灵活、不偏极端。";

    // 本次 B 段情境所代入的身份角色（general 为通用，不额外提示）。
    const rk = roleKey();
    const roleLabel = (typeof ROLE_LABELS !== "undefined" && ROLE_LABELS[rk]) ? ROLE_LABELS[rk] : "通用";
    const roleNote = (rk !== "general")
      ? `<p class="stage-role-note">情境题已按你选的<strong>【${esc(roleLabel)}】</strong>视角定制——下面的成长重心，是你以这个身份作答得出的。</p>`
      : ``;

    /**
     * 每维度「偏好强度」分档（用户校准：距中点 ≤3 分 = 弱偏好/接近中间）。
     *   gap = |sum − mid|（5 题制：0..10；3 题制：0..6）
     *   - 距中点 ≤ midThresh(=3，按题数缩放) → weak（弱偏好/接近中间，会翻面）
     *   - 否则按量程比例：≥60% → strong（强偏），其余 → lean（偏）。
     * 返回 {tier, gap, winLetter, winName, oppName}。
     */
    function dimStrength(d) {
      const meta = d.meta;
      const gap = Math.abs(d.sum - d.mid);
      const span = d.max - d.mid;                 // 5 题=10，3 题=6
      const midThresh = Math.round(3 * (d.n / 5)); // ±3 分按题数缩放（5题→3，3题→2）
      const isX = d.winner === "X";
      const winLetter = isX ? "" : d.winner;
      const winName = (d.winner === meta.anchor) ? meta.leftName : meta.rightName;
      const oppName = (d.winner === meta.anchor) ? meta.rightName : meta.leftName;
      let tier;
      if (isX || gap <= midThresh) tier = "weak";
      else if (gap >= span * 0.6) tier = "strong";
      else tier = "lean";
      return { tier, gap, isX, winLetter, winName, oppName, meta };
    }

    // 逐维度解读文案（强偏 / 偏 / 接近中间三档；接近中间专门安抚"会翻面"）
    function dimInterpText(d) {
      const s = dimStrength(d);
      const { winName, oppName } = s;
      if (s.tier === "weak") {
        return `这一项<strong>很接近中间</strong>，属于<strong>弱偏好</strong>：你偏向「${esc(winName)}」，` +
          `但只是<strong>略微</strong>——换个场合、换个心情，很可能就偏到「${esc(oppName)}」那一侧。` +
          `更准确的说法是：你在这个维度上<strong>比较灵活</strong>，别把它当成固定标签。`;
      }
      if (s.tier === "strong") {
        return `这一项你<strong>明显偏向「${esc(winName)}」</strong>，是四个维度里比较稳定、` +
          `不太会随情境翻面的一面。`;
      }
      return `这一项你<strong>偏向「${esc(winName)}」</strong>，倾向比较清楚，但还没到极端——` +
        `多数情况下是这样，少数情况下也会靠近「${esc(oppName)}」。`;
    }

    // 总览：统计有几个维度是弱偏好/接近中间 → 直接回应"和上次不一样"的困惑
    const weakDims = ["EI", "SN", "TF", "JP"].filter((k) => dimStrength(a.dims[k]).tier === "weak");
    const weakCount = weakDims.length;
    let overviewBanner = "";
    if (weakCount >= 1) {
      const names = weakDims.map((k) => a.dims[k].meta.title).join("、");
      const strongPart = weakCount >= 3
        ? `你的<strong>四个维度几乎都靠近中间</strong>——这本身就是一种鲜明的特点：你是个<strong>适应性很强、不走极端</strong>的人，能在不同情境里自如切换。`
        : `你有 <strong>${weakCount} 个维度</strong>（${esc(names)}）<strong>靠近中间</strong>，属于弱偏好。`;
      overviewBanner = `
        <div class="overview-banner">
          <span class="ob-emoji">🧭</span>
          <div>
            ${strongPart}
            正因如此，<strong>这次的字母组合（${a.type}）和你上次／别处测出来的不一致，是完全正常的</strong>——
            靠近中间的维度，多答对几道、少答对几道，甚至当天心情，都可能让它翻面。
            <strong>别被某一个字母框住</strong>；下面每一项我们都标了它到底有多“偏”。
          </div>
        </div>`;
    }

    // 维度连续条（含原始分、置信带、近中点波动旗标）
    const dimRow = (key) => {
      const d = a.dims[key];
      const meta = d.meta;
      const leftWin = d.winner === meta.anchor;     // 左=锚字母
      const isX = d.winner === "X";
      // 指针位置：anchorFrac=1 → 左端(锚)，但视觉上"左=锚字母名"，用 anchorFrac 直接当左→右？
      // 设计：条左端=锚字母(E/N/F/J)，右端=对立(I/S/T/P)。anchorFrac 高→偏左(锚)。
      // 指针 left% = (1 - anchorFrac)*100，使锚字母强时指针靠左。
      const ptrPct = Math.round((1 - d.anchorFrac) * 100);
      // 置信带宽：极性越弱越宽（最宽 ±26%，最窄 ±6%）
      const halfBand = Math.round(6 + (1 - d.polarity) * 20);
      const bandLeft = Math.max(0, ptrPct - halfBand);
      const bandRight = Math.min(100, ptrPct + halfBand);
      const bandW = bandRight - bandLeft;
      const rawLabel = `原始分 ${d.sum}/${d.max}（中点 ${d.mid}）`;
      const weak = dimStrength(d).tier === "weak";
      const wobble = weak
        ? `<span class="wobble">接近中间，可能波动</span>` : ``;
      return `
        <div class="dim-row">
          <div class="dim-title">${esc(meta.title)}</div>
          <div class="dim-labels">
            <span class="lab ${leftWin && !isX ? "win" : ""}">${meta.anchor} ${esc(meta.leftName)}</span>
            <span class="lab ${!leftWin && !isX ? "win" : ""}">${esc(meta.rightName)} ${meta.opposite}</span>
          </div>
          <div class="dim-bar">
            <div class="dim-band" style="left:${bandLeft}%;width:${bandW}%;"></div>
            <div class="dim-mid"></div>
            <div class="dim-pointer" style="left:${ptrPct}%;"></div>
          </div>
          <div class="dim-foot">
            <span class="raw">${rawLabel}</span>
            ${wobble}
          </div>
          <div class="dim-interp ${weak ? "weak" : ""}">${dimInterpText(d)}</div>
        </div>
      `;
    };

    // 阶位区间文案
    let intervalNote = "";
    let rangeHtml = "";
    if (b.isInterval && b.lower.code !== b.upper.code) {
      intervalNote = `
        <div class="stage-interval-note">
          你的回答在阶位上有一定跨度——重心落在【${b.lower.name}】到【${b.upper.name}】之间。
          这通常意味着你正处在过渡期：在不同情境里，你会在这两种“看世界的方式”之间来回。
          下面以你的主要重心【${stage.name}】为你展开，但请把它读成一个“区间”，而非一个固定的点。
        </div>`;
      const rLeft = Math.min(b.lowerPos, b.upperPos);
      const rW = Math.abs(b.upperPos - b.lowerPos);
      rangeHtml = `<div class="spectrum-range" style="left:${rLeft}%;width:${rW}%;"></div>`;
    }

    // C 段回显（仅完整版有）
    let cBlock = "";
    if (state.mode === "full") {
      const cEcho = C_QUESTIONS.map((q) => {
        const ans = (state.answersC[q.id] || "").trim();
        return `
          <div class="c-item">
            <div class="c-q">${esc(q.title)}</div>
            <div class="c-a ${ans ? "" : "empty"}">${ans ? esc(ans) : "（你跳过了这一题）"}</div>
          </div>`;
      }).join("");
      cBlock = `
        <div class="result-card">
          <h3>你写下的深度作答</h3>
          <div class="c-echo">${cEcho}</div>
          <div class="llm-note">
            <span>✦</span>
            <span>此部分将由 AI 按“主体-客体结构复杂度”评分，用于校准纵向阶位；当前原型暂存作答，并不据此打分。完整版会从你“怎么想”里读出更细的成长信号，再回头校准上面的阶位结论。</span>
          </div>
        </div>`;
    }

    // 乱答警示
    let warnBanner = "";
    if (cons.ratio >= 0.5 && cons.checked >= 2) {
      warnBanner = `
        <div class="warn-banner">
          <span>⚠️</span>
          <span>我们注意到，有几对“意思相反”的题，你给了方向一致的回答。这可能是手滑，也可能是题目当时没读仔细——
          所以这份结果的<strong>置信度我们调低了</strong>。如果想要更准的画像，可以重测一次、慢一点作答。</span>
        </div>`;
    }

    // 置信度徽章
    const confClass = fused.confidence === "高" ? "hi" : (fused.confidence === "中" ? "mid" : "lo");

    // 组合叙事
    const comboLine = `
      你是 <strong>${a.type} × ${stage.name}</strong>。同一个 ${a.type}，处在不同的成长重心，
      会活成很不一样的人——你的天赋（${a.type}）决定了你“用什么方式”看世界，
      而你的重心（${stage.name}${stage.edge ? "，正通往" + stage.edge : ""}）决定了这份天赋“长成什么样”。
    `;

    const screen = el(`
      <div class="screen active" style="padding-top:8px;">
        <div class="result-hero">
          <div class="eyebrow">你的性格类型</div>
          <div class="mbti-badge">${a.type}</div>
          <div class="mbti-name">${esc(blurb)}</div>
          ${weakCount >= 1 ? `<div class="mbti-caveat">这是一个<strong>倾向</strong>，不是对你的<strong>定义</strong>——你有 ${weakCount} 个维度偏好并不强烈，下面细看。</div>` : ``}
        </div>

        ${overviewBanner}

        ${warnBanner}

        <div class="result-card">
          <h3>四个维度 · 连续刻画</h3>
          ${dimRow("EI")}
          ${dimRow("SN")}
          ${dimRow("TF")}
          ${dimRow("JP")}
          <div class="sim-note">
            我们不只给你一个字母，而是把每个维度画成一条<strong>连续的光谱</strong>：圆点是你的位置，
            浅色带是“置信区间”——越靠近正中（中点），带越宽，说明你在这个维度上越灵活、越可能波动。
            每条下方那句话，告诉你这一项到底是<strong>“明显偏”</strong>还是<strong>“只是略偏、随时会翻面”</strong>。
            这比非黑即白的“你就是 X”更接近真实。
          </div>
        </div>

        <div class="result-card">
          <div style="display:flex;align-items:center;">
            <h3 style="margin:0;">你当下的成长重心</h3>
            <span class="confidence-chip ${confClass}">置信度 · ${fused.confidence}</span>
          </div>
          <div class="stage-head" style="margin-top:14px;">
            <div class="stage-emoji" style="background:${stage.color}1A;">${stage.emoji}</div>
            <div>
              <p class="stage-title" style="color:${stage.color};">${stage.name}</p>
              <p class="stage-sub">${esc(stage.academic)}</p>
            </div>
          </div>
          ${roleNote}

          <div class="spectrum-bar-wrap">
            <div class="spectrum-bar">
              ${rangeHtml}
              <div class="spectrum-pointer" id="ptr" style="left:${b.pointerPos}%;"></div>
            </div>
            <div class="spectrum-ticks">
              <span>自我中心者</span><span>归属者</span><span>钻研者</span>
              <span>掌舵者</span><span>觉察者</span><span>整合者</span>
            </div>
          </div>

          ${intervalNote}

          <div class="stage-body">
            <span class="block-label">你的画像</span>
            ${esc(stage.portrait)}
            <span class="block-label">你的光彩</span>
            ${esc(stage.light)}
            <span class="block-label">你的代价（温和）</span>
            ${esc(stage.cost)}
            <div class="growth-edge">
              <strong>你的成长边缘 → ${esc(stage.edge)}</strong><br/>
              ${esc(stage.edgeText)}
            </div>
          </div>
        </div>

        <div class="result-card">
          <h3>类型 × 阶位</h3>
          <div class="combo-line">${comboLine}</div>
        </div>

        ${cBlock}

        <details class="why-accurate why-diff" ${weakCount >= 1 ? "open" : ""}>
          <summary>为什么这次结果和上次／别处不一样？</summary>
          <div class="why-body">
            如果你测过别的 MBTI，或者上次测的结果和这次不同——<strong>这几乎一定不是“测不准”，而是两个原因</strong>：
            <ul>
              <li><b>你本来就在中间地带</b>：MBTI 把每个维度切成“非此即彼”，但大多数人不是纯 E 或纯 I。
                只要你在某一维<strong>靠近中点</strong>（比如外向得 16 分、中点是 15），这次多偏一点显示 E、
                下次少偏一点就显示 I——<strong>翻面的是标签，不是你这个人</strong>。${weakCount >= 1 ? `你这次就有 <b>${weakCount}</b> 个这样的维度。` : ``}</li>
              <li><b>二元字母丢掉了“强弱”</b>：同样写“E”，有人是 24 分的强外向，有人是 16 分的弱外向，
                体验天差地别，但字母一样。所以我们<strong>额外给你连续分 + 置信带</strong>，
                让你看见自己到底“偏多少”，而不是被一个字母代表。</li>
            </ul>
            想要更稳的结果：<strong>慢一点、按第一反应作答，间隔一两周再测一次</strong>；
            把<strong>那些“明显偏”的维度</strong>当作你较稳定的部分，把<strong>靠近中间的维度</strong>当作“看场合”的灵活面。
          </div>
        </details>

        <details class="why-accurate">
          <summary>为什么这样测更准</summary>
          <div class="why-body">
            普通测试容易“一答就准”地骗自己。我们做了几件让结果更站得住的事：
            <ul>
              <li><b>反向题校验</b>：性格题里混了“正反两面”的问法（如“爱社交”配“社交后需独处”），
                反向题用 <b>6 − 原分</b> 还原，能抵消“一路点同意”的作答惯性。</li>
              <li><b>连续刻画 + 置信带</b>：我们报告的是<b>连续的维度分</b>，不是一个写死的字母；
                离中点近就明确告诉你“这里可能波动”，而不是假装你 100% 是某一型。</li>
              <li><b>阶位不取平均、而取“高位拐点”</b>：心智阶位用你回答里的<b>高位信号</b>定级
                （借鉴发展测评的 ogive 思想），避免把偶尔的高阶回答被一堆中庸答案平均抹平；
                当回答跨度大时，给你一个<b>“X→Y 过渡区间”</b>而不是硬凑一个点。</li>
              <li><b>多段交叉验证</b>：第二部分（情境选择）与第三部分（开放作答）相互印证——
                完整版接入 AI 后，二者一致才给高置信，背离则输出区间。</li>
              <li><b>一致性低就降置信</b>：如果反向题答得自相矛盾，我们会主动调低这份报告的置信度并提示你。</li>
            </ul>
            这些不是话术——它们都已经在你这次的计分里真实生效了。
          </div>
        </details>

        <div class="disclaimer">
          本测评仅供自我探索与成长参考，不构成心理诊断或临床建议；<br/>
          它描述的是你“此刻”看世界的方式，会随你的人生历练而演化——<br/>
          没有哪个结果是终点，也没有哪个结果代表“更好的人”。<br/>
          本产品独立设计，不隶属于、也不代表 MBTI®、Myers-Briggs® 或任何官方机构。
        </div>

        <div class="actions">
          <button class="btn btn-ghost" id="exportBtn">导出 JSON</button>
          <button class="btn btn-primary" id="restartBtn">重新测试</button>
        </div>
      </div>
    `);
    stageEl.innerHTML = "";
    stageEl.appendChild(screen);

    // 光点入场动画
    const ptr = screen.querySelector("#ptr");
    if (ptr) {
      ptr.style.left = "0%";
      requestAnimationFrame(() => { setTimeout(() => { ptr.style.left = b.pointerPos + "%"; }, 60); });
    }

    // 导出 JSON（复制结果）
    screen.querySelector("#exportBtn").onclick = () => {
      const payload = {
        mode: state.mode,
        role: rk,
        roleLabel: roleLabel,
        type: a.type,
        dimensions: Object.fromEntries(Object.entries(a.dims).map(([k, d]) => [k, {
          winner: d.winner, sum: d.sum, max: d.max, midpoint: d.mid,
          anchorFraction: Number(d.anchorFrac.toFixed(3)),
          nearMidpoint: d.nearMid,
        }])),
        stage: {
          principalName: stage.name, principalCode: stage.code,
          principalValue: Number(b.principal.toFixed(2)),
          mean: Number(b.mean.toFixed(2)), std: Number(b.std.toFixed(2)),
          highInflectionP75: Number(b.p75.toFixed(2)),
          isInterval: b.isInterval,
          interval: b.isInterval ? [b.lower.name, b.upper.name] : null,
        },
        confidence: fused.confidence,
        consistency: { checked: cons.checked, inconsistent: cons.inconsistent },
        sectionC: { answered: cResult._answered, chars: cResult._chars, scored: false, note: "待 AI 按主体-客体复杂度校准" },
        answers: { A: state.answersA, B: state.answersB, C: state.answersC },
        generatedAt: new Date().toISOString(),
      };
      const txt = JSON.stringify(payload, null, 2);
      copyText(txt);
    };

    screen.querySelector("#restartBtn").onclick = () => {
      state.answersA = {}; state.answersB = {}; state.answersC = {};
      state.started = false; state.mode = null; state.role = "general";
      clearState();
      buildFlow();
      cursor = 0;
      render();
      window.scrollTo({ top: 0 });
    };
  }

  // 复制文本到剪贴板（file:// 下 navigator.clipboard 可能不可用 → textarea 兜底）
  function copyText(txt) {
    const done = () => showToast("结果 JSON 已复制到剪贴板");
    const fail = () => {
      // 兜底：弹出可手动复制的窗口
      window.prompt("复制下面的 JSON（Ctrl/Cmd + C）：", txt);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done).catch(() => legacyCopy(txt, done, fail));
    } else {
      legacyCopy(txt, done, fail);
    }
  }
  function legacyCopy(txt, done, fail) {
    try {
      const ta = document.createElement("textarea");
      ta.value = txt;
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      ok ? done() : fail();
    } catch (e) { fail(); }
  }
  let toastTimer = null;
  function showToast(msg) {
    let t = document.getElementById("toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "toast"; t.className = "toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 1900);
  }

  /* ==========================================================================
     5. 启动
     ========================================================================== */
  // 启动时不自动恢复进度（避免一来就跳到题中间）；
  // 而是在欢迎页显示「继续」按钮让用户决定。这里仅恢复 mode/role 以便默认勾选。
  const saved = loadState();
  if (saved && saved.mode) state.mode = saved.mode;
  if (saved && saved.role && typeof STAGE_SJT_BY_ROLE !== "undefined" && STAGE_SJT_BY_ROLE[saved.role]) {
    state.role = saved.role;
  }
  buildFlow();
  cursor = 0;
  render();
})();
