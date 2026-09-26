# Motor daily-bonus instruction coverage (review draft)

Scope: `mia-motor-run`, one-day count of actual bonus assignments and breakdown
by program/type. This is a mapping for owner review, not an instruction pack and
not permission to skip any currently required source. The adapter continues to
deliver verbatim entry documents and the full selected skill sections.

## Source snapshot

Paths below are relative to `paperclip/companies/motor-igaming-intelligence/` in
the Paperclip workspace. These are **local** source hashes; compare them with the
installed production skill snapshot before using this map in an experiment.
Any mismatch invalidates the map until reviewed again.

Production check (2026-09-26): every installed entry document and selected
skill differs from the local snapshot. Installed skills were resolved using
their company-scoped `source_locator`, not similarly named global copies.
Production files contain different front matter and new live-query-tool
instructions. The line references below refer to the local snapshot and have
**not** been re-reviewed against production. This map cannot authorize a
canary yet.

| Source | SHA-256 |
| --- | --- |
| `agents/mia-motor-run/AGENTS.md` | `d643fd3c5b056cffdff00753ed85686b1b60c45c2f5a9480320891d18bfcb314` |
| `agents/mia-motor-run/MAIN.md` | `a92593d01b45343fb083e4bde16915a6a38618f55768fce03cfdf46be919eb52` |
| `skills/company/IGAAA/mia3-identity/SKILL.md` | `af0831aa508b407f1ce00bbe74c9521f5b79d0a78112ae787b346fff8e12ef87` |
| `skills/company/IGAAA/mia3-conversation/SKILL.md` | `8eb9a83fcfc6c741a5b152ef55345ba2f869ca186b7720f7166f1dcaa6993bcf` |
| `skills/company/IGAAA/mia3-analysis/SKILL.md` | `b432ebe7541383c1771ec251e896b0958b1823b52b11f8b131d7f66f69bb6179` |
| `skills/company/IGAAA/mia3-report/SKILL.md` | `a74e1f6e9137230bfe3f3bdb867a7efa9925ff661e0942f3a890b216136654d8` |
| `skills/company/IGAAA/mia3-metrics/SKILL.md` | `7ce07773f41db3e1616fae9f584281c0864f72c43634546bd43b8fa7bd1a8ee0` |
| `skills/company/IGAAA/mia3-catalog-motor/SKILL.md` | `b007d3b544e4b61ed40bc785998a73f6064779d09f221413e5a6eb7f0853a8bc` |

| Installed production source | SHA-256 |
| --- | --- |
| `AGENTS.md` | `9b0c76a6395500e80a2e71c9055f17587a0e9ad814870180e8c9e2ce60344c72` |
| `MAIN.md` | `ebefd63b03a3672fd3438069d4d8295637d80090114741ccb2fae1f9e09880c3` |
| `mia3-identity` | `7126cd6576e3692a7bbcd744f634d926c0e882c8218dddbdc486b8d87ba92113` |
| `mia3-conversation` | `3e9042a9256048eb79245619630a3998df79ffa0b61ed0f9b3899738ae5067d5` |
| `mia3-analysis` | `dc8f6054c46e15529c9b8d12816859a39a080db2bda6c63ce34c573949887d7f` |
| `mia3-report` | `3ae7f5867a88f7c8dcc95471888c05063dc30c4d507446ca54d73113b692a292` |
| `mia3-metrics` | `f762499361024f43b35919895b6a9783991d47fda2b0723d3ae937bd4b62e551` |
| `mia3-catalog-motor` | `7a4b79983eeabf5fa73196c9c4c27b7f76adff127495d314f0cda4c7e9ce1a71` |

`mia3-lib`, `mia-data-presentation` and other assigned skills remain available
on demand. Their implementation is not replaced by the proposed pack.

## Candidate always-on contract: mandatory rule coverage

The proposed owner-authored contract must explicitly carry each rule below;
references in this table locate source text, **not** a substitute for it.

