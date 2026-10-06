/*
 * POPUP — the control-center. Runs in EXTENSION context, so it CAN read
 * chrome.storage (unlike page-console code). Reads the logged interactions,
 * filters to today, computes today's pattern, and renders it.
 *
 * Same analysis logic as the Python digest agent: exclude Undetermined (not
 * work tasks) from the stats, compute behavior rate + nudge engagement.
 */
(function () {
  const KEY = "interactions";
  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

  chrome.storage.local.get([KEY], function (data) {
    const all = data[KEY] || [];
    const todays = all.filter(function (r) {
      return (r.timestamp || "").slice(0, 10) === today;
    });
    render(todays);
    renderRecall(all);   // recall uses ALL records (across days), not just today
  });

  // ---- Wire the on/off toggles (Tracking / Nudges) ----
  setupToggles();
  setupMode();

  function setupMode() {
    const sel = document.getElementById("mode-select");
    const keyRow = document.getElementById("key-row");
    const keyInput = document.getElementById("api-key");
    const desc = document.getElementById("mode-desc");
    if (!sel) return;

    const DESCS = {
      "local": "Uses only the built-in heuristic. No API key, no network — your prompts never leave this browser.",
      "own-key": "Ambiguous or high-risk prompts are checked by Claude using YOUR key, sent directly to Anthropic (your account, your cost). Not stored anywhere by us.",
      "server": "Ambiguous or high-risk prompts are checked via our shared server (our Claude account, daily quota). Your prompt passes through our server — don't use for sensitive content.",
    };

    function refresh(mode) {
      keyRow.style.display = (mode === "own-key") ? "block" : "none";
      desc.textContent = DESCS[mode] || "";
    }

    chrome.storage.local.get(["settings"], function (d) {
      const s = Object.assign({ mode: "server", apiKey: "" }, d.settings || {});
      sel.value = s.mode;
      keyInput.value = s.apiKey || "";
      refresh(s.mode);
    });

    sel.addEventListener("change", function () {
      saveSetting("mode", sel.value);
      refresh(sel.value);
    });
    // Save the key as they type (debounced-lite: on input is fine for a local field).
    keyInput.addEventListener("change", function () {
      saveSetting("apiKey", keyInput.value.trim());
    });
  }

  // Shared saver used by mode + key.
  function saveSetting(name, value) {
    chrome.storage.local.get(["settings"], function (d) {
      const s = Object.assign({ tracking: true, nudges: true, mode: "local", apiKey: "" }, d.settings || {});
      s[name] = value;
      chrome.storage.local.set({ settings: s });
    });
  }

  function setupToggles() {
    const storeEl = document.getElementById("toggle-store");
    const nudgesEl = document.getElementById("toggle-nudges");
    chrome.storage.local.get(["settings"], function (d) {
      const s = Object.assign({ storePrompts: true, nudges: true }, d.settings || {});
      storeEl.checked = s.storePrompts;
      nudgesEl.checked = s.nudges;
    });
    bindToggle(storeEl, "storePrompts");
    bindToggle(nudgesEl, "nudges");
  }

  // Save a toggle change straight to chrome.storage (content.js reads it live).
  function bindToggle(el, name) {
    el.addEventListener("change", function () {
      chrome.storage.local.get(["settings"], function (d) {
        const s = Object.assign({ storePrompts: true, nudges: true }, d.settings || {});
        s[name] = el.checked;
        chrome.storage.local.set({ settings: s });
      });
    });
  }

  function render(records) {
    const content = document.getElementById("content");

    if (records.length === 0) {
      content.innerHTML = '<p class="empty">No interactions logged today yet. '
        + 'Use your AI and check back.</p>';
      return;
    }

    // Exclude Undetermined (operational / not work tasks) from the stats.
    const tasks = records.filter(function (r) { return r.category !== "Undetermined"; });
    const uncategorized = records.length - tasks.length;
    const total = tasks.length;

    // Category counts.
    const cats = {};
    tasks.forEach(function (r) { cats[r.category] = (cats[r.category] || 0) + 1; });

    // Header: "Your AI usage today — on <site(s)>".
    const sites = {};
    records.forEach(function (r) { if (r.site) sites[r.site] = true; });
    const siteList = Object.keys(sites).join(", ") || "Claude";
    const sub = document.getElementById("subtitle");
    if (sub) sub.textContent = "Your AI usage today — on " + siteList;

    // Per-category SKILL-PROTECTION rate — only for Think & Draft (the categories
    // where bringing your own thinking matters). We don't push thinking on Lookup,
    // so we show its count but not a protection %. "brought your thinking" = any
    // protective behavior detected on that task.
    function protectRate(cat) {
      const inCat = tasks.filter(function (r) { return r.category === cat; });
      if (!inCat.length) return null;
      const withB = inCat.filter(function (r) { return (r.behaviors || []).length > 0; }).length;
      return Math.round(100 * withB / inCat.length);
    }

    // Build the HTML. Order (per design): categories first, then per-category
    // skill-protection %. No spine line here (that framework lives in the digest/about).
    let html = '';

    // 1) What you used AI for today (counts).
    html += '<div class="section-title">What you used AI for today</div>';
    ["Think", "Draft", "Lookup"].forEach(function (cat) {
      if (cats[cat]) html += '<div class="prompt-row">' + cat + ': ' + cats[cat] + '</div>';
    });
    if (uncategorized) {
      html += '<div class="prompt-row" style="color:#9aa0a6">'
        + uncategorized + ' operational (not counted)</div>';
    }

    // 2) Skill protection % — Think & Draft only (not Lookup).
    html += '<div class="section-title">Skill protection</div>';
    let anyProtect = false;
    ["Think", "Draft"].forEach(function (cat) {
      const rate = protectRate(cat);
      if (rate === null) return;
      anyProtect = true;
      const cls = rate >= 40 ? "good" : "warn";
      html += '<div class="prompt-row">' + cat + ': brought your thinking on '
        + '<span class="' + cls + '">' + rate + '%</span></div>';
    });
    if (!anyProtect) {
      html += '<div class="empty">No Think or Draft tasks yet today.</div>';
    }

    // Last few prompts — show category/risk, protective behaviors, and nudge outcome.
    html += '<div class="section-title">Recent prompts</div>';
    const recent = tasks.slice(-5).reverse();
    recent.forEach(function (r) {
      // If prompt text wasn't stored (privacy toggle off), show a placeholder.
      const pText = (r.prompt_stored === false)
        ? '<span class="none">[prompt text not stored]</span>'
        : escapeHtml((r.prompt || "").slice(0, 70));

      // Protective behaviors shown (or "none"). Behaviors are objects -> use sub_behavior.
      const behaviors = (r.behaviors || []).map(function (b) {
        return typeof b === "string" ? b : (b.sub_behavior || b.behavior || "");
      }).filter(Boolean);
      const behaviorText = behaviors.length
        ? '<span class="ok">' + escapeHtml(behaviors.join(", ")) + '</span>'
        : '<span class="none">No protective behavior</span>';

      // Nudge outcome (only if a nudge was shown).
      let nudgeText = "";
      if (r.nudge_shown) {
        nudgeText = r.engaged
          ? ' / <span class="ok">Nudge: engaged</span>'
          : ' / <span class="warn-t">Nudge: skipped</span>';
      }

      // Prompt on top; then ONE meta line: category / behavior / risk / nudge.
      html += '<div class="prompt-row">'
        + pText + '<br>'
        + '<span class="meta">'
        +   '<span class="cat">' + r.category + '</span>'
        +   ' / ' + behaviorText
        +   ' / ' + '<span class="risk-' + r.risk + '">' + r.risk + ' risk</span>'
        +   nudgeText
        + '</span>'
        + '</div>';
    });

    content.innerHTML = html;
  }

  // --- RECALL TEST (proactive review, testing effect + spacing) ---
  // Find a Lookup from a PREVIOUS day, ask the user to recall it before revealing.
  function renderRecall(all) {
    const el = document.getElementById("recall");
    if (!el) return;
    const today = new Date().toISOString().slice(0, 10);

    // SPACED retrieval (spacing effect + active recall; Oakley pairs recall with
    // spacing): pick ONE Lookup per DISTINCT previous day, newest day first, up to
    // 3 days. This spreads items across time (real spacing) instead of clustering
    // several from one old day. Must have stored prompt text to be recallable.
    const byDay = {};  // day -> newest lookup that day (with text)
    all.forEach(function (r) {
      if (r.category !== "Lookup") return;
      if (r.prompt_stored === false || !(r.prompt || "").trim()) return; // need the words
      const day = (r.timestamp || "").slice(0, 10);
      if (!day || day >= today) return;         // previous days only
      // keep the newest entry per day (later timestamp wins)
      if (!byDay[day] || (r.timestamp || "") > (byDay[day].timestamp || "")) byDay[day] = r;
    });
    // Newest days first, take up to 3.
    const days = Object.keys(byDay).sort().reverse().slice(0, 3);
    const candidates = days.map(function (d) { return byDay[d]; });
    if (candidates.length === 0) {
      el.innerHTML = '<div class="empty">No past lookups to review yet. Come back after you\'ve looked things up on earlier days.</div>';
      return;
    }

    // One per day, newest first. The prompt IS the recall cue (try to answer it
    // yourself, no AI). Date tag makes the SPACING visible (the active ingredient).
    const picks = candidates;
    let rows = "";
    picks.forEach(function (r) {
      const lookedUp = (r.timestamp || "").slice(0, 10);
      const dateTag = lookedUp
        ? ' <span style="color:#9aa0a6;">[looked up ' + escapeHtml(lookedUp) + ']</span>'
        : '';
      rows += '<div class="prompt-row">&bull; ' + escapeHtml((r.prompt || "").slice(0, 120)) + dateTag + '</div>';
    });

    el.innerHTML = '<div class="empty" style="margin-bottom:6px;">Can you recall the answers to these previous lookup prompts, without using AI?</div>'
      + rows;
  }

  function metric(num, label, cls) {
    return '<div class="metric"><div class="num ' + (cls || "") + '">' + num
      + '</div><div class="label">' + label + '</div></div>';
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
})();
