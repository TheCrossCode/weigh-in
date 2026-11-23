# Weigh-In

A dark-mode PWA for logging your weight, progress photos, and cut/bulk programs.
Everything is stored on your device (IndexedDB) — nothing is uploaded.

## Features
- One-tap logging (+ button), multiple weigh-ins per day, optional photos
- Stats: change since last log, week, month, total
- Weight chart with Week / Month / Year ranges — swipe to browse past periods, tap a point for its weight
- Cut / Bulk programs with a day-by-day log, target, rate per week, and their own chart
- Shareable progress images (single day, program before/after, overall, or compare any two days)
- Backup export / import (Settings)

## Install on iPhone
Open the site in Safari → Share → **Add to Home Screen**.

## Develop
Static files, no build step:

```bash
python -m http.server 5180
```

Then open http://localhost:5180. Regenerate icons with `python tools/make_icons.py`.
Bump `CACHE` in `sw.js` when shipping changes so installed copies refresh their offline cache.
