'use strict';

// Icon SVG paths live in fileicons.json (data, not code). This loader fetches
// them and exposes window.FILE_ICON_PATHS. Consumers await FILE_ICON_PATHS_READY
// before their first render so icons never flash in late.
window.FILE_ICON_PATHS = {};
window.FILE_ICON_PATHS_READY = fetch('/js/fileicons.json')
  .then((r) => r.json())
  .then((data) => {
    window.FILE_ICON_PATHS = data;
    return data;
  })
  .catch(() => {
    // On failure, callers fall back to letter badges (guarded at each use site).
    return window.FILE_ICON_PATHS;
  });
