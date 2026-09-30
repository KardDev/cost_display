/**
 * dsh-cost-usage — browser half.
 *
 * Client-side ModuleLoader bundle that reads the `costUsage` session
 * projection and displays cost information alongside the existing token
 * usage indicators in the chat UI.
 *
 * @module dsh-cost-usage/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-cost-usage',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    var PROJECTION_KEY = 'costUsage';
    var CSS_CLASS_PREFIX = 'dsh-cost-';
    var ATTR_INJECTED = 'data-dsh-cost';

    // Selectors for finding the stats pills area
    var STATS_PILLS_SEL = '[class*="statsPills"], [class*="stats-pills"], [class*="StatsPills"]';
    var STATS_DIALOG_SEL = '[class*="statDialog"], [class*="stat-dialog"]';
    var TURN_TAIL_SEL = '[class*="turnTail"], [class*="turn-tail"]';

    // Default currency — can be overridden by the projection's config
    var CURRENCY = '$';

    // -------------------------------------------------------------------------
    // CSS
    // -------------------------------------------------------------------------

    var CSS = (
      '.' + CSS_CLASS_PREFIX + 'pill{' +
        'display:inline-flex;align-items:center;gap:3px;' +
        'padding:0 6px;height:22px;border-radius:6px;' +
        'font-size:12px;line-height:16px;font-variant-numeric:tabular-nums;' +
        'color:var(--dsw-alias-label-secondary,#8b8b8b);' +
        'background:var(--dsw-alias-bg-tertiary,rgba(128,128,128,.08));' +
        'white-space:nowrap;cursor:default' +
      '}' +
      '.' + CSS_CLASS_PREFIX + 'pill strong{' +
        'font-weight:500;color:var(--dsw-alias-label-primary,#e0e0e0)' +
      '}' +
      '.' + CSS_CLASS_PREFIX + 'dialog{' +
        'position:fixed;z-index:1000;' +
        'background:var(--dsw-alias-bg-primary,#1e1e1e);' +
        'border:1px solid var(--dsw-alias-border-l3,#333);' +
        'border-radius:12px;padding:16px;min-width:260px;' +
        'box-shadow:0 8px 32px rgba(0,0,0,.4);' +
        'font-size:13px;line-height:20px' +
      '}' +
      '.' + CSS_CLASS_PREFIX + 'dialog h3{' +
        'margin:0 0 12px;font-size:14px;font-weight:500;' +
        'color:var(--dsw-alias-label-primary,#e0e0e0)' +
      '}' +
      '.' + CSS_CLASS_PREFIX + 'row{' +
        'display:flex;justify-content:space-between;padding:4px 0;' +
        'color:var(--dsw-alias-label-secondary,#8b8b8b)' +
      '}' +
      '.' + CSS_CLASS_PREFIX + 'rowValue{' +
        'color:var(--dsw-alias-label-primary,#e0e0e0);font-weight:500' +
      '}' +
      '.' + CSS_CLASS_PREFIX + 'total{' +
        'border-top:1px solid var(--dsw-alias-border-l3,#333);' +
        'margin-top:8px;padding-top:8px;font-weight:500;' +
        'color:var(--dsw-alias-label-primary,#e0e0e0)' +
      '}' +
      '.' + CSS_CLASS_PREFIX + 'routeGroup{' +
        'margin-top:8px' +
      '}' +
      '.' + CSS_CLASS_PREFIX + 'routeLabel{' +
        'font-size:11px;color:var(--dsw-alias-label-tertiary,#666);' +
        'margin-bottom:4px' +
      '}'
    );

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function formatCost(value) {
      if (value == null || isNaN(value)) return CURRENCY + '0.00';
      if (value === 0) return CURRENCY + '0.00';
      if (value < 0.0001) return CURRENCY + value.toExponential(2);
      if (value < 0.01) return CURRENCY + value.toFixed(5);
      if (value < 1) return CURRENCY + value.toFixed(4);
      if (value < 100) return CURRENCY + value.toFixed(3);
      return CURRENCY + value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function el(tag, attrs, children) {
      var e = document.createElement(tag);
      if (attrs) for (var k in attrs) if (attrs.hasOwnProperty(k)) {
        if (k === 'className') e.className = attrs[k];
        else if (k === 'textContent') e.textContent = attrs[k];
        else if (k === 'innerHTML') e.innerHTML = attrs[k];
        else e.setAttribute(k, attrs[k]);
      }
      if (children) for (var i = 0; i < children.length; i++) {
        if (typeof children[i] === 'string') e.appendChild(document.createTextNode(children[i]));
        else if (children[i]) e.appendChild(children[i]);
      }
      return e;
    }

    // -------------------------------------------------------------------------
    // Cost display components
    // -------------------------------------------------------------------------

    /**
     * Create the cost pill element showing the total session cost.
     */
    function createCostPill(value) {
      var text = formatCost(value);
      var pill = el('span', { className: CSS_CLASS_PREFIX + 'pill', title: 'Session cost — click for details' });
      pill.textContent = text;
      pill.addEventListener('click', function (e) {
        e.stopPropagation();
        showCostDialog(pill);
      });
      return pill;
    }

    /**
     * Show a detailed cost breakdown dialog anchored near the pill.
     */
    function showCostDialog(anchor) {
      // Remove any existing dialog
      var existing = document.querySelector('.' + CSS_CLASS_PREFIX + 'dialog');
      if (existing) existing.remove();

      var data = window.__dshCostData;
      if (!data) return;

      var dialog = el('div', { className: CSS_CLASS_PREFIX + 'dialog' });

      var title = el('h3', { textContent: 'Session Cost Breakdown' });
      dialog.appendChild(title);

      // Route breakdowns
      var routes = data.routes || {};
      var routeKeys = Object.keys(routes);
      if (routeKeys.length > 0) {
        var routeGroup = el('div', { className: CSS_CLASS_PREFIX + 'routeGroup' });
        var routeLabel = el('div', { className: CSS_CLASS_PREFIX + 'routeLabel', textContent: 'By provider/model:' });
        routeGroup.appendChild(routeLabel);
        for (var i = 0; i < routeKeys.length; i++) {
          var r = routes[routeKeys[i]];
          if (!r) continue;
          var row = el('div', { className: CSS_CLASS_PREFIX + 'row' });
          row.appendChild(el('span', { textContent: r.provider + ' / ' + r.model }));
          row.appendChild(el('span', { className: CSS_CLASS_PREFIX + 'rowValue', textContent: formatCost(r.totalCost) }));
          routeGroup.appendChild(row);
        }
        dialog.appendChild(routeGroup);
      }

      // Cost components
      var comps = el('div', { className: CSS_CLASS_PREFIX + 'routeGroup' });
      var compLabel = el('div', { className: CSS_CLASS_PREFIX + 'routeLabel', textContent: 'By component:' });
      comps.appendChild(compLabel);

      var addRow = function (label, value) {
        var row = el('div', { className: CSS_CLASS_PREFIX + 'row' });
        row.appendChild(el('span', { textContent: label }));
        row.appendChild(el('span', { className: CSS_CLASS_PREFIX + 'rowValue', textContent: formatCost(value) }));
        comps.appendChild(row);
      };
      addRow('Input tokens', data.totalInputCost);
      addRow('Output tokens', data.totalOutputCost);
      addRow('Cache read', data.totalCacheReadCost);
      addRow('Cache write', data.totalCacheWriteCost);
      dialog.appendChild(comps);

      // Session total
      var totalRow = el('div', { className: CSS_CLASS_PREFIX + 'total ' + CSS_CLASS_PREFIX + 'row' });
      totalRow.appendChild(el('span', { textContent: 'Session total' }));
      totalRow.appendChild(el('span', { className: CSS_CLASS_PREFIX + 'rowValue', textContent: formatCost(data.totalCost) }));
      dialog.appendChild(totalRow);

      // Position and show
      document.body.appendChild(dialog);
      var rect = anchor.getBoundingClientRect();
      var left = Math.max(8, rect.left - 130 + rect.width / 2);
      var top = rect.bottom + 4;
      dialog.style.left = left + 'px';
      dialog.style.top = top + 'px';

      // Close on click outside
      var close = function (ev) {
        if (!dialog.contains(ev.target) && ev.target !== anchor) {
          dialog.remove();
          document.removeEventListener('mousedown', close, true);
        }
      };
      setTimeout(function () { document.addEventListener('mousedown', close, true); }, 0);
    }

    // -------------------------------------------------------------------------
    // Projection reader
    // -------------------------------------------------------------------------

    /**
     * Attempt to read the costUsage projection from the current session.
     * Returns the projection view data, or null if unavailable.
     */
    function readCostProjection(ctx) {
      try {
        // Access the sessions service
        var sessions = ctx.get('sessions');
        if (!sessions || !sessions.list) return null;

        var state = sessions.list.state;
        if (!state || !state.current) return null;

        var binding = sessions.binding(state.current);
        if (!binding || !binding.session) return null;

        var face = binding.session.projections.faceOf(PROJECTION_KEY);
        if (!face) return null;

        // Read the current value
        return face.get() || null;
      } catch (e) {
        return null;
      }
    }

    /**
     * Subscribe to costUsage projection updates.
     * Calls `onChange` with the new projection value whenever it changes.
     */
    function subscribeCostProjection(ctx, onChange) {
      try {
        var sessions = ctx.get('sessions');
        if (!sessions || !sessions.list) return function () {};

        var unsubs = [];
        var currentId = null;

        // Watch for session changes
        var unsubList = sessions.list.subscribe(function () {
          var state = sessions.list.state;
          if (!state) return;
          var newId = state.current;

          if (newId !== currentId) {
            currentId = newId;
            // Unsubscribe old face
            for (var i = 0; i < unsubs.length; i++) unsubs[i]();
            unsubs = [];

            if (!newId) return;

            var binding = sessions.binding(newId);
            if (!binding || !binding.session) return;

            var face = binding.session.projections.faceOf(PROJECTION_KEY);
            if (!face) return;

            // Read initial value
            var initial = face.get();
            if (initial) onChange(initial);

            // Subscribe to changes
            var unsub = face.subscribe(function (value) {
              if (value) onChange(value);
            });
            unsubs.push(unsub);
          }
        });
        unsubs.push(unsubList);

        // Read initial value if session is already active
        var state = sessions.list.state;
        if (state && state.current) {
          currentId = state.current;
          var binding = sessions.binding(state.current);
          if (binding && binding.session) {
            var face = binding.session.projections.faceOf(PROJECTION_KEY);
            if (face) {
              var initial = face.get();
              if (initial) onChange(initial);
              var unsub = face.subscribe(function (value) {
                if (value) onChange(value);
              });
              unsubs.push(unsub);
            }
          }
        }

        return function () {
          for (var i = 0; i < unsubs.length; i++) unsubs[i]();
        };
      } catch (e) {
        return function () {};
      }
    }

    // -------------------------------------------------------------------------
    // DOM injection
    // -------------------------------------------------------------------------

    /**
     * Inject or update the cost pill in the stats area.
     */
    function updateCostDisplay(data) {
      // Store for dialog
      window.__dshCostData = data;

      var pillsArea = findPillsArea();
      if (!pillsArea) return;

      // Find or create cost pill container
      var existing = pillsArea.querySelector('[' + ATTR_INJECTED + ']');
      if (existing) {
        // Update text
        var textNode = existing.firstChild;
        if (textNode) textNode.textContent = formatCost(data.totalCost);
      } else {
        // Inject at the end of the pills area
        var pill = createCostPill(data.totalCost);
        pill.setAttribute(ATTR_INJECTED, '');
        pillsArea.appendChild(pill);
      }
    }

    /**
     * Find the stats pills area in the DOM.
     */
    function findPillsArea() {
      // Try the standard stats pills selector
      var area = document.querySelector(STATS_PILLS_SEL);
      if (area) return area;

      // Fallback: look for the token usage pill and get its parent
      var tokenPill = document.querySelector('[class*="tokenUsage"], [class*="token-usage"]');
      if (tokenPill) return tokenPill.parentElement;

      return null;
    }

    // -------------------------------------------------------------------------
    // Plugin entry
    // -------------------------------------------------------------------------

    /**
     * Apply the client-side plugin.
     * @param {import('@deepseek-ai/cordis').Context} ctx - Client Cordis context
     */
    function apply(ctx) {
      // Inject CSS
      var style = document.createElement('style');
      style.setAttribute('data-plugin', 'dsh-cost-usage');
      style.textContent = CSS;
      document.head.appendChild(style);

      // Subscribe to cost projection updates
      var unsubscribe = subscribeCostProjection(ctx, function (data) {
        if (data) updateCostDisplay(data);
      });

      // Also poll as a fallback (some sessions may not trigger subscriptions)
      var pollTimer = setInterval(function () {
        var data = readCostProjection(ctx);
        if (data) updateCostDisplay(data);
      }, 2000);

      // Cleanup on plugin unload
      ctx.effect(function () {
        return function () {
          clearInterval(pollTimer);
          if (unsubscribe) unsubscribe();
          var style = document.querySelector('style[data-plugin="dsh-cost-usage"]');
          if (style) style.remove();
          var pills = document.querySelectorAll('[' + ATTR_INJECTED + ']');
          for (var i = 0; i < pills.length; i++) pills[i].remove();
          delete window.__dshCostData;
        };
      });
    }

    // -------------------------------------------------------------------------
    // Exports
    // -------------------------------------------------------------------------

    module.exports = {
      apply: apply,
      inject: []
    };
    return module.exports;
  }
});