/**
 * dsh-cost-usage — host half.
 *
 * Server-side Cordis plugin that registers a `costUsage` session projection.
 * The projection listens to `assistant/message` events, reads token usage
 * and model identity, and folds in configured per-token pricing to
 * accumulate session-level cost tracking.
 *
 * Configuration is provider-agnostic: any model under any provider route can
 * have a `pricing` entry in the plugin config. Pricing is manual by design:
 * resellers and gateways rarely expose per-model rates, so unpriced routes
 * are reported as zero cost rather than guessed.
 *
 * @module dsh-cost-usage
 */


// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------
//
// The projection seam only ever calls `.parse(value)` on `stateSchema` and
// `wire.viewSchema`, so a three-line validator is enough — and worth more than
// a real schema library here. This package is loaded from a linked directory
// that has no `node_modules`, so ANY bare import (zod included) fails to
// resolve and takes the whole plugin row down with it before `apply` runs.

/** Validation failure raised by the local schemas below. */
class SchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SchemaError';
  }
}

/** Wrap a plain predicate as something exposing the `.parse` the seam calls. */
function schemaOf(check) {
  return { parse: check };
}

/** A required finite, non-negative number. */
const costNumber = schemaOf((value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new SchemaError(`expected a finite non-negative number, received ${JSON.stringify(value)}`);
  }
  return value;
});

/** A required string. */
const textValue = schemaOf((value) => {
  if (typeof value !== 'string') throw new SchemaError(`expected a string, received ${JSON.stringify(value)}`);
  return value;
});

/**
 * A required object with every listed key present. Unknown keys pass through
 * untouched: a state restored from an older checkpoint must still load.
 */
function objectOf(shape) {
  return schemaOf((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new SchemaError(`expected an object, received ${JSON.stringify(value)}`);
    }
    const parsed = {};
    for (const key of Object.keys(shape)) {
      if (!Object.hasOwn(value, key)) throw new SchemaError(`missing required key ${JSON.stringify(key)}`);
      parsed[key] = shape[key].parse(value[key]);
    }
    return parsed;
  });
}

/** A record whose every own value parses under `valueSchema`. */
function recordOf(valueSchema) {
  return schemaOf((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new SchemaError(`expected a record, received ${JSON.stringify(value)}`);
    }
    const parsed = {};
    for (const key of Object.keys(value)) parsed[key] = valueSchema.parse(value[key]);
    return parsed;
  });
}

// ---------------------------------------------------------------------------
// Cost state schema
// ---------------------------------------------------------------------------

/**
 * Cost contribution from one model, keyed by "provider/model".
 */
const routeContributionSchema = objectOf({
  provider: textValue,
  model: textValue,
  inputCost: costNumber,
  outputCost: costNumber,
  cacheReadCost: costNumber,
  cacheWriteCost: costNumber,
  totalCost: costNumber,
});

/**
 * Full cost-usage state: accumulators per turn and session-wide totals,
 * plus per-route breakdowns.
 */
const costUsageStateSchema = objectOf({
  // Session-wide totals
  totalInputCost: costNumber,
  totalOutputCost: costNumber,
  totalCacheReadCost: costNumber,
  totalCacheWriteCost: costNumber,
  totalCost: costNumber,
  // Per-route accumulators
  routes: recordOf(routeContributionSchema),
});

/**
 * View exposed to the client via the projection seam — a subset of the
 * full state suitable for display.
 */
const costUsageViewSchema = objectOf({
  totalCost: costNumber,
  totalInputCost: costNumber,
  totalOutputCost: costNumber,
  totalCacheReadCost: costNumber,
  totalCacheWriteCost: costNumber,
  /** Display symbol from the plugin config, so the client needs no own copy. */
  currency: textValue,
  routes: recordOf(objectOf({
    provider: textValue,
    model: textValue,
    totalCost: costNumber,
  })),
});

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
 * Holds pricing configuration for all providers/models, with wildcard support.
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
  };
}

/**
 * The `costUsage` projection unit: a pure fold of assistant/message events
 * into session-wide cost accumulators.
 */
const costUsageProjectionDefinition = {
  key: COST_USAGE_KEY,
  // Bump when the state shape changes: cached rows at an older version are
  // discarded and the session log re-folds from scratch (the projection cache
  // falls back to a full fold on a version mismatch).
  stateVersion: 2,
  stateSchema: costUsageStateSchema,
  init: initCostUsageState,

  apply: (state, event) => {
    // Fold onto a copy; the registry detects changes by reference.
    const next = { ...state };

    if (event.type !== 'assistant/message') return next;
    if (!event.data.usage) return next;
    if (!event.data.message?.source) return next;

    const source = event.data.message.source;
    if (source.kind !== 'model') return next;

    const provider = source.provider;
    const model = source.model;
    const usage = event.data.usage;

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
      return {
        currency: currentRegistry?.currency ?? '$',
        totalCost: state.totalCost,
        totalInputCost: state.totalInputCost,
        totalOutputCost: state.totalOutputCost,
        totalCacheReadCost: state.totalCacheReadCost,
        totalCacheWriteCost: state.totalCacheWriteCost,
        routes: routeViews,
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
 * The projection unit, exported for tests and for other host plugins that want
 * to fold the same events without registering a second key.
 */
export { costUsageProjectionDefinition };

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

  // Register the projection. Cordis disposes this registration together with
  // the fiber, so anything that throws after it would silently remove the key
  // again — leave the failure loud instead of swallowing it.
  ctx.sessionProjections.register(costUsageProjectionDefinition);

  // Expose the pricing registry for other plugins to query. Cordis refuses a
  // bare property assignment here ("cannot set property without provide"), and
  // that throw used to take the projection down with it: `ctx.provide()` is the
  // supported form and rides this fiber like any other effect.
  ctx.provide('costUsage', {
    pricing: registry,
    projectionKey: COST_USAGE_KEY,
  });
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
 */

/**
 * @typedef {Object} CostUsageService
 * @property {PricingRegistry} pricing
 * @property {string} projectionKey
 */