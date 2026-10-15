---
id: 80
type: adr
status: accepted
date: 2026-09-10
tags: [ai, llm]
triggered_by_external_trap: true
related: [55, 73]
supersedes: []
superseded_by: null
amends: []
---

# ADR #80: An agent needs breadth before depth — hand it the table map, and let the user write down what the schema cannot say

Agent mode gave the model tools and nothing else, so its first move was always a guess: it fixed on whichever table or column the question named and answered about that, because as far as it knew nothing else existed. `ai::orient::overview` now hands it the table list before the first model call, and `ConnectionProfile::ai_notes` lets the user say the part no read can discover.

**External trap behind it:** An agent given only tools, with no map of the database, fixes on the table or column the question names and assumes nothing else exists.

**Decision:** ai::orient::overview prepends the table name list with an instruction before the first model call, and ConnectionProfile::ai_notes lets the user write domain knowledge that is bounded, labelled and kept local across origin refreshes.

**Alternatives rejected:**

- Describing every table up front: rejected because eighty describe_table replies would fill the context window.
- Caching the overview: rejected as a second copy of the schema that can be wrong.
- Failing the turn when the overview read fails: rejected; the turn runs without orientation.
- Publishing ai_notes through the shared origin: deferred because it needs a field in the origin document and a schema version.

## Detail

**The complaint was "it focuses on one field and does not understand the context of the database", and it was a context problem rather than an intelligence problem.** A person reading the schema tree has the map on screen before they type a word. An agent that has to *discover* the map by spending iterations on it usually will not bother — and a small model, with six steps and a small context window, genuinely cannot afford to. The comparison the user drew was to a coding agent, which arrives already knowing the repository's shape: the difference is not reasoning, it is orientation.

- **Names are cheap; structure is not.** Eighty table names cost a few hundred tokens. Eighty `describe_table` replies would fill the window and leave no room for the question — the same trade `ai::exec`'s size budget exists for (ADR #73). Names are enough to orient: they say what the database is *about* and which tool to spend a step on.
- **The map carries an instruction, or it is trivia.** `table_map` ends with "that is the whole surface — nothing outside that list exists to query", plus the ask to check whether a neighbouring table is the one the question means. Without those two sentences a model treats the list as decoration; with them, the list is what stops the answer being about whichever name the question happened to mention.
- **Deliberately not cached.** A catalog read is milliseconds next to a completion that takes seconds, and a cache here would be a second copy of the schema that can be wrong — the lesson the schema tree's warm state already taught (ADR #55). A failed read is not an error either: the turn runs without orientation exactly as it did before, because losing a whole turn over a preamble would be the wrong trade.
- **`ai_notes` is the half that no read can produce**, and the closest thing this feature has to the project instructions a coding agent gets. A model can read every table and still not know that `cfg_*` holds one row per tenant, that `status` uses the codes an old system wrote, or that the table everyone asks about is the one with the least obvious name. The user writes it once per connection; it is prepended to agent turns *and* assisted tasks, ordered **last** in the preamble (closest to the question) and **first** among a task's context sections, because it is what changes how everything after it should be read.
- **Bounded twice, and attributed.** `MAX_AI_NOTES_CHARS` caps it on the way in (a `profiles.json` carrying a pasted-in wiki page is a slow load and a big write on every unrelated flag change) and again in the prompt, where truncation says so out loud. The section is labelled *what the user says*, so the model weighs it as domain knowledge rather than as one more tool reply.
- **Local, preserved across a shared-origin refresh** — like `ai_enabled` and `ai_rows_allowed`, but for a weaker reason. Those are decisions about what may leave this machine, which a publisher cannot make; a note describes the *database*, so a publisher documenting it once for a whole team would be a genuinely better feature. That needs a field in the origin document and a schema version, so until then the rule is simply that a refresh must never erase what somebody wrote.
