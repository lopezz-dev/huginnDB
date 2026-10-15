---
id: NNN                          # next free number in the global sequence (all kinds share it)
type: adr
status: accepted                 # accepted | superseded
date: YYYY-MM-DD
tags: []                         # 1–3, reuse existing tags (see the indexes)
triggered_by_external_trap: false
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #NNN: <the decision, stated as a sentence>

<One-paragraph summary: the decision and the reason that matters most. The indexes show this paragraph.>

**External trap behind it:** <only if triggered_by_external_trap — the external fact, one sentence; otherwise delete this line>

**Decision:** <what was chosen, one sentence>

**Alternatives rejected:**

- <alternative> — <why not>

## Context

<What forced a choice: the bug, the constraint, the feature.>

## Consequences

<What this makes true elsewhere, what it costs, what must not be undone without revisiting this ADR. Name files and functions.>
