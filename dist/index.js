/*!
 * LineCallout3D. Labels with connector lines for MapLibre GL JS.
 *
 * Markers use a native MapLibre `circle` layer (GPU rendered). Labels are
 * generated from GeoJSON feature properties via a `template` function. Only a
 * bounded number of labels are placed on screen using greedy collision
 * avoidance. Only in-viewport features are considered each frame.
 *
 * Usage:
 *   const callouts = new LineCallout3D(map, {
 *     data: portsGeoJSON,
 *     idProperty: 'portid',
 *     priority: (p) => p.vessel_count_total,
 *     template: (p) => `<div>${p.portname}</div>`,
 *   });
 */

const DEFAULTS = {
  sourceId: "lc3d-source",
  markerLayerId: "lc3d-markers",
  idProperty: null,
  template: (props) => `<div style="font-weight:600;">${props.name || props.id || ""}</div>`,
  priority: null,
  offset: [0, -56],
  connectSide: "bottom",
  boxSize: [150, 34],
  padding: 6,
  maxLabels: Infinity,
  maxOffset: 3,
  minZoom: -Infinity,
  maxZoom: Infinity,
  minPitch: 0,
  maxPitch: 85,
  lineColor: "#000000",
  lineWidth: 1.25,
  lineDash: null,
  dotRadius: 3.5,
  dotColor: "#c65b2e",
  markerPaint: {
    "circle-radius": 3,
    "circle-color": "#c65b2e",
    "circle-stroke-width": 1,
    "circle-stroke-color": "#ffffff",
  },
  className: "",
  onClick: null,
  minLineLength: 10,
  maxLineLength: Infinity,
  labelPadding: "7px 12px 7px 16px",
  labelBackground: "#ffffff",
  labelBorder: "1px solid #e2e8f0",
  labelBorderRadius: "8px",
  labelColor: "#16150f",
  labelFont: "13px system-ui, -apple-system, sans-serif",
  labelShadow: "0 2px 8px rgba(0,0,0,0.08)",
  labelAccentColor: null,
  labelPosition: "fixed",
};

function rectsOverlap(a, b, pad) {
  return !(a.x2 + pad < b.x1 || b.x2 + pad < a.x1 || a.y2 + pad < b.y1 || b.y2 + pad < a.y1);
}

function segSegIntersect(a1, a2, b1, b2) {
  const ccw = (a, b, c) => (c.y - a.y) * (b.x - a.x) > (b.y - a.y) * (c.x - a.x);
  return ccw(a1, b1, b2) !== ccw(a2, b1, b2) && ccw(a1, a2, b1) !== ccw(a1, a2, b2);
}

function lineRectIntersect(x1, y1, x2, y2, rect, pad) {
  const l = rect.x1 - pad;
  const r = rect.x2 + pad;
  const t = rect.y1 - pad;
  const b = rect.y2 + pad;
  const a1 = { x: x1, y: y1 };
  const a2 = { x: x2, y: y2 };
  return (
    segSegIntersect(a1, a2, { x: l, y: t }, { x: r, y: t }) ||
    segSegIntersect(a1, a2, { x: r, y: t }, { x: r, y: b }) ||
    segSegIntersect(a1, a2, { x: r, y: b }, { x: l, y: b }) ||
    segSegIntersect(a1, a2, { x: l, y: b }, { x: l, y: t })
  );
}

function resolveColor(option, props) {
  if (typeof option === "function") return option(props);
  return option;
}

function getFeatureAnchor(feature) {
  const g = feature.geometry;
  if (!g) return null;
  if (g.type === "Point") return g.coordinates;
  let coords;
  if (g.type === "MultiPoint" || g.type === "LineString") {
    coords = g.coordinates;
  } else if (g.type === "MultiLineString" || g.type === "Polygon") {
    coords = g.coordinates[0];
  } else if (g.type === "MultiPolygon") {
    coords = g.coordinates[0][0];
  } else {
    return null;
  }
  if (!coords || coords.length === 0) return null;
  let sumLng = 0,
    sumLat = 0;
  for (const c of coords) {
    sumLng += c[0];
    sumLat += c[1];
  }
  return [sumLng / coords.length, sumLat / coords.length];
}

class LineCallout3D {
  constructor(map, options = {}) {
    if (!map) throw new Error("LineCallout3D: a MapLibre GL `map` instance is required");
    this.map = map;
    this.opts = Object.assign({}, DEFAULTS, options);
    this._pool = [];
    this._raf = null;
    this._ready = false;
    this._coloredIds = new Set();

    this._buildOverlay();
    this._onMove = this._onMove.bind(this);
    this._onMoveEnd = this._onMoveEnd.bind(this);

    if (map.isStyleLoaded()) {
      this._setup();
    } else {
      map.once("load", () => this._setup());
    }
  }

