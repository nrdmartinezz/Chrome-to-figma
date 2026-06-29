/**
 * service-worker.js — Core orchestration for Site to Figma
 *
 * Flow:
 *   1. Attach Chrome Debugger to the active tab
 *   2. For each breakpoint, override the viewport via Emulation API
 *   3. Wait for layout to settle
 *   4. Capture a full-page screenshot (Page.captureScreenshot)
 *   5. Inject captureDOM() to extract element positions + styles
 *   6. Restore viewport and detach debugger
 *   7. Return captures array to popup
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'START_CAPTURE') {
    runCapture(message.options)
      .then(result  => sendResponse({ success: true,  result }))
      .catch(error  => sendResponse({ success: false, error: error.message }));
    return true; // Keep message channel open for async response
  }
});

// ── Keep service worker alive during long operations ─────────────────────────
function keepAlive() {
  const id = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20_000);
  return () => clearInterval(id);
}

// ── Main capture orchestrator ─────────────────────────────────────────────────
async function runCapture(options) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found.');

  const { id: tabId, url, title } = tab;

  // Block capture on privileged pages
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('edge://')) {
    throw new Error('Cannot capture browser internal pages (chrome://, edge://).');
  }

  const stopKeepAlive = keepAlive();

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    stopKeepAlive();
    throw new Error(`Could not attach debugger: ${e.message}. Is DevTools open on this tab?`);
  }

  const captures = [];

  try {
    const breakpoints = options.breakpoints;

    for (let i = 0; i < breakpoints.length; i++) {
      const bp = breakpoints[i];

      // ── Step 1: resize viewport ─────────────────────────────────────────
      chrome.runtime.sendMessage({
        action: 'CAPTURE_PROGRESS',
        step: i + 1,
        total: breakpoints.length,
        label: `Resizing to ${bp.label} (${bp.width}px)…`,
      }).catch(() => {});

      // Set viewport dimensions
      await debuggerCmd(tabId, 'Emulation.setDeviceMetricsOverride', {
        width:             bp.width,
        height:            bp.height,
        deviceScaleFactor: bp.deviceScaleFactor ?? (bp.mobile ? 2 : 1),
        mobile:            bp.mobile ?? false,
        screenWidth:       bp.width,
        screenHeight:      bp.height,
      });

      // Hide scrollbars for clean screenshots
      await debuggerCmd(tabId, 'Emulation.setScrollbarsHidden', { hidden: true })
        .catch(() => {}); // Not available in all Chromium versions

      // Scroll to top so the coordinate systems align
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.scrollTo(0, 0),
      });

      // ── Step 2: wait for the page to fully settle ──────────────────────
      chrome.runtime.sendMessage({
        action: 'CAPTURE_PROGRESS',
        step: i + 1,
        total: breakpoints.length,
        label: `Waiting for ${bp.label} to fully load…`,
      }).catch(() => {});

      await waitForPageSettled(tabId);

      // Scroll back to top — lazy-loading may have triggered scroll
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.scrollTo(0, 0),
      });
      await sleep(150);

      // ── Step 3: capture ────────────────────────────────────────────────
      chrome.runtime.sendMessage({
        action: 'CAPTURE_PROGRESS',
        step: i + 1,
        total: breakpoints.length,
        label: `Capturing ${bp.label} elements…`,
      }).catch(() => {});

      // Take screenshot
      const screenshotParams = {
        format: 'png',
        fromSurface: true,
      };
      if (options.fullPage !== false) {
        screenshotParams.captureBeyondViewport = true;
      }

      const { data: screenshot } = await debuggerCmd(tabId, 'Page.captureScreenshot', screenshotParams);

      // Capture DOM tree + computed styles
      let domData = null;
      try {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          func: captureDOM,
        });
        domData = result.result;
      } catch (domErr) {
        console.warn(`DOM capture skipped for ${bp.label}:`, domErr.message);
      }

      captures.push({ breakpoint: bp, screenshot, domData });
    }

  } finally {
    // Always restore viewport and detach debugger
    await debuggerCmd(tabId, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
    await debuggerCmd(tabId, 'Emulation.setScrollbarsHidden', { hidden: false }).catch(() => {});
    await chrome.debugger.detach({ tabId }).catch(() => {});
    stopKeepAlive();
  }

  return { url, title, captures };
}

// ── Debugger helper ───────────────────────────────────────────────────────────
function debuggerCmd(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// ── Wait for the page to fully load and layout to settle ─────────────────────
// Polls document.readyState and image completion up to MAX_MS before giving up.
async function waitForPageSettled(tabId) {
  const MAX_MS   = 10000; // Maximum time to wait (10 s)
  const POLL_MS  = 300;   // How often to check
  const start    = Date.now();

  while (Date.now() - start < MAX_MS) {
    let ready = false;
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: function () {
          // 1. Document must be fully parsed and loaded
          if (document.readyState !== 'complete') return false;

          // 2. All <img> elements must have finished loading
          var imgs = document.querySelectorAll('img[src]');
          for (var i = 0; i < imgs.length; i++) {
            if (!imgs[i].complete) return false;
          }

          // 3. No pending CSS animations or transitions on body-level elements
          //    (getAnimations is Chrome 84+; skip gracefully if unavailable)
          if (typeof document.body.getAnimations === 'function') {
            var anims = document.body.getAnimations();
            for (var j = 0; j < anims.length; j++) {
              if (anims[j].playState === 'running') return false;
            }
          }

          return true;
        },
      });
      ready = res && res.result === true;
    } catch (_e) {
      // Page not yet scriptable — keep polling
    }

    if (ready) break;
    await sleep(POLL_MS);
  }

  // Extra pause for JS-framework re-renders (React/Vue/Angular hydration, etc.)
  await sleep(600);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── DOM Capture ───────────────────────────────────────────────────────────────
// This function is serialised and injected into the target page via executeScript.
// It must be completely self-contained (no external variable references).
function captureDOM() {
  const STYLE_PROPS = [
    'backgroundColor', 'color', 'fontSize', 'fontFamily', 'fontWeight',
    'fontStyle', 'lineHeight', 'letterSpacing', 'textAlign', 'textDecoration',
    'textTransform', 'whiteSpace',
    'borderRadius',
    'borderTopLeftRadius', 'borderTopRightRadius',
    'borderBottomLeftRadius', 'borderBottomRightRadius',
    'borderWidth', 'borderColor', 'borderStyle',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'display', 'position', 'overflow', 'opacity', 'visibility',
    'boxShadow', 'backgroundImage', 'backgroundSize', 'backgroundPosition',
    'backgroundRepeat', 'objectFit',
    'flexDirection', 'alignItems', 'justifyContent', 'flexWrap', 'gap',
    'gridTemplateColumns',
    'zIndex', 'transform',
  ];

  function serializeStyles(el) {
    const cs = window.getComputedStyle(el);
    const styles = {};
    for (const prop of STYLE_PROPS) {
      const val = cs[prop];
      if (val !== '' && val !== null && val !== undefined) {
        styles[prop] = val;
      }
    }
    return styles;
  }

  function serializeNode(el, depth) {
    if (depth > 40) return null;
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;

    const tag = el.tagName.toLowerCase();

    // Skip non-visual tags
    if (['script', 'style', 'noscript', 'meta', 'head', 'link',
         'template', 'slot', 'base'].includes(tag)) return null;

    const cs = window.getComputedStyle(el);

    // Skip truly hidden elements; but keep opacity-0 (structure preserved)
    if (cs.display === 'none') return null;
    // Only skip visibility:hidden on non-root elements
    if (depth > 0 && cs.visibility === 'hidden') return null;

    const rect   = el.getBoundingClientRect();
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    const node = {
      tag,
      id:      el.id      || undefined,
      classes: typeof el.className === 'string' && el.className ? el.className : undefined,
      rect: {
        x:      Math.round(rect.left   + scrollX),
        y:      Math.round(rect.top    + scrollY),
        width:  Math.round(rect.width),
        height: Math.round(rect.height),
      },
      styles: serializeStyles(el),
    };

    // Collect direct text (only from Text nodes to avoid duplicating child element text)
    const directText = Array.from(el.childNodes)
      .filter(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim())
      .map(n => n.textContent.trim())
      .join(' ');
    if (directText) node.text = directText;

    // Image source
    if (tag === 'img') {
      node.src = el.currentSrc || el.src || undefined;
      node.alt = el.alt || undefined;
    }

    // Input / textarea placeholder
    if (['input', 'textarea', 'button'].includes(tag)) {
      node.placeholder = el.placeholder || undefined;
      node.value       = el.value       || undefined;
    }

    // Inline SVG — serialize as string, skip children
    if (tag === 'svg') {
      node.svgContent = el.outerHTML;
      return node;
    }

    // Recurse into children
    const children = Array.from(el.children)
      .map(child => serializeNode(child, depth + 1))
      .filter(Boolean);
    if (children.length) node.children = children;

    return node;
  }

  const body = document.body;
  const html = document.documentElement;
  const scrollHeight = Math.max(
    body.scrollHeight, body.offsetHeight,
    html.clientHeight, html.scrollHeight, html.offsetHeight
  );

  return {
    url:      window.location.href,
    title:    document.title,
    viewport: {
      width:      window.innerWidth,
      height:     window.innerHeight,
      fullHeight: scrollHeight,
    },
    domTree: serializeNode(body, 0),
  };
}
