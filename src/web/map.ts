import L from "leaflet";
import "leaflet/dist/leaflet.css";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

L.Icon.Default.mergeOptions({ iconUrl: markerIcon, iconRetinaUrl: markerIcon2x, shadowUrl: markerShadow });
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;

export function createMap(el: HTMLElement, center: [number, number] = [42.5, 12.5], zoom = 6): L.Map {
  const map = L.map(el, { center, zoom, scrollWheelZoom: true });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    // OSM's tile policy rejects requests without a Referer; send only the origin, never the page path.
    referrerPolicy: "strict-origin-when-cross-origin",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  // Maps created inside a view that is not yet laid out need a size recompute.
  requestAnimationFrame(() => map.invalidateSize());
  return map;
}

export const colorFor = (warnCount: number) => (warnCount === 0 ? "#1f7a4d" : warnCount <= 2 ? "#b7791f" : "#b42318");

export function dot(lat: number, lon: number, color: string) {
  return L.circleMarker([lat, lon], { radius: 9, color: "#fff", weight: 2, fillColor: color, fillOpacity: 0.95 });
}

export function accuracyCircle(lat: number, lon: number, meters: number) {
  return L.circle([lat, lon], { radius: meters, color: "#2563eb", weight: 1, fillOpacity: 0.08 });
}

export { L };
