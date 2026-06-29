/**
 * svg-gen.js — Convert captured DOM data to an SVG string
 *
 * The generated SVG can be dragged directly into Figma and will create:
 *   - Rectangle layers   (from element backgrounds + borders)
 *   - Text layers        (from computed font + color styles)
 *   - Image layers       (from <img> and background-image sources)
 *   - Groups             (mirroring the DOM hierarchy)
 *
 * Coordinates are already absolute (page-relative) from the capture step,
 * so no per-group transforms are needed.
 */

/* global generateSVG */

/**
 * @param {Object} domData    — Result of captureDOM() in service-worker.js
 * @param {Object} breakpoint — { id, label, width, height }
 * @returns {string} SVG markup
 */
function generateSVG(domData, breakpoint) {
  if (!domData || !domData.domTree) return '';

  const svgW = breakpoint.width;
  const svgH = domData.viewport?.fullHeight || breakpoint.height;

  const defs   = [];
  const idMap  = new Map(); // clipPath ids
  let   defIdx = 0;

  // ── Utilities ───────────────────────────────────────────────────────────────

  function esc(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;');
  }

  function px(val) {
    return parseFloat(val) || 0;
  }

  function isTransparent(c) {
    return !c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)' || c === 'none';
  }

  function extractUrl(bgImage) {
    if (!bgImage || bgImage === 'none') return null;
    const m = bgImage.match(/url\(["']?([^"')]+)["']?\)/);
    return m ? m[1] : null;
  }

  // Figma reads rx/ry as a single value; use the computed border-radius
  function radiusAttr(styles) {
    const r = px(styles.borderRadius);
    return r > 0 ? ` rx="${r}" ry="${r}"` : '';
  }

  // ── Render a single DOM node recursively ────────────────────────────────────
  function renderNode(node) {
    if (!node || !node.rect) return '';

    const { tag, rect, styles = {}, text, src, svgContent, children = [] } = node;

    // Skip truly invisible / zero-size elements with no content
    const hasContent = text || src || svgContent || (children && children.length > 0);
    if (rect.width < 2 && rect.height < 2 && !hasContent) return '';

    const { x, y, width: w, height: h } = rect;

    const opacityAttr = styles.opacity && parseFloat(styles.opacity) < 1
      ? ` opacity="${styles.opacity}"` : '';

    let out = `<g${opacityAttr}>`;

    // ── 1. Background rectangle ──────────────────────────────────────────────
    const bgColor    = styles.backgroundColor;
    const bgImageUrl = extractUrl(styles.backgroundImage);
    const bw         = px(styles.borderWidth);
    const bc         = styles.borderStyle !== 'none' ? styles.borderColor : null;
    const rx         = radiusAttr(styles);

    const hasBg = !isTransparent(bgColor) || (bc && bw > 0);

    if (hasBg) {
      const fill   = isTransparent(bgColor) ? 'none' : esc(bgColor);
      const stroke = (bc && bw > 0) ? ` stroke="${esc(bc)}" stroke-width="${bw}"` : ' stroke="none"';
      out += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${stroke}${rx}/>`;
    }

    // ── 2. Box shadow as SVG filter (simplified drop-shadow) ─────────────────
    if (styles.boxShadow && styles.boxShadow !== 'none') {
      const shadowFilter = parseBoxShadow(styles.boxShadow, defIdx);
      if (shadowFilter) {
        const filterId = `shadow-${defIdx++}`;
        defs.push(`<filter id="${filterId}" x="-20%" y="-20%" width="140%" height="140%">${shadowFilter}</filter>`);
        // Re-draw background rect with shadow filter
        const fill = isTransparent(bgColor) ? 'none' : esc(bgColor);
        out += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" filter="url(#${filterId})"${rx}/>`;
      }
    }

    // ── 3. Background image ───────────────────────────────────────────────────
    if (bgImageUrl) {
      const preserve = styles.backgroundSize === 'cover'
        ? 'xMidYMid slice' : 'xMidYMid meet';

      if (rx) {
        // Clip bg image to border-radius
        const clipId = `clip-${defIdx++}`;
        defs.push(`<clipPath id="${clipId}"><rect x="${x}" y="${y}" width="${w}" height="${h}"${rx}/></clipPath>`);
        out += `<image href="${esc(bgImageUrl)}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="${preserve}" clip-path="url(#${clipId})"/>`;
      } else {
        out += `<image href="${esc(bgImageUrl)}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="${preserve}"/>`;
      }
    }

    // ── 4. <img> element ─────────────────────────────────────────────────────
    if (tag === 'img' && src) {
      const preserve = styles.objectFit === 'contain'
        ? 'xMidYMid meet' : 'xMidYMid slice';
      out += `<image href="${esc(src)}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="${preserve}"/>`;
    }

    // ── 5. Inline SVG ─────────────────────────────────────────────────────────
    if (tag === 'svg' && svgContent) {
      // Wrap inline SVG at its page position
      out += `<g transform="translate(${x},${y})">${svgContent}</g>`;
    }

    // ── 6. Text ───────────────────────────────────────────────────────────────
    if (text && tag !== 'svg') {
      out += renderText(text, x, y, w, h, styles);
    }

    // ── 7. Children ───────────────────────────────────────────────────────────
    if (children && children.length) {
      for (const child of children) {
        out += renderNode(child);
      }
    }

    out += '</g>';
    return out;
  }

  // ── Text rendering ──────────────────────────────────────────────────────────
  function renderText(text, x, y, w, h, styles) {
    const fontSize   = Math.max(px(styles.fontSize) || 16, 1);
    const fontFamily = styles.fontFamily  || 'sans-serif';
    const fontWeight = styles.fontWeight  || 'normal';
    const fontStyle  = styles.fontStyle   || 'normal';
    const fill       = styles.color       || '#000000';
    const textAlign  = styles.textAlign   || 'left';
    const paddingTop = px(styles.paddingTop) || 0;

    const textAnchor = textAlign === 'center' ? 'middle'
      : textAlign === 'right'  ? 'end'
      : 'start';
    const textX = textAlign === 'center' ? x + w / 2
      : textAlign === 'right'  ? x + w
      : x + (px(styles.paddingLeft) || 0);
    const textY = y + paddingTop + fontSize;

    // Apply text-transform
    let display = text;
    switch (styles.textTransform) {
      case 'uppercase':   display = text.toUpperCase(); break;
      case 'lowercase':   display = text.toLowerCase(); break;
      case 'capitalize':  display = text.replace(/\b\w/g, c => c.toUpperCase()); break;
    }

    const lsAttr = styles.letterSpacing && styles.letterSpacing !== 'normal'
      ? ` letter-spacing="${styles.letterSpacing}"` : '';
    const tdAttr = styles.textDecoration && !styles.textDecoration.includes('none')
      ? ` text-decoration="${styles.textDecoration.split(' ').find(p => ['underline','overline','line-through'].includes(p)) || ''}"` : '';

    return `<text x="${textX}" y="${textY}" ` +
      `font-family="${esc(fontFamily)}" ` +
      `font-size="${fontSize}" ` +
      `font-weight="${esc(fontWeight)}" ` +
      `font-style="${esc(fontStyle)}" ` +
      `fill="${esc(fill)}" ` +
      `text-anchor="${textAnchor}"` +
      `${lsAttr}${tdAttr}` +
      `>${esc(display)}</text>`;
  }

  // ── Box-shadow → SVG feDropShadow ──────────────────────────────────────────
  function parseBoxShadow(shadow, idx) {
    // Match the first shadow: offset-x offset-y blur-radius color
    const m = shadow.match(/(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px(?:\s+([\d.]+)px)?\s+(rgba?\([^)]+\)|#[0-9a-f]+)/i);
    if (!m) return null;
    const dx = parseFloat(m[1]);
    const dy = parseFloat(m[2]);
    const blur = parseFloat(m[3]);
    const color = m[5] || 'rgba(0,0,0,0.25)';
    return `<feDropShadow dx="${dx}" dy="${dy}" stdDeviation="${blur / 2}" flood-color="${esc(color)}"/>`;
  }

  // ── Assemble SVG ─────────────────────────────────────────────────────────────
  const body = renderNode(domData.domTree);
  const defsTag = defs.length ? `<defs>${defs.join('\n')}</defs>` : '';

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"`,
    `     width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">`,
    defsTag,
    `<!-- Site to Figma — ${esc(domData.title)} @ ${breakpoint.label} (${svgW}px) -->`,
    body,
    `</svg>`,
  ].join('\n');
}
