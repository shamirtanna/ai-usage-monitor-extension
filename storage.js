/*
 * STORAGE (shared) — the extension's local memory, using chrome.storage.local.
 *
 * This is the browser equivalent of the Python JSONL log: append one record per
 * interaction. It persists across page reloads and browser restarts, but lives
 * locally in this browser (a working cache — the durable cloud "vault" is later).
 *
 * chrome.storage is ASYNC: to append, we read the current array, push, write back.
 * We keep it here as a shared module so content.js just calls logInteraction(...).
 */
window.SkillShieldStorage = {
  KEY: "interactions",

  // Append one interaction record to the stored array.
  // We ALWAYS store the derived classification (category/risk/behaviors/timestamp)
  // for stats. The prompt TEXT is only kept if storePrompts is on — otherwise we
  // drop it (privacy), which means recall/recent-text can't be shown for it.
  logInteraction: function (record) {
    const KEY = this.KEY;
    const self = this;
    record = Object.assign({ timestamp: new Date().toISOString() }, record);
    this.getSettings(function (settings) {
      if (!settings.storePrompts) {
        delete record.prompt;            // drop the words; keep the stats
        record.prompt_stored = false;    // mark so the popup can show "hidden"
      }
      chrome.storage.local.get([KEY], function (data) {
        const list = data[KEY] || [];
        list.push(record);
        const obj = {};
        obj[KEY] = list;
        chrome.storage.local.set(obj, function () {
          console.log("[Skill Shield] logged interaction (total:", list.length + ")");
        });
      });
    });
  },

  // Read all interactions back (used later by the popup). Callback gets the array.
  readInteractions: function (callback) {
    chrome.storage.local.get([this.KEY], function (data) {
      callback(data[this.KEY] || []);
    }.bind(this));
  },

  // ---- SETTINGS (user toggles) ----
  // Two flags, both default ON: 'tracking' (log interactions) and 'nudges'
  // (show the pre-send nudge). Stored under one key so we read/write together.
  SETTINGS_KEY: "settings",
  // storePrompts: whether to KEEP the actual prompt TEXT. Classification, nudging,
  //   and STATS always happen regardless — this only controls retention of the
  //   words. OFF = we store the derived classification (category/risk/behaviors/
  //   timestamp) but NOT the prompt text, so recall ("Testing your learning") and
  //   the recent-prompts text can't be shown (you can't resurface words you didn't keep).
  // nudges: show the pre-send nudge on high-risk prompts.
  // mode: how ambiguous/high-risk prompts get the smarter LLM check —
  //   "local" = heuristic only (private); "own-key" = browser->Claude with user key;
  //   "server" = route through our hosted server (our key, quota).
  // apiKey: used only in "own-key" mode; stored locally, sent only to Anthropic.
  // Default mode = "server": new users get smart classification out of the box
  // (no key setup), protected by the per-user + global quota. Private alternatives
  // (local / own-key) are one click away in Settings. See notebook part 27 + 32.
  DEFAULT_SETTINGS: { storePrompts: true, nudges: true, mode: "server", apiKey: "" },

  // A random per-install id, sent with server-mode requests so the server can
  // enforce PER-USER quota. Not identity/auth — just a counter key. Generated
  // once and persisted. (A user could reset it; the server's GLOBAL cap is the
  // real backstop against that — see quota.py.)
  getUserId: function (callback) {
    chrome.storage.local.get(["userId"], function (data) {
      if (data.userId) { callback(data.userId); return; }
      const id = "u_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      chrome.storage.local.set({ userId: id }, function () { callback(id); });
    });
  },

  getSettings: function (callback) {
    const self = this;
    chrome.storage.local.get([this.SETTINGS_KEY], function (data) {
      // Merge stored over defaults so a missing flag falls back to ON.
      callback(Object.assign({}, self.DEFAULT_SETTINGS, data[self.SETTINGS_KEY] || {}));
    });
  },

  setSetting: function (name, value, callback) {
    const self = this;
    this.getSettings(function (current) {
      current[name] = value;
      const obj = {};
      obj[self.SETTINGS_KEY] = current;
      chrome.storage.local.set(obj, function () {
        if (callback) callback(current);
      });
    });
  },
};
