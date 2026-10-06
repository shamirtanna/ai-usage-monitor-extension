# AI Usage Monitor and Skill Protection

A Chrome extension that helps you keep your own thinking sharp while using AI.

AI is great at giving answers. But if you hand it the *thinking* too — the judgment, the reasoning, the
framing — the underlying skill quietly fades. This extension detects the moments where you're delegating the
thinking and, right before you send a prompt, nudges you to bring your own first.

> This is an independent personal project, exploring how to protect and build human skills in the age of AI.
> It is not affiliated with Anthropic or Claude. Currently works on Claude (claude.ai).

---

## What it does

- **Nudges in the moment.** It reads your prompt before it's sent and, on high-stakes prompts (a decision, a
  judgment call, a piece of persuasive writing), asks you for your own hypothesis or key points — then adds
  what you write into the prompt, so your thinking shapes the answer. It also asks the AI to push back and
  offer alternatives, rather than just agree.
- **Only when it matters.** Quick lookups and formatting are left alone — the nudge fires only where handing
  off the thinking has real cost.
- **A private dashboard.** A popup showing how you've used AI today, by category, and how often you brought
  your own thinking.
- **Recall ("testing your learning").** Resurfaces a few things you looked up earlier and asks you to recall
  them first — turning one-off lookups into knowledge you keep.

## The framework

Each prompt is read along a few dimensions:

- **Category** — what you're asking AI to do: *Lookup* (find a fact), *Draft* (produce content, split into
  "execution" vs. "thinking"), *Think* (a judgment/decision/strategy task), or operational chatter.
- **Protective behaviors** — did you bring your own thinking? These fall into two groups:
  - *Test yourself* — form a hypothesis, push back on the output, recall before looking up.
  - *Bring what AI can't* — your own experience, an analogy from another domain, a combination of ideas.
- **Risk** — high-stakes category + no protective behavior = the moment to nudge.

## The science it draws on

- **Testing effect / retrieval practice** — recalling an answer strengthens memory far more than re-reading
  it (Roediger & Karpicke, 2008).
- **Spacing effect** — retrieval spread over time builds durable memory (Ebbinghaus; Cepeda et al., 2006).
- **Consider-the-opposite** — deliberately generating alternatives counters confirmation bias (Lord, Lepper
  & Preston, 1984).
- **LLM sycophancy** — models tend to agree with the user, which is why bringing a hypothesis isn't enough
  on its own (Sharma et al., 2023).
- **Deliberate practice / desirable difficulty** — skill grows from effortful reps, not passive exposure
  (Ericsson; Bjork).

## Privacy — your choice (three modes)

Interaction history is stored **locally in your browser**, never on a server. For the smarter classification
of ambiguous prompts, you choose how:

- **Local** — a built-in rule-based classifier runs entirely in your browser. Nothing leaves your device.
- **Your own key** — the extension calls the Anthropic API directly from your browser with *your* key. Your
  prompt goes to your account, not ours.
- **Shared server** — routes through a hosted classifier (with daily limits). The prompt is classified in
  transit and **never stored**; only anonymous usage counts are kept.

Full privacy policy: https://ai-usage-monitor-server.onrender.com/privacy

## Architecture

- **This repo (public): the Chrome extension.** Content script that intercepts the send and shows the nudge,
  a JS classifier (heuristics + an optional direct-to-Anthropic LLM tier for "your own key" mode), the
  popup dashboard, and a per-site adapter.
- **The classifier backend is a separate, private service.** In "shared server" mode the extension calls a
  small hosted Python server that runs the same heuristic-first + LLM-tail classification and enforces usage
  quotas. It stores no prompt content. (Kept private because it holds the API key and server-side logic;
  the extension works fully in Local and Your-own-key modes without it.)

```
Chrome extension (this repo)
  ├─ adapters/claude.js      per-site DOM: find prompt box + send button, read/inject text
  ├─ content.js              intercept send → classify → nudge → inject → send
  ├─ classifier.js           JS heuristic classifier (local mode)
  ├─ llm_classify.js         direct Anthropic call (your-own-key mode)
  ├─ storage.js              local history + settings (chrome.storage)
  └─ popup.html / popup.js   dashboard + settings + recall
        │
        └── (shared-server mode) → private hosted classifier service
```

## Install (developer / manual)

1. Clone or download this repo.
2. Go to `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Open claude.ai and start a prompt — the nudge appears on high-stakes prompts.

(A one-click Chrome Web Store listing is in review.)

## Status

Early and personal. This is a prototype I built to study my own AI use; treat the findings as exploratory,
not settled. Feedback and ideas welcome.
