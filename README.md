# maplibre-label-callout

Labels with connector lines for MapLibre GL JS.

[![npm](https://img.shields.io/npm/v/@leoneljdias/maplibre-label-callout)](https://www.npmjs.com/package/@leoneljdias/maplibre-label-callout)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm bundle size](https://img.shields.io/bundlephobia/min/@leoneljdias/maplibre-label-callout)](https://bundlephobia.com/package/@leoneljdias/maplibre-label-callout)

![demo](https://raw.githubusercontent.com/leoneljdias/maplibre-label-callout/main/demo/screenshot.png)

[Demo](https://leoneljdias.github.io/maplibre-label-callout/demo/) · [npm](https://www.npmjs.com/package/@leoneljdias/maplibre-label-callout)

---

## Install

```bash
npm install @leoneljdias/maplibre-label-callout
```

Or via CDN (ESM):

```html
<script type="module">
  import LineCallout3D from "https://unpkg.com/@leoneljdias/maplibre-label-callout/dist/index.js";
</script>
```

Or via CDN (UMD):

```html
<script src="https://unpkg.com/@leoneljdias/maplibre-label-callout/dist/index.umd.js"></script>
<script>
  const callouts = new LineCallout3D(map, options);
</script>
```

## Usage

```js
import LineCallout3D from "@leoneljdias/maplibre-label-callout";

const callouts = new LineCallout3D(map, {
  data: myGeoJSON, // FeatureCollection or URL
  template: (p) => `
    <div style="font-weight:600">${p.name}</div>
    <div style="color:#64748b;font-size:10.5px">${p.description}</div>
  `,
  priority: (p) => p.importance,
  idProperty: "id",
});
```

Markers are rendered as a native MapLibre `circle` layer (GPU-accelerated).
Labels are positioned with spatial-hash collision detection, priority-based
eviction, and exhaustive backfill. Supports Mercator and Globe projections.
Only in-viewport features are considered. Performance stays bounded by `maxLabels`.

## Options

| Option                | Default                                              | Description                                                                                                         |
| --------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `data`                | —                                                    | GeoJSON FeatureCollection or URL (required)                                                                         |
| `template`            | `(p) => …`                                           | Function returning label HTML from feature properties                                                               |
| `idProperty`          | `null`                                               | Property name for deduplication                                                                                     |
| `priority`            | `null`                                               | `(props) => number`, higher values placed first                                                                     |
| `maxLabels`           | `Infinity`                                           | Max visible labels at once                                                                                          |
| `offset`              | `[0, -56]`                                           | `[x, y]` px offset from anchor                                                                                      |
| `connectSide`         | `'bottom'`                                           | `'top'`, `'bottom'`, `'left'`, `'right'`, or `'auto'`                                                               |
| `labelPosition`       | `'fixed'`                                            | `'fixed'`, `'auto'`, `'onlyTop'`, `'onlyBottom'`, `'onlyLeft'`, `'onlyRight'`, `'onlyVertical'`, `'onlyHorizontal'` |
| `boxSize`             | `[150, 34]`                                          | Approx `[w, h]` for collision detection                                                                             |
| `padding`             | `6`                                                  | Min px gap between label boxes                                                                                      |
| `maxOffset`           | `3`                                                  | Max multiplier for offset growth to avoid collisions                                                                |
| `lineColor`           | `'#000000'`                                          | Connector line color (or `(props) => color`)                                                                        |
| `lineWidth`           | `1.25`                                               | Connector line width                                                                                                |
| `lineDash`            | `null`                                               | Connector line dash array                                                                                           |
| `minLineLength`       | `10`                                                 | Minimum connector line length in px                                                                                 |
| `maxLineLength`       | `50`                                                 | Maximum connector line length in px                                                                                 |
| `dotRadius`           | `3.5`                                                | Anchor dot radius                                                                                                   |
| `dotColor`            | `'#c65b2e'`                                          | Anchor dot color (or `(props) => color`)                                                                            |
| `labelBackground`     | `'#ffffff'`                                          | Label background (or `(props) => …`)                                                                                |
| `labelColor`          | `'#16150f'`                                          | Label text color                                                                                                    |
| `labelPadding`        | `'7px 12px 7px 16px'`                                | Label padding                                                                                                       |
| `labelBorder`         | `'1px solid #e2e8f0'`                                | Label border                                                                                                        |
| `labelBorderRadius`   | `'8px'`                                              | Label border radius                                                                                                 |
| `labelAccentColor`    | `null`                                               | Left border accent color                                                                                            |
| `onClick`             | `null`                                               | `(props, feature, event) => …`                                                                                      |
| `minZoom` / `maxZoom` | `-∞` / `∞`                                           | Zoom bounds                                                                                                         |
| `markerPaint`         | `{ circle-radius: 3, circle-color: '#c65b2e', ... }` | Paint object for the marker circle layer                                                                            |

## API

- **`setData(data)`** - Replace the GeoJSON data
- **`setLabelOptions(patch)`** - Update label config without touching data
- **`destroy()`** - Remove all layers, sources, and DOM nodes

## Contributing

Any contributions to this project are more than welcome. Feel free to reach us and we will gladly include any improvements or ideas that you may have. Please, fork this repository, make any changes and submit a Pull Request and we will get in touch!

## License

MIT

by [Leonel Dias](https://leoneljdias.github.io/)
