// URLs that need hand-written handling, and therefore must NOT be picked up by the generic
// auto-mirroring in vendor.mjs.
//
// Something belongs here when a plain "download the file" mirror isn't enough — because the
// library fetches siblings at runtime (MediaPipe's locateFile), or because the URL is a
// stylesheet that references further files (Google Fonts), or because it's a whole runtime
// tree (Pygbag). Everything else can just be downloaded and repointed automatically.

export const MANUAL_URL_PREFIXES = [
  // Vendored from npm so the whole package (wasm/tflite/binarypb siblings) comes along.
  'https://cdn.jsdelivr.net/npm/@mediapipe/',
  'https://cdnjs.cloudflare.com/ajax/libs/matter-js/',
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/',

  // Fetched as CSS, then every woff2 it names is mirrored and the CSS rewritten.
  // No trailing slash: bare-origin `<link rel="preconnect">` hints must match too, otherwise
  // they get queued for download and fail (an origin on its own isn't a fetchable asset).
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',

  // A whole CPython-WASM runtime tree — see scripts/pygbag-files.json.
  'https://pygame-web.github.io/',
];

export function isManuallyHandled(url) {
  return MANUAL_URL_PREFIXES.some((p) => url.startsWith(p));
}

// Scans site HTML for anything loaded off-box. Deliberately conservative about what counts:
// only real subresource references, not every string that happens to look like a URL.
export function findExternalUrls(html) {
  const urls = new Set();

  const patterns = [
    /<script[^>]+src\s*=\s*["'](https?:\/\/[^"']+)["']/gi,
    /<link[^>]+href\s*=\s*["'](https?:\/\/[^"']+)["']/gi,
    /@import\s+url\(\s*["']?(https?:\/\/[^"')]+)["']?\s*\)/gi,
    /url\(\s*["']?(https?:\/\/[^"')]+\.(?:woff2?|ttf|otf|png|jpe?g|gif|svg|webp))["']?\s*\)/gi,
  ];

  for (const re of patterns) {
    for (const m of html.matchAll(re)) {
      // XML namespace identifiers are never fetched.
      if (!m[1].includes('www.w3.org')) urls.add(m[1]);
    }
  }
  return urls;
}
