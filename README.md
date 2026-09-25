# Paperclip Goose adapter override

This is an external Paperclip adapter plugin. It overrides the unused built-in
`grok_local` adapter type and runs Goose on a Paperclip SSH execution target.
Paperclip core is not modified.

## Build

```bash
npm install
npm run build
```

## Install into Paperclip

### Option A: install from npm

After publishing the package, use **Settings → Adapters → Install from npm**
and enter:

```text
paperclip-goose-adapter
```

The adapter reports itself as `grok_local`, so installing it intentionally
overrides the built-in Grok adapter type. Existing `opencode_local` agents are
unchanged. Restart Paperclip if the UI does not refresh the adapter list.

The same operation can be performed through the admin API:

```bash
curl -fsS -X POST "$PAPERCLIP_API_URL/api/adapters/install" \
  -H "Authorization: Bearer $PAPERCLIP_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"packageName":"paperclip-goose-adapter"}'
```

### Option B: install from a local checkout

```bash
git clone https://github.com/hex-drift/paperclip-goose-adapter.git
cd paperclip-goose-adapter
npm install
npm run build
```

Install the absolute checkout path from **Settings → Adapters → Install from
local path**, or use:

```bash
curl -fsS -X POST "$PAPERCLIP_API_URL/api/adapters/install" \
  -H "Authorization: Bearer $PAPERCLIP_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data "{\"packageName\":\"$(pwd)\",\"isLocalPath\":true}"
```

The Paperclip server must be able to read the path. If Paperclip runs in a
container, mount the checkout into the server container and use the mounted
path, not the host path.

For development, the instance plugin store entry is:

```json
[
  {
    "packageName": "paperclip-goose-adapter",
    "localPath": "/absolute/path/to/paperclip-goose-adapter",
    "type": "grok_local",
    "installedAt": "2026-09-24T00:00:00.000Z"
  }
]
```

The UI label remains `Grok Build` because the override intentionally reuses the
core type's SSH capability and form. Name the agent itself `Goose Remote ...`.

## Remote worker prerequisites

Install Goose on the SSH worker and verify it as the Paperclip SSH user:

```bash
goose --version
```

The Paperclip container only runs SSH/workspace transport helpers. The Goose
process runs on the SSH worker.

## AI Gate configuration

Set the Paperclip agent model to the main Goose model, for example:

```text
ai-gate/gpt-6-sol
```

When `adapterConfig.model` is omitted, the adapter defaults to:

```text
Goose main model: gpt-6-sol
Goose subagents:  gpt-6-luna
```

An explicit Paperclip model always wins. For example,
`ai-gate/gpt-5.6-terra` remains available as an explicit main Goose model while the default
subagent model remains `gpt-6-luna` unless `GOOSE_SUBAGENT_MODEL` is set.

Configure these values in the agent environment editor. Secret values should be
Paperclip secret bindings, not plain text:

```text
AI_GATE_API_KEY=<Paperclip secret binding>
AI_GATE_BASE_URL=https://your-ai-gate.example/v1/chat/completions
AI_GATE_MODELS=gpt-6-sol,gpt-6-luna,gpt-5.6-terra
GOOSE_SUBAGENT_PROVIDER=ai-gate
GOOSE_SUBAGENT_MODEL=gpt-6-luna
```

`AI_GATE_MODELS` also accepts a JSON string array. The adapter maps AI Gate to
Goose's built-in OpenAI-compatible provider and forwards the endpoint as
`OPENAI_HOST`/`OPENAI_BASE_PATH`; the API key is forwarded as
`OPENAI_API_KEY` only to the remote Goose process.

`AI_GATE_BASE_URL` should normally be `https://ai-gate.example/v1`; a full
`/v1/chat/completions` URL is also accepted.

Paperclip runtime MCP connections are also forwarded automatically. The adapter
creates temporary Goose `streamable_http` extensions under the per-run
`GOOSE_PATH_ROOT`, including each Paperclip-issued bearer token. The tokens are
not written to the prompt, logs, or the persistent Goose home.

## Model separation

The Paperclip `model` selects the main Goose orchestration model:

```text
Paperclip model: ai-gate/gpt-6-sol
Goose main model: gpt-6-sol
Goose subagents: gpt-6-luna
```

The adapter forwards `GOOSE_SUBAGENT_PROVIDER` and `GOOSE_SUBAGENT_MODEL` to
Goose. Goose recipes or custom agents can override those defaults when needed.

## Session behavior

Runs use a fresh native Goose recipe and `--no-session`. Persistent sessions are
not resumed because the recipe, credentials and asset paths belong to one run.

## Native recipe runtime (Goose 1.52)

The adapter invokes:

```sh
goose run --recipe /per-run/paperclip-motor.yaml --no-session \
  --output-format stream-json --params task=/per-run/task.md
```

