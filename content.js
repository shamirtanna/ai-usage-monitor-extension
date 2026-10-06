/*
 * CONTENT SCRIPT (shared) — the entry point running in the page.
 *
 * THE MONEY SHOT: intercept the send, and if the prompt is high-risk, show a
 * nudge IN OUR OWN UI on the page BEFORE the prompt goes to the AI. This is the
 * thing Kiro couldn't do — here WE own the page injection, so nothing overrides us.
 *
 * Flow: user hits send -> we intercept -> classify -> if high-risk, show nudge
 * (respond or skip) -> then let the send proceed.
 */
(function () {
  const adapter = window.SkillShieldAdapter;
  const classifier = window.SkillShieldClassifier;
  console.log("[Skill Shield] loaded on", adapter ? adapter.siteName : "unknown");

  // When true, we let the next send through WITHOUT intercepting (so after the
  // user resolves the nudge and we trigger the real send, we don't loop).
  let allowNextSend = false;

  // Guards against the DOUBLE-FIRE bug:
  //  - `wired`: wireUp() attaches DOCUMENT-level listeners; if it runs more than
  //    once (SPA re-render / poll re-entry), listeners STACK and every send fires
  //    N times. This ensures we wire exactly once.
  //  - `inFlight`: a single send can arrive via Enter AND click (or a stray dup);
  //    this ignores a second send attempt while one is already being handled.
  let wired = false;
  let inFlight = false;

  // --- Decide which nudge (if any) to show, given a classification. ---
  // Returns null (no nudge) OR a nudge object:
  //   { question, injectPrefix, injectSuffix }
  // - question:     what we ask the user
  // - injectPrefix: how their answer is framed when added to the prompt
  // - injectSuffix: an instruction to the AI to WIDEN, not just confirm — asks for
  //   alternatives/challenge so injecting the user's hypothesis doesn't cause the AI
  //   to simply agree (fixes the "leading response" / confirmation-bias risk).
  function decideNudge(result) {
    if (result.risk !== "high") return null; // only high-risk interrupts

    if (result.category === "Draft") {
      // DRAFT: invite the user's key points. Suffix tells the AI to USE them but
      // also EVALUATE them (flag weak points, gaps, better framing) — same anti-
      // sycophancy principle as Think: your input is used AND challenged, not
      // blindly accepted. User's ask stays ONE thing; the evaluation loads the AI side.
      return {
        question: "Before AI drafts this — what are the 2-3 key points you want to make?",
        injectPrefix: "My key points: ",
        injectSuffix: "[Note to AI: draft this using my points, but don't just accept them. Flag any that are weak or unconvincing, note anything important I've missed, and tell me if a different framing would land better.]",
      };
    }
    // THINK: invite a hypothesis AND/OR relevant experience (the two spines) in ONE
    // optional box — one perceived ask, both spines invited. Prefix is spine-neutral
    // ("My own thinking") so it fits a hypothesis, experience, or both. Suffix loads
    // the AI side: challenge + use my experience + alternatives (anti-sycophancy).
    return {
      question: "Before AI answers — what's your hypothesis? And any relevant experience? (either is fine)",
      injectPrefix: "My own thinking on this: ",
      injectSuffix: "[Note to AI: don't just agree. Weigh my thinking honestly, challenge it where it's weak, factor in any experience I shared, and give me 2-3 alternatives or angles I may be missing so I can compare.]",
    };
  }

  // --- Wait until the prompt box exists (page builds its UI dynamically). ---
  let tries = 0;
  const timer = setInterval(function () {
    tries++;
    const el = adapter && adapter.getPromptElement();
    if (el) {
      clearInterval(timer);
      wireUp(el);
    } else if (tries > 20) {
      clearInterval(timer);
      console.log("[Skill Shield] prompt box not found.");
    }
  }, 500);

  function wireUp(promptEl) {
    if (wired) return;   // only ever attach the global listeners ONCE (no stacking)
    wired = true;
    console.log("[Skill Shield] watching for sends.");

    // We intercept at the DOCUMENT level (capture phase) rather than on the prompt
    // element. Why: modern SPAs like Claude (Tiptap/ProseMirror + React) handle Enter
    // and re-create the send button internally — a listener bound to a specific node
    // gets bypassed or goes stale when React swaps the element. Listening at document
    // root in capture phase means we run FIRST, before Claude's own handlers, on every
    // send path. We check whether the event is really a send inside the handler.

    // ENTER key: only counts as a send when focus is IN the prompt box.
    document.addEventListener("keydown", function (e) {
      if (allowNextSend) return;
      if (!adapter.isSendKey(e)) return;
      const promptNow = adapter.getPromptElement();
      // Is the keydown happening inside the prompt editor? (target is the editor
      // or a descendant of it — ProseMirror events target inner nodes).
      if (!promptNow || !(promptNow === e.target || promptNow.contains(e.target))) return;
      handleSendAttempt(e);
    }, true);

    // SEND BUTTON click: match by walking up from the click target to see if it's
    // the send button (works even after React replaces the button element).
    document.addEventListener("click", function (e) {
      if (allowNextSend) return;
      const btn = adapter.getSendButton && adapter.getSendButton();
      if (!btn) return;
      // e.target may be an icon/span inside the button — climb to the button.
      const clickedBtn = e.target.closest && e.target.closest("button");
      if (clickedBtn && clickedBtn === btn) {
        handleSendAttempt(e);
      }
    }, true);
  }

  // --- The interception: classify, and nudge if high-risk. ---
  // THREE MODES (user's choice, see notebook part 27):
  //   "local"   = JS heuristic only; nothing leaves the browser (default, private)
  //   "own-key" = heuristic first; escalate ambiguous/high-risk to Claude DIRECTLY
  //               with the user's key (nothing touches our server)
  //   "server"  = route through our hosted server (our key + quota)
  // In every mode we run the heuristic FIRST and only escalate on the same trigger
  // the Python server uses: category Undetermined OR risk high (the "double-check
  // the empty behavior list before we nudge" case). Cost/privacy discipline stays.
  // Hosted classifier server (server mode). Was http://localhost:8765/classify
  // during local dev; now the public Render URL so any user's extension reaches it.
  const CLASSIFY_URL = "https://ai-usage-monitor-server.onrender.com/classify";
  // How long we'll wait for the smart (server OR own-key) classification before
  // giving up and using the instant local heuristic. Keep it SHORT — this runs at
  // send time; a slow nudge is a failed nudge. Tune against real cold-start/latency.
  const SMART_TIMEOUT_MS = 2500;

  // fetch with a hard timeout via AbortController: if the request isn't done in
  // `ms`, we abort it (which makes the await throw -> caller falls back to local).
  function fetchWithTimeout(url, options, ms) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, ms);
    return fetch(url, Object.assign({}, options, { signal: controller.signal }))
      .finally(function () { clearTimeout(timer); });
  }

  function needsEscalation(result) {
    if (result.category === "Undetermined" || result.risk === "high") return true;
    // BLIND SPOT FIX: a Draft the heuristic can't call thinking-vs-execution lands
    // at medium and would never escalate — but that subtype decides whether to nudge
    // (e.g. "draft a message to my VP on this strategic investment" is thinking with
    // no keyword). Let the LLM resolve it.
    if (result.category === "Draft" &&
        result.draft_subtype !== "thinking" && result.draft_subtype !== "execution") {
      return true;
    }
    return false;
  }

  // Recompute risk from category + subtype + whether any behavior was found —
  // mirrors the Python _risk_for so OUR thesis owns risk, LLM informs behaviors.
  function riskFor(category, draftSubtype, engaged) {
    if (category === "Think") return engaged ? "medium" : "high";
    if (category === "Draft") {
      if (draftSubtype === "thinking" && !engaged) return "high";
      if (draftSubtype === "execution") return "low";
      if (!engaged) return "medium";
      return "low";
    }
    return "low"; // Lookup / Undetermined
  }

  async function classifyText(text, settings) {
    const mode = (settings && settings.mode) || "local";

    // Step 1 — heuristic (free, instant, private) in ALL modes.
    const base = classifier.classify(text);
    base._source = "local";

    // Local mode, or nothing to escalate -> done.
    if (mode === "local" || !needsEscalation(base)) return base;

    // Step 2 — escalate.
    if (mode === "own-key") {
      const key = settings.apiKey;
      if (!key) { base._source = "local (no key set)"; return base; }
      // Same timeout discipline as server mode — Claude-direct can also be slow.
      const llm = window.SkillShieldLLM &&
        await window.SkillShieldLLM.classify(text, key, SMART_TIMEOUT_MS);
      if (!llm) { base._source = "local (llm slow/failed)"; return base; }
      return mergeLlm(base, llm, "own-key");
    }

    if (mode === "server") {
      try {
        const userId = await new Promise(function (resolve) {
          if (window.SkillShieldStorage && window.SkillShieldStorage.getUserId) {
            window.SkillShieldStorage.getUserId(resolve);
          } else { resolve("anon"); }
        });
        // TIMEOUT: cap the wait. The nudge must be fast — if the smart path (server,
        // maybe cold-starting) hasn't answered in SMART_TIMEOUT_MS, abandon it and
        // use the instant local heuristic. Converts "slow" into "treated as failed"
        // so the user never stares at a frozen send. (See notebook: slow != failed.)
        const resp = await fetchWithTimeout(CLASSIFY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: text, userId: userId }),
        }, SMART_TIMEOUT_MS);
        if (!resp.ok) throw new Error("server " + resp.status);
        const data = await resp.json();
        data._source = "server";
        return data;
      } catch (err) {
        console.log("[Skill Shield] server slow/unreachable, using local heuristic:", err.message);
        base._source = "local (server timeout/down)";
        return base;
      }
    }

    return base;
  }

  // Fold the LLM's judgment into the heuristic result: LLM owns behaviors + subtype
  // + (if we'd given up) category; OUR riskFor owns risk. Matches the server's Plan B.
  function mergeLlm(base, llm, source) {
    const category = base.category === "Undetermined" ? llm.category : base.category;
    const behaviors = llm.behaviors || [];
    const engaged = behaviors.length > 0;
    const draftSubtype = category === "Draft"
      ? (llm.draft_subtype && llm.draft_subtype !== "unknown" ? llm.draft_subtype : base.draft_subtype)
      : null;
    return {
      category: category,
      behaviors: behaviors,
      engaged: engaged,
      draft_subtype: draftSubtype,
      risk: riskFor(category, draftSubtype, engaged),
      undetermined: category === "Undetermined",
      _source: source,
    };
  }

  function handleSendAttempt(e) {
    // RE-ENTRY GUARD: a single send can arrive via Enter AND click (or a dup
    // listener). If we're already handling one, swallow the duplicate — freeze it
    // so it doesn't leak through, but don't classify/log/nudge a second time.
    if (inFlight) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    const text = adapter.getPromptText();
    console.log("[Skill Shield] send intercepted. text:", JSON.stringify(text));
    if (!text) return; // nothing typed; let it be

    // Mark in-flight now that we know it's a real send we'll process.
    inFlight = true;

    // FREEZE the send SYNCHRONOUSLY, right now. We must call preventDefault before
    // any async work — if we waited for the storage/settings callback, the browser
    // would already have sent the prompt (preventDefault only works synchronously
    // within the event). So we freeze first, then decide whether to release.
    e.preventDefault();
    e.stopPropagation();

    // Read settings. We ALWAYS classify + (maybe) nudge + log stats; the only
    // thing the privacy toggle controls is whether the prompt TEXT is retained
    // (handled in storage.logInteraction). So there's no "do nothing" path here.
    getSettings(function (settings) {
      console.log("[Skill Shield] settings at send:", JSON.stringify({
        storePrompts: settings.storePrompts, nudges: settings.nudges, mode: settings.mode,
      }));

      classifyText(text, settings).then(function (result) {
        // If the shared server was quota-blocked, let the user know (once) why
        // they're getting the simpler heuristic instead of the smart check.
        if (result.quota_block) {
          const msg = result.quota_block === "global"
            ? "Skill Shield: the shared smart-mode limit for the whole app is reached for today — try again tomorrow, or switch to your own key."
            : "Skill Shield: you've reached today's shared smart-mode limit — switch to your own key for unlimited, or try again tomorrow.";
          console.log("[Skill Shield] " + msg);
          showToast(msg);
        }

        // NUDGES toggle: only build a nudge if the user has nudges enabled.
        const nudge = settings.nudges ? decideNudge(result) : null;
        console.log("[Skill Shield] classified:", result.category, "/", result.risk,
          "(" + (result.classified_by || result._source) + ") -> nudge:",
          nudge ? "YES" : (settings.nudges ? "no" : "OFF"));

        if (nudge) {
          // HIGH RISK + nudges on: show it; sends after the user resolves it.
          showNudge(nudge, text, result);
        } else {
          // Log it (tracking is on), then re-trigger the real send.
          logInteraction(text, result, false, false, false);
          allowNextSend = true;
          adapter.submit();
          setTimeout(function () { allowNextSend = false; inFlight = false; }, 300);
        }
      }).catch(function () {
        // Never leave the guard stuck if classification throws.
        inFlight = false;
      });
    });
  }

  // Small transient banner (top-right) for quota/status messages. Auto-dismisses.
  function showToast(message) {
    const existing = document.getElementById("skill-shield-toast");
    if (existing) existing.remove();
    const el = document.createElement("div");
    el.id = "skill-shield-toast";
    el.textContent = message;
    el.style.cssText =
      "position:fixed;top:16px;right:16px;z-index:2147483647;max-width:320px;" +
      "background:#171a1f;color:#e6e8eb;border:1px solid #2b2f36;border-radius:8px;" +
      "padding:12px 14px;font:13px -apple-system,Segoe UI,sans-serif;line-height:1.4;" +
      "box-shadow:0 4px 16px rgba(0,0,0,.4);";
    document.body.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.remove(); }, 6000);
  }

  // Read the settings (defaults to ON if storage isn't available in this context).
  function getSettings(callback) {
    if (window.SkillShieldStorage && window.SkillShieldStorage.getSettings) {
      window.SkillShieldStorage.getSettings(callback);
    } else {
      callback({ storePrompts: true, nudges: true, mode: "server", apiKey: "" });
    }
  }

  // --- Log one interaction to the extension's local store. ---
  function logInteraction(prompt, result, nudgeShown, engaged, skipped) {
    if (!window.SkillShieldStorage) return; // storage may not be loaded (page context)
    window.SkillShieldStorage.logInteraction({
      site: adapter.siteName,
      prompt: prompt,
      category: result.category,
      risk: result.risk,
      behaviors: result.behaviors.map(function (b) { return b.sub_behavior; }),
      nudge_shown: nudgeShown,
      engaged: engaged,
      skipped: skipped,
    });
  }

  // --- Show the nudge UI (injected onto the page). ---
  function showNudge(nudge, originalPrompt, result) {
    if (document.getElementById("skill-shield-nudge")) return; // don't double-show

    const overlay = document.createElement("div");
    overlay.id = "skill-shield-nudge";
    overlay.innerHTML =
      '<div class="ss-box">' +
      '  <div class="ss-title">' + nudge.question + '</div>' +
      '  <textarea id="ss-input" placeholder="Take a beat — even a rough answer counts..."></textarea>' +
      '  <div class="ss-note">Anything you write here is added to your input, so the AI builds on your thinking. Skip to send as-is.</div>' +
      '  <div class="ss-actions">' +
      '    <button id="ss-continue">Continue</button>' +
      '    <button id="ss-skip" class="ss-secondary">Skip</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(overlay);
    document.getElementById("ss-input").focus();

    // CONTINUE: if they typed a hypothesis, INJECT it into the prompt so it
    // reaches the AI (their thinking shapes the answer). Then send.
    document.getElementById("ss-continue").addEventListener("click", function () {
      const response = document.getElementById("ss-input").value.trim();
      const engaged = response.length > 0;  // did they actually bring their thinking?
      if (engaged) {
        // Inject AFTER the original prompt (original stays primary). Structure:
        //   [their prompt] + [prefix + their thinking] + [suffix asking AI to WIDEN
        //   not just confirm]. The suffix prevents the injected hypothesis from
        //   causing the AI to simply agree (the confirmation-bias / leading-response fix).
        // Three visually separated blocks so it's clear what's what:
        //   1) the original prompt, 2) the user's own thinking, 3) a bracketed
        //   instruction TO the AI (bracketed = "this is framing, not my hypothesis").
        const suffix = nudge.injectSuffix ? "\n\n" + nudge.injectSuffix : "";
        const finalPrompt =
          originalPrompt +
          "\n\n" + nudge.injectPrefix + response +
          suffix;
        adapter.setPromptText(finalPrompt);
      }
      // Log: nudge was shown; engaged if they typed something.
      logInteraction(originalPrompt, result, true, engaged, false);
      closeNudgeAndSend();
    });

    // SKIP: send the ORIGINAL prompt unchanged. Log as nudge-shown + skipped.
    document.getElementById("ss-skip").addEventListener("click", function () {
      logInteraction(originalPrompt, result, true, false, true);
      closeNudgeAndSend();
    });
  }

  function closeNudgeAndSend() {
    const overlay = document.getElementById("skill-shield-nudge");
    if (overlay) overlay.remove();
    allowNextSend = true;      // let the next send through (don't re-intercept)
    adapter.submit();          // trigger the real send
    setTimeout(function () { allowNextSend = false; inFlight = false; }, 300); // reset for next prompt
  }
})();
