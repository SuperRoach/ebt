import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Device } from "./api.js";
import { type CartStatus, position, type trailSegments } from "./tracking.js";

const circuit: L.LatLngTuple = [-37.0442, 143.7422];
const arcgisApiKey = import.meta.env.VITE_ARCGIS_API_KEY?.trim();

export interface MapCart {
  device: Device;
  number: number;
  colour: string;
  liveSequence?: string;
  status: CartStatus;
  historical: boolean;
  positionDemo: boolean;
  point: ReturnType<typeof position>;
  headingDeg: number | null;
  trail: ReturnType<typeof trailSegments>;
}

const basemaps = {
  Street: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    maxNativeZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
} as const;

type Basemap = "Street" | "Satellite";

export function CartMap({ carts, followId, fitRequest }: {
  carts: MapCart[];
  followId: string;
  fitRequest: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<L.Map>(null);
  const layers = useRef(new Map<string, {
    trail: L.Polyline;
    marker?: L.Marker;
    glyph?: HTMLSpanElement;
    lastPulsedSequence?: string;
  }>());
  const lastFit = useRef(0);
  const [basemap, setBasemap] = useState<Basemap>("Street");
  const [tileError, setTileError] = useState<string | null>(null);

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
    if (basemap === "Satellite" && !arcgisApiKey) {
      setTileError("Set VITE_ARCGIS_API_KEY to enable Esri satellite imagery.");
      return;
    }

    const layer = basemap === "Satellite"
      ? L.tileLayer(
          `https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token=${encodeURIComponent(arcgisApiKey!)}`,
          {
            maxZoom: 19,
            attribution: '<a href="https://www.esri.com/">Esri</a>, Vantor, Earthstar Geographics, and the GIS User Community',
            referrerPolicy: "strict-origin-when-cross-origin",
          },
        )
      : L.tileLayer(basemaps.Street.url, {
          ...basemaps.Street,
          maxZoom: 19,
          referrerPolicy: "strict-origin-when-cross-origin",
        });
    let failures = 0;
    setTileError(null);
    layer.on("loading", () => { failures = 0; });
    layer.on("tileerror", () => { failures++; });
    layer.on("load", () => setTileError(failures > 0 ? "Some map tiles are unavailable." : null));
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
      const { device, number, colour, historical, positionDemo, point, trail, liveSequence } = cart;
      let layer = layers.current.get(device.id);
      if (!layer) {
        layer = { trail: L.polyline([], { color: colour, weight: 4, opacity: 0.84, dashArray: "5 7", interactive: false }).addTo(map) };
        layers.current.set(device.id, layer);
      }
      layer.trail.setStyle({ color: colour }).setLatLngs(trail);
      if (!point) {
        layer.marker?.remove();
        layer.marker = undefined;
        layer.glyph = undefined;
        continue;
      }
      if (!layer.marker) {
        const glyph = document.createElement("span");
        layer.glyph = glyph;
        const icon = L.divIcon({ className: "cart-marker", html: glyph, iconSize: [30, 30], iconAnchor: [15, 15] });
        layer.marker = L.marker(point, { icon, keyboard: false }).addTo(map);
        layer.marker.bindTooltip("", { permanent: true, direction: "right", offset: [17, 0], className: "cart-map-label" });
      }
      if (layer.glyph) {
        layer.glyph.textContent = String(number);
        layer.glyph.style.background = colour;
        layer.glyph.style.setProperty("--heading-colour", colour);
        if (cart.headingDeg == null) {
          layer.glyph.style.removeProperty("--cart-heading");
          delete layer.glyph.dataset.hasHeading;
        } else {
          layer.glyph.style.setProperty("--cart-heading", `${cart.headingDeg}deg`);
          layer.glyph.dataset.hasHeading = "true";
        }
      }
      const label = document.createElement("span");
      label.textContent = device.displayName + (positionDemo ? " · Demo" : "") + (historical ? " · Last known" : "");
      layer.marker.setLatLng(point).setTooltipContent(label);
      if (liveSequence !== undefined && liveSequence !== layer.lastPulsedSequence) {
        layer.lastPulsedSequence = liveSequence;
        const marker = layer.marker.getElement();
        marker?.querySelector(".cart-pulse")?.remove();
        const pulse = document.createElement("i");
        pulse.className = "cart-pulse";
        pulse.style.setProperty("--pulse-colour", colour);
        pulse.setAttribute("aria-hidden", "true");
        pulse.addEventListener("animationend", () => pulse.remove(), { once: true });
        marker?.prepend(pulse);
      }
    }

    if (fitRequest !== lastFit.current) {
      lastFit.current = fitRequest;
      const points = carts.flatMap(({ point }) => point ? [point] : []);
      if (points.length) map.fitBounds(L.latLngBounds(points), { padding: [54, 54], maxZoom: 17, animate: false });
      else map.setView(circuit, 16);
    } else {
      const followed = carts.find(({ device, status }) => device.id === followId && status === "Live")?.point;
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
    {tileError && <p className="tile-error" role="status">{tileError}</p>}
  </div>;
}
