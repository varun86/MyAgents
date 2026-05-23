/**
 * Sandbox iframe receiver HTML for Generative UI widgets.
 *
 * This HTML is injected as the iframe's `srcdoc`. It:
 * - Sets a strict CSP (only 4 CDN domains for scripts, no connect-src)
 * - Listens for postMessage commands: widget:update (streaming), widget:finalize (final)
 * - Reports height changes back to the parent via widget:resize
 * - Intercepts link clicks and forwards them to the parent via widget:link
 */

export function buildSandboxHtml(cssVarsBlock: string): string {
  // The receiver template. All dynamic content arrives via postMessage.
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://esm.sh; img-src data: https:; font-src https://cdn.jsdelivr.net https://cdnjs.cloudflare.com;">
<style>
${cssVarsBlock}
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
body { font-family: system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; font-size: 16px; line-height: 1.6; color: var(--widget-text); }
#root { min-height: 20px; }

/* Pre-styled form elements — AI writes bare tags, they look polished */
input[type="text"], input[type="number"], select, textarea {
  font-family: inherit; font-size: 14px; line-height: 1.5;
  padding: 8px 12px; border: 1px solid var(--widget-border); border-radius: 8px;
  background: var(--widget-bg-elevated); color: var(--widget-text);
  outline: none; transition: border-color 0.15s;
}
input:focus, select:focus, textarea:focus { border-color: var(--widget-accent); }
input[type="range"] {
  width: 100%; height: 6px; -webkit-appearance: none; appearance: none;
  background: var(--widget-border); border-radius: 3px; outline: none;
}
input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none; width: 18px; height: 18px; border-radius: 50%;
  background: var(--widget-accent); cursor: pointer; border: 2px solid white;
  box-shadow: 0 1px 3px rgba(0,0,0,0.15);
}
button {
  font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  padding: 8px 16px; border-radius: 8px; border: 1px solid var(--widget-border);
  background: var(--widget-bg-elevated); color: var(--widget-text);
  transition: all 0.15s;
}
button:hover { border-color: var(--widget-border-strong); }
button.primary {
  background: var(--widget-accent); color: white; border-color: var(--widget-accent);
}
button.primary:hover { opacity: 0.9; }
label { font-size: 12px; font-weight: 600; color: var(--widget-text-secondary); display: block; margin-bottom: 4px; }

/* Layout utilities — AI can use these classes */
.flex { display: flex; } .flex-col { flex-direction: column; }
.items-center { align-items: center; } .justify-center { justify-content: center; } .justify-between { justify-content: space-between; }
.gap-2 { gap: 8px; } .gap-3 { gap: 12px; } .gap-4 { gap: 16px; } .gap-6 { gap: 24px; }
.grid { display: grid; }
.grid-2 { grid-template-columns: repeat(2, 1fr); } .grid-3 { grid-template-columns: repeat(3, 1fr); } .grid-4 { grid-template-columns: repeat(4, 1fr); }
.p-2 { padding: 8px; } .p-3 { padding: 12px; } .p-4 { padding: 16px; }
.px-3 { padding-left: 12px; padding-right: 12px; } .py-2 { padding-top: 8px; padding-bottom: 8px; }
.m-0 { margin: 0; } .mt-2 { margin-top: 8px; } .mt-4 { margin-top: 16px; } .mb-2 { margin-bottom: 8px; } .mb-4 { margin-bottom: 16px; }
.w-full { width: 100%; } .text-center { text-align: center; }
.text-sm { font-size: 13px; } .text-xs { font-size: 11px; } .text-lg { font-size: 18px; } .text-xl { font-size: 22px; } .text-2xl { font-size: 28px; }
.font-semibold { font-weight: 600; } .font-normal { font-weight: 400; }
.rounded { border-radius: 8px; } .rounded-lg { border-radius: 12px; }
.border { border: 1px solid var(--widget-border); }
.bg-elevated { background: var(--widget-bg-elevated); }
.bg-inset { background: var(--widget-bg-inset); }
.text-muted { color: var(--widget-text-muted); }
.text-secondary { color: var(--widget-text-secondary); }
.text-accent { color: var(--widget-accent); }
.overflow-hidden { overflow: hidden; }
.relative { position: relative; } .absolute { position: absolute; }
.flex-wrap { flex-wrap: wrap; } .flex-1 { flex: 1; }
.cursor-pointer { cursor: pointer; }

