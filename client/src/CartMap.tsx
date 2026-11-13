import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Device } from "./api.js";
import { type CartStatus, position, type trailSegments } from "./tracking.js";

const circuit: L.LatLngTuple = [-37.0442, 143.7422];

export interface MapCart {
  device: Device;
  number: number;
  colour: string;
  status: CartStatus;
  demo: boolean;
  point: ReturnType<typeof position>;
  trail: ReturnType<typeof trailSegments>;
}

const basemaps = {
  Street: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    maxNativeZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
  Satellite: {
    url: "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg",
    maxNativeZoom: 14,
    attribution: '<a href="https://cloudless.eox.at/">EOxCloudless</a> by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016 &amp; 2017) · <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>',
  },
} as const;

type Basemap = keyof typeof basemaps;

export function CartMap({ carts, followId, fitRequest }: {
  carts: MapCart[];
  followId: string;
  fitRequest: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<L.Map>(null);
  const layers = useRef(new Map<string, { trail: L.Polyline; marker?: L.Marker }>());
  const lastFit = useRef(0);
  const [basemap, setBasemap] = useState<Basemap>("Street");
  const [tileError, setTileError] = useState(false);

  useEffect(() => {
    const map = L.map(container.current!, { zoomControl: false, maxZoom: 19 }).setView(circuit, 16);
    L.control.zoom({ position: "bottomleft" }).addTo(map);
    L.control.scale({ position: "bottomleft", imperial: false }).addTo(map);
    instance.current = map;
    const observer = new ResizeObserver(() => map.invalidateSize({ pan: false }));
    observer.observe(container.current!);
    return () => {
      observer.disconnect();
      map.remove();
      layers.current.clear();
      instance.current = null;
    };
  }, []);

  useEffect(() => {
    const map = instance.current!;
    const { url, ...options } = basemaps[basemap];
    const layer = L.tileLayer(url, { ...options, maxZoom: 19, referrerPolicy: "strict-origin-when-cross-origin" });
    let failures = 0;
    setTileError(false);
    layer.on("loading", () => { failures = 0; });
    layer.on("tileerror", () => { failures++; });
    layer.on("load", () => setTileError(failures > 0));
    layer.addTo(map);
    return () => { layer.remove(); };
  }, [basemap]);

  useEffect(() => {
    const map = instance.current!;
    const visible = new Set(carts.map(({ device }) => device.id));
    for (const [id, layer] of layers.current) {
      if (visible.has(id)) continue;
      layer.trail.remove();
      layer.marker?.remove();
      layers.current.delete(id);
    }

    for (const cart of carts) {
      const { device, number, colour, demo, point, trail } = cart;
      let layer = layers.current.get(device.id);
      if (!layer) {
        layer = { trail: L.polyline([], { color: colour, weight: 4, opacity: 0.84, dashArray: "5 7", interactive: false }).addTo(map) };
        layers.current.set(device.id, layer);
      }
      layer.trail.setLatLngs(trail);
      if (!point) {
        layer.marker?.remove();
        layer.marker = undefined;
        continue;
      }
      if (!layer.marker) {
        const glyph = document.createElement("span");
        glyph.textContent = String(number);
        glyph.style.background = colour;
        const icon = L.divIcon({ className: "cart-marker", html: glyph, iconSize: [30, 30], iconAnchor: [15, 15] });
        layer.marker = L.marker(point, { icon, keyboard: false }).addTo(map);
        layer.marker.bindTooltip("", { permanent: true, direction: "right", offset: [17, 0], className: "cart-map-label" });
      }
      const label = document.createElement("span");
      label.textContent = demo ? `${device.displayName} · Demo` : device.displayName;
      layer.marker.setLatLng(point).setTooltipContent(label);
    }

    if (fitRequest !== lastFit.current) {
      lastFit.current = fitRequest;
      const points = carts.flatMap(({ point }) => point ? [point] : []);
      if (points.length) map.fitBounds(L.latLngBounds(points), { padding: [54, 54], maxZoom: 17, animate: false });
      else map.setView(circuit, 16);
    } else {
      const followed = carts.find(({ device }) => device.id === followId)?.point;
      if (followed && !map.getCenter().equals(followed)) map.panTo(followed, { animate: false });
    }
  }, [carts, followId, fitRequest]);

  return <div className="map-frame">
    <div className="map-surface" ref={container} aria-label="Interactive map of the Energy Breakthrough circuit" />
    <div className="map-layers" role="group" aria-label="Map layer">
      {(["Street", "Satellite"] as const).map((name) =>
        <button type="button" key={name} aria-pressed={basemap === name} onClick={() => setBasemap(name)}>{name}</button>,
      )}
    </div>
    {tileError && <p className="tile-error" role="status">Some map tiles are unavailable.</p>}
  </div>;
}
