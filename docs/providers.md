# Inference providers

Cleetus connects to separately installed local inference servers. It supports llama.cpp,
LM Studio, and Ollama as first-class provider types. Provider names are your own aliases; the
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

## Supported providers

| Type | Usual URL | Provider-specific behavior |
|---|---|---|
| `llama.cpp` | `http://localhost:8080` | Uses `/v1` for models, streaming chat, tools, and embeddings. Reads `/props` for the effective loaded context and chat-template capabilities. |
| `lmstudio` | `http://localhost:1234` | Uses the OpenAI-compatible API and reads `/api/v0/models` when available for loaded-context metadata. |
| `ollama` | `http://localhost:11434` | Uses the OpenAI-compatible API and reads `/api/ps` and `/api/show` for loaded and architectural context metadata. |

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

## Troubleshooting

All three providers should answer an OpenAI-compatible model-list request:

```bash
curl http://localhost:8080/v1/models
curl http://localhost:1234/v1/models
curl http://localhost:11434/v1/models
```

If Cleetus can list a model but tool calls fail, verify that the selected model and its chat
template support native tools. For llama.cpp, inspect `http://localhost:8080/props` and look at
`chat_template_caps`. For every provider, confirm that the configured root URL does not end in
`/v1`.

Remote provider URLs are supported, but Cleetus does not configure transport security for the
server. Use HTTPS, authentication, and appropriate network controls when the endpoint is not
strictly local.