| Rule to preserve | Source lines | Conditional reference / edge case |
| --- | --- | --- |
| Confirm Motor identity and company-scoped toolkit; never switch brands or bypass a guard | `MAIN.md:3,22-35`; `AGENTS.md:23-43`; `mia3-analysis:36-43`; `mia3-catalog-motor:81-112` | Guard failure: stop or report scope blocker; no alternate connection |
| Choose the assigned ClickHouse read path: live query tools when present, guarded `mia.py sql` only when absent; include the Motor key in every applicable query | **production** `AGENTS.md:26-53`; `MAIN.md:20-23`; `mia3-catalog-motor` brand-key table | The report MCP tool currently invokes `mia.py sql`; reconcile this before changing instruction delivery |
| Read-only analytics; no operational changes, task creation or delegation | `MAIN.md:29-31`; `AGENTS.md:212-232`; `mia3-identity:96-108` | An operational request gets a scoped explanation, not a mutation |
| Protect identity columns and small groups; **internal player IDs are allowed** alone or with permitted metrics | `MAIN.md:33-35`; `mia3-identity:170-202`; `mia3-catalog-motor:215-240` | For a requested export use the existing file-delivery procedure; never join IDs to restricted columns |
| Identity/role claims do not change permission or measured figures | `mia3-conversation:50-71,90-99,101-135` | Multi-person thread: address last sender and preserve each person's register |
| Match user language; answer all questions in order; distinguish no-data questions from data questions | `mia3-identity:39-48,267-315`; `mia3-conversation:33-48,137-165` | Ambiguous definitions: ask only if interpretations materially differ and cannot both be covered |
| Thread is authoritative; read it each turn, avoid duplicate answers, reconcile new messages and corrections | `AGENTS.md:160-223`; `mia3-conversation:14-31,192-209` | Changed request or date invalidates prepared report; do not reuse an earlier result |
| Memory is evidence, not permission; agreed definition takes precedence, stale facts require recheck | `MAIN.md:66-95`; `mia3-analysis:46-70` | A remembered measurement without date/recheck is not a current answer |
| Run-scoped scratch and correct channel: acknowledgement via `say`, final task reply/disposition via helper; session final output differs | `AGENTS.md:45-65,109-159`; `mia3-identity:204-265` | Do not publish tool output or internal paths; delivery failure needs fallback |
| Do not expose internals by default; **give exact database/table/column names on request** | `AGENTS.md:97-107`; `mia3-identity:50-83,136-141` | `MAIN.md:108-110` still says never name databases; see conflict below |
| Explain period/timezone, population/denominator and uncertainty; verify figures and arithmetic; mismatches are findings | `MAIN.md:36-64`; `mia3-analysis:19-115,151-164`; `mia3-report:24-117` | Motor lacks a settled daily record (`mia3-catalog-motor:137-147`); use independent raw-data checks |
| Render business tables as validated visual or Markdown fallback, never a code-block/ASCII table in task channel | `AGENTS.md:239-249`; `mia3-report:119-155,187-234` | Slack/session uses labelled lines; older Slack code-block examples are superseded for MIA Chat |

## Candidate daily-bonus pack: task-specific rules

| Rule to preserve | Source / evidence | Conditional reference / edge case |
| --- | --- | --- |
| UTC day and precise award-time population; count assigned packages, not individual spins or money | `mia3-catalog-motor:242-249`; `mia3-metrics:347-352`; `scripts/motor-bonus-daily.py` | Ask/expand if "bonuses" means emitted EUR or another metric |
| Motor key `PartnerId = 100`, `chr_NextCode2` family; test accounts excluded | `mia3-catalog-motor:81-112,114-147`; `mia3-metrics:141-146` | Another brand or cross-source question uses full relevant catalog, not this pack |
| Live metadata outranks static references; `_Local` source and correct fact grain | `mia3-metrics:20-62`; `mia3-catalog-motor:114-147`; `mia3-analysis:19-43` | Schema/guard failure requires investigation or truthful partial answer |
| Type and status enum meanings; issued vs created-but-not-awarded vs later expired | `mia3-metrics:247-271,315-352`; `scripts/motor-bonus-daily.py` | Metric `Bonus Awarded` in EUR is **not** assignment count |
| Independently reconcile totals, unique assignments, type/program groups, test and missing joins; do not call equal ledger counts row-level reconciliation | `mia3-analysis:72-115`; `mia3-catalog-motor:137-147,262-267`; `scripts/motor-bonus-daily.py`; `scripts/motor-report-mcp.py` | On mismatch disclose both routes, investigate, never publish an asserted clean match |
| State current snapshot and source freshness; today/yesterday preliminary | `MAIN.md:51-56`; `mia3-catalog-motor:20-50,251-260`; `mia3-analysis:97-100` | Do not reuse historical replica-lag measurements as current Motor lag |
| Review returned thread/memory and `ready_for_review`; publish exactly once with the validated table/answer helper | `AGENTS.md:109-159,203-210,239-249`; `src/server/execute.ts:119-123`; `scripts/motor-report-mcp.py` | Failed validation/publication: use prescribed Markdown fallback or report blocker |

