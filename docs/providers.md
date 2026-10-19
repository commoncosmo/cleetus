# Inference providers

Cleetus connects to separately installed local inference servers. It supports llama.cpp,
LM Studio, Ollama, oMLX, and vLLM as first-class provider types. Provider names are your own aliases; the
`type` selects the adapter.

## Configuration

Add one or more providers to `~/.config/cleetus/config.yaml`. Use the server root URL without
`/v1`; Cleetus adds API paths itself.

```yaml
providers:
  local:
    type: llama.cpp
    base_url: http://localhost:8080
  studio:
    type: lmstudio
    base_url: http://localhost:1234
  ollama:
    type: ollama
    base_url: http://localhost:11434
  mac:
    type: omlx
    base_url: http://localhost:8000
  gpu:
    type: vllm
    base_url: http://gpu-server:8000

default_provider: local
# default_model: your-model-id
```

`api_key` is optional on every provider. It is useful when a server is authenticated or exposed
through a protected reverse proxy.

```yaml
providers:
  lab:
    type: llama.cpp
    base_url: https://models.example.test
    api_key: ${LOCAL_MODEL_API_KEY}
```

Run `cleetus --list-models` to check every configured provider. In an interactive session, use
`/provider` to switch servers and `/model` to switch models. If the same model ID exists on more
than one server, select its provider explicitly.

On first launch without a configured provider, Cleetus probes the default localhost ports below
and writes a configuration for servers that return models. Add remote servers or servers that
require an API key manually. vLLM always requires explicit configuration. The port-8000 oMLX
probe accepts only models identified as `owned_by: omlx`, so a vLLM server is not saved as oMLX.

## Supported providers

| Type | Usual URL | Provider-specific behavior |
|---|---|---|
| `llama.cpp` | `http://localhost:8080` | Uses `/v1` for models, streaming chat, tools, and embeddings. Reads `/props` for the effective loaded context and chat-template capabilities. |
| `lmstudio` | `http://localhost:1234` | Uses the OpenAI-compatible API and reads `/api/v0/models` when available for loaded-context metadata. |
| `ollama` | `http://localhost:11434` | Uses the OpenAI-compatible API and reads `/api/ps` and `/api/show` for loaded and architectural context metadata. |
| `omlx` | `http://localhost:8000` | Uses the OpenAI-compatible API and reads the effective context window from `/v1/models` (`max_model_len`) when reported. |
| `vllm` | `http://localhost:8000` | Explicit configuration only. Uses OpenAI-compatible routes and `/v1/models` (`max_model_len`) for the served context limit. Configure tool/reasoning parsers on the server. |

Embedding requests use the configured provider's `/v1/embeddings` route. The server must have an
embedding-capable model available; ordinary chat models do not necessarily support embeddings.

## llama.cpp

Start `llama-server` with a tool-capable model and Jinja chat templates. A representative command
is:

```bash
llama-server \
  --model /path/to/model.gguf \
  --host 127.0.0.1 \
  --port 8080 \
  --jinja \
  --ctx-size 32768 \
  --alias my-coding-model
```

Choose `--ctx-size` for agentic work rather than relying on a small server default. Cleetus reads
the effective per-slot context from `/props` and warns below 16,384 tokens. It also warns when
llama.cpp explicitly reports that the active template lacks tool calls or system-role support.
`--alias` is recommended because otherwise the model picker may display a long GGUF path.

llama.cpp supports reasoning output through `reasoning_content`, which Cleetus renders separately
from final prose. For Cleetus's internal schema-constrained retries, the adapter uses llama.cpp's
native `json_object` plus `schema` request form and disables template thinking only for that
request. Normal chat requests keep the server's configured reasoning behavior.

In llama.cpp router mode, model IDs are passed through to both `/v1` and `/props`, so configure the
exact ID returned by `cleetus --list-models`.

## LM Studio

Start LM Studio's local server and load a model before launching Cleetus. Configure the server root
as `http://localhost:1234`, not `http://localhost:1234/v1`. Cleetus prefers LM Studio's native model
metadata when available so its context budget reflects the loaded context length rather than only
the model's theoretical maximum.

For reliable agent behavior, choose a model with a native tool-use template and allocate at least
16,384 tokens of context in LM Studio's model settings.

## Ollama

Start Ollama and pull or run the desired model before launching Cleetus. Configure the root as
`http://localhost:11434`, not `http://localhost:11434/v1`.

Cleetus checks both the currently loaded context reported by `/api/ps` and model metadata from
`/api/show`. Increase context with the model's `num_ctx` setting or the server's
`OLLAMA_CONTEXT_LENGTH` setting when Cleetus reports a small window.

## oMLX

