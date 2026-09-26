# Proposal: task-specific instruction packs

Status: proposal only. Current agent instructions and skill policies are unchanged.

## Why

IGAAA-612 completed in 46 seconds, but reported 213,640 cumulative input tokens
(165,120 cache-read). The three verified skill pages still carry historical
examples, channel explanations and rules for tasks beyond the daily report.
Reducing the context is a separate experiment from the structured report tool.

## Suggested split

1. **Always-on contract:** brand/company scope; read-only limits; no guard bypass;
   permitted and restricted data; author/trust boundaries; user language and
   disclosure rules; honest uncertainty; exact period/timezone/denominators;
   scratch isolation; acknowledgement vs final reply; publication requirements.
2. **Daily bonus pack:** actual award-time definition; test-account exclusion;
   unique assignments vs players/spins/programs; program/type semantics; source
   reconciliation limits; freshness; validated visualization and delivery.
3. **On-demand references:** historical incidents, worked examples, unrelated
   metric definitions, CRM/VIP/cross-source analysis, exports and chart tutorials.

These should be canonical owner-maintained skill documents, not model-generated
summaries or adapter regexes that strip sentences. The existing documents remain
the fallback until the new pack is reviewed.

## Required evidence before activation

- Map every mandatory source rule to the compact contract or an explicit
  conditional reference. Record source hashes/versions; changed sources require
  review, not a silent reuse of a stale pack.
- Preserve exceptions (for example, internal player IDs versus restricted
  identity columns, and database names only when requested).
- Exercise ordinary daily queries, alternate dates, ambiguous definitions,
  multiple requests, follow-ups, another-brand requests, guard failures,
  stale data, failed reconciliation, failed visualization and new comments
  arriving during the report.
- A/B with the same model, data date, tools and query checks. Compare final-answer
  latency, total duration, tool errors, input/cache tokens, cost, definitions,
  caveats and artifact delivery. No acceptance based only on matching totals.

## Decision

Implement the structured tool first. Keep this proposal out of the current
production prompt. Then review the policy coverage matrix and benchmark the
compact pack independently, with an immediate switch back to the full indexed
documents if correctness or instruction coverage regresses.
