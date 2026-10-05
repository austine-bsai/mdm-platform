import { api, get } from "../api.js";
import { badge, field, fmtTime, h, input, modal, responsive, select, toast, toastError } from "../ui.js";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const ACTION_LABEL = { lock: "Lock device", enable_lost_mode: "Lost mode", remote_alarm: "Ring alarm" };

/** Settings → Monitoring card (tracking, working hours, thresholds, alert rules). */
export async function monitoringSection(ctx, reload) {
  const [st, rules] = await Promise.all([get("/api/monitoring/settings"), get("/api/monitoring/rules")]);
  const owner = ctx.can("owner");
  const dis = !owner;

  const tracking = h("input", { type: "checkbox", checked: st.location_tracking_enabled, disabled: dis });
  const interval = input({ type: "number", min: 5, max: 1440, value: st.location_interval_minutes, disabled: dis });
  const hoursOnly = h("input", { type: "checkbox", checked: st.working_hours_only, disabled: dis });
  const start = input({ type: "time", value: st.work_start.slice(0, 5), disabled: dis });
  const end = input({ type: "time", value: st.work_end.slice(0, 5), disabled: dis });
  const dayBoxes = DAYS.map((d, i) => ({ n: i + 1, el: h("input", { type: "checkbox", checked: st.work_days.includes(i + 1), disabled: dis }), d }));
  const tz = input({ value: st.timezone, disabled: dis });
  const retention = input({ type: "number", min: 1, max: 365, value: st.location_retention_days, disabled: dis });
  const offline = input({ type: "number", min: 1, max: 720, value: st.offline_hours, disabled: dis });
  const spike = input({ type: "number", min: 1.5, max: 50, step: 0.5, value: st.data_spike_factor, disabled: dis });
  const email = h("input", { type: "checkbox", checked: st.email_critical_alerts, disabled: dis });

  const save = async () => {
    const body = {
      locationTrackingEnabled: tracking.checked,
      locationIntervalMinutes: Number(interval.value),
      workingHoursOnly: hoursOnly.checked,
      workStart: start.value,
      workEnd: end.value,
      workDays: dayBoxes.filter((d) => d.el.checked).map((d) => d.n),
      timezone: tz.value.trim(),
      locationRetentionDays: Number(retention.value),
      offlineHours: Number(offline.value),
      dataSpikeFactor: Number(spike.value),
      emailCriticalAlerts: email.checked,
    };
    const send = async (extra = {}) => {
      await api("PUT", "/api/monitoring/settings", { ...body, ...extra });
      toast("Monitoring settings saved");
      reload();
    };
    if (body.locationTrackingEnabled && !st.location_tracking_enabled) {
      const ok = h("input", { type: "checkbox" });
      modal("Turn on location tracking?", h("div", { class: "stack" },
        h("p", {}, "Location is personal data under Tanzania's Personal Data Protection Act (2022). Before turning this on:"),
        h("ul", {}, h("li", {}, "tell employees in writing that company devices report their location, when, and why;"),
          h("li", {}, `points are kept ${body.locationRetentionDays} days, then deleted automatically;`),
          h("li", {}, "only owners/admins can view locations, and every view is logged;"),
          h("li", {}, "personal (work-profile) phones are never tracked.")),
        h("label", { class: "pick" }, ok, h("span", {}, "Employees have been informed")),
      ), [
        { label: "Cancel" },
        { label: "Turn on", tone: "primary", onClick: async () => {
          if (!ok.checked) {
            toast("Tick the confirmation first", "warn");
            return true; // keep the dialog open
          }
          await send({ employeesInformed: true });
        } },
      ]);
      return;
    }
    await send();
  };

  const ruleRows = rules.map((r) => {
    const on = h("input", { type: "checkbox", checked: r.enabled, disabled: dis, "aria-label": `Enable ${r.label}` });
    const sev = select(["info", "warning", "critical"].map((v) => ({ value: v, label: v, selected: v === r.severity })), { disabled: dis, "aria-label": "Severity" });
    const act = select([{ value: "", label: "No automatic action" }, ...r.autoActions.map((a) => ({ value: a, label: ACTION_LABEL[a], selected: a === r.autoAction }))], { disabled: dis || !r.autoActions.length, "aria-label": "Automatic action" });
    const push = async () => {
      try {
        await api("PUT", `/api/monitoring/rules/${r.key}`, { enabled: on.checked, severity: sev.value, autoAction: act.value || null });
        toast(`Rule "${r.label}" updated`, "info");
      } catch (err) {
        toastError(err);
      }
    };
    for (const c of [on, sev, act]) c.addEventListener("change", push);
    return h("tr", {},
      h("td", {}, on),
      h("td", {}, h("strong", {}, r.label), h("div", { class: "muted small" }, r.description)),
      h("td", {}, sev),
      h("td", {}, act),
    );
  });

  return h("section", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Monitoring"), st.location_tracking_enabled ? badge("tracking on", "info") : badge("tracking off", "muted")),
    h("h3", {}, "Location tracking"),
    h("label", { class: "pick" }, tracking, h("span", {}, "Collect location of corporate devices")),
    st.tracking_consent_at ? h("p", { class: "muted small" }, `Employees-informed confirmation recorded ${fmtTime(st.tracking_consent_at)}.`) : null,
    h("div", { class: "grid3" }, field("Every (minutes)", interval), field("Keep points (days)", retention), field("Timezone", tz)),
    h("label", { class: "pick" }, hoursOnly, h("span", {}, "Only during working hours")),
    h("div", { class: "grid3" }, field("Work starts", start), field("Work ends", end),
      h("div", { class: "field" }, h("label", {}, "Work days"), h("div", { class: "days" }, dayBoxes.map((d) => h("label", { class: "pick" }, d.el, h("span", {}, d.d)))))),
    h("h3", {}, "Thresholds"),
    h("div", { class: "grid3" }, field("Offline after (hours)", offline), field("Data spike (× normal)", spike),
      h("div", { class: "field" }, h("label", {}, "Email"), h("label", { class: "pick" }, email, h("span", {}, "Email critical alerts to owners/admins")))),
    owner ? h("div", { class: "btn-row" }, h("button", { class: "btn btn-primary", type: "button", onclick: () => save().catch(toastError) }, "Save monitoring settings")) : h("p", { class: "muted" }, "Only the owner can change monitoring."),
    h("h3", {}, "Alert rules"),
    h("div", { class: "table-wrap" }, responsive(h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "On"), h("th", {}, "Rule"), h("th", {}, "Severity"), h("th", {}, "Automatic action"))), h("tbody", {}, ruleRows)), { primary: 1 })),
  );
}
