/**
 * popup.js — UI logic for Site to Figma extension
 */

const DEFAULT_BREAKPOINTS = [
  { id: 'desktop', label: 'Desktop', width: 1440, height: 900,  mobile: false,
    icon: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="1" y="2" width="14" height="10" rx="1.5" stroke="currentColor" stroke-width="1.3"/>
      <path d="M6 14h4M8 12v2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    </svg>` },
  { id: 'tablet', label: 'Tablet',  width: 768,  height: 1024, mobile: true,
    icon: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="3" y="1" width="10" height="14" rx="1.5" stroke="currentColor" stroke-width="1.3"/>
      <circle cx="8" cy="13" r="0.8" fill="currentColor"/>
    </svg>` },
  { id: 'mobile', label: 'Mobile',  width: 390,  height: 844,  mobile: true,
    icon: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="4.5" y="1" width="7" height="14" rx="1.5" stroke="currentColor" stroke-width="1.3"/>
      <circle cx="8" cy="13" r="0.7" fill="currentColor"/>
    </svg>` },
];

let captureResults = null;

// ── Build breakpoint rows ──────────────────────────────────────────────────────
function renderBreakpoints() {
  const container = document.getElementById('breakpoints-list');
  container.innerHTML = '';

  DEFAULT_BREAKPOINTS.forEach(bp => {
    const row = document.createElement('div');
    row.className = 'breakpoint-row';
    row.dataset.id = bp.id;

    row.innerHTML = `
      <div class="bp-check-wrap">
        <input class="bp-checkbox bp-enabled" type="checkbox" id="bp-${bp.id}" checked>
      </div>
      <div class="bp-icon">${bp.icon}</div>
      <label class="bp-label" for="bp-${bp.id}">${bp.label}</label>
      <div class="bp-dims">
        <input class="bp-input bp-width"  type="number" min="320" max="3840" value="${bp.width}"  title="Width">
        <span class="bp-sep">×</span>
        <input class="bp-input bp-height" type="number" min="400" max="4096" value="${bp.height}" title="Height">
      </div>
    `;
    container.appendChild(row);
  });
}

// ── Collect current breakpoint settings ───────────────────────────────────────
function getBreakpoints() {
  return DEFAULT_BREAKPOINTS
    .map(bp => {
      const row = document.querySelector(`.breakpoint-row[data-id="${bp.id}"]`);
      const enabled = row.querySelector('.bp-enabled').checked;
      const width   = parseInt(row.querySelector('.bp-width').value, 10)  || bp.width;
      const height  = parseInt(row.querySelector('.bp-height').value, 10) || bp.height;
      return { ...bp, width, height, enabled };
    })
    .filter(bp => bp.enabled);
}

// ── Progress helpers ──────────────────────────────────────────────────────────
function showProgress(label, pct) {
  document.getElementById('progress-area').classList.remove('hidden');
  document.getElementById('progress-fill').style.width = `${pct}%`;
  document.getElementById('progress-label').textContent = label;
}

function hideProgress() {
  document.getElementById('progress-area').classList.add('hidden');
}

function showError(msg) {
  const area = document.getElementById('error-area');
  area.classList.remove('hidden');
  document.getElementById('error-message').textContent = msg;
}

function hideError() {
  document.getElementById('error-area').classList.add('hidden');
}

// ── Render preview thumbnails ─────────────────────────────────────────────────
function renderResults(captures) {
  captureResults = captures;

  const container = document.getElementById('previews-container');
  container.innerHTML = '';

  captures.captures.forEach(cap => {
    const card = document.createElement('div');
    card.className = 'preview-card';
    card.innerHTML = `
      <div class="preview-img-wrap">
        <img src="data:image/png;base64,${cap.screenshot}" alt="${cap.breakpoint.label}">
      </div>
      <div class="preview-label">${cap.breakpoint.label}</div>
      <div class="preview-dims">${cap.breakpoint.width}px</div>
    `;
    container.appendChild(card);
  });

  document.getElementById('results-area').classList.remove('hidden');
}

// ── Download helpers ──────────────────────────────────────────────────────────
function downloadFile(filename, dataUrl) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

function b64toBlob(b64, mime) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function slugify(str) {
  return str.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// ── Export: PNG screenshots ───────────────────────────────────────────────────
function exportPNGs() {
  if (!captureResults) return;
  const pageSlug = slugify(captureResults.title || 'capture');

  captureResults.captures.forEach(cap => {
    const blob = b64toBlob(cap.screenshot, 'image/png');
    const url = URL.createObjectURL(blob);
    downloadFile(`${pageSlug}-${cap.breakpoint.id}.png`, url);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
}

// ── Export: SVG files ─────────────────────────────────────────────────────────
function exportSVGs() {
  if (!captureResults) return;
  const pageSlug = slugify(captureResults.title || 'capture');

  captureResults.captures.forEach(cap => {
    if (!cap.domData) return;
    const svg = generateSVG(cap.domData, cap.breakpoint);
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    downloadFile(`${pageSlug}-${cap.breakpoint.id}.svg`, url);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
}

// ── Export: JSON data ─────────────────────────────────────────────────────────
function exportJSON() {
  if (!captureResults) return;
  const data = {
    capturedAt: new Date().toISOString(),
    url: captureResults.url,
    title: captureResults.title,
    captures: captureResults.captures.map(c => ({
      breakpoint: c.breakpoint,
      viewport: c.domData?.viewport,
      domTree: c.domData?.domTree,
    })),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const slug = slugify(captureResults.title || 'capture');
  downloadFile(`${slug}-figma-capture.json`, url);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ── Main capture flow ─────────────────────────────────────────────────────────
async function startCapture() {
  const breakpoints = getBreakpoints();
  if (breakpoints.length === 0) {
    showError('Enable at least one breakpoint.');
    return;
  }

  hideError();
  captureResults = null;
  document.getElementById('results-area').classList.add('hidden');

  const btn = document.getElementById('capture-btn');
  btn.disabled = true;
  showProgress('Connecting...', 5);

  const options = {
    breakpoints,
    fullPage:    document.getElementById('opt-fullpage').checked,
    includeSVG:  document.getElementById('opt-svg').checked,
    includeJSON: document.getElementById('opt-json').checked,
  };

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'START_CAPTURE',
      options,
    });

    if (!response.success) {
      throw new Error(response.error || 'Capture failed.');
    }

    hideProgress();
    renderResults(response.result);

    // Auto-download JSON if enabled
    if (options.includeJSON) exportJSON();

  } catch (err) {
    hideProgress();
    showError(err.message);
  } finally {
    btn.disabled = false;
  }
}

// ── Progress listener (from service worker) ───────────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'CAPTURE_PROGRESS') {
    const pct = Math.round((message.step / message.total) * 90) + 5;
    showProgress(message.label, pct);
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  renderBreakpoints();

  document.getElementById('capture-btn').addEventListener('click', startCapture);
  document.getElementById('export-png').addEventListener('click', exportPNGs);
  document.getElementById('export-svg').addEventListener('click', exportSVGs);
});
