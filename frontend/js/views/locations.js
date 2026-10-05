import { api, del, get, post } from "../api.js";
import { ago, badge, clear, emptyState, field, fmtTime, h, icon, input, loading, modal, pageHeader, responsive, select, toast, toastError } from "../ui.js";

const SVGNS = "http://www.w3.org/2000/svg";
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  for (const c of children.flat()) if (c) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

/** Simple projected map (no tiles, no third-party scripts): devices as dots, geofences as circles. */
function mapSvg(points, fences, names) {
  const W = 760, H = 420, PAD = 40;
  const lats = [...points.map((p) => p.latitude), ...fences.map((f) => f.latitude)];
  const lons = [...points.map((p) => p.longitude), ...fences.map((f) => f.longitude)];
  if (!lats.length) return null;
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180); // shrink longitude away from the equator
  const mPerDegLat = 111_320;
  // Expand the box so whole fences are visible.
  const pad = Math.max(0.002, ...fences.map((f) => f.radius_m / mPerDegLat));
  let minLat = Math.min(...lats) - pad, maxLat = Math.max(...lats) + pad;
  let minLon = Math.min(...lons) - pad / kx, maxLon = Math.max(...lons) + pad / kx;
  const spanX = (maxLon - minLon) * kx, spanY = maxLat - minLat;
  const scale = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY);
  const offX = (W - spanX * scale) / 2, offY = (H - spanY * scale) / 2;
  const X = (lon) => offX + (lon - minLon) * kx * scale;
  const Y = (lat) => H - (offY + (lat - minLat) * scale);
  const metres = (m) => (m / mPerDegLat) * scale;

  const kmBar = Math.min(5000, Math.max(100, Math.round(((W - 2 * PAD) / 4 / scale) * mPerDegLat / 100) * 100));
  return s("svg", { viewBox: `0 0 ${W} ${H}`, class: "map", role: "img", "aria-label": "Device locations and geofences" },
    s("rect", { x: 0, y: 0, width: W, height: H, class: "map-bg" }),
    fences.map((f) =>
      s("g", {},
        s("circle", { cx: X(f.longitude), cy: Y(f.latitude), r: Math.max(metres(f.radius_m), 3), class: f.kind === "restricted" ? "fence fence-restricted" : "fence fence-allowed" }),
        s("text", { x: X(f.longitude), y: Y(f.latitude) - Math.max(metres(f.radius_m), 3) - 4, class: "map-label", "text-anchor": "middle" }, f.name),
      )
    ),
    points.map((p) =>
      s("g", {},
        s("circle", { cx: X(p.longitude), cy: Y(p.latitude), r: 6, class: Date.now() - Date.parse(p.located_at) > 6 * 3600_000 ? "dot dot-stale" : "dot" },
          s("title", {}, `${names.get(p.device_id) ?? "device"} · ${fmtTime(p.located_at)}`)),
        s("text", { x: X(p.longitude) + 9, y: Y(p.latitude) + 4, class: "map-label" }, names.get(p.device_id) ?? ""),
      )
    ),
    s("g", { class: "map-scale" },
      s("line", { x1: PAD, y1: H - 18, x2: PAD + metres(kmBar), y2: H - 18 }),
      s("text", { x: PAD, y: H - 24, class: "map-label" }, kmBar >= 1000 ? `${kmBar / 1000} km` : `${kmBar} m`),
    ),
  );
}

