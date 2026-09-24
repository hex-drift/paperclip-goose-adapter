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
ai-gate/gpt-5.6-sol
```

When `adapterConfig.model` is omitted, the adapter defaults to:

```text
Goose main model: gpt-6-sol
Goose subagents:  gpt-6-luna
```

An explicit Paperclip model always wins. For example,
`ai-gate/gpt-5.6-terra` becomes the main Goose model while the default
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

The default is one-shot `goose run --no-session`, which is the safest mode while
the provider catalog is staged per run. Set `persistSession` in adapter config
only when Goose session storage is already persistent on the SSH worker and no
per-run staged provider root is being used.
