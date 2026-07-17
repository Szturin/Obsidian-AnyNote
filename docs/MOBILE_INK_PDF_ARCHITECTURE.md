# Mobile Ink PDF Architecture Notes

This note records the PDF annotation principles reverse-read from the local
`.research-mobile-ink-annotation` build.

## Key Principles

- PDF pages are treated as stable page descriptors, not as a single moving overlay.
- Each PDF page descriptor carries `pageNumber`, `pageEl`, `width`, `height`, and `offsetY`.
- Ink is page-local. A page engine receives strokes in that page's own coordinate space.
- Visible pages get their own committed/live canvas pair. Far pages release engines and canvases.
- The live canvas is for active input. The committed canvas is for completed strokes.
- Completed strokes are committed later through a pending queue instead of forcing a full redraw on every pen-up.
- PDF background rendering is lazy and quality-tiered: nearby pages get preview rendering first, then sharp rendering after interaction stops.
- Rendering budgets are enforced on mobile by releasing far PDF canvases and PDF.js page caches.
- Pointer handling has recovery paths: interrupted input is finished, stray pointer moves may start recovery, and touch/pointer suppression prevents duplicate input.

## Difference From The Old AnyNote PDF Layer

AnyNote works inside Obsidian's native PDF view. That keeps the UI native, but it means the plugin must discover and attach to Obsidian's page DOM. Before 0.2.13, the fragile parts were:

- a single active writing stage was moved between pages;
- non-active pages used passive render layers;
- page hit testing depended on the current PDF DOM shape;
- stroke coordinates were stored against page display size at write time, then scaled on render.

The direction is to keep the native PDF surface while adopting mobile-ink's page-engine model:

- route pointer down by the actual page under the pen;
- keep per-page render state and cache;
- treat each page as an independent ink surface;
- avoid whole-document redraws during scroll, zoom, and pen-up.

## Applied Changes In AnyNote 0.2.13

- PDF ink is now represented as per-page ink surfaces.
- Each visible native PDF page gets its own `anynote-pdf-page-stage`.
- Each page stage owns committed, live, prediction, and selection layers.
- Host-level pointer down finds the real PDF page under the pen before starting a stroke.
- Completed strokes are committed into the current page surface first, instead of forcing all visible pages to redraw on every pen-up.
- Erase, selection, undo, redo, and delete now invalidate only affected pages through a dirty-page queue.
- Rejoining a rapid Apple Pencil stroke rebuilds the affected page before replaying the resumed live stroke, preventing duplicated committed ink.
- Existing page-level render signatures, Path2D caches, and deferred zoom redraws remain in place.