export async function locationsView(el, ctx) {
  clear(el, loading());
  if (!ctx.can("admin")) {
    return clear(el, pageHeader("Locations"), emptyState("Admins only", "Location is personal data — only owners and admins can view it."));
  }
  const [latest, fences, devices, groups, settings] = await Promise.all([
    get("/api/locations/latest"),
    get("/api/locations/geofences"),
    get("/api/devices"),
    get("/api/groups"),
    get("/api/monitoring/settings"),
  ]);
  const names = new Map(devices.map((d) => [d.id, d.device_name]));
  const enabledFences = fences.filter((f) => f.enabled);

  const historyBox = h("div");
  const showHistory = async (d) => {
    clear(historyBox, loading());
    const pts = await get(`/api/locations/device/${d.id}?hours=24`);
    clear(historyBox,
      h("h3", {}, `${d.device_name} — last 24 h (${pts.length} points)`),
      pts.length ? h("div", { class: "map-wrap" }, mapSvg(pts.map((p) => ({ ...p, device_id: d.id })), enabledFences, names)) : h("p", { class: "muted" }, "No points in the last 24 hours."),
    );
  };

  const fenceForm = () => {
    const name = input({ maxlength: 100, placeholder: "Head office" });
    const kind = select([{ value: "allowed", label: "Allowed area — alert when a device leaves" }, { value: "restricted", label: "Restricted area — alert when a device enters" }]);
    const lat = input({ type: "number", step: "0.000001", placeholder: "-6.816100" });
    const lon = input({ type: "number", step: "0.000001", placeholder: "39.280300" });
    const radius = input({ type: "number", min: 50, max: 50000, value: 500 });
    const group = select([{ value: "", label: "All devices" }, ...groups.map((g) => ({ value: g.id, label: g.name }))]);
    const hours = h("input", { type: "checkbox", checked: true });
    const from = select([{ value: "", label: "— use a device's last location —" }, ...latest.points.map((p) => ({ value: p.device_id, label: names.get(p.device_id) ?? p.device_id }))]);
    from.addEventListener("change", () => {
      const p = latest.points.find((x) => x.device_id === from.value);
      if (p) {
        lat.value = p.latitude.toFixed(6);
        lon.value = p.longitude.toFixed(6);
      }
    });
    modal("New geofence", h("div", { class: "stack" },
      field("Name", name), field("Type", kind),
      latest.points.length ? field("Centre from device", from) : null,
      h("div", { class: "grid2" }, field("Latitude", lat), field("Longitude", lon)),
      field("Radius (metres)", radius), field("Applies to", group),
      h("label", { class: "pick" }, hours, h("span", {}, "Only check during working hours")),
      h("p", { class: "hint" }, "Tip: right-click a spot in Google Maps / OpenStreetMap to copy its coordinates."),
    ), [
      { label: "Cancel" },
      { label: "Create", tone: "primary", onClick: async () => {
        await post("/api/locations/geofences", { name: name.value, kind: kind.value, latitude: Number(lat.value), longitude: Number(lon.value), radiusM: Number(radius.value), groupId: group.value || null, activeHoursOnly: hours.checked });
        toast("Geofence created");
        locationsView(el, ctx);
      } },
    ]);
  };

  const osm = (p) => `https://www.openstreetmap.org/?mlat=${p.latitude}&mlon=${p.longitude}#map=16/${p.latitude}/${p.longitude}`;
  const map = mapSvg(latest.points, enabledFences, names);

  clear(
    el,
    pageHeader("Locations", `Corporate devices only. Points are kept ${settings.location_retention_days} days and every view is logged.`, [
      h("button", { class: "btn btn-primary", type: "button", onclick: fenceForm }, icon("plus"), "New geofence"),
    ]),
    !settings.location_tracking_enabled
      ? h("div", { class: "banner banner-warn" }, h("strong", {}, "Location tracking is off. "), "Geofences only work when it is on. ", ctx.can("owner") ? h("a", { href: "#/settings?tab=monitoring" }, "Turn it on in Settings → Monitoring") : "Ask the owner to enable it.")
      : null,
    h("section", { class: "card" },
      h("div", { class: "card-head" }, h("h2", {}, "Map"), h("span", { class: "muted small" }, "Dot = device · green ring = allowed area · red ring = restricted area · grey = older than 6 h")),
      map ? h("div", { class: "map-wrap" }, map) : h("p", { class: "muted" }, "No location points yet."),
    ),
    h("section", { class: "card" },
      h("div", { class: "card-head" }, h("h2", {}, "Last known position")),
      latest.points.length
        ? h("div", { class: "table-wrap" }, responsive(h("table", {},
          h("thead", {}, h("tr", {}, h("th", {}, "Device"), h("th", {}, "Coordinates"), h("th", {}, "Seen"), h("th", {}, ""))),
          h("tbody", {}, latest.points.map((p) => {
            const d = devices.find((x) => x.id === p.device_id) ?? { id: p.device_id, device_name: "device" };
            return h("tr", {},
              h("td", {}, d.device_name),
              h("td", { class: "mono" }, `${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}`),
              h("td", { class: "muted" }, ago(p.located_at)),
              h("td", { class: "actions" },
                h("button", { class: "btn btn-sm", type: "button", onclick: () => showHistory(d).catch(toastError) }, "24 h trail"),
                h("a", { class: "btn btn-sm btn-ghost", href: osm(p), target: "_blank", rel: "noopener noreferrer" }, "Open map")),
            );
          })),
        )))
        : h("p", { class: "muted" }, "Nothing collected yet."),
      historyBox,
    ),
    h("section", { class: "card" },
      h("div", { class: "card-head" }, h("h2", {}, "Geofences")),
      fences.length
        ? h("ul", { class: "list" }, fences.map((f) =>
          h("li", {},
            h("span", {}, badge(f.kind, f.kind === "restricted" ? "bad" : "ok"), h("strong", {}, f.name),
              h("span", { class: "muted small" }, ` · ${f.radius_m} m · ${f.groups?.name ?? "all devices"}${f.active_hours_only ? " · working hours" : " · always"}`)),
            h("span", { class: "btn-row" },
              h("button", { class: "btn btn-xs", type: "button", onclick: async () => {
                try {
                  await api("PATCH", `/api/locations/geofences/${f.id}`, { enabled: !f.enabled });
                  locationsView(el, ctx);
                } catch (err) {
                  toastError(err);
                }
              } }, f.enabled ? "Disable" : "Enable"),
              h("button", { class: "btn btn-xs btn-ghost", type: "button", onclick: async () => {
                try {
                  await del(`/api/locations/geofences/${f.id}`);
                  toast("Geofence deleted", "info");
                  locationsView(el, ctx);
                } catch (err) {
                  toastError(err);
                }
              } }, "Delete")),
          )))
        : h("p", { class: "muted" }, "No geofences. Add an allowed area around the office or a client site."),
    ),
  );
}