The explicit recipe extension list contains the `developer` platform extension
and the run's MCP connections. Do **not** add `--no-profile`: in Goose 1.52 that
flag also discards extensions declared by a recipe. `--text` and `--instructions`
conflict with `--recipe`. Task text uses a file parameter inside a YAML block so
quotes, newlines and literal template syntax in the task remain data.

Selected skills are staged under a company-qualified, run-local directory. The
adapter exports `PAPERCLIP_SKILLS_ROOT`, `PAPERCLIP_INSTRUCTIONS_PATH`, and a fresh
`PAPERCLIP_RUN_SCRATCH_DIR`. When the assigned MIA toolkit exists, `MIA` and `LIB`
point directly to its script and directory. Its staged legacy path resolvers use
the run-local skill root while retaining their company and ambiguity checks;
the original skills and SQL guards are unchanged. A `mia.py --help` preflight
checks imports before starting the LLM. Shared worker skill directories are not
replaced. The recipe does not enable extension discovery or subagent delegation;
the subagent environment settings only take effect if delegation is enabled.

## Motor daily bonus fast path

For Motor agents with the assigned MIA toolkit, `MIA_BONUS_DAILY` points to a
one-day report procedure. Goose chooses the requested date and invokes:

```sh
python3 "$MIA_BONUS_DAILY" --date YYYY-MM-DD
```

The procedure checks current table schemas and uses the existing `mia.py sql`
guards, credentials and cumulative run query budget. It reads current data on
every invocation: no cached figures, direct credential client or disabled guard.
Four statements cover the program breakdown, independent unique total, ledger,
test accounts, missing joins, unawarded records and freshness. Failed checks are
reported for further investigation rather than silently accepted. The ledger
count comparison is not represented as row-level reconciliation.

When the assigned presentation skill is available, the procedure calls its
builder and validator to create a table of types and all programs. Goose writes
the explanatory answer and uses the returned `answer_helper` to post it and link
the artifact. Other questions continue using the general guarded toolkit.

Full instruction preloading is opt-in (`preloadInstructions: true`); on the
measured Motor task it increased latency. By default, only complete entry
documents (AGENTS/MAIN, at most 32 KB total) and a versioned section index enter
the recipe. Other assigned skill text is loaded using the bounded reader below.

On 2026-09-25, two runs of the same Motor question/date with `gpt-6-sol` and this
fast path completed in 52.11s and 45.67s, with final comments at 47.44s and 39.01s.
Both included validated, comment-linked tables and live reconciled reads. Prior
corrected-runtime runs took 92.45s and 97.79s; the original benchmark took
163.32s. This is a task-specific two-run observation, not a universal latency SLO.

## Verification

```sh
npm run typecheck
npm test
# Also validate and render tricky task inputs with the installed Goose binary:
GOOSE_TEST_BINARY=/path/to/goose npm test
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'test_*.py'
```

For performance comparisons, measure both run duration and time to the final
issue comment with the same model, question and date. Require actual guarded
data reads and a reconciled answer; a fast `succeeded` run with no tools is not a
successful benchmark.

## Bounded instruction delivery

Goose 1.52's shell truncates output beyond 50,000 bytes or 2,000 lines to a tail
preview. Do not concatenate the instruction bundle and all skills with `cat`.

`PAPERCLIP_INSTRUCTION_READER` and `PAPERCLIP_INSTRUCTION_MANIFEST` point to a
per-run snapshot of the assigned documents. The recipe lists document and section
IDs and distinguishes fully preloaded entry documents from an unread index.

```sh
python3 "$PAPERCLIP_INSTRUCTION_READER" index --doc DOCUMENT_ID
python3 "$PAPERCLIP_INSTRUCTION_READER" read --select DOCUMENT_ID:1,3,4
```

Responses have `BEGIN_PAGE`/`END_PAGE`, source and body SHA-256, source line ranges,
selection byte offsets, `complete` and `next_page`. Bodies are limited to 36,000
UTF-8 bytes and 1,200 newlines (including giant-line handling); the entire envelope
is checked below Goose's limits. A checksum change, unknown section or bad page
fails explicitly. Read every requested page; the last page alone does not prove
the earlier pages were read.

For daily Motor bonus tasks, the runtime precomputes a versioned bundle of full
relevant sections and lists all page commands up front. Goose reads them as
separate parallel tool calls. Identity, conversation and analysis rules are kept
in full; only named off-topic report/metric/catalog sections are left for on-demand
reading. New headings are included by default; missing or ambiguous skill matches
disable this shortcut. Original documents and SQL/report procedures are unchanged.

Validation on 2026-09-25: IGAAA-610/611 delivered all three pages with no truncation
or repeated filesystem searches. From issue creation, final comments took
50.74s/41.87s and complete runs took 55.02s/48.49s, versus IGAAA-607's 61.57s/68.70s.
Both tests used gpt-6-sol, fresh guarded reads, matching counts and linked visual
artifacts. These two observations are not a latency guarantee.
