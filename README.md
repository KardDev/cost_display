# dsh-cost-usage

**Provider-agnostic cost tracking plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).**

Track LLM API spending per session by configuring per-model token pricing you declare in your profile configuration. Works with any provider — OpenAI-compatible APIs, AWS Bedrock, Alibaba Cloud, and more.

## Features

- **Per-session cost tracking** — accumulates costs across the entire session via a `costUsage` session projection
- **Provider-agnostic** — works with any provider route; just configure pricing per model
- **Manual pricing configuration** — declare per-token rates in `cordis.patch.yml`
- **Wildcard defaults** — set a `"*"` model key to provide fallback pricing for all models in a provider
- **Session cost UI** — the client half registers a cost pill beside the context meter with a clickable breakdown dialog
- **Per-route breakdown** — see cost split by provider/model
- **Per-component breakdown** — see input, output, and cache costs separately
- **Manual pricing by design** — unpriced routes report zero cost rather than a guess

## Installation

### 1. Install the package

The plugin is hosted on GitHub. Add it to your DSH profile's `package.json` as a git dependency:

```json
{
  "dependencies": {
    "dsh-cost-usage": "github:KardDev/cost_display"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-cost-usage"
      ]
    }
  }
}
```

Then install:

```bash
cd /path/to/your/dsh/profile
pnpm install
```

> **Note:** For a local clone, prefer `dsh plugin --profile <name> add <path-to-cost_display>`: it links the directory, so source edits stay live. A `file:` dependency is copied at install time and silently goes stale when you edit the source.

### 2. Configure pricing

Add pricing configuration to your `cordis.patch.yml`:

```yaml
- id: dsh-cost-usage
  name: dsh-cost-usage
  config:
    # Currency symbol for display (default: $)
    currency: "$"

    # Per-model pricing configuration
    # Keyed by provider route, then model id
    pricing:
      my-openai-provider:
        # Per-model pricing
        gpt-4o:
          input: 0.0000025
          output: 0.00001
        gpt-4o-mini:
          input: 0.00000015
          output: 0.0000006

      my-aws-bedrock:
        # Wildcard "*" provides defaults for all models in this provider
        "*":
          input: 0.000003
          output: 0.000015
        # Specific model overrides the wildcard
        claude-sonnet-4-20250514:
          input: 0.000003
          output: 0.000015
```

### 3. Restart DSH

The plugin activates on next startup. The `costUsage` projection will begin accumulating costs from that point forward.

## Usage

Once installed and configured:

1. **Cost pill** - registers into the `conversation.composer.dock` slot, so it appears in the composer row beside the context meter, showing the current session total cost
2. **Click for details** — click the cost pill to open a breakdown dialog showing:
   - Cost per provider/model route
   - Cost by component (input, output, cache read, cache write)
   - Session total

   The panel closes on Escape, an outside click, or a window resize.

## Configuration Reference

### Plugin Configuration (`cordis.patch.yml`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `currency` | string | `"$"` | Currency symbol for display |
| `pricing` | object | `{}` | Per-model pricing rates, keyed by provider route → model id |

### Pricing Entry

Each pricing entry supports:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `input` | number | `0` | Cost per input token |
| `output` | number | `0` | Cost per output token |
| `cacheRead` | number | `0` | Cost per cache-read token |
| `cacheWrite` | number | `0` | Cost per cache-write token |

A `"*"` model key sets default pricing for all models under that provider. Specific model entries override the wildcard.

## How It Works

The plugin consists of two parts:

### Server-side (`lib/index.js`)

A Cordis plugin that:

1. Registers a `costUsage` session projection on `ctx.sessionProjections`
2. Listens to `assistant/message` events in the session log
3. Reads the provider, model, and token usage from each event
4. Looks up the configured pricing for that provider/model pair
5. Accumulates costs session-wide, per-route, and per-turn
6. Exposes the accumulated data through the standard projection seam

### Client-side (`lib/client.js`)

A ModuleLoader browser bundle that:

1. Connects to the session controller's projection value store
2. Subscribes to `costUsage` projection updates
3. Renders the cost pill as a `conversation.composer.dock` slot entry beside the context meter
4. Provides a clickable breakdown dialog

## Plugin API

Other plugins can access cost data through the Cordis context:

```typescript
// On the server side
const costUsage = ctx.get('costUsage');
// costUsage.pricing — the PricingRegistry instance
// costUsage.projectionKey — 'costUsage'

// Read current projection state via the session projection system.
// stateOf returns the raw folded state (or undefined when the key is not registered);
// snapshot(session, [keys]) returns { asOfSeq, values } with schema-validated views.
const state = ctx.sessionProjections.stateOf(session, 'costUsage');
const { values } = ctx.sessionProjections.snapshot(session, ['costUsage']);
// values.costUsage.totalCost, values.costUsage.totalInputCost, etc.
```

## License

MIT

## Contributing

Contributions welcome! This plugin aims to be provider-agnostic and community-driven.