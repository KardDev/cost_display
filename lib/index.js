/**
 * dsh-cost-usage — host half.
 *
 * Server-side Cordis plugin that registers a `costUsage` session projection.
 * The projection listens to `assistant/message` events, reads token usage
 * and model identity, and folds in configured (or auto-discovered) per-token
 * pricing to accumulate session-level cost tracking.
 *
 * Configuration is provider-agnostic: any model under any provider route can
 * have a `pricing` entry in the plugin config. When `autoDiscover` is true,
 * the plugin attempts to fetch pricing from the provider's `/v1/models`
 * endpoint for OpenAI-compatible routes.
 *
 * @module dsh-cost-usage
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Cost state schema
// ---------------------------------------------------------------------------

/**
 * Per-turn cost bucket: the accumulated cost for one turn, broken down by
 * input, output, and cache components.
 */
const turnCostBucketSchema = z.object({
  inputCost: z.number().nonnegative(),
  outputCost: z.number().nonnegative(),
  cacheReadCost: z.number().nonnegative(),
  cacheWriteCost: z.number().nonnegative(),
  totalCost: z.number().nonnegative(),
}).strict();

/**
 * Cost contribution from one model in one turn, keyed by "provider/model".
 */
const routeContributionSchema = z.object({
  provider: z.string(),
  model: z.string(),
  inputCost: z.number().nonnegative(),
  outputCost: z.number().nonnegative(),
  cacheReadCost: z.number().nonnegative(),
  cacheWriteCost: z.number().nonnegative(),
  totalCost: z.number().nonnegative(),
}).strict();

/**
 * Full cost-usage state: accumulators per turn and session-wide totals,
 * plus per-route breakdowns.
 */
const costUsageStateSchema = z.object({
  // Session-wide totals
  totalInputCost: z.number().nonnegative(),
  totalOutputCost: z.number().nonnegative(),
  totalCacheReadCost: z.number().nonnegative(),
  totalCacheWriteCost: z.number().nonnegative(),
  totalCost: z.number().nonnegative(),
  // Per-route accumulators
  routes: z.record(z.string(), routeContributionSchema),
  // Per-turn accumulators (last N turns retained)
  turns: z.record(z.string(), turnCostBucketSchema),
  // Last processed event seq for dedup
  lastSeq: z.number().int().nonnegative().nullable(),
}).strict();

/**
 * View exposed to the client via the projection seam — a subset of the
 * full state suitable for display.
 */
const costUsageViewSchema = z.object({
  totalCost: z.number().nonnegative(),
  totalInputCost: z.number().nonnegative(),
  totalOutputCost: z.number().nonnegative(),
  totalCacheReadCost: z.number().nonnegative(),
  totalCacheWriteCost: z.number().nonnegative(),
  routes: z.record(z.string(), z.object({
    provider: z.string(),
    model: z.string(),
    totalCost: z.number().nonnegative(),
  })),
  turns: z.record(z.string(), z.object({
    totalCost: z.number().nonnegative(),
  })),
}).strict();

// ---------------------------------------------------------------------------
// Pricing resolution
// ---------------------------------------------------------------------------

/**
 * Pricing rates for one model, per-token in the configured currency.
 */
class ModelPricing {
  constructor(input, output, cacheRead, cacheWrite) {
    this.input = input;
    this.output = output;
    this.cacheRead = cacheRead;
    this.cacheWrite = cacheWrite;
  }

  /**
   * Calculate cost from token usage.
   */
  costFor(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const input = safeToken(usage.inputTokens);
    const output = safeToken(usage.outputTokens);
    const cacheRead = safeToken(usage.cacheReadTokens);
    const cacheWrite = safeToken(usage.cacheWriteTokens);
    if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return null;
    return {
      inputCost: input * this.input,
      outputCost: output * this.output,
      cacheReadCost: cacheRead * this.cacheRead,
      cacheWriteCost: cacheWrite * this.cacheWrite,
    };
  }
}

