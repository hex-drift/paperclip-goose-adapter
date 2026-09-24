# Paperclip Goose adapter override

This is an external Paperclip adapter plugin. It overrides the unused built-in
`grok_local` adapter type and runs Goose on a Paperclip SSH execution target.
Paperclip core is not modified.

## Build

```bash
pnpm install
pnpm build
```

## Install into Paperclip

Install the package from the Adapter Manager, or add this to the instance's
adapter plugin store:

```json
[
  {
    "packageName": "paperclip-goose-grok-adapter",
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

Configure these values in the agent environment editor. Secret values should be
Paperclip secret bindings, not plain text:

```text
AI_GATE_API_KEY=<Paperclip secret binding>
AI_GATE_BASE_URL=https://your-ai-gate.example/v1/chat/completions
AI_GATE_MODELS=gpt-5.6-sol,gpt-5.6-luna,gpt-5.6-terra
GOOSE_SUBAGENT_PROVIDER=ai-gate
GOOSE_SUBAGENT_MODEL=gpt-5.6-luna
```

`AI_GATE_MODELS` also accepts a JSON string array. When `AI_GATE_BASE_URL` and
the model catalog are present, the adapter stages a Goose custom provider file
on the SSH worker for that run. The key is referenced through
`api_key_env: AI_GATE_API_KEY` and is not written into the provider file.

If the remote worker already has an `ai-gate` Goose custom provider configured,
omit `AI_GATE_BASE_URL` and `AI_GATE_MODELS`; the adapter will use that remote
configuration.

## Model separation

The Paperclip `model` selects the main Goose orchestration model:

```text
Paperclip model: ai-gate/gpt-5.6-sol
Goose main model: gpt-5.6-sol
Goose subagents: gpt-5.6-luna
```

The adapter forwards `GOOSE_SUBAGENT_PROVIDER` and `GOOSE_SUBAGENT_MODEL` to
Goose. Goose recipes or custom agents can override those defaults when needed.

## Session behavior

The default is one-shot `goose run --no-session`, which is the safest mode while
the provider catalog is staged per run. Set `persistSession` in adapter config
only when Goose session storage is already persistent on the SSH worker and no
per-run staged provider root is being used.