  _setup() {
    const { sourceId, markerLayerId } = this.opts;
    if (!this.map.getSource(sourceId)) {
      this.map.addSource(sourceId, {
        type: "geojson",
        data: this.opts.data || { type: "FeatureCollection", features: [] },
      });
    }
    if (!this.map.getLayer(markerLayerId)) {
      this.map.addLayer({
        id: markerLayerId,
        type: "circle",
        source: sourceId,
        paint: this.opts.markerPaint,
      });
    }
    this._ready = true;

    this.map.on("move", this._onMove);
    this.map.on("moveend", this._onMoveEnd);
    this.map.on("rotate", this._onMove);
    this.map.on("pitch", this._onMove);
    this.map.on("resize", this._onMoveEnd);
    this.map.on("data", (e) => {
      if (e.sourceId === sourceId && e.isSourceLoaded) this._scheduleUpdate();
    });

    this._scheduleUpdate();
  }

  _buildOverlay() {
    const container = this.map.getCanvasContainer();

    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "absolute",
      top: "0",
      left: "0",
      width: "100%",
      height: "100%",
      pointerEvents: "none",
      overflow: "visible",
      zIndex: 5,
    });

    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    Object.assign(this.svg.style, {
      position: "absolute",
      top: "0",
      left: "0",
      width: "100%",
      height: "100%",
      overflow: "visible",
    });

    this.labelLayer = document.createElement("div");
    Object.assign(this.labelLayer.style, {
      position: "absolute",
      top: "0",
      left: "0",
      width: "100%",
      height: "100%",
    });

    this.root.appendChild(this.svg);
    this.root.appendChild(this.labelLayer);
    container.appendChild(this.root);
  }

  setData(data) {
    this.opts.data = data;
    if (this._ready) {
      this.map.getSource(this.opts.sourceId).setData(data);
    }
    return this;
  }

  setLabelOptions(patch) {
    Object.assign(this.opts, patch);
    this._scheduleUpdate();
    return this;
  }

  destroy() {
    this.map.off("move", this._onMove);
    this.map.off("moveend", this._onMoveEnd);
    this.map.off("rotate", this._onMove);
    this.map.off("pitch", this._onMove);
    this.map.off("resize", this._onMoveEnd);
    this.map.removeFeatureState({ source: this.opts.sourceId }, "callout_color");
    if (this.map.getLayer(this.opts.markerLayerId)) this.map.removeLayer(this.opts.markerLayerId);
    if (this.map.getSource(this.opts.sourceId)) this.map.removeSource(this.opts.sourceId);
    this.root.remove();
  }

  _onMove() {
    if (this._ready && this._pool.length > 0) {
      this._reposition();
    }
  }

  _onMoveEnd() {
    this._scheduleUpdate();
  }

  _scheduleUpdate() {
    if (this._raf || !this._ready) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this._render();
    });
  }

  _reposition() {
    const opts = this.opts;
    const zoom = this.map.getZoom();
    const pitch = this.map.getPitch();
    if (
      zoom < opts.minZoom ||
      zoom > opts.maxZoom ||
      pitch < opts.minPitch ||
      pitch > opts.maxPitch
    )
      return;

    for (let i = 0; i < this._pool.length; i++) {
      const e = this._pool[i];
      if (!e || e.wrap.style.display === "none" || !e._data) continue;
      const d = e._data;
      const anchor = this.map.project(d.coords);
      const labelCenter = {
        x: anchor.x + d.offset[0] * d.mult,
        y: anchor.y + d.offset[1] * d.mult,
      };
      const connector = this._connectorPoint(
        labelCenter,
        d.boxSize,
        anchor,
        d.connectSide || opts.connectSide,
      );

      e.wrap.style.left = Math.round(labelCenter.x) + "px";
      e.wrap.style.top = Math.round(labelCenter.y) + "px";
      e.line.setAttribute("x1", connector.x);
      e.line.setAttribute("y1", connector.y);
      e.line.setAttribute("x2", anchor.x);
      e.line.setAttribute("y2", anchor.y);
      e.dot.setAttribute("cx", anchor.x);
      e.dot.setAttribute("cy", anchor.y);
    }
  }

  _getPoolEntry(i) {
    if (this._pool[i]) return this._pool[i];

    const wrap = document.createElement("div");
    Object.assign(wrap.style, {
      position: "absolute",
      pointerEvents: "auto",
      transform: "translate(-50%, -50%)",
    });
    wrap.className = `lc3d-label ${this.opts.className || ""}`.trim();
    this.labelLayer.appendChild(wrap);

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    this.svg.appendChild(line);

    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    this.svg.appendChild(dot);

    const entry = { wrap, line, dot };
    this._pool[i] = entry;
    return entry;
  }

  _connectorPoint(labelCenter, boxSize, anchor, side) {
    const hw = boxSize[0] / 2;
    const hh = boxSize[1] / 2;
    let s = side;
    if (s === "auto") {
      const dx = anchor.x - labelCenter.x;
      const dy = anchor.y - labelCenter.y;
      s = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "bottom" : "top";
    }
    switch (s) {
      case "top":
        return { x: labelCenter.x, y: labelCenter.y - hh };
      case "bottom":
        return { x: labelCenter.x, y: labelCenter.y + hh };
      case "left":
        return { x: labelCenter.x - hw, y: labelCenter.y };
      case "right":
        return { x: labelCenter.x + hw, y: labelCenter.y };
      default:
        return labelCenter;
    }
  }

  _getAutoPositions(props) {
    const opts = this.opts;
    const [ox, oy] = resolveColor(opts.offset, props);
    const boxSize = resolveColor(opts.boxSize, props);
    const vDist = Math.abs(oy) || 46;
    const hDist = Math.abs(ox) || boxSize[0] / 2 + 20;
    return [
      { offset: [ox, -vDist], connectSide: "bottom" },
      { offset: [ox, vDist], connectSide: "top" },
      { offset: [-hDist, oy], connectSide: "right" },
      { offset: [hDist, oy], connectSide: "left" },
    ];
  }

  _render() {
    if (!this._ready) return;
    const opts = this.opts;
    const zoom = this.map.getZoom();
    const pitch = this.map.getPitch();
    if (
      zoom < opts.minZoom ||
      zoom > opts.maxZoom ||
      pitch < opts.minPitch ||
      pitch > opts.maxPitch
    ) {
      this._pool.forEach((e) => {
        e.wrap.style.display = "none";
        e.line.style.display = "none";
        e.dot.style.display = "none";
      });
      return;
    }

    const rendered = this.map.queryRenderedFeatures(undefined, { layers: [opts.markerLayerId] });

    const seen = new Set();
    const candidates = [];
    for (let i = 0; i < rendered.length; i++) {
      const f = rendered[i];
      const key = opts.idProperty ? f.properties[opts.idProperty] : f.id != null ? f.id : i;
      if (seen.has(key)) continue;
      seen.add(key);
      const anchorCoords = getFeatureAnchor(f);
      if (!anchorCoords) continue;
      const anchor = this.map.project(anchorCoords);
      const priorityValue = typeof opts.priority === "function" ? opts.priority(f.properties) : 0;
      candidates.push({ feature: f, anchor, priorityValue, anchorCoords });
    }

    candidates.sort((a, b) => b.priorityValue - a.priorityValue);

    if (opts.maxLabels < Infinity) {
      candidates.splice(opts.maxLabels * 3);
    }

    const placed = [];
    let poolIndex = 0;

    const mults = [];
    for (let m = 1; m <= opts.maxOffset; m += 0.5) mults.push(m);

    for (let i = 0; i < candidates.length && placed.length < opts.maxLabels; i++) {
      const c = candidates[i];
      const props = c.feature.properties;
      let placedLabel = null;

      const boxSize = resolveColor(opts.boxSize, props);
      const bw = boxSize[0];
      const bh = boxSize[1];

      const positions =
        opts.labelPosition === "auto"
          ? this._getAutoPositions(props)
          : [{ offset: resolveColor(opts.offset, props), connectSide: opts.connectSide }];

      for (const pos of positions) {
        const offset = pos.offset;
        for (const mult of mults) {
          const labelCenter = {
            x: c.anchor.x + offset[0] * mult,
            y: c.anchor.y + offset[1] * mult,
          };
          const rect = {
            x1: labelCenter.x - bw / 2,
            x2: labelCenter.x + bw / 2,
            y1: labelCenter.y - bh / 2,
            y2: labelCenter.y + bh / 2,
          };
          const connector = this._connectorPoint(labelCenter, boxSize, c.anchor, pos.connectSide);
          const dx = connector.x - c.anchor.x;
          const dy = connector.y - c.anchor.y;
          const lineLen = Math.sqrt(dx * dx + dy * dy);
          if (lineLen < opts.minLineLength || lineLen > opts.maxLineLength) continue;
          const labelCollides = placed.some((p) => rectsOverlap(rect, p.rect, opts.padding));
          const lineHitsLabel = placed.some((p) =>
            lineRectIntersect(
              c.anchor.x,
              c.anchor.y,
              connector.x,
              connector.y,
              p.rect,
              opts.padding,
            ),
          );
          const labelHitsLine = placed.some((p) =>
            lineRectIntersect(
              p.anchor.x,
              p.anchor.y,
              p.connector.x,
              p.connector.y,
              rect,
              opts.padding,
            ),
          );
          if (!labelCollides && !lineHitsLabel && !labelHitsLine) {
            placedLabel = Object.assign({}, c, {
              labelCenter,
              rect,
              connector,
              offset,
              boxSize,
              mult,
              connectSide: pos.connectSide,
            });
            break;
          }
        }
        if (placedLabel) break;
      }

      if (placedLabel) placed.push(placedLabel);
    }

    placed.forEach((p) => {
      const props = p.feature.properties;
      const entry = this._getPoolEntry(poolIndex++);
      entry.wrap.style.display = "";
      entry.line.style.display = "";
      entry.dot.style.display = "";

      entry.wrap.style.left = Math.round(p.labelCenter.x) + "px";
      entry.wrap.style.top = Math.round(p.labelCenter.y) + "px";
      entry.wrap.innerHTML = opts.template(props);
      entry.wrap.style.padding = resolveColor(opts.labelPadding, props);
      entry.wrap.style.background = resolveColor(opts.labelBackground, props);
      entry.wrap.style.border = resolveColor(opts.labelBorder, props);
      entry.wrap.style.borderRadius = resolveColor(opts.labelBorderRadius, props);
      entry.wrap.style.color = resolveColor(opts.labelColor, props);
      entry.wrap.style.font = resolveColor(opts.labelFont, props);
      entry.wrap.style.boxShadow = resolveColor(opts.labelShadow, props);

      const accentColor = resolveColor(opts.labelAccentColor, props);
      entry.wrap.style.borderLeft = accentColor ? `4px solid ${accentColor}` : "";

      const lineColor = resolveColor(opts.lineColor, props);
      const dotColor = resolveColor(opts.dotColor, props);
      const lineWidth = resolveColor(opts.lineWidth, props);
      const lineDash = resolveColor(opts.lineDash, props);
      const dotRadius = resolveColor(opts.dotRadius, props);

      entry.line.setAttribute("x1", p.connector.x);
      entry.line.setAttribute("y1", p.connector.y);
      entry.line.setAttribute("x2", p.anchor.x);
      entry.line.setAttribute("y2", p.anchor.y);
      entry.line.setAttribute("stroke", lineColor);
      entry.line.setAttribute("stroke-width", String(lineWidth));

      if (lineDash) {
        entry.line.setAttribute("stroke-dasharray", lineDash);
      } else {
        entry.line.removeAttribute("stroke-dasharray");
      }
      entry.line.removeAttribute("marker-end");

      entry.dot.setAttribute("cx", p.anchor.x);
      entry.dot.setAttribute("cy", p.anchor.y);
      entry.dot.setAttribute("r", String(dotRadius));
      entry.dot.setAttribute("fill", dotColor);

      entry._data = {
        coords: p.anchorCoords,
        offset: p.offset,
        boxSize: p.boxSize,
        mult: p.mult,
        connectSide: p.connectSide,
      };

      if (opts.onClick) {
        entry.wrap.style.cursor = "pointer";
        entry.wrap.onclick = (e) => opts.onClick(props, p.feature, e);
      } else {
        entry.wrap.style.cursor = "";
        entry.wrap.onclick = null;
      }
    });

    for (let i = poolIndex; i < this._pool.length; i++) {
      this._pool[i].wrap.style.display = "none";
      this._pool[i].line.style.display = "none";
      this._pool[i].dot.style.display = "none";
      this._pool[i]._data = null;
    }

    const sourceId = opts.sourceId;
    const newColored = new Set();
    for (const p of placed) {
      const fid = p.feature.id;
      if (fid != null) {
        const color = resolveColor(opts.lineColor, p.feature.properties);
        this.map.setFeatureState({ source: sourceId, id: fid }, { callout_color: color });
        newColored.add(fid);
      }
    }
    for (const fid of this._coloredIds) {
      if (!newColored.has(fid)) {
        this.map.removeFeatureState({ source: sourceId, id: fid }, "callout_color");
      }
    }
    this._coloredIds = newColored;
  }
}

if (typeof maplibregl !== "undefined") {
  maplibregl.LineCallout3D = LineCallout3D;
}

export { LineCallout3D as default };
