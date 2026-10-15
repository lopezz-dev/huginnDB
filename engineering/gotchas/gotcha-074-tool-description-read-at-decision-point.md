---
id: 74
type: gotcha
status: active
date: 2026-09-10
tags: [llm, ai, testing]
related: [71]
supersedes: []
superseded_by: null
amends: []
---

# Gotcha #74: A tool's description is read at the decision point, so it must never tell the model to delegate the tool's own job

`run_query`'s description used to end with "propose the SQL to the user instead of trying to run it" — a sentence about the *write* refusal, sitting in the one string the model reads while deciding whether to call the tool at all — and the observable result was an assistant that wrote out a `SELECT` and waited for the user to run it.

**Trap:** Guidance in a tool's description is read at the decision point, so a sentence telling the model to propose instead of run made it stop calling the tool and hand SQL to the user.

## Detail

**A system prompt is read once; a tool description is read every time the model chooses.** They are not interchangeable places for the same guidance, and the difference is position rather than emphasis. Guidance about what a tool must *not* do belongs in the refusal path, where it answers an attempt that already happened. Put it in `description` and it stops being a constraint on misuse and becomes an argument against calling the tool, evaluated at the exact moment the model is weighing whether to act — competing with the reason to call it, in the same paragraph, with the last word. The report from live use was that the model "no infiere tanto", waiting for the user on everything; the cause was our own text telling it to.

- **The system prompt had the same defect from the other side.** It weighted proposing a statement above reading one, so the two reinforced each other: the prompt said the polite move is to propose, and the tool said its own job was better delegated. Both were rewritten — every description in the imperative, naming what the tool does and when to reach for it, and the prompt now states plainly that reading is the assistant's job and that a statement is proposed only when it would *write*.
- **Both rewrites carry regression guards, because prose has no type.** Tests assert the descriptions contain no delegation language and that the prompt's read-before-propose ordering holds. The first version of the delegation guard was itself buggy — it matched the prohibition as well as the instruction, so a description saying "never ask the user to run this" failed the test meant to protect it. A guard over natural language has to match intent, not keywords.
- **Descriptions grew, and that broke a test double rather than the product.** `ai::provider`'s hand-rolled one-shot loopback server never drained the request body, which is invisible while requests are small and becomes `ECONNRESET` once they are not: the client was still writing when the server closed. It now reads `content-length` before replying. A fixture that only works on small inputs is a fixture that fails the day the input gets interesting.
- **Every extra tool costs accuracy on every turn**, which is the other half of why the withheld variants in ADR #71 stay withheld. The catalogue's job is not to expose capability; it is to make the right call obvious.