Start [oMLX](https://github.com/jundot/omlx) on your Apple Silicon Mac, using the macOS app or
`omlx serve --model-dir ~/models`. Configure the server root as `http://localhost:8000`, without
`/v1`. oMLX discovers models in its model directory and loads them on demand. Use the exact model
ID or alias returned by `cleetus --list-models`.

```yaml
providers:
  mac:
    type: omlx
    base_url: http://localhost:8000
    # api_key: ${OMLX_API_KEY}  # if authentication is enabled on your server
default_provider: mac
default_model: your-model-id
```

For a server on another Mac, replace `localhost` with that Mac's reachable hostname or IP
address, keeping port `8000` unless you changed it in oMLX. If authentication is enabled,
uncomment `api_key` and set `OMLX_API_KEY` in Cleetus's environment. Cleetus sends the key as a
Bearer token for model discovery, chat, and embeddings.

Cleetus supports streamed text and reasoning, native tool calls, OpenAI-style structured output,
and embeddings through oMLX's `/v1` routes. Choose a tool-capable chat model for coding, and
configure a separate embedding model if you enable code indexing.

Current oMLX servers report their effective context limit as `max_model_len` in `/v1/models`;
Cleetus uses it for context budgeting. Set a per-model `max_context_window` in oMLX's admin
settings when you need to change that limit. Servers without this field still work, but Cleetus
cannot discover their context window and uses its configured budget and conservative capability
fallback.

## vLLM

Install [vLLM](https://docs.vllm.ai/en/stable/getting_started/installation/) in a supported
environment with enough accelerator memory for the selected model and context. Configure it in
Cleetus before the first launch; vLLM is not autodetected. Both vLLM and oMLX default to port
`8000`, so use different ports when running both on one host.

### Tool-calling server example

With vLLM installed, start this Qwen2.5 instruct model:

```bash
vllm serve Qwen/Qwen2.5-7B-Instruct \
  --host 127.0.0.1 \
  --port 8000 \
  --served-model-name qwen2.5-7b-instruct \
  --max-model-len 32768 \
  --enable-auto-tool-choice \
  --tool-call-parser hermes
```

Qwen2.5's bundled chat template supports Hermes-style tools; no external template file is
needed for this example. `--enable-auto-tool-choice` and the matching parser allow the model to
choose native tool calls rather than returning tool markup as ordinary prose. Use the parser
and template recommended for your model; `hermes` is not universal. See vLLM's
[tool-calling guide](https://docs.vllm.ai/en/stable/features/tool_calling/#qwen-models).
Adjust the model/context to your accelerator's memory; a larger context requires more KV-cache
memory. The example binds to loopback for a client on the same machine. For a remote client,
configure an appropriate listen address, authentication, and transport protection.

Add this to `~/.config/cleetus/config.yaml`:

```yaml
providers:
  gpu:
    type: vllm
    base_url: http://localhost:8000
    # api_key: ${VLLM_API_KEY}
default_provider: gpu
default_model: qwen2.5-7b-instruct
```

Use the server root without `/v1`. For a remote server, replace `localhost` with its reachable
hostname. Use the exact served ID from `/v1/models`, including when `--served-model-name`
overrides the checkpoint name. Keeping a recognizable model-family name in the alias lets
Cleetus select its family defaults. If the server uses `--api-key`, uncomment `api_key` above
and set the same `VLLM_API_KEY` in Cleetus's environment. Cleetus sends Bearer authentication
for model discovery, chat, and embeddings. These settings work in terminal and ACP launches.

Check discovery and native tool calling after the server is ready:

```bash
cleetus --list-models
curl --fail-with-body http://localhost:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "qwen2.5-7b-instruct",
    "messages": [{"role": "user", "content": "Use the add tool to calculate 2 plus 3."}],
    "tools": [{"type": "function", "function": {
      "name": "add",
      "description": "Add two integers",
      "parameters": {
        "type": "object",
        "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}},
        "required": ["a", "b"],
        "additionalProperties": false
      }
    }}],
    "tool_choice": "auto",
    "temperature": 0,
    "max_tokens": 256
  }'
```

The response should contain `choices[0].message.tool_calls` with an `add` call and JSON
arguments for `2` and `3`. This API check returns the call; it does not execute the function.
If authentication is enabled, add `-H "Authorization: Bearer $VLLM_API_KEY"` to the curl request.
Then try a full Cleetus tool round trip from a project containing `README.md`:

```bash
cleetus --provider gpu --model qwen2.5-7b-instruct \
  'Use read_file to read README.md, then summarize it.'
```

### Context, reasoning, structured output, and embeddings

Cleetus reads the effective served limit from `max_model_len` in `/v1/models`, including when
`--max-model-len` restricts the model's architectural window. It warns below 16,384 tokens with
vLLM-specific guidance. Missing/invalid metadata remains unknown and uses Cleetus's configured
context budget rather than inventing a window.

Streamed text, fragmented native tool calls, token usage, and OpenAI-style `response_format`
JSON schemas use the shared adapter. Reasoning streams accept both `reasoning` and the older
`reasoning_content` field. For a reasoning model, configure vLLM's model-appropriate
`--reasoning-parser` and thinking/template settings; the non-reasoning Qwen2.5 example above
does not need them. See [reasoning outputs](https://docs.vllm.ai/en/stable/features/reasoning_outputs/)
and [structured outputs](https://docs.vllm.ai/en/stable/features/structured_outputs/) for
model/backend requirements. Cleetus does not change the server's template settings automatically.

Embeddings use `/v1/embeddings` only when the endpoint serves an embedding-capable model. The
chat server above does not provide embeddings merely because chat works. Configure a separate
vLLM provider pointing at an embedding server and select it in `embeddings.provider` and
`embeddings.model` when enabling code indexing.

## Troubleshooting

All supported providers should answer an OpenAI-compatible model-list request:

```bash
curl http://localhost:8080/v1/models
curl http://localhost:1234/v1/models
curl http://localhost:11434/v1/models
curl http://localhost:8000/v1/models
```

If Cleetus can list a model but tool calls fail, verify that the selected model and its chat
template support native tools. For llama.cpp, inspect `http://localhost:8080/props` and look at
`chat_template_caps`. For every provider, confirm that the configured root URL does not end in
`/v1`.

Remote provider URLs are supported, but Cleetus does not configure transport security for the
server. Use HTTPS, authentication, and appropriate network controls when the endpoint is not
strictly local.