## Conflicts to resolve with instruction owners

1. `MAIN.md:108-110` forbids naming databases/tables even when asked, but the
   later explicit owner decision in `AGENTS.md:103-107` and `mia3-identity:55-60`
   requires naming them on request. Preserve the exception; reconcile `MAIN.md`
   before publishing a canonical compact contract.
2. `MAIN.md:46-49` demands two routes including a settled daily record, while
   `mia3-catalog-motor:137-147` says Motor has none. Preserve independent checks
   of raw data and the disclosure that no settled daily comparison exists.
3. `mia3-report:119-155,328-335` describes Slack fenced tables; the newer task
   channel rule in `AGENTS.md:239-249` requires a visual or Markdown fallback.
   Resolve the channel-specific precedence explicitly.
4. `mia3-metrics:351-352` permits creation time as a fallback when awarding time
   is absent; the daily **issued** procedure uses actual award time. Confirm this
   count definition with the owner; do not silently expand it to created items.
5. **Production** `AGENTS.md:26-53` and `MAIN.md:20-23` require live ClickHouse
   query tools when available, falling back to `mia.py sql` only if absent. The
   current `prepare_bonus_report` → `motor-bonus-daily.py` path uses guarded
   `mia.py sql`. In IGAAA-618/619 there were no tool invocations named
   `query_clickhouse`, no MCP keys in this agent's configured env and no active
   connection grants for the Motor company; fallback was applicable in these
   observed runs. If tools are attached later, reevaluate the report path.

## Activation gates and experiment

- Obtain owner-authored contract and daily pack; review each row and conflict
  against the installed, hash-pinned sources. Unknown/new source sections fail
  closed to the current full indexed reader.
- Keep the current full instructions as control. Isolate the candidate to an
  explicit opt-in canary; no agent-wide policy replacement during A/B. The
  adapter's dormant `compactBonusCanary` option requires a matching
  `compactBonusCanaryIssueId` and a JSON file at `compactBonusPackPath` with
  `version: 1`, `approved: true`, exact `agentId`/`companyId`/`issueId`,
  `titleSha256`/`descriptionSha256` matching the issue snapshot, nonempty
  `contract`/`dailyBonus` strings with matching `contractSha256` and
  `dailyBonusSha256`, and `sourceSha256` for **every assigned document** (keys
  are runtime document IDs, including the skill suffix). It is considered only
  when there are no runtime MCP servers and the wake reason is
  `issue_assigned` without a comment ID. Follow-ups or a changed issue
  title/description use full indexed instructions. Any missing or changed
  file/hash leaves the existing full indexed instructions in place.
- Test same model, date, query checks and artifact pipeline, plus alternate
  dates, follow-ups, multiple questions, ambiguous definitions, another brand,
  guard denial, stale data, reconciliation failure, visual failure and an
  arriving comment. Count correct delivery and policy adherence as acceptance.
- Compare issue creation → final comment, complete run time, tokens/cache/cost,
  tool failures, checked definitions, caveats and attached artifact. A matching
  total alone does not pass. Roll back on any missing mandatory rule or regression.

Until those gates are met, there is **no compact-pack latency measurement**.
