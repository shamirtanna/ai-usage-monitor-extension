/*
 * CLAUDE ADAPTER — the per-site piece (the ONLY site-specific code).
 *
 * Its job: know how to (1) FIND Claude's prompt box + send button in the live DOM,
 * (2) READ what the user typed, (3) WRITE injected text back so it "sticks", and
 * (4) SEND. Everything else (classify, nudge UI, log) is shared in content.js.
 *
 * DESIGN — self-discovery via RANKED FALLBACKS (not one hard-coded selector):
 * We can't see Claude's live DOM ahead of time and sites change their markup, so
 * each "find" tries several selectors most-specific-first and takes the first hit.
 * This is the same heuristics-over-certainty trade as the classifier: a little
 * precision given up for resilience + zero runtime cost. When a guess misses, it
 * surfaces in the console (see the __ssProbe helper at the bottom) so we can tune.
 *
 * NOTE ON TIMING: content.js already waits (polls) for getPromptElement() before
 * wiring up, so this file only needs solid ONE-PASS discovery, not its own wait.
 */

window.SkillShieldAdapter = {
  siteName: "Claude",

  // ---- 1. FIND THE PROMPT BOX (ranked fallbacks, first match wins) ----
  getPromptElement: function () {
    const selectors = [
      '[data-testid="chat-input"]',                  // CONFIRMED on live Claude (2026-09)
      'div[contenteditable="true"][enterkeyhint]',   // Claude composer sets enterkeyhint
      'div.ProseMirror[contenteditable="true"]',     // ProseMirror/Tiptap rich editor
      '[contenteditable="true"]',                    // any rich editor (broad)
      'textarea[placeholder]',                       // textarea with a placeholder
      'textarea',                                    // last-resort
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && this._isVisible(el)) return el;
    }
    return null;
  },

  // ---- 2. READ what the user typed ----
  getPromptText: function () {
    const el = this.getPromptElement();
    if (!el) return null;
    // contenteditable divs use innerText; textareas use value.
    return (el.innerText || el.value || "").trim();
  },

  // ---- 3. WRITE injected text so the framework actually registers it ----
  // ProseMirror/React track their OWN internal state — setting innerText alone is
  // often ignored or wiped. So we set the text AND dispatch an 'input' event to
  // tell the framework "the user typed", which makes the change stick.
  setPromptText: function (text) {
    const el = this.getPromptElement();
    if (!el) return;

    if (el.tagName === "TEXTAREA") {
      // React tracks textarea value via a native setter; use it, then fire 'input'.
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, "value"
      ).set;
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    // contenteditable (ProseMirror): focus, replace text content, fire input.
    el.focus();
    el.textContent = text;
    // Move caret to end so a subsequent Enter sends the whole thing.
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
  },

  // ---- 4a. FIND THE SEND BUTTON (ranked fallbacks) ----
  getSendButton: function () {
    const selectors = [
      'button[data-testid="chat-input-send"]',   // CONFIRMED on live Claude (2026-09)
      'button[aria-label*="send" i]',            // aria-label containing "send" (case-insensitive)
      'button[data-testid*="send" i]',           // test id containing "send"
      'button[type="submit"]',                   // a submit button
      'form button:not([aria-label*="attach" i])', // button in the composer form (not attach)
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && this._isVisible(el)) return el;
    }
    // Last resort: the button physically nearest the prompt box.
    return this._buttonNearPrompt();
  },

  // ---- 4b. Is this keydown a "send"? (Enter without Shift) ----
  isSendKey: function (e) {
    return e.key === "Enter" && !e.shiftKey;
  },

  // ---- 4c. Actually SEND (called after the nudge is resolved) ----
  // Claude DISABLES the send button while the composer is empty and only enables
  // it once the framework (Tiptap) registers text. After we inject, that enable is
  // ASYNC — so clicking immediately can hit a still-disabled button (a no-op). We
  // poll briefly for the button to become enabled, then click; if it never enables
  // (or no button found), fall back to dispatching Enter on the prompt box.
  submit: function () {
    const self = this;
    let tries = 0;
    const timer = setInterval(function () {
      tries++;
      const btn = self.getSendButton();
      const enabled = btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true";
      if (enabled) {
        clearInterval(timer);
        btn.click();
      } else if (tries > 10) { // ~1s of waiting, then give up on the button
        clearInterval(timer);
        self._pressEnter();
      }
    }, 100);
  },

  _pressEnter: function () {
    const el = this.getPromptElement();
    if (!el) return;
    el.focus();
    ["keydown", "keypress", "keyup"].forEach(function (type) {
      el.dispatchEvent(new KeyboardEvent(type, {
        key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true,
      }));
    });
  },

  // ---- helpers ----
  // Skip hidden/zero-size elements (querySelector can match offscreen leftovers).
  _isVisible: function (el) {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  },

  // Find the button closest to the prompt box (by vertical distance) as a fallback.
  _buttonNearPrompt: function () {
    const prompt = this.getPromptElement();
    if (!prompt) return null;
    const pr = prompt.getBoundingClientRect();
    let best = null;
    let bestDist = Infinity;
    document.querySelectorAll("button").forEach((b) => {
      if (!this._isVisible(b)) return;
      const br = b.getBoundingClientRect();
      const dist = Math.hypot(br.left - pr.right, br.top - pr.top);
      if (dist < bestDist) { bestDist = dist; best = b; }
    });
    return best;
  },
};

/*
 * TUNING HELPER — auto-runs shortly after load and PRINTS what the adapter finds.
 * It logs from the extension's own context (isolated world), so the output shows
 * in the F12 console WITHOUT you typing anything — content scripts can't be called
 * from the page's console (separate JS world), so we log proactively instead.
 * Purely diagnostic. Delay lets Claude finish building its UI before we probe.
 */
function __ssProbe() {
  const a = window.SkillShieldAdapter;
  const prompt = a.getPromptElement();
  const btn = a.getSendButton();
  console.log("[SS PROBE] prompt box:", prompt);
  console.log("[SS PROBE] prompt tag/class:",
    prompt ? prompt.tagName + " . " + prompt.className : "NOT FOUND");
  console.log("[SS PROBE] send button:", btn);
  console.log("[SS PROBE] send label / text:",
    btn ? (btn.getAttribute("aria-label") || ("«" + btn.textContent.trim().slice(0, 40) + "»")) : "NOT FOUND");
  console.log("[SS PROBE] send outerHTML:",
    btn ? btn.outerHTML.slice(0, 300) : "NOT FOUND");
}
// One probe after the UI settles. Kept for re-tuning if Claude changes markup;
// set to false to silence once you trust discovery.
const SS_PROBE_ON = true;
if (SS_PROBE_ON) setTimeout(__ssProbe, 3000);
