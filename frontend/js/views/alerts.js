import { get, post } from "../api.js";
import { ago, badge, clear, emptyState, fmtTime, h, input, jsonBlock, loading, modal, pageHeader, select, toast, toastError } from "../ui.js";

const SEVERITY_TONE = { critical: "bad", warning: "warn", info: "info" };

export async function alertsView(el, ctx) {
  const status = select([
    { value: "active", label: "Open & acknowledged" },
    { value: "open", label: "Open" },
    { value: "acknowledged", label: "Acknowledged" },
    { value: "resolved", label: "Resolved" },
  ], { "aria-label": "Status" });
  const severity = select([{ value: "", label: "All severities" }, { value: "critical", label: "Critical" }, { value: "warning", label: "Warning" }, { value: "info", label: "Info" }], { "aria-label": "Severity" });
  const listBox = h("div");
  const scanBtn = ctx.can("admin") ? h("button", { class: "btn", type: "button" }, "Scan now") : null;

  const load = async () => {
    clear(listBox, loading());
    const qs = new URLSearchParams({ status: status.value });
    if (severity.value) qs.set("severity", severity.value);
    const rows = await get(`/api/alerts?${qs}`);
    clear(listBox, rows.length
      ? h("div", { class: "alert-list" }, rows.map((a) => alertCard(a)))
      : emptyState(status.value === "resolved" ? "Nothing resolved yet" : "No open alerts", "Security scans run every sync interval; location checks follow your monitoring settings."));
  };

  const alertCard = (a) =>
    h("article", { class: `card alert-card alert-${a.severity}` },
      h("div", { class: "card-head" },
        h("div", {}, badge(a.severity, SEVERITY_TONE[a.severity]), badge(a.status), h("strong", {}, a.title)),
        h("span", { class: "muted small nowrap" }, ago(a.last_seen_at)),
      ),
      h("p", { class: "muted small" },
        [a.devices?.device_name, a.geofences?.name, a.rule_key.replace(/_/g, " "), a.occurrences > 1 ? `seen ${a.occurrences}×` : null, `first ${fmtTime(a.first_seen_at)}`].filter(Boolean).join(" · ")),
      a.auto_action_event_id ? h("p", { class: "small" }, "Automatic action was triggered — see Activity.") : null,
      a.status === "resolved" ? h("p", { class: "small muted" }, `Resolved ${fmtTime(a.resolved_at)} ${a.res?.email ? `by ${a.res.email}` : "automatically"}${a.resolution_note ? ` — ${a.resolution_note}` : ""}`) : null,
      h("div", { class: "btn-row" },
        h("button", { class: "btn btn-sm", type: "button", onclick: () => modal(a.title, jsonBlock(a.details)) }, "Details"),
        ctx.can("admin") && a.status === "open" ? h("button", { class: "btn btn-sm", type: "button", onclick: async () => {
          try {
            await post(`/api/alerts/${a.id}/acknowledge`, {});
            toast("Acknowledged", "info");
            load();
          } catch (err) {
            toastError(err);
          }
        } }, "Acknowledge") : null,
        ctx.can("admin") && a.status !== "resolved" ? h("button", { class: "btn btn-sm btn-primary", type: "button", onclick: () => {
          const note = input({ maxlength: 500, placeholder: "What was it? e.g. phone replaced, false alarm" });
          modal("Resolve alert", h("div", { class: "stack" }, h("p", {}, a.title), note), [
            { label: "Cancel" },
            { label: "Resolve", tone: "primary", onClick: async () => {
              await post(`/api/alerts/${a.id}/resolve`, { note: note.value });
              toast("Resolved");
              load();
            } },
          ]);
        } }, "Resolve") : null,
      ),
    );

  status.addEventListener("change", () => load().catch(toastError));
  severity.addEventListener("change", () => load().catch(toastError));
  scanBtn?.addEventListener("click", async () => {
    scanBtn.disabled = true;
    scanBtn.textContent = "Scanning…";
    try {
      const { data } = await post("/api/monitoring/scan", {});
      toast(`Scanned ${data.security.scanned} device(s)${data.locations.skipped ? ` · locations: ${data.locations.skipped}` : ` · ${data.locations.stored ?? 0} new location point(s)`}`, "info");
      load();
    } catch (err) {
      toastError(err);
    } finally {
      scanBtn.disabled = false;
      scanBtn.textContent = "Scan now";
    }
  });

  clear(
    el,
    pageHeader("Alerts", "Rooted devices, missing screen locks, devices gone silent or removed, unusual data use, geofence breaches and unusual admin activity.", [scanBtn]),
    h("div", { class: "toolbar" }, status, severity),
    listBox,
  );
  await load();
}
