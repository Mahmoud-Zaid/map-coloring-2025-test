/*
Composable Map Coloring - Single-file React component (TypeScript)

What this file is:
- A single React component (default export) that implements a composable, multi-layer map coloring webapp.
- Uses SVG + D3-geo + topojson-client to render vectored layers from GeoJSON/TopoJSON.
- Supports multiple independent layers (political countries, administrative subdivisions, topographical zones, linguistic regions).
- Click to select a feature and paint a color for that layer. Features keep their layer color independent and the map composes them by SVG draw order.
- Exports final composed image as PNG (serializes SVG into canvas then to PNG).

How to use / run
1. Create a React project (Vite or CRA). Install:
   - react, react-dom
   - d3-geo
   - topojson-client
   - @types/topojson-client (optional for TS)
   - file-saver (optional)
   - tinycolor2 (optional color helper)

   Example: npm i d3-geo topojson-client tinycolor2 file-saver

2. Add Tailwind if you want the same styling, or remove the Tailwind classes.
3. Place this file as `ComposableMap.tsx` and import into App.
4. The component fetches a default world TopoJSON from unpkg (world-atlas). You can replace with your own layer GeoJSON/TopoJSON endpoints.

Notes about composability
- Each *layer* is an independent GeoJSON collection with its own feature ids, color map, and z-order. The UI exposes layer stacking and visibility.
- Clicking a rendered path will paint only that layer's feature color state, preserving other layers.
- You can supply overlapping layers: the SVG order determines which visuals appear on top. To produce blend-like results you can change opacity on layers or use SVG mix-blend-mode in CSS.

Limitations & extensions
- This single-file focuses on vector (GeoJSON). For raster topography (DEM) or continuous elevation bands you'd need to precompute vectorized contours (e.g., GMT/GDAL) or use an elevation tiling service.
- Administrative subdivisions (states/provinces) require a separate GeoJSON data source (e.g., Natural Earth, GADM, OpenStreetMap extracts).
- Linguistic / custom areas: you can upload your own GeoJSON files using the UI.

*/

import React, { useEffect, useRef, useState } from "react";
import { geoPath, geoNaturalEarth1 } from "d3-geo";
import { feature as topoFeature } from "topojson-client";
// tinycolor is optional; if unavailable you can use simple hex strings
import tinycolor from "tinycolor2";
import type * as GeoJSON from "geojson";

// -------------------------- Types --------------------------
type LayerId = string;

type LayerConfig = {
  id: LayerId;
  name: string;
  visible: boolean;
  opacity: number; // 0..1
  zIndex: number;
  geojson: GeoJSON.FeatureCollection | null;
  colorMap: Record<string, string>; // featureId -> color
  defaultColor: string;
};

// ------------------------ Helpers --------------------------
function uid() {
  return Math.random().toString(36).slice(2, 9);
}
function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------------------- Default Data -----------------------
const WORLD_TOPOJSON_URL =
  "https://unpkg.com/world-atlas@2.0.2/countries-110m.json";
// That topojson contains objects: countries, land, etc. We'll extract countries.

