/*
 * CLASSIFIER (JavaScript port of the Python heuristic classifier).
 *
 * This is the SHARED BRAIN — site-agnostic, runs natively in the browser (no
 * Python, no server, no network). Same logic/markers/risk rules as the Python
 * version, so it produces equivalent results.
 *
 * Python -> JS mapping notes:
 *   - Python list  ["a","b"]        -> JS array   ["a","b"]   (same)
 *   - Python `any(m in text ...)`   -> JS `arr.some(m => text.includes(m))`
 *   - Python dict {"k": v}          -> JS object  {k: v}
 *   - Python `def f(x):`            -> JS `function f(x) {`
 *
 * Exposes: window.SkillShieldClassifier.classify(prompt) -> {category, risk, behaviors, ...}
 */
(function () {
  // --- normalize: lowercase + collapse whitespace (same as Python _normalize) ---
  function normalize(text) {
    return (text || "").toLowerCase().trim().replace(/\s+/g, " ");
  }

  // ===== CATEGORY MARKERS (the keyword lists) =====
  const LOOKUP_MARKERS = [
    "what is", "what are", "what's the difference", "define", "definition of",
    "who is", "when did", "where is", "list of", "examples of",
    "find me", "look up", "search for", "how many", "what does",
  ];
  const DRAFT_MARKERS = [
    "write", "draft", "compose", "create a", "generate a", "make me a",
    "rewrite", "edit this", "summarize", "reword", "format",
    "turn this into", "give me a template",
  ];
  const DRAFT_EXECUTION_MARKERS = [
    "format", "fix the", "fix my", "grammar", "rewrite", "reword", "edit this",
    "turn this into", "turn my", "clean up", "proofread", "shorten", "tighten",
    "make this", "polish", "into a table", "into bullets", "into prose",
  ];
  const DRAFT_THINKING_MARKERS = [
    "persuade", "convince", "argue", "make the case", "make a case", "pitch",
    "propose", "proposal", "recommend", "justify", "position", "narrative",
    "prfaq", "pr faq", "strategy", "vision",
  ];
  const THINK_MARKERS = [
    "should i", "should we", "help me decide", "help me think", "what's the best",
    "what is the best", "how should", "what would you do", "is it worth",
    "do you think", "what's your take", "pros and cons", "evaluate", "assess",
    "which is better", "how do i decide", "strategy for", "approach to",
    "why should", "worth it", "trade-off", "tradeoff",
  ];

  // small helper: does the text contain any marker in the list?
  function hasAny(text, markers) {
    return markers.some(function (m) { return text.includes(m); });
  }
  // helper: does the text start with a marker, or contain " marker"?
  function startsOrContains(text, markers) {
    return markers.some(function (m) {
      return text.startsWith(m) || text.includes(" " + m);
    });
  }

  // ===== QUESTION 1 — CATEGORY =====
  function classifyCategory(text) {
    // draft-execution first (so "fix the grammar" isn't treated as Think)
    if (hasAny(text, DRAFT_EXECUTION_MARKERS)) return "Draft";
    // retrieval intent
    if (hasAny(text, ["list the", "list of", "name the", "what are the"])) return "Lookup";
    // decision words -> Think
    if (hasAny(text, THINK_MARKERS)) return "Think";
    if (startsOrContains(text, LOOKUP_MARKERS)) return "Lookup";
    if (startsOrContains(text, DRAFT_MARKERS)) return "Draft";
    // short factual openers
    if (/^(what |when |who |where |how many)/.test(text)) return "Lookup";
    // do NOT default to Think — one "Undetermined" bucket for non-tasks/unclear
    return "Undetermined";
  }

  function classifyDraftSubtype(text) {
    if (hasAny(text, DRAFT_THINKING_MARKERS)) return "thinking";
    if (hasAny(text, DRAFT_EXECUTION_MARKERS)) return "execution";
    return "unknown";
  }

  // ===== QUESTION 2 — BEHAVIORS =====
  // Each entry: [family, sub_behavior, [phrases]]
  const BEHAVIOR_SIGNALS = [
    ["Challenge", "Hypothesis first", ["i think", "i believe", "my hypothesis", "my guess", "my take is", "i'd say", "i would say", "my view is", "i suspect", "i assume", "my instinct", "i lean toward", "i'm leaning"]],
    ["Challenge", "Questioned output", ["but doesn't", "but isn't", "that seems wrong", "i disagree", "am i wrong", "what am i missing", "push back", "isn't that", "that can't be right", "are you sure"]],
    ["Challenge", "Went deeper", ["why does", "why would", "what's underneath", "root cause", "first principles", "fundamentally why"]],
    ["Extend", "Human experience", ["in my experience", "i've seen", "we've found", "at my company", "in our case", "from what i've observed", "last time we", "we tried", "in the past we", "our team", "my customers"]],
    ["Extend", "Combined ideas", ["this connects to", "similar to", "reminds me of", "combined with", "building on"]],
    ["Extend", "Combined domains", ["how does this connect to", "apply what we learned", "cross-apply", "like our", "like the", "same as when we", "similar to when we", "does this apply to our", "relate this to"]],
    ["Recall", "Active recall", ["i already know", "off the top of my head", "before i look", "let me try first", "i recall", "if i remember"]],
    ["Challenge", "Challenged the source", ["what's this based on", "what is this based on", "is that source", "how reliable", "can i trust", "is that actually true", "verify this", "what's the evidence", "who says", "according to what", "how do we know"]],
    ["Extend", "Referenced a source", ["the article says", "it states", "the source says", "on page", "the study found", "according to the", "the report says", "quote:", "\"", "it says that"]],
    ["Extend", "Brought content/outline", ["here are my points", "here are the points", "my outline is", "the structure is", "i want to cover", "cover these", "my key points", "here's my draft", "here is my draft", "based on these points", "using these bullets", "my argument is"]],
    ["Experiment", "Iterated on output", ["make that", "make it", "no, instead", "sharper", "push further", "take your last", "build on that", "refine that", "tighten that", "now apply that", "go deeper on that", "revise that", "instead of that"]],
    ["Recall", "Hypothesized the answer", ["i think it's", "i think it is", "probably", "my guess is", "i'd estimate", "i would estimate", "is it around", "i'm guessing", "i'd bet", "if i had to guess"]],
    ["Extend", "Made an analogy", ["like a", "it's like", "analogous to", "think of it as", "the same way that"]],
  ];

  // Two spines (static map, not a judgment): Extend = "bring what AI can't";
  // everything else (Challenge/Recall/Experiment) = "test yourself".
  function spineOf(family) {
    return family === "Extend" ? "bring" : "test";
  }

  function classifyBehaviors(text) {
    const found = [];
    BEHAVIOR_SIGNALS.forEach(function (entry) {
      const family = entry[0], sub = entry[1], phrases = entry[2];
      if (phrases.some(function (p) { return text.includes(p); })) {
        found.push({ behavior: family, sub_behavior: sub, spine: spineOf(family) });
      }
    });
    return found;
  }

  // ===== PUT IT TOGETHER =====
  function classify(prompt) {
    if (!prompt || !prompt.trim()) {
      return { category: "Undetermined", behaviors: [], risk: "low", engaged: false, undetermined: true };
    }
    const text = normalize(prompt);
    const category = classifyCategory(text);
    const behaviors = classifyBehaviors(text);
    const engaged = behaviors.length > 0;
    const draftSubtype = category === "Draft" ? classifyDraftSubtype(text) : null;

    // ---- risk logic (same as Python) ----
    let risk;
    if (category === "Think") {
      risk = engaged ? "medium" : "high";
    } else if (category === "Draft") {
      if (draftSubtype === "thinking" && !engaged) risk = "high";
      else if (draftSubtype === "execution") risk = "low";
      else if (!engaged) risk = "medium";
      else risk = "low";
    } else {
      // Lookup or Undetermined
      risk = "low";
    }

    return {
      category: category,
      behaviors: behaviors,
      risk: risk,
      engaged: engaged,
      draft_subtype: draftSubtype,
      undetermined: category === "Undetermined",
    };
  }

  // expose it for content.js to use
  window.SkillShieldClassifier = { classify: classify };
})();
