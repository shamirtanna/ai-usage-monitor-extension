/*
 * MOCK ADAPTER — per-site adapter for our local mock-ai.html dev page.
 *
 * Adapter jobs (all site-specific):
 *   1. getPromptElement / getPromptText  — read what the user typed
 *   2. getSendButton / isSendKey         — know HOW this site sends (to intercept)
 *   3. submit                            — actually send, after the nudge is handled
 *
 * Everything else (classify, decide, nudge UI) is shared in content.js.
 */
window.SkillShieldAdapter = {
  siteName: "Mock AI",

  getPromptElement: function () {
    return document.getElementById("prompt-input");
  },

  getPromptText: function () {
    const el = this.getPromptElement();
    if (!el) return null;
    return (el.innerText || el.value || "").trim();
  },

  // Overwrite the prompt box text (used to inject the user's hypothesis before send).
  setPromptText: function (text) {
    const el = this.getPromptElement();
    if (!el) return;
    if ("value" in el && el.tagName === "TEXTAREA") {
      el.value = text;
    } else {
      el.innerText = text;  // contenteditable div
    }
  },

  // The send button element (so we can intercept clicks on it).
  getSendButton: function () {
    return document.getElementById("send-btn");
  },

  // Does this keydown event represent a "send"? (Enter without Shift.)
  isSendKey: function (e) {
    return e.key === "Enter" && !e.shiftKey;
  },

  // Actually perform the send (called after the nudge is resolved).
  // For the mock, that's clicking the send button.
  submit: function () {
    const btn = this.getSendButton();
    if (btn) btn.click();
  },
};