// ---------------------- Main Component ---------------------
export default function ComposableMap() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [width, setWidth] = useState<number>(1000);
  const [height, setHeight] = useState<number>(600);
  const [projection, setProjection] = useState<GeoJSON | null>(null);
  const [layers, setLayers] = useState<LayerConfig[]>([]);
  const [activeLayerId, setActiveLayerId] = useState<LayerId | null>(null);
  const [pickedColor, setPickedColor] = useState<string>("#ffcc00");

  // load initial world countries as base political layer
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(WORLD_TOPOJSON_URL);
        const topo = await res.json();
        // world-atlas v2 topologies: objects.countries
        const countries = topoFeature(topo, topo.objects.countries) as any; // GeoJSON

        const baseLayer: LayerConfig = {
          id: "countries",
          name: "Countries (political)",
          visible: true,
          opacity: 1,
          zIndex: 0,
          geojson: countries,
          colorMap: {},
          defaultColor: "#eeeeee",
        };

        // Setup projection to fit the world
        const proj = geoNaturalEarth1().fitSize(
          [width, height],
          countries as any
        );

        setProjection(() => proj);
        setLayers([baseLayer]);
        setActiveLayerId(baseLayer.id);
      } catch (e) {
        console.error("Failed to fetch world topojson", e);
      }
    })();
  }, []);

  // resize handler simple (not responsive complex)
  useEffect(() => {
    const onResize = () => {
      const w = Math.min(window.innerWidth - 80, 1200);
      const h = Math.round((w * 9) / 16);
      setWidth(w);
      setHeight(h);
      // recompute projection fit for each change
      if (layers.length > 0 && layers[0].geojson && projection) {
        projection.fitSize([w, h], layers[0].geojson as any);
        // re-trigger render
        setProjection(() => projection);
      }
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [layers, projection]);

  // --------------------- Layer actions ---------------------
  function addLayerFromGeoJSON(
    geojson: GeoJSON.FeatureCollection,
    name?: string
  ) {
    const id = uid();
    const layer: LayerConfig = {
      id,
      name: name ?? `Layer ${layers.length}`,
      visible: true,
      opacity: 1,
      zIndex: layers.length,
      geojson,
      colorMap: {},
      defaultColor: "#ffffff00",
    };
    setLayers((prev) => [...prev, layer]);
    setActiveLayerId(id);
  }

  function toggleLayerVisibility(id: LayerId) {
    setLayers((prev) =>
      prev.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l))
    );
  }

  function setLayerOpacity(id: LayerId, opacity: number) {
    setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, opacity } : l)));
  }

  function setFeatureColor(layerId: LayerId, featureId: string, color: string) {
    setLayers((prev) =>
      prev.map((l) => {
        if (l.id !== layerId) return l;
        return { ...l, colorMap: { ...l.colorMap, [featureId]: color } };
      })
    );
  }

  // Handle click on a feature path
  function onFeatureClick(layer: LayerConfig, feature: GeoJSON.Feature) {
    const fid = getFeatureId(feature);
    if (!fid) return;
    const newColor = pickedColor;
    setFeatureColor(layer.id, fid, newColor);
  }

  function getFeatureId(feature: GeoJSON.Feature) {
    // Try id, then properties.iso_a3, name, fallback to generated
    // Note: real GeoJSON should have stable ids
    const id =
      (feature as any).id ??
      (feature.properties &&
        (feature.properties.iso_a3 || feature.properties.name));
    if (id) return String(id);
    return uid();
  }

  // ---------------------- Export PNG -----------------------
  async function exportPNG(filename = "map.png") {
    const svg = svgRef.current;
    if (!svg) return;
    const serializer = new XMLSerializer();
    const cloned = svg.cloneNode(true) as SVGSVGElement;

    // Inline styles needed: get computed styles of SVG and child paths and inline them
    inlineAllStyles(svg, cloned);

    const svgString = serializer.serializeToString(cloned);
    const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width * 2; // high-res
      canvas.height = height * 2;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      // white background
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((b) => {
        if (!b) return;
        downloadBlob(filename, b);
        URL.revokeObjectURL(url);
      }, "image/png");
    };
    image.onerror = (e) => {
      console.error("Image load error exporting PNG", e);
      URL.revokeObjectURL(url);
    };
    image.src = url;
  }

  function inlineAllStyles(orig: SVGElement, clone: SVGElement) {
    // Copy computed styles from orig to clone for every element
    const origNodes = orig.querySelectorAll("*");
    const cloneNodes = clone.querySelectorAll("*");
    origNodes.forEach((n, i) => {
      const c = cloneNodes[i] as HTMLElement;
      if (!c) return;
      const style = window.getComputedStyle(n as Element);
      // pick commonly useful style props (stroke, fill, opacity, stroke-width, font)
      const useful: string[] = [
        "stroke",
        "stroke-width",
        "stroke-linejoin",
        "stroke-linecap",
        "fill",
        "fill-opacity",
        "opacity",
        "font-size",
        "font-family",
        "font-weight",
        "text-anchor",
        "mix-blend-mode",
      ];
      const inline: string[] = [];
      useful.forEach((prop) => {
        const v = style.getPropertyValue(prop);
        if (v) inline.push(`${prop}:${v};`);
      });
      if (inline.length) c.setAttribute("style", inline.join(""));
    });
    // also copy width/height/viewBox on root
    if (clone instanceof SVGSVGElement && orig instanceof SVGSVGElement) {
      const vb = orig.getAttribute("viewBox");
      if (vb) clone.setAttribute("viewBox", vb);
      clone.setAttribute("width", String(orig.getBoundingClientRect().width));
      clone.setAttribute("height", String(orig.getBoundingClientRect().height));
    }
  }

  // --------------------- Drag & Upload ---------------------
  function onFileUpload(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const json = JSON.parse(text) as GeoJSON.FeatureCollection;
        addLayerFromGeoJSON(json, file.name.replace(/\.[^/.]+$/, ""));
      } catch (err) {
        alert("Failed to load GeoJSON: " + err);
      }
    };
    reader.readAsText(file);
  }

  // --------------------- Render Helpers --------------------
  function renderLayerPaths(layer: LayerConfig) {
    if (!layer.geojson || !projection) return null;
    const pathGen = geoPath().projection(projection) as any;
    return (layer.geojson.features as GeoJSON.Feature[]).map((f, idx) => {
      const fid = getFeatureId(f) || String(idx);
      const fill = layer.colorMap[fid] ?? layer.defaultColor;
      const stroke = tinycolor(fill).isDark() ? "#ffffff99" : "#00000066";
      const d = pathGen(f as any) as string;
      return (
        <path
          key={layer.id + "__" + fid + "__" + idx}
          d={d}
          fill={fill}
          stroke={stroke}
          strokeWidth={0.3}
          style={{ opacity: layer.opacity, cursor: "pointer" }}
          onClick={(e) => {
            e.stopPropagation();
            onFeatureClick(layer, f);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            const fid = getFeatureId(f);
            if (!fid) return;
            // right click to clear
            setFeatureColor(layer.id, fid, layer.defaultColor);
          }}
        />
      );
    });
  }

  // ------------------------- UI ----------------------------
  return (
    <div className="p-4 font-sans">
      <div className="flex gap-4 mb-3 items-center">
        <div className="flex items-center gap-2">
          <label className="text-sm">Pick color</label>
          <input
            type="color"
            value={pickedColor}
            onChange={(e) => setPickedColor(e.target.value)}
          />
        </div>

        <div className="flex items-center gap-2">
          <label className="text-sm">Active layer</label>
          <select
            value={activeLayerId ?? ""}
            onChange={(e) => setActiveLayerId(e.target.value)}
            className="border rounded px-2 py-1"
          >
            {layers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>

        <button
          className="px-3 py-1 rounded bg-blue-600 text-white"
          onClick={() => {
            // color all selected features in active layer with pickedColor
            if (!activeLayerId) return;
            const layer = layers.find((l) => l.id === activeLayerId);
            if (!layer || !layer.geojson) return;
            const ids = layer.geojson.features.map((f) => getFeatureId(f));
            const newMap = { ...layer.colorMap } as Record<string, string>;
            ids.forEach((id) => (newMap[id] = pickedColor));
            setLayers((prev) =>
              prev.map((l) =>
                l.id === activeLayerId ? { ...l, colorMap: newMap } : l
              )
            );
          }}
        >
          Fill layer
        </button>

        <button
          className="px-3 py-1 rounded border"
          onClick={() => {
            // reset colors in active layer
            if (!activeLayerId) return;
            const layer = layers.find((l) => l.id === activeLayerId);
            if (!layer) return;
            setLayers((prev) =>
              prev.map((l) =>
                l.id === activeLayerId ? { ...l, colorMap: {} } : l
              )
            );
          }}
        >
          Clear layer colors
        </button>

        <button
          className="px-3 py-1 rounded border"
          onClick={() => exportPNG("map.png")}
        >
          Export PNG
        </button>

        <input
          type="file"
          accept="application/geo+json,application/json,.geojson"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFileUpload(f);
          }}
        />
      </div>

      <div className="flex gap-4">
        <div style={{ flex: "1 1 auto" }}>
          <div className="border rounded overflow-hidden">
            <svg
              ref={svgRef}
              width={width}
              height={height}
              viewBox={`0 0 ${width} ${height}`}
              xmlns="http://www.w3.org/2000/svg"
              style={{ display: "block", background: "#e6f0fa" }}
              onClick={() => {
                /* clicking on background deselects */
              }}
            >
              {/* Render layers sorted by zIndex */}
              {layers
                .slice()
                .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))
                .map((l) => (
                  <g
                    key={l.id}
                    style={{
                      display: l.visible ? undefined : "none",
                      opacity: l.opacity,
                    }}
                    data-layer-id={l.id}
                  >
                    {renderLayerPaths(l)}
                  </g>
                ))}
            </svg>
          </div>
        </div>

        <div style={{ width: 320 }}>
          <div className="p-2 border rounded">
            <h3 className="font-semibold">Layers</h3>
            <div className="flex flex-col gap-2 mt-2">
              {layers
                .slice()
                .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))
                .map((l) => (
                  <div key={l.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={l.visible}
                      onChange={() => toggleLayerVisibility(l.id)}
                    />
                    <div className="flex-1">
                      <div className="text-sm">{l.name}</div>
                      <div className="text-xs text-gray-500">
                        features: {l.geojson?.features.length ?? 0}
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <label className="text-xs">opacity</label>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={l.opacity}
                          onChange={(e) =>
                            setLayerOpacity(l.id, Number(e.target.value))
                          }
                        />
                      </div>
                    </div>
                    <button
                      className="px-2 py-1 text-xs border rounded"
                      onClick={() => setActiveLayerId(l.id)}
                    >
                      Edit
                    </button>
                  </div>
                ))}
            </div>

            <div className="mt-4">
              <h4 className="font-semibold text-sm">Tips</h4>
              <ul className="text-xs list-disc ml-4 mt-2">
                <li>Click a feature to paint it with the picked color.</li>
                <li>Right-click a feature to clear its color.</li>
                <li>
                  Upload GeoJSON files to add layers (admin boundaries,
                  linguistic regions, topo-polygons).
                </li>
                <li>
                  Use opacity and layer order to compose overlapping datasets.
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
