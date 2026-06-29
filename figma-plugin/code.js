/**
 * code.js — Chrome to Figma Importer (Figma Plugin)
 *
 * Reads the JSON exported by the Chrome extension and builds:
 *   Section
 *     └─ Frame: Desktop — 1440px
 *     └─ Frame: Tablet — 768px
 *     └─ Frame: Mobile — 390px
 *         └─ DOM elements as Figma nodes (FRAME / TEXT)
 *            ├─ Fills from computed background colors
 *            ├─ Strokes from computed borders
 *            ├─ Corner radius from border-radius
 *            └─ Auto Layout on flex containers
 */

figma.showUI(__html__, { width: 420, height: 360, title: 'Chrome to Figma' });

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'import') {
    try {
      await createFigmaStructure(msg.data);
      figma.closePlugin('Import complete ✓');
    } catch (err) {
      figma.ui.postMessage({ type: 'error', message: err.message });
    }
  } else if (msg.type === 'cancel') {
    figma.closePlugin();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Color helpers
// ─────────────────────────────────────────────────────────────────────────────

function parseCSSColor(cssColor) {
  if (!cssColor) return null;

  // rgba(r, g, b, a) or rgb(r, g, b)
  const rgba = cssColor.match(
    /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/
  );
  if (rgba) {
    return {
      color:   { r: +rgba[1] / 255, g: +rgba[2] / 255, b: +rgba[3] / 255 },
      opacity: rgba[4] !== undefined ? +rgba[4] : 1,
    };
  }

  // #rrggbb / #rgb / #rrggbbaa
  const hex = cssColor.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    return {
      color: {
        r: parseInt(h.slice(0, 2), 16) / 255,
        g: parseInt(h.slice(2, 4), 16) / 255,
        b: parseInt(h.slice(4, 6), 16) / 255,
      },
      opacity: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }

  return null;
}

function isTransparent(cssColor) {
  if (!cssColor || cssColor === 'transparent' || cssColor === 'none') return true;
  const p = parseCSSColor(cssColor);
  if (!p) return true;
  if (p.opacity < 0.01) return true;
  const { r, g, b } = p.color;
  // rgba(0,0,0,0)
  if (r === 0 && g === 0 && b === 0 && p.opacity === 0) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Style application helpers
// ─────────────────────────────────────────────────────────────────────────────

function applyFills(node, styles) {
  if (!styles || isTransparent(styles.backgroundColor)) {
    node.fills = [];
    return;
  }
  const p = parseCSSColor(styles.backgroundColor);
  if (!p) { node.fills = []; return; }
  node.fills = [{ type: 'SOLID', color: p.color, opacity: p.opacity }];
}

function applyStrokes(node, styles) {
  if (!styles) { node.strokes = []; return; }
  const bw = parseFloat(styles.borderWidth) || 0;
  if (bw <= 0 || styles.borderStyle === 'none' || !styles.borderColor) {
    node.strokes = [];
    return;
  }
  const p = parseCSSColor(styles.borderColor);
  if (!p) { node.strokes = []; return; }
  node.strokes      = [{ type: 'SOLID', color: p.color }];
  node.strokeWeight  = bw;
  node.strokeAlign   = 'INSIDE';
}

function applyCornerRadius(node, styles) {
  if (!styles) return;
  const tl = parseFloat(styles.borderTopLeftRadius)     || parseFloat(styles.borderRadius) || 0;
  const tr = parseFloat(styles.borderTopRightRadius)    || parseFloat(styles.borderRadius) || 0;
  const bl = parseFloat(styles.borderBottomLeftRadius)  || parseFloat(styles.borderRadius) || 0;
  const br = parseFloat(styles.borderBottomRightRadius) || parseFloat(styles.borderRadius) || 0;
  if (tl === tr && tr === bl && bl === br) {
    node.cornerRadius = tl;
  } else {
    node.topLeftRadius     = tl;
    node.topRightRadius    = tr;
    node.bottomLeftRadius  = bl;
    node.bottomRightRadius = br;
  }
}

function applyAutoLayout(frame, styles) {
  const direction = styles.flexDirection === 'column' ? 'VERTICAL' : 'HORIZONTAL';
  frame.layoutMode            = direction;
  frame.primaryAxisSizingMode = 'FIXED';
  frame.counterAxisSizingMode = 'FIXED';
  frame.itemSpacing           = parseFloat(styles.gap) || 0;
  frame.paddingTop            = parseFloat(styles.paddingTop)    || 0;
  frame.paddingRight          = parseFloat(styles.paddingRight)  || 0;
  frame.paddingBottom         = parseFloat(styles.paddingBottom) || 0;
  frame.paddingLeft           = parseFloat(styles.paddingLeft)   || 0;

  const justifyMap = {
    'center':        'CENTER',
    'flex-end':      'MAX',
    'space-between': 'SPACE_BETWEEN',
    'flex-start':    'MIN',
    'start':         'MIN',
    'end':           'MAX',
  };
  const alignMap = {
    'center':   'CENTER',
    'flex-end': 'MAX',
    'flex-start':'MIN',
    'start':    'MIN',
    'end':      'MAX',
    'stretch':  'STRETCH',
    'baseline': 'MIN',
  };
  frame.primaryAxisAlignItems = justifyMap[styles.justifyContent] || 'MIN';
  frame.counterAxisAlignItems = alignMap[styles.alignItems]       || 'MIN';
}

// ─────────────────────────────────────────────────────────────────────────────
// Node name helper
// ─────────────────────────────────────────────────────────────────────────────

function nodeName(domNode) {
  const { tag, id, classes } = domNode;
  let name = tag || 'div';
  if (id) name += `#${id}`;
  else if (classes) {
    const first = String(classes).trim().split(/\s+/)[0];
    if (first) name += `.${first}`;
  }
  return name;
}

// ─────────────────────────────────────────────────────────────────────────────
// Text node creation
// ─────────────────────────────────────────────────────────────────────────────

const loadedFonts = new Set();

async function loadFont(family, style) {
  const key = `${family}:${style}`;
  if (loadedFonts.has(key)) return;
  try {
    await figma.loadFontAsync({ family, style });
    loadedFonts.add(key);
  } catch {
    // fall back to Inter Regular
    await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
    loadedFonts.add('Inter:Regular');
  }
}

async function createTextNode(text, styles) {
  const node      = figma.createText();
  const fw        = styles?.fontWeight || 'normal';
  const isBold    = fw === 'bold' || +fw >= 600;
  const figmaStyle = isBold ? 'Bold' : 'Regular';

  await loadFont('Inter', figmaStyle);
  node.fontName   = { family: 'Inter', style: figmaStyle };
  node.fontSize   = Math.max(parseFloat(styles?.fontSize) || 14, 1);
  node.characters = text;

  const textColor = parseCSSColor(styles?.color);
  node.fills = textColor
    ? [{ type: 'SOLID', color: textColor.color, opacity: textColor.opacity }]
    : [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];

  switch (styles?.textAlign) {
    case 'center':  node.textAlignHorizontal = 'CENTER';    break;
    case 'right':   node.textAlignHorizontal = 'RIGHT';     break;
    case 'justify': node.textAlignHorizontal = 'JUSTIFIED'; break;
    default:        node.textAlignHorizontal = 'LEFT';
  }

  node.textAutoResize = 'WIDTH_AND_HEIGHT';
  return node;
}

// ─────────────────────────────────────────────────────────────────────────────
// Recursive DOM → Figma node builder
// ─────────────────────────────────────────────────────────────────────────────

async function buildNodes(figmaParent, domNode, parentDomX, parentDomY) {
  if (!domNode || !domNode.rect) return;

  const { tag, rect, styles = {}, text, children = [] } = domNode;

  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'head', 'link', 'meta', 'br', 'hr']);
  if (SKIP_TAGS.has(tag)) return;

  const x = Math.round(rect.x - parentDomX);
  const y = Math.round(rect.y - parentDomY);
  const w = Math.max(Math.round(rect.width),  1);
  const h = Math.max(Math.round(rect.height), 1);

  const isFlex = styles.display === 'flex' || styles.display === 'inline-flex';
  const isGrid = styles.display === 'grid'  || styles.display === 'inline-grid';

  // ── Create the Figma frame for this DOM element ───────────────────────────
  const frame = figma.createFrame();
  frame.name         = nodeName(domNode);
  frame.x            = x;
  frame.y            = y;
  frame.resize(w, h);
  frame.clipsContent = false;

  applyFills(frame, styles);
  applyCornerRadius(frame, styles);
  applyStrokes(frame, styles);

  if (styles.opacity) {
    const op = parseFloat(styles.opacity);
    if (!isNaN(op) && op < 1) frame.opacity = op;
  }

  // Apply Auto Layout for flex/grid containers
  if ((isFlex || isGrid) && children.length > 0) {
    applyAutoLayout(frame, styles);
  } else {
    frame.layoutMode = 'NONE';
  }

  // ── Add direct text content ───────────────────────────────────────────────
  if (text && tag !== 'svg') {
    const textNode = await createTextNode(text, styles);
    if (frame.layoutMode === 'NONE') {
      textNode.x = parseFloat(styles.paddingLeft) || 0;
      textNode.y = parseFloat(styles.paddingTop)  || 0;
    }
    frame.appendChild(textNode);
  }

  // ── Recurse into children ─────────────────────────────────────────────────
  for (const child of children) {
    await buildNodes(frame, child, rect.x, rect.y);
  }

  figmaParent.appendChild(frame);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main: create Section + breakpoint frames
// ─────────────────────────────────────────────────────────────────────────────

async function createFigmaStructure(data) {
  const { title = 'Capture', url = '', captures = [] } = data;

  if (!captures.length) throw new Error('No captures found in the JSON.');

  // Pre-load required fonts up-front
  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });
  loadedFonts.add('Inter:Regular');
  loadedFonts.add('Inter:Bold');

  const FRAME_GAP    = 80;   // px between breakpoint frames inside the section
  const SEC_PADDING  = 48;   // px padding around the section contents

  // ── Create the wrapping Section ──────────────────────────────────────────
  let section;
  try {
    section = figma.createSection();
    section.name = `${title} — Chrome to Figma`;
  } catch {
    // Fallback: use a frame if createSection is unavailable
    section = figma.createFrame();
    section.name  = `${title} — Chrome to Figma`;
    section.fills = [{ type: 'SOLID', color: { r: 0.96, g: 0.94, b: 1 } }];
  }

  // ── Build each breakpoint frame ───────────────────────────────────────────
  let cursorX = SEC_PADDING;
  let maxH    = 0;

  for (const capture of captures) {
    const { breakpoint, viewport, domTree } = capture;

    const bpW = breakpoint.width;
    const bpH = viewport?.fullHeight || breakpoint.height;

    // Breakpoint frame
    const bpFrame = figma.createFrame();
    bpFrame.name        = `${breakpoint.label} — ${bpW}px`;
    bpFrame.resize(bpW, bpH);
    bpFrame.x           = cursorX;
    bpFrame.y           = SEC_PADDING;
    bpFrame.fills       = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
    bpFrame.layoutMode  = 'NONE';
    bpFrame.clipsContent = true;

    // Walk the DOM tree and build child nodes
    if (domTree) {
      const baseX = domTree.rect?.x || 0;
      const baseY = domTree.rect?.y || 0;
      const bodyChildren = domTree.children || [];
      for (const child of bodyChildren) {
        await buildNodes(bpFrame, child, baseX, baseY);
      }
    }

    section.appendChild(bpFrame);

    cursorX += bpW + FRAME_GAP;
    if (bpH > maxH) maxH = bpH;
  }

  // ── Size the section to fit its contents ─────────────────────────────────
  const totalW = cursorX - FRAME_GAP + SEC_PADDING;
  const totalH = maxH + SEC_PADDING * 2;

  if (section.resizeWithoutConstraints) {
    section.resizeWithoutConstraints(totalW, totalH);
  } else {
    section.resize(totalW, totalH);
  }

  // ── Place section at the current viewport centre ──────────────────────────
  const { x: cx, y: cy } = figma.viewport.center;
  section.x = cx - totalW / 2;
  section.y = cy - totalH / 2;

  figma.currentPage.appendChild(section);
  figma.viewport.scrollAndZoomIntoView([section]);
}
