# Invariant logo assets

Based on the site's original logo: the word `invariant` in bold system sans with an accent-colored period. Shared by the landing page and the docs. Reference them with a relative path (`assets/...` from the site root, `../assets/...` from `docs/`).

| File | Use |
|---|---|
| `logo-wordmark.svg` | The wordmark in light ink. Use on dark backgrounds. |
| `logo-wordmark-light.svg` | The wordmark in dark ink. Use on light backgrounds. |
| `logo-icon.svg` | `i.` on the site's dark panel. Avatars and app icons. |
| `favicon.svg`, `favicon-32.png`, `apple-touch-icon.png` | Browser tab and home-screen icons. |
| `og-image.svg`, `og-image.png` | 1200x630 social card. |
| `logo-wordmark.png`, `logo-icon-512.png` | Raster copies for tools that cannot take SVG. |

## Colors

| Name | Value |
|---|---|
| Ink (background) | `#0b0d12` |
| Paper (text on dark) | `#e8eaf0` |
| Accent (the period) | `#7c8cff` |
| Accent 2 | `#5eead4` |
| Line | `#222733` |

## Notes

- The SVGs use live text in the system sans stack (`system-ui`), pinned to a fixed width with `textLength`, so they look close to the site on any machine but not identical to the PNGs, which were exported on macOS. For exact results, use the PNGs.
- The wordmark's period is always Accent. Do not recolor it, and do not place the light-ink wordmark on a light background.
- Keep clear space around the wordmark of at least the height of the `i` dot.
- The PNGs are exported from the SVGs with headless Chrome. Re-export them if an SVG changes.
