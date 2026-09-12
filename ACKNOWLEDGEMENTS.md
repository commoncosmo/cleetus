# Acknowledgements

Cleetus is possible because of the work shared by open-source maintainers and
contributors across the local-AI, terminal-UI, JavaScript, and Swift
communities.

First and foremost, Cleetus thanks the
[llama.cpp](https://github.com/ggml-org/llama.cpp) maintainers and contributors. llama.cpp made
high-quality local inference broadly accessible, Cleetus supports `llama-server` directly, and
its work underpins local inference used by projects such as Ollama and LM Studio.

We also thank [Hugging Face](https://huggingface.co/) and the model authors and community members
who publish their work there. The Hugging Face Hub, open-source libraries, and model ecosystem make
local models substantially easier to discover, share, and use.

Cleetus also builds on:

- [Bun](https://github.com/oven-sh/bun) for its runtime, package manager,
  bundler, test runner, and standalone executable support.
- [Ink](https://github.com/vadimdemedes/ink) and
  [React](https://github.com/facebook/react) for the terminal user interface.
- The [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
  for MCP connectivity.
- [Swift Markdown](https://github.com/swiftlang/swift-markdown) and
  [cmark-gfm](https://github.com/swiftlang/swift-cmark) for Markdown support in
  the macOS application.
- [SwiftTerm](https://github.com/migueldeicaza/SwiftTerm) for the embedded
  macOS terminal.
- [Ollama](https://github.com/ollama/ollama) and
  [LM Studio](https://lmstudio.ai/), with which Cleetus interoperates as separately installed
  local-model servers.

Many other projects contribute essential functionality. The complete
dependency list and legally required notices are maintained separately in
[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).

These acknowledgements express gratitude and do not imply endorsement by any
project or contributor. Project names and trademarks remain the property of
their respective owners.
