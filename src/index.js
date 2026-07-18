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
  maxLineLength: 50,
  labelPadding: "7px 12px 7px 16px",
  labelBackground: "#ffffff",
  labelBorder: "1px solid #e2e8f0",
  labelBorderRadius: "8px",
  labelColor: "#16150f",
  labelFont: "13px system-ui, -apple-system, sans-serif",
  labelShadow: "0 2px 8px rgba(0,0,0,0.08)",
  labelAccentColor: null,
  labelPosition: "fixed", // "fixed" | "auto" | "onlyTop" | "onlyBottom" | "onlyLeft" | "onlyRight" | "onlyVertical" | "onlyHorizontal"
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
    this._savedMaxPitch = null;
    this._lastIsGlobe = false;

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
    this._savedMaxPitch = this.map.getMaxPitch();

    this.map.on("move", this._onMove);
    this.map.on("moveend", this._onMoveEnd);
    this.map.on("rotate", this._onMove);
    this.map.on("pitch", this._onMove);
    this.map.on("pitch", this._onMoveEnd);
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
    this.map.off("pitch", this._onMoveEnd);
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
    ) {
      this._pool.forEach((e) => {
        if (!e) return;
        e.wrap.style.display = "none";
        e.line.style.display = "none";
        e.dot.style.display = "none";
      });
      return;
    }

    const w = this.map.getContainer().clientWidth;
    const h = this.map.getContainer().clientHeight;
    const margin = 200;

    const proj = this.map.getProjection();
    const isGlobe = proj && proj.type === "globe";
    if (isGlobe !== this._lastIsGlobe) {
      if (isGlobe) {
        this._savedMaxPitch = this.map.getMaxPitch();
        this.map.setMaxPitch(0);
      } else {
        this.map.setMaxPitch(this._savedMaxPitch);
      }
      this._lastIsGlobe = isGlobe;
    }
    let globeCamDir = null;
    if (isGlobe) {
      let camLatRad = null;
      let camLngRad = null;
      try {
        const camPos = this.map.transform.getCameraPosition();
        if (camPos) {
          camLngRad = ((camPos.x * 360 - 180) * Math.PI) / 180;
          camLatRad = 2 * Math.atan(Math.exp(Math.PI - 2 * Math.PI * camPos.y)) - Math.PI / 2;
        }
      } catch (e) {
        // fallback below
      }
      if (camLatRad == null) {
        const center = this.map.getCenter();
        if (center) {
          camLatRad = (center.lat * Math.PI) / 180;
          camLngRad = (center.lng * Math.PI) / 180;
        }
      }
      if (camLatRad != null) {
        globeCamDir = [
          Math.cos(camLatRad) * Math.cos(camLngRad),
          Math.sin(camLatRad),
          Math.cos(camLatRad) * Math.sin(camLngRad),
        ];
      }
    }

    for (let i = 0; i < this._pool.length; i++) {
      const e = this._pool[i];
      if (!e || !e._data) continue;
      const d = e._data;
      const anchor = this.map.project(d.coords);

      if (globeCamDir) {
        const toRad = Math.PI / 180;
        const plat = d.coords[1] * toRad;
        const plng = d.coords[0] * toRad;
        const px = Math.cos(plat) * Math.cos(plng);
        const py = Math.sin(plat);
        const pz = Math.cos(plat) * Math.sin(plng);
        const dot = globeCamDir[0] * px + globeCamDir[1] * py + globeCamDir[2] * pz;
        if (dot <= 0.1) {
          e.wrap.style.display = "none";
          e.line.style.display = "none";
          e.dot.style.display = "none";
          continue;
        }
      }

      const labelCenter = {
        x: anchor.x + d.offset[0] * d.mult,
        y: anchor.y + d.offset[1] * d.mult,
      };
      const bw = d.boxSize[0];
      const bh = d.boxSize[1];
      const rect = {
        x1: labelCenter.x - bw / 2,
        x2: labelCenter.x + bw / 2,
        y1: labelCenter.y - bh / 2,
        y2: labelCenter.y + bh / 2,
      };
      const conn = this._connectorPoint(
        labelCenter,
        d.boxSize,
        anchor,
        d.connectSide || opts.connectSide,
      );
      const dotRad = d.dotRadius || 4;
      const dotRect = {
        x1: anchor.x - dotRad,
        x2: anchor.x + dotRad,
        y1: anchor.y - dotRad,
        y2: anchor.y + dotRad,
      };

      const inside =
        rect.x2 >= -margin &&
        rect.x1 <= w + margin &&
        rect.y2 >= -margin &&
        rect.y1 <= h + margin &&
        conn.x >= -margin &&
        conn.x <= w + margin &&
        conn.y >= -margin &&
        conn.y <= h + margin &&
        dotRect.x2 >= -margin &&
        dotRect.x1 <= w + margin &&
        dotRect.y2 >= -margin &&
        dotRect.y1 <= h + margin;

      if (!inside) {
        e.wrap.style.display = "none";
        e.line.style.display = "none";
        e.dot.style.display = "none";
        continue;
      }

      e.wrap.style.display = "";
      e.line.style.display = "";
      e.dot.style.display = "";
      e.wrap.style.left = Math.round(labelCenter.x) + "px";
      e.wrap.style.top = Math.round(labelCenter.y) + "px";
      e.line.setAttribute("x1", conn.x);
      e.line.setAttribute("y1", conn.y);
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

  _getPositions(props) {
    const opts = this.opts;
    const mode = opts.labelPosition;
    if (mode === "fixed") {
      return [{ offset: resolveColor(opts.offset, props), connectSide: opts.connectSide }];
    }
    const [ox, oy] = resolveColor(opts.offset, props);
    const boxSize = resolveColor(opts.boxSize, props);
    const vDist = Math.abs(oy) || 46;
    const hDist = Math.abs(ox) || boxSize[0] / 2 + 20;
    const top = { offset: [0, -vDist], connectSide: "bottom" };
    const bottom = { offset: [0, vDist], connectSide: "top" };
    const left = { offset: [-hDist, 0], connectSide: "right" };
    const right = { offset: [hDist, 0], connectSide: "left" };
    switch (mode) {
      case "onlyTop":
        return [top];
      case "onlyBottom":
        return [bottom];
      case "onlyLeft":
        return [left];
      case "onlyRight":
        return [right];
      case "onlyVertical":
        return [top, bottom];
      case "onlyHorizontal":
        return [left, right];
      default:
        return [top, bottom, left, right];
    }
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

    const proj = this.map.getProjection();
    const isGlobe = proj && proj.type === "globe";
    if (isGlobe !== this._lastIsGlobe) {
      if (isGlobe) {
        this._savedMaxPitch = this.map.getMaxPitch();
        this.map.setMaxPitch(0);
      } else {
        this.map.setMaxPitch(this._savedMaxPitch);
      }
      this._lastIsGlobe = isGlobe;
    }
    let globeCamDir = null;
    if (isGlobe) {
      let camLatRad = null;
      let camLngRad = null;
      try {
        const camPos = this.map.transform.getCameraPosition();
        if (camPos) {
          camLngRad = ((camPos.x * 360 - 180) * Math.PI) / 180;
          camLatRad = 2 * Math.atan(Math.exp(Math.PI - 2 * Math.PI * camPos.y)) - Math.PI / 2;
        }
      } catch (e) {}
      if (camLatRad == null) {
        const center = this.map.getCenter();
        if (center) {
          camLatRad = (center.lat * Math.PI) / 180;
          camLngRad = (center.lng * Math.PI) / 180;
        }
      }
      if (camLatRad != null) {
        globeCamDir = [
          Math.cos(camLatRad) * Math.cos(camLngRad),
          Math.sin(camLatRad),
          Math.cos(camLatRad) * Math.sin(camLngRad),
        ];
      }
    }

    const features = (() => {
      if (!globeCamDir)
        return this.map.queryRenderedFeatures(undefined, { layers: [opts.markerLayerId] });
      const qrf = this.map.queryRenderedFeatures(undefined, { layers: [opts.markerLayerId] });
      return qrf.length > 0 ? qrf : opts.data ? opts.data.features : [];
    })();
    const candidates = [];
    const seen = new Set();
    const w = this.map.getContainer().clientWidth;
    const h = this.map.getContainer().clientHeight;
    const margin = 200;

    for (let i = 0; i < features.length; i++) {
      const f = features[i];
      const key = opts.idProperty ? f.properties[opts.idProperty] : f.id != null ? f.id : i;
      if (seen.has(key)) continue;
      seen.add(key);
      const anchorCoords = getFeatureAnchor(f);
      if (!anchorCoords) continue;

      if (globeCamDir) {
        const toRad = Math.PI / 180;
        const plat = anchorCoords[1] * toRad;
        const plng = anchorCoords[0] * toRad;
        const px = Math.cos(plat) * Math.cos(plng);
        const py = Math.sin(plat);
        const pz = Math.cos(plat) * Math.sin(plng);
        const dot = globeCamDir[0] * px + globeCamDir[1] * py + globeCamDir[2] * pz;
        if (dot <= 0.1) continue;
        const anchor = this.map.project(anchorCoords);
        if (
          anchor.x < -margin ||
          anchor.x > w + margin ||
          anchor.y < -margin ||
          anchor.y > h + margin
        )
          continue;
        const priorityValue = typeof opts.priority === "function" ? opts.priority(f.properties) : 0;
        candidates.push({
          feature: f,
          anchor,
          priorityValue,
          anchorCoords,
          globeAngle: (Math.acos(Math.min(1, dot)) * 180) / Math.PI,
        });
      } else {
        const anchor = this.map.project(anchorCoords);
        if (
          anchor.x < -margin ||
          anchor.x > w + margin ||
          anchor.y < -margin ||
          anchor.y > h + margin
        )
          continue;
        const priorityValue = typeof opts.priority === "function" ? opts.priority(f.properties) : 0;
        candidates.push({ feature: f, anchor, priorityValue, anchorCoords });
      }
    }

    // Spatial ordering: Z-order (Morton) over projected anchor coordinates
    // This replaces the latitude sort to avoid geographic bias — nearby screen
    // points are still nearby in Z-order, but no orientation dominates early placement.
    const cellSize = opts.boxSize
      ? Math.max(opts.boxSize[0], opts.boxSize[1]) + opts.padding * 2
      : 162;
    const originX = -margin;
    const originY = -margin;

    function spreadBits(v) {
      v = (v | (v << 8)) & 0x00ff00ff;
      v = (v | (v << 4)) & 0x0f0f0f0f;
      v = (v | (v << 2)) & 0x33333333;
      v = (v | (v << 1)) & 0x55555555;
      return v;
    }

    for (const c of candidates) {
      const cx = Math.max(0, Math.floor((c.anchor.x - originX) / cellSize));
      const cy = Math.max(0, Math.floor((c.anchor.y - originY) / cellSize));
      c._z = spreadBits(cx) | (spreadBits(cy) << 1);
    }
    candidates.sort((a, b) => a._z - b._z);

    // Spatial hash grid — stores occupied labels in fixed-size cells (~label box size).
    // Query returns only labels in cells that a candidate's rect/dot/connector touches,
    // avoiding O(n) scan of all placed labels.
    const gridCells = new Map();

    function gridKey(col, row) {
      return col + "," + row;
    }

    function gridCellsForRect(x1, y1, x2, y2) {
      const minCol = Math.floor((x1 - opts.padding) / cellSize);
      const maxCol = Math.floor((x2 + opts.padding) / cellSize);
      const minRow = Math.floor((y1 - opts.padding) / cellSize);
      const maxRow = Math.floor((y2 + opts.padding) / cellSize);
      const keys = [];
      for (let c = minCol; c <= maxCol; c++)
        for (let r = minRow; r <= maxRow; r++) keys.push(gridKey(c, r));
      return keys;
    }

    function gridInsert(pl) {
      function add(keys) {
        for (const key of keys) {
          let cell = gridCells.get(key);
          if (!cell) {
            cell = new Set();
            gridCells.set(key, cell);
          }
          cell.add(pl);
        }
      }
      add(gridCellsForRect(pl.rect.x1, pl.rect.y1, pl.rect.x2, pl.rect.y2));
      if (pl.dotRect)
        add(gridCellsForRect(pl.dotRect.x1, pl.dotRect.y1, pl.dotRect.x2, pl.dotRect.y2));
      if (pl.anchor && pl.connector)
        add(
          gridCellsForRect(
            Math.min(pl.anchor.x, pl.connector.x),
            Math.min(pl.anchor.y, pl.connector.y),
            Math.max(pl.anchor.x, pl.connector.x),
            Math.max(pl.anchor.y, pl.connector.y),
          ),
        );
    }

    function gridQuery(rect, dotRect, anchor, connector) {
      const seen = new Set();
      const result = [];
      function add(keys) {
        for (const key of keys) {
          const cell = gridCells.get(key);
          if (cell)
            for (const pl of cell)
              if (!seen.has(pl)) {
                seen.add(pl);
                result.push(pl);
              }
        }
      }
      add(gridCellsForRect(rect.x1, rect.y1, rect.x2, rect.y2));
      if (dotRect) add(gridCellsForRect(dotRect.x1, dotRect.y1, dotRect.x2, dotRect.y2));
      if (anchor && connector)
        add(
          gridCellsForRect(
            Math.min(anchor.x, connector.x),
            Math.min(anchor.y, connector.y),
            Math.max(anchor.x, connector.x),
            Math.max(anchor.y, connector.y),
          ),
        );
      return result;
    }

    function gridRemove(pl) {
      function remove(keys) {
        for (const key of keys) {
          const cell = gridCells.get(key);
          if (cell) {
            cell.delete(pl);
            if (cell.size === 0) gridCells.delete(key);
          }
        }
      }
      remove(gridCellsForRect(pl.rect.x1, pl.rect.y1, pl.rect.x2, pl.rect.y2));
      if (pl.dotRect)
        remove(gridCellsForRect(pl.dotRect.x1, pl.dotRect.y1, pl.dotRect.x2, pl.dotRect.y2));
      if (pl.anchor && pl.connector)
        remove(
          gridCellsForRect(
            Math.min(pl.anchor.x, pl.connector.x),
            Math.min(pl.anchor.y, pl.connector.y),
            Math.max(pl.anchor.x, pl.connector.x),
            Math.max(pl.anchor.y, pl.connector.y),
          ),
        );
    }

    // Exact collision check between two placed-label objects (same 8 tests as original)
    function collidesWith(a, b) {
      if (rectsOverlap(a.rect, b.rect, opts.padding)) return true;
      if (
        lineRectIntersect(
          a.anchor.x,
          a.anchor.y,
          a.connector.x,
          a.connector.y,
          b.rect,
          opts.padding,
        )
      )
        return true;
      if (
        lineRectIntersect(
          b.anchor.x,
          b.anchor.y,
          b.connector.x,
          b.connector.y,
          a.rect,
          opts.padding,
        )
      )
        return true;
      if (rectsOverlap(a.rect, b.dotRect, opts.padding)) return true;
      if (rectsOverlap(a.dotRect, b.rect, opts.padding)) return true;
      if (
        lineRectIntersect(
          a.anchor.x,
          a.anchor.y,
          a.connector.x,
          a.connector.y,
          b.dotRect,
          opts.padding,
        )
      )
        return true;
      if (
        lineRectIntersect(
          b.anchor.x,
          b.anchor.y,
          b.connector.x,
          b.connector.y,
          a.dotRect,
          opts.padding,
        )
      )
        return true;
      if (segSegIntersect(a.anchor, a.connector, b.anchor, b.connector)) return true;
      return false;
    }

    const placed = [];
    let poolIndex = 0;
    const mults = [];
    for (let m = 1; m <= opts.maxOffset; m += 0.5) mults.push(m);
    const evictedOnce = new Set();

    // Main placement pass: process candidates in Z-order, with priority-based eviction.
    // When a candidate collides and its priority exceeds all colliding labels,
    // those labels are removed (grid + placed) and the candidate takes their place.
    // Evicted labels get one retry attempt after the pass.
    for (let ci = 0; ci < candidates.length; ci++) {
      const c = candidates[ci];
      const props = c.feature.properties;
      const boxSize = resolveColor(opts.boxSize, props);
      const bw = boxSize[0];
      const bh = boxSize[1];
      const positions = this._getPositions(props);

      let bestPlacedLabel = null;

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
          const connector = this._connectorPoint(
            labelCenter,
            boxSize,
            c.anchor,
            pos.connectSide || opts.connectSide,
          );
          const dx = connector.x - c.anchor.x;
          const dy = connector.y - c.anchor.y;
          if (
            Math.sqrt(dx * dx + dy * dy) < opts.minLineLength ||
            Math.sqrt(dx * dx + dy * dy) > opts.maxLineLength
          )
            continue;
          const dotRad = resolveColor(opts.dotRadius, props) || 4;
          const dotRect = {
            x1: c.anchor.x - dotRad,
            x2: c.anchor.x + dotRad,
            y1: c.anchor.y - dotRad,
            y2: c.anchor.y + dotRad,
          };

          if (rect.x2 < 0 || rect.x1 > w || rect.y2 < 0 || rect.y1 > h) continue;
          if (connector.x < 0 || connector.x > w || connector.y < 0 || connector.y > h) continue;
          if (dotRect.x2 < 0 || dotRect.x1 > w || dotRect.y2 < 0 || dotRect.y1 > h) continue;

          const neighbors = gridQuery(rect, dotRect, c.anchor, connector);
          const colliders = [];
          const candidatePl = { rect, dotRect, anchor: c.anchor, connector };
          for (const pl of neighbors) {
            if (collidesWith(candidatePl, pl)) colliders.push(pl);
          }

          if (colliders.length === 0) {
            if (placed.length < opts.maxLabels) {
              bestPlacedLabel = Object.assign({}, c, {
                labelCenter,
                rect,
                connector,
                offset,
                boxSize,
                mult,
                connectSide: pos.connectSide,
                dotRect,
              });
            }
            break;
          } else {
            const priority = typeof opts.priority === "function" ? opts.priority(props) : 0;
            const canEvict = colliders.every((p) => priority > p.priorityValue);
            if (canEvict) {
              for (const p of colliders) {
                gridRemove(p);
                const idx = placed.indexOf(p);
                if (idx !== -1) {
                  placed.splice(idx, 1);
                  if (!evictedOnce.has(p.feature)) evictedOnce.add(p.feature);
                }
              }
              bestPlacedLabel = Object.assign({}, c, {
                labelCenter,
                rect,
                connector,
                offset,
                boxSize,
                mult,
                connectSide: pos.connectSide,
                dotRect,
              });
              break;
            }
          }
        }
        if (bestPlacedLabel) break;
      }

      if (bestPlacedLabel) {
        placed.push(bestPlacedLabel);
        gridInsert(bestPlacedLabel);
      }
    }

    // Retry evicted labels (one pass, no further eviction, depth limit 1)
    if (evictedOnce.size > 0) {
      const toRetry = candidates.filter((c) => evictedOnce.has(c.feature));
      for (const c of toRetry) {
        if (placed.length >= opts.maxLabels) break;
        const props = c.feature.properties;
        const boxSize = resolveColor(opts.boxSize, props);
        const bw = boxSize[0];
        const bh = boxSize[1];
        const positions = this._getPositions(props);

        let placedLabel = null;
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
            const connector = this._connectorPoint(
              labelCenter,
              boxSize,
              c.anchor,
              pos.connectSide || opts.connectSide,
            );
            const dx = connector.x - c.anchor.x;
            const dy = connector.y - c.anchor.y;
            if (
              Math.sqrt(dx * dx + dy * dy) < opts.minLineLength ||
              Math.sqrt(dx * dx + dy * dy) > opts.maxLineLength
            )
              continue;
            const dotRad = resolveColor(opts.dotRadius, props) || 4;
            const dotRect = {
              x1: c.anchor.x - dotRad,
              x2: c.anchor.x + dotRad,
              y1: c.anchor.y - dotRad,
              y2: c.anchor.y + dotRad,
            };

            if (rect.x2 < 0 || rect.x1 > w || rect.y2 < 0 || rect.y1 > h) continue;
            if (connector.x < 0 || connector.x > w || connector.y < 0 || connector.y > h) continue;
            if (dotRect.x2 < 0 || dotRect.x1 > w || dotRect.y2 < 0 || dotRect.y1 > h) continue;

            const neighbors = gridQuery(rect, dotRect, c.anchor, connector);
            const candidatePl = { rect, dotRect, anchor: c.anchor, connector };
            let collides = false;
            for (const pl of neighbors) {
              if (collidesWith(candidatePl, pl)) {
                collides = true;
                break;
              }
            }
            if (!collides) {
              placedLabel = Object.assign({}, c, {
                labelCenter,
                rect,
                connector,
                offset,
                boxSize,
                mult,
                connectSide: pos.connectSide,
                dotRect,
              });
              break;
            }
          }
          if (placedLabel) break;
        }
        if (placedLabel) {
          placed.push(placedLabel);
          gridInsert(placedLabel);
        }
      }
    }

    // Place DOM for all placed labels
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
      if (lineDash) entry.line.setAttribute("stroke-dasharray", lineDash);
      else entry.line.removeAttribute("stroke-dasharray");
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
        globeAngle: p.globeAngle != null ? p.globeAngle : null,
        dotRadius,
      };
      if (opts.onClick) {
        entry.wrap.style.cursor = "pointer";
        entry.wrap.onclick = (e) => opts.onClick(props, p.feature, e);
      } else {
        entry.wrap.style.cursor = "";
        entry.wrap.onclick = null;
      }
    });

    // Second pass — re-check collision with actual box sizes (offsetWidth/height)
    const survivors = [];
    const survivedIds = new Set();
    const survivedColor = {};
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i];
      const entry = this._getPoolEntry(i);
      const rw = entry.wrap.offsetWidth;
      const rh = entry.wrap.offsetHeight;
      const bw = rw > 0 ? rw : p.boxSize[0];
      const bh = rh > 0 ? rh : p.boxSize[1];
      const rect = {
        x1: p.labelCenter.x - bw / 2,
        x2: p.labelCenter.x + bw / 2,
        y1: p.labelCenter.y - bh / 2,
        y2: p.labelCenter.y + bh / 2,
      };
      const props = p.feature.properties;
      const dotRad = resolveColor(opts.dotRadius, props) || 4;
      const dotRect = {
        x1: p.anchor.x - dotRad,
        x2: p.anchor.x + dotRad,
        y1: p.anchor.y - dotRad,
        y2: p.anchor.y + dotRad,
      };
      const realBoxSize = [bw, bh];
      const conn = this._connectorPoint(
        p.labelCenter,
        realBoxSize,
        p.anchor,
        p.connectSide || opts.connectSide,
      );
      const collides = survivors.some((a) => {
        if (rectsOverlap(rect, a.rect, opts.padding)) return true;
        if (lineRectIntersect(p.anchor.x, p.anchor.y, conn.x, conn.y, a.rect, opts.padding))
          return true;
        if (
          lineRectIntersect(
            a.anchor.x,
            a.anchor.y,
            a.connector.x,
            a.connector.y,
            rect,
            opts.padding,
          )
        )
          return true;
        if (rectsOverlap(rect, a.dotRect, opts.padding)) return true;
        if (rectsOverlap(dotRect, a.rect, opts.padding)) return true;
        if (lineRectIntersect(p.anchor.x, p.anchor.y, conn.x, conn.y, a.dotRect, opts.padding))
          return true;
        if (
          lineRectIntersect(
            a.anchor.x,
            a.anchor.y,
            a.connector.x,
            a.connector.y,
            dotRect,
            opts.padding,
          )
        )
          return true;
        if (segSegIntersect(p.anchor, conn, a.anchor, a.connector)) return true;
        return false;
      });
      if (collides) {
        entry.wrap.style.display = "none";
        entry.line.style.display = "none";
        entry.dot.style.display = "none";
        entry._data = null;
      } else {
        entry.line.setAttribute("x1", conn.x);
        entry.line.setAttribute("y1", conn.y);
        entry._data.boxSize = realBoxSize;
        survivors.push({ rect, dotRect, anchor: p.anchor, connector: conn });
        const fid = opts.idProperty ? p.feature.properties[opts.idProperty] : p.feature.id;
        if (fid != null) {
          survivedIds.add(fid);
          survivedColor[fid] = resolveColor(opts.lineColor, props);
        }
      }
    }

    // Phase 3: Backfill — exhaustive fill, no eviction.
    // Collect all candidates whose feature is not yet placed.
    // Includes: never placed, evicted without successful retry, rejected by 2nd pass.
    const unplaced = [];
    for (const c of candidates) {
      const fid = c.feature.id;
      if (fid != null && survivedIds.has(fid)) continue;
      unplaced.push(c);
    }
    unplaced.sort((a, b) => {
      const pa = typeof opts.priority === "function" ? opts.priority(a.feature.properties) : 0;
      const pb = typeof opts.priority === "function" ? opts.priority(b.feature.properties) : 0;
      return pb - pa;
    });

    const backfillPlaced = new Set();
    for (let round = 0; round < 3; round++) {
      if (survivors.length >= opts.maxLabels || unplaced.length === 0) break;
      let placedInRound = 0;
      for (const c of unplaced) {
        if (backfillPlaced.has(c)) continue;
        if (survivors.length >= opts.maxLabels) break;
        const props = c.feature.properties;
        const boxSize = resolveColor(opts.boxSize, props);
        const bw = boxSize[0];
        const bh = boxSize[1];
        const positions = this._getPositions(props);

        let placed = false;
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
            const connector = this._connectorPoint(
              labelCenter,
              boxSize,
              c.anchor,
              pos.connectSide || opts.connectSide,
            );
            const dx = connector.x - c.anchor.x;
            const dy = connector.y - c.anchor.y;
            if (
              Math.sqrt(dx * dx + dy * dy) < opts.minLineLength ||
              Math.sqrt(dx * dx + dy * dy) > opts.maxLineLength
            )
              continue;
            const dotRad = resolveColor(opts.dotRadius, props) || 4;
            const dotRect = {
              x1: c.anchor.x - dotRad,
              x2: c.anchor.x + dotRad,
              y1: c.anchor.y - dotRad,
              y2: c.anchor.y + dotRad,
            };

            if (rect.x2 < 0 || rect.x1 > w || rect.y2 < 0 || rect.y1 > h) continue;
            if (connector.x < 0 || connector.x > w || connector.y < 0 || connector.y > h) continue;
            if (dotRect.x2 < 0 || dotRect.x1 > w || dotRect.y2 < 0 || dotRect.y1 > h) continue;

            // Estimated-size collision against survivors (2nd pass + earlier backfill)
            const candidatePl = { rect, dotRect, anchor: c.anchor, connector };
            let collides = false;
            for (const s of survivors) {
              if (collidesWith(candidatePl, s)) {
                collides = true;
                break;
              }
            }
            if (collides) continue;

            // Estimated fit found — create DOM entry and measure real size immediately.
            // Real size can differ from estimate, so we re-check before confirming.
            const entry = this._getPoolEntry(poolIndex++);
            entry.wrap.style.display = "";
            entry.line.style.display = "";
            entry.dot.style.display = "";
            entry.wrap.style.left = Math.round(labelCenter.x) + "px";
            entry.wrap.style.top = Math.round(labelCenter.y) + "px";
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

            const rw = entry.wrap.offsetWidth;
            const rh = entry.wrap.offsetHeight;
            const realBw = rw > 0 ? rw : bw;
            const realBh = rh > 0 ? rh : bh;
            const realBoxSize = [realBw, realBh];
            const realRect = {
              x1: labelCenter.x - realBw / 2,
              x2: labelCenter.x + realBw / 2,
              y1: labelCenter.y - realBh / 2,
              y2: labelCenter.y + realBh / 2,
            };
            const realConn = this._connectorPoint(
              labelCenter,
              realBoxSize,
              c.anchor,
              pos.connectSide || opts.connectSide,
            );

            const realPl = { rect: realRect, dotRect, anchor: c.anchor, connector: realConn };
            let realCollides = false;
            for (const s of survivors) {
              if (collidesWith(realPl, s)) {
                realCollides = true;
                break;
              }
            }

            if (realCollides) {
              entry.wrap.style.display = "none";
              entry.line.style.display = "none";
              entry.dot.style.display = "none";
              entry._data = null;
              continue; // try next mult/pos for this candidate
            }

            // Confirm — real size fits
            const lineColor = resolveColor(opts.lineColor, props);
            const dotColor = resolveColor(opts.dotColor, props);
            const lineWidth = resolveColor(opts.lineWidth, props);
            const lineDash = resolveColor(opts.lineDash, props);
            const dotRadius = resolveColor(opts.dotRadius, props);
            entry.line.setAttribute("x1", realConn.x);
            entry.line.setAttribute("y1", realConn.y);
            entry.line.setAttribute("x2", c.anchor.x);
            entry.line.setAttribute("y2", c.anchor.y);
            entry.line.setAttribute("stroke", lineColor);
            entry.line.setAttribute("stroke-width", String(lineWidth));
            if (lineDash) entry.line.setAttribute("stroke-dasharray", lineDash);
            else entry.line.removeAttribute("stroke-dasharray");
            entry.line.removeAttribute("marker-end");
            entry.dot.setAttribute("cx", c.anchor.x);
            entry.dot.setAttribute("cy", c.anchor.y);
            entry.dot.setAttribute("r", String(dotRadius));
            entry.dot.setAttribute("fill", dotColor);
            entry._data = {
              coords: c.anchorCoords,
              offset,
              boxSize: realBoxSize,
              mult,
              connectSide: pos.connectSide,
              globeAngle: c.globeAngle != null ? c.globeAngle : null,
              dotRadius,
            };
            if (opts.onClick) {
              entry.wrap.style.cursor = "pointer";
              entry.wrap.onclick = (e) => opts.onClick(props, c.feature, e);
            } else {
              entry.wrap.style.cursor = "";
              entry.wrap.onclick = null;
            }

            survivors.push({ rect: realRect, dotRect, anchor: c.anchor, connector: realConn });
            const fid = opts.idProperty ? c.feature.properties[opts.idProperty] : c.feature.id;
            if (fid != null) {
              survivedIds.add(fid);
              survivedColor[fid] = resolveColor(opts.lineColor, props);
            }
            backfillPlaced.add(c);
            placedInRound++;
            placed = true;
            break;
          }
          if (placed) break;
        }
      }
      if (placedInRound === 0) break;
    }

    for (let i = poolIndex; i < this._pool.length; i++) {
      this._pool[i].wrap.style.display = "none";
      this._pool[i].line.style.display = "none";
      this._pool[i].dot.style.display = "none";
      this._pool[i]._data = null;
    }

    if (this.map.getSource(opts.sourceId)) {
      for (const fid of survivedIds) {
        this.map.setFeatureState(
          { source: opts.sourceId, id: fid },
          { callout_color: survivedColor[fid] },
        );
      }
      for (const fid of this._coloredIds) {
        if (!survivedIds.has(fid))
          this.map.removeFeatureState({ source: opts.sourceId, id: fid }, "callout_color");
      }
    }
    this._coloredIds = survivedIds;
  }
}

if (typeof maplibregl !== "undefined") {
  maplibregl.LineCallout3D = LineCallout3D;
}

export default LineCallout3D;