function safeToken(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

// ---------------------------------------------------------------------------
// Pricing registry
// ---------------------------------------------------------------------------

/**
 * Holds pricing configuration for all providers/models, with wildcard support
 * and optional auto-discovery from provider API endpoints.
 *
 * The pricing data is stored as a flat map keyed by "provider/model" strings.
 * A "*" wildcard model provides defaults for any model within that provider.
 */
class PricingRegistry {
  constructor() {
    /** Map<"provider/model", ModelPricing> */
    this._pricing = new Map();
    /** Map<provider, ModelPricing> — wildcard defaults */
    this._wildcards = new Map();
    /** Set of providers that have been discovered */
    this._discovered = new Set();
    /** Currency symbol */
    this.currency = '$';
  }

  /**
   * Configure pricing from the plugin config object.
   */
  configure(configPricing, currency) {
    this.currency = currency || '$';
    this._pricing.clear();
    this._wildcards.clear();

    if (!configPricing || typeof configPricing !== 'object') return;

    for (const [provider, models] of Object.entries(configPricing)) {
      if (!models || typeof models !== 'object') continue;
      for (const [modelId, rates] of Object.entries(models)) {
        if (!rates || typeof rates !== 'object') continue;
        const pricing = new ModelPricing(
          safeRate(rates.input),
          safeRate(rates.output),
          safeRate(rates.cacheRead),
          safeRate(rates.cacheWrite),
        );
        if (modelId === '*') {
          this._wildcards.set(provider, pricing);
        } else {
          this._pricing.set(`${provider}/${modelId}`, pricing);
        }
      }
    }
  }

  /**
   * Get pricing for a specific provider/model combination.
   * Falls back to the provider's wildcard, then to auto-discovered data.
   */
  get(provider, model) {
    // Exact match first
    const exact = this._pricing.get(`${provider}/${model}`);
    if (exact) return exact;
    // Provider wildcard
    const wildcard = this._wildcards.get(provider);
    if (wildcard) return wildcard;
    return null;
  }

  /**
   * Mark a provider as having been auto-discovered.
   */
  markDiscovered(provider) {
    this._discovered.add(provider);
  }

  /**
   * Whether a provider's pricing has been auto-discovered.
   */
  isDiscovered(provider) {
    return this._discovered.has(provider);
  }
}

function safeRate(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

// ---------------------------------------------------------------------------
// Auto-discovery
// ---------------------------------------------------------------------------

/**
 * Attempt to fetch pricing from an OpenAI-compatible provider's /v1/models
 * endpoint. Returns a map of modelId → ModelPricing, or null on failure.
 */
async function discoverProviderPricing(baseUrl, apiKey) {
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/models`;
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;

    const body = await response.json();
    if (!body || !Array.isArray(body.data)) return null;

    const discovered = new Map();
    for (const model of body.data) {
      if (!model.id || !model.pricing) continue;
      const p = model.pricing;
      // Many providers return pricing as strings like "0.000000045"
      const input = parsePricingField(p.prompt);
      const output = parsePricingField(p.completion);
      const cacheRead = parsePricingField(p.input_cache_read) ?? parsePricingField(p.cacheRead);
      const cacheWrite = parsePricingField(p.input_cache_write) ?? parsePricingField(p.cacheWrite);
      if (input !== null || output !== null) {
        discovered.set(model.id, new ModelPricing(
          input ?? 0,
          output ?? 0,
          cacheRead ?? 0,
          cacheWrite ?? 0,
        ));
      }
    }
    return discovered.size > 0 ? discovered : null;
  } catch {
    return null;
  }
}

function parsePricingField(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Projection definition
// ---------------------------------------------------------------------------

const COST_USAGE_KEY = 'costUsage';

function buildRouteKey(provider, model) {
  return `${provider}/${model}`;
}

function initCostUsageState() {
  return {
    totalInputCost: 0,
    totalOutputCost: 0,
    totalCacheReadCost: 0,
    totalCacheWriteCost: 0,
    totalCost: 0,
    routes: {},
    turns: {},
    lastSeq: null,
  };
}

/**
 * The `costUsage` projection unit: a pure fold of assistant/message events
 * into session-wide cost accumulators.
 */
const costUsageProjectionDefinition = {
  key: COST_USAGE_KEY,
  stateVersion: 1,
  stateSchema: costUsageStateSchema,
  init: initCostUsageState,

  apply: (state, event) => {
    // Track last processed seq for dedup (projections are idempotent folds)
    const next = { ...state, lastSeq: event.seq };

    if (event.type !== 'assistant/message') return next;
    if (!event.data.usage) return next;
    if (!event.data.message?.source) return next;

    const source = event.data.message.source;
    if (source.kind !== 'model') return next;

    const provider = source.provider;
    const model = source.model;
    const usage = event.data.usage;
    const turn = event.data.turn;

    // Access the pricing registry — stored as a weak reference on the module
    const registry = /** @type {PricingRegistry} */ currentRegistry;
    if (!registry) return next;

    const pricing = registry.get(provider, model);
    if (!pricing) return next;

    const costs = pricing.costFor(usage);
    if (!costs) return next;

    // Update session totals
    next.totalInputCost += costs.inputCost;
    next.totalOutputCost += costs.outputCost;
    next.totalCacheReadCost += costs.cacheReadCost;
    next.totalCacheWriteCost += costs.cacheWriteCost;
    next.totalCost += costs.inputCost + costs.outputCost + costs.cacheReadCost + costs.cacheWriteCost;

    // Update per-route accumulators
    const routeKey = buildRouteKey(provider, model);
    const existingRoute = next.routes[routeKey];
    next.routes = {
      ...next.routes,
      [routeKey]: {
        provider,
        model,
        inputCost: (existingRoute?.inputCost ?? 0) + costs.inputCost,
        outputCost: (existingRoute?.outputCost ?? 0) + costs.outputCost,
        cacheReadCost: (existingRoute?.cacheReadCost ?? 0) + costs.cacheReadCost,
        cacheWriteCost: (existingRoute?.cacheWriteCost ?? 0) + costs.cacheWriteCost,
        totalCost: (existingRoute?.totalCost ?? 0) + costs.inputCost + costs.outputCost + costs.cacheReadCost + costs.cacheWriteCost,
      },
    };

    // Update per-turn accumulators
    const turnKey = String(turn);
    const existingTurn = next.turns[turnKey];
    const turnTotal = costs.inputCost + costs.outputCost + costs.cacheReadCost + costs.cacheWriteCost;
    next.turns = {
      ...next.turns,
      [turnKey]: {
        inputCost: (existingTurn?.inputCost ?? 0) + costs.inputCost,
        outputCost: (existingTurn?.outputCost ?? 0) + costs.outputCost,
        cacheReadCost: (existingTurn?.cacheReadCost ?? 0) + costs.cacheReadCost,
        cacheWriteCost: (existingTurn?.cacheWriteCost ?? 0) + costs.cacheWriteCost,
        totalCost: (existingTurn?.totalCost ?? 0) + turnTotal,
      },
    };

    return next;
  },

  wire: {
    viewSchema: costUsageViewSchema,
    view: (state) => {
      const routeViews = {};
      for (const [key, r] of Object.entries(state.routes)) {
        routeViews[key] = {
          provider: r.provider,
          model: r.model,
          totalCost: r.totalCost,
        };
      }
      const turnViews = {};
      for (const [key, t] of Object.entries(state.turns)) {
        turnViews[key] = { totalCost: t.totalCost };
      }
      return {
        totalCost: state.totalCost,
        totalInputCost: state.totalInputCost,
        totalOutputCost: state.totalOutputCost,
        totalCacheReadCost: state.totalCacheReadCost,
        totalCacheWriteCost: state.totalCacheWriteCost,
        routes: routeViews,
        turns: turnViews,
      };
    },
  },
};

// ---------------------------------------------------------------------------
// Cordis plugin registration
// ---------------------------------------------------------------------------

/** @type {PricingRegistry | null} */
let currentRegistry = null;

/** Cordis plugin name. */
export const name = 'cost-usage';

/** Inject into the sessionProjections service. */
export const inject = ['sessionProjections'];

/**
 * Register the `costUsage` projection and wire up pricing configuration.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis context.
 * @param {Object} [config] - Plugin configuration from the entry's `config` field.
 */
export function apply(ctx, config = {}) {
  const registry = new PricingRegistry();
  currentRegistry = registry;

  // Configure immediately from the entry configuration (second argument).
  // Cordis invokes function plugins as (ctx, config); a patch reload re-runs
  // apply with the updated config, so no listeners are needed.
  registry.configure(config.pricing, config.currency);

  // Auto-discovery: when enabled, fetch pricing from provider endpoints
  if (config.autoDiscover !== false) {
    discoverAllProviders(ctx, registry).catch(() => {
      // Silent — discovery is best-effort
    });
  }

  // Register the projection (Cordis disposes the registration on re-apply)
  ctx.sessionProjections.register(costUsageProjectionDefinition);

  // Expose the pricing registry for other plugins to query
  ctx.costUsage = {
    pricing: registry,
    projectionKey: COST_USAGE_KEY,
  };
}

/**
 * Attempt to auto-discover pricing from all known provider routes.
 */
async function discoverAllProviders(ctx, registry) {
  // Attempt to get provider list from the LLM adapter system
  try {
    const providers = ctx.llm?.listProviders?.() ?? [];
    for (const provider of providers) {
      if (registry.isDiscovered(provider.id)) continue;
      if (!provider.baseUrl) continue;
      // Try to get the API key for this provider
      const apiKey = resolveApiKey(ctx, provider.id);
      const discovered = await discoverProviderPricing(provider.baseUrl, apiKey);
      if (discovered) {
        for (const [modelId, pricing] of discovered) {
          registry._pricing.set(`${provider.id}/${modelId}`, pricing);
        }
        registry.markDiscovered(provider.id);
      }
    }
  } catch {
    // Silent — discovery is best-effort
  }
}

/**
 * Resolve the API key for a provider from the credentials system.
 */
function resolveApiKey(ctx, providerId) {
  try {
    const envVar = ctx.llm?.getProviderConfig?.(providerId)?.apiKeyEnv;
    if (envVar && typeof process !== 'undefined' && process.env) {
      return process.env[envVar];
    }
  } catch {
    // Ignore
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Module declaration for TypeScript consumers
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CostUsageView
 * @property {number} totalCost
 * @property {number} totalInputCost
 * @property {number} totalOutputCost
 * @property {number} totalCacheReadCost
 * @property {number} totalCacheWriteCost
 * @property {Object<string, {provider: string, model: string, totalCost: number}>} routes
 * @property {Object<string, {totalCost: number}>} turns
 */

/**
 * @typedef {Object} CostUsageService
 * @property {PricingRegistry} pricing
 * @property {string} projectionKey
 */