/* Stat card pattern */
.stat-card { background: var(--widget-bg-elevated); border-radius: 12px; padding: 16px; border: 1px solid var(--widget-border); }
.stat-value { font-size: 24px; font-weight: 600; color: var(--widget-text); }
.stat-label { font-size: 11px; color: var(--widget-text-muted); margin-top: 4px; }
</style>
</head>
<body>
<div id="root"></div>
<script>
(function() {
  var root = document.getElementById('root');
  var currentHtml = '';
  var finalized = false;

  // Height reporting via ResizeObserver
  var lastHeight = 0;
  var firstResize = true;
  function reportHeight() {
    var h = document.body.scrollHeight;
    if (h !== lastHeight) {
      lastHeight = h;
      window.parent.postMessage({ type: 'widget:resize', height: h, first: firstResize }, '*');
      firstResize = false;
    }
  }
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(reportHeight).observe(root);
  }
  // Also report on load and after script execution
  window.addEventListener('load', reportHeight);

  // Link interception — open in parent's system browser
  document.addEventListener('click', function(e) {
    var a = e.target;
    while (a && a.tagName !== 'A') a = a.parentElement;
    if (a && a.href) {
      e.preventDefault();
      window.parent.postMessage({ type: 'widget:link', href: a.href }, '*');
    }
  });

  // Execute script tags in document order (innerHTML doesn't run them).
  //
  // A DOM-inserted <script src> loads ASYNCHRONOUSLY and does NOT block the
  // next script — unlike a parser-inserted one. So replacing every <script> in
  // one synchronous pass runs an inline "new Chart(...)" BEFORE the CDN
  // chart.js it depends on has loaded → "Chart is not defined" (thrown inside
  // this iframe, invisible to the parent console) → blank widget. Contract-
  // compliant widgets dodge it via the documented onload="init()" + window.Lib
  // fallback, but weaker / non-Claude models routinely emit the naive shape
  // (issue #221: widgets blank on GLM etc.).
  //
  // Fix: walk scripts sequentially and BLOCK on each external script's load
  // before running the next — replicating native parser-blocking order, so an
  // inline script that references a CDN global always runs after it loads. We
  // chain via load/error listeners and drop the script's own on* handler
  // attributes: with external-before-inline guaranteed, the inline
  // "if(window.Lib)init()" fallback covers init, while a stale onload="init()"
  // firing before the inline defines init would otherwise throw or double-run.
  function runScripts() {
    var scripts = Array.prototype.slice.call(root.querySelectorAll('script'));
    var i = 0;
    function runNext() {
      if (i >= scripts.length) { requestAnimationFrame(reportHeight); return; }
      var old = scripts[i++];
      var s = document.createElement('script');
      // Copy attributes except src (set explicitly) and on* handlers (managed here).
      Array.from(old.attributes).forEach(function(attr) {
        if (attr.name === 'src' || /^on/i.test(attr.name)) return;
        s.setAttribute(attr.name, attr.value);
      });
      if (old.src) {
        s.src = old.src;
        // Proceed once the external script settles. 'error' also advances so a
        // blocked / failed CDN never stalls the chain; a watchdog covers the
        // rare case where a hung connection fires neither event.
        var advanced = false;
        var timer = null;
        var advance = function() {
          if (advanced) return;
          advanced = true;
          if (timer) clearTimeout(timer);
          runNext();
        };
        s.addEventListener('load', advance);
        s.addEventListener('error', advance);
        timer = setTimeout(advance, 10000);
        old.parentNode.replaceChild(s, old);
      } else {
        s.textContent = old.textContent;
        old.parentNode.replaceChild(s, old); // inline scripts run synchronously
        runNext();
      }
    }
    runNext();
  }

  // Message handler
  window.addEventListener('message', function(e) {
    if (!e.data || !e.data.type) return;

    if (e.data.type === 'widget:update' && !finalized) {
      // Streaming preview — update HTML without executing scripts
      if (e.data.html !== currentHtml) {
        currentHtml = e.data.html;
        root.innerHTML = currentHtml;
        reportHeight();
      }
    }

    if (e.data.type === 'widget:finalize' && !finalized) {
      finalized = true;
      var newHtml = e.data.html;
      // Always rebuild DOM on finalize — streaming updates had scripts stripped,
      // so we need to set the full HTML (with scripts) and execute them.
      root.innerHTML = newHtml;
      currentHtml = newHtml;
      runScripts();
      reportHeight();
    }

    if (e.data.type === 'widget:theme') {
      // Theme update — inject new CSS variables
      var styleEl = document.getElementById('theme-vars');
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'theme-vars';
        document.head.appendChild(styleEl);
      }
      styleEl.textContent = e.data.css;
      reportHeight();
    }
  });

  // Signal ready
  window.parent.postMessage({ type: 'widget:ready' }, '*');
})();
</script>
</body>
</html>`;
}
