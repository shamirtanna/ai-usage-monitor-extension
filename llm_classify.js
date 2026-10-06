/*
 * LLM CLASSIFIER (JS) — the "own key" path (mode 2).
 *
 * Mirrors the Python llm_classify.py, but runs IN THE BROWSER and calls Claude
 * DIRECTLY with the USER's own API key. Nothing goes through our server, so the
 * prompt stays between the user and their own Anthropic account (privacy).
 *
 * DUPLICATION NOTE (accepted trade, see notebook part 27): this repeats the
 * Python classifier's LLM logic in JS. It's the price of the private BYO-key path
 * — the browser can't call the Python classifier without hitting our server.
 * Keep this in sync with skill-shield-live/llm_classify.py if the taxonomy changes.
 *
 * Exposes: window.SkillShieldLLM.classify(prompt, apiKey) -> Promise<result|null>
 */
(function () {
  const MODEL = "claude-haiku-4-5-20251001";
  const API_URL = "https://api.anthropic.com/v1/messages";

  // Same instruction as the Python system prompt — category + risk + draft_subtype
  // + behaviors, in OUR vocabulary, detected by MEANING (paraphrases count).
  const SYSTEM = [
    "You classify a single user prompt that someone is about to send to an AI assistant.",
    "Return STRICT JSON only, no prose. Schema:",
    '{"category": one of ["Lookup","Draft","Think","Undetermined"],',
    '"risk": one of ["low","medium","high"],',
    '"draft_subtype": one of ["thinking","execution","unknown"] (only meaningful if Draft; else "unknown"),',
    '"behaviors": a list (possibly empty) of {"behavior": <family>, "sub_behavior": <name>}}.',
    "Definitions: Lookup = find a fact/definition (low). Draft = produce content;",
    "draft_subtype 'thinking' = the content/argument/framing IS the work (persuade, propose, recommend,",
    "frame bad news); 'execution' = thinking done, AI is the typist (format, fix, shorten). Unsure -> 'thinking'.",
    "Think = a JUDGMENT/DECISION/STRATEGY task (should we, what's best, how to decide, trade-offs).",
    "Undetermined = not a real work task (operational chatter like 'yes','continue','thanks') = low.",
    "Risk by atrophy stakes: unreasoned Think = high; reasoned Think or plain Draft = medium; Lookup/Undetermined = low.",
    "Behaviors — detect by MEANING (paraphrases count). Use ONLY these (family -> sub_behavior):",
    "Challenge -> 'Hypothesis first','Questioned output','Went deeper','Challenged the source'.",
    "Extend -> 'Human experience','Combined ideas','Combined domains','Extended from source',",
    "'Brought content/outline','Made an analogy'. Recall -> 'Active recall','Hypothesized the answer'.",
    "Experiment -> 'Iterated on output'. None present -> empty list.",
  ].join(" ");

  // Valid (family, sub_behavior) pairs — reject anything off-taxonomy the model invents.
  const VALID = {
    "Challenge|Hypothesis first": 1, "Challenge|Questioned output": 1,
    "Challenge|Went deeper": 1, "Challenge|Challenged the source": 1,
    "Extend|Human experience": 1, "Extend|Combined ideas": 1,
    "Extend|Combined domains": 1, "Extend|Extended from source": 1,
    "Extend|Brought content/outline": 1, "Extend|Referenced a source": 1,
    "Extend|Made an analogy": 1,
    "Recall|Active recall": 1, "Recall|Hypothesized the answer": 1,
    "Experiment|Iterated on output": 1,
  };

  function cleanBehaviors(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = {};
    const out = [];
    raw.forEach(function (item) {
      if (!item || typeof item !== "object") return;
      const key = item.behavior + "|" + item.sub_behavior;
      if (VALID[key] && !seen[key]) {
        seen[key] = 1;
        var spine = item.behavior === "Extend" ? "bring" : "test";
        out.push({ behavior: item.behavior, sub_behavior: item.sub_behavior, spine: spine });
      }
    });
    return out;
  }

  function extractJson(text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) return null;
    try { return JSON.parse(text.slice(start, end + 1)); }
    catch (e) { return null; }
  }

  // Returns a Promise resolving to {category, risk, draft_subtype, behaviors} or
  // null on any failure (bad key, network, off-schema) so the caller can fall back.
  async function classify(prompt, apiKey, timeoutMs) {
    if (!apiKey || !prompt) return null;
    // Hard timeout: a slow nudge is a failed nudge. If Claude doesn't answer in
    // timeoutMs, abort -> this returns null -> caller falls back to local heuristic.
    const controller = new AbortController();
    const timer = timeoutMs ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;
    try {
      const resp = await fetch(API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          // Required for browser-origin calls to the Anthropic API.
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 300,
          temperature: 0,
          system: SYSTEM,
          messages: [{ role: "user", content: prompt.slice(0, 2000) }],
        }),
        signal: controller.signal,
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      const text = (data.content || []).map(function (b) { return b.text || ""; }).join("").trim();
      const parsed = extractJson(text);
      if (!parsed) return null;

      const category = parsed.category;
      const risk = parsed.risk;
      if (["Lookup", "Draft", "Think", "Undetermined"].indexOf(category) === -1) return null;
      if (["low", "medium", "high"].indexOf(risk) === -1) return null;
      let subtype = parsed.draft_subtype;
      if (["thinking", "execution", "unknown"].indexOf(subtype) === -1) subtype = "unknown";

      return {
        category: category,
        risk: risk,
        draft_subtype: subtype,
        behaviors: cleanBehaviors(parsed.behaviors),
      };
    } catch (e) {
      // Includes AbortError (timeout) — treated as a failure -> caller falls back.
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  window.SkillShieldLLM = { classify: classify };
})();
