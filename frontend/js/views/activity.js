import { get, post } from "../api.js";
import { badge, clear, fmtTime, h, jsonBlock, loading, modal, pageHeader, select, table, tabStrip, toastError, toastEvent } from "../ui.js";

const CATEGORIES = ["", "command", "group", "profile", "announcement", "sync", "zoho", "auth"];
const STATES = ["", "awaiting_confirmation", "requested", "sent", "acknowledged", "succeeded", "failed", "dead", "cancelled"];
const TABS = [
  { id: "all", label: "All activity" },
  { id: "backlog", label: "Backlog" },
];

export async function activityView(el, ctx, params) {
  const tab = params?.get("tab") === "backlog" ? "backlog" : "all";
  const backlog = tab === "backlog";
  const category = select(CATEGORIES.map((c) => ({ value: c, label: c || "All categories" })), { "aria-label": "Category" });
  const state = select(STATES.map((s) => ({ value: s, label: s ? s.replace(/_/g, " ") : "All states" })), { "aria-label": "State" });
  const listBox = h("div");
  const more = h("button", { class: "btn btn-sm", type: "button", hidden: true }, "Load older");
  let rows = [];

  const load = async (append = false) => {
    if (!append) clear(listBox, loading());
    const qs = new URLSearchParams({ limit: "100" });
    if (category.value) qs.set("category", category.value);
    if (state.value) qs.set("state", state.value);
    if (append && rows.length) qs.set("before", rows[rows.length - 1].action_time);
    const data = await get(backlog ? "/api/events/backlog" : `/api/events?${qs}`);
    rows = append ? [...rows, ...data] : data;
    more.hidden = backlog || data.length < 100;
    draw();
  };

  const cols = [
    { label: "Action", primary: true, cell: (e) => h("div", {}, h("button", { class: "link", type: "button", onclick: () => detail(e) }, e.action.replace(/_/g, " ")), h("div", { class: "cell-sub" }, fmtTime(e.action_time))) },
    { label: "State", cell: (e) => badge(e.state) },
    { label: "Target", cell: (e) => [e.devices?.device_name, e.groups?.name, e.profiles?.name].filter(Boolean).join(" · ") || h("span", { class: "muted" }, "—") },
    { label: "Error / retries", cell: (e) => h("span", { class: "muted small" }, e.error_code ? `${e.error_code}: ${e.error_message ?? ""}` : (e.attempts > 1 ? `${e.attempts} attempts` : "—")) },
    { label: "By", cell: (e) => h("span", { class: "muted" }, e.admins?.email ?? "system") },
  ];

  const draw = () => clear(listBox, table(cols, rows, {
    empty: backlog ? "Backlog is empty. Operations that keep failing after retries land here." : "No events match these filters.",
  }));

  const detail = (e) => {
    const admin = ctx.can("admin");
    modal(e.action.replace(/_/g, " "), h("div", { class: "stack" },
      h("p", {}, badge(e.state), " ", `attempt ${e.attempts} of ${e.max_attempts} · ${fmtTime(e.action_time)}`),
      e.error_code ? h("div", { class: "banner banner-bad" }, `${e.error_code}: ${e.error_message ?? ""}`) : null,
      h("h3", {}, "Parameters"), jsonBlock(e.params),
      h("h3", {}, "Response"), jsonBlock(e.response),
    ), [
      ...(admin && ["dead", "failed"].includes(e.state) ? [{ label: "Retry now", tone: "primary", onClick: async () => {
        toastEvent(await post(`/api/events/${e.id}/retry`, {}), "Retried");
        load();
      } }] : []),
      ...(admin && ["awaiting_confirmation", "requested", "dead", "failed"].includes(e.state) ? [{ label: ["failed", "dead"].includes(e.state) ? "Dismiss" : "Cancel event", onClick: async () => {
        await post(`/api/events/${e.id}/cancel`, {});
        load();
      } }] : []),
      { label: "Close" },
    ]);
  };

  category.addEventListener("change", () => load().catch(toastError));
  state.addEventListener("change", () => load().catch(toastError));
  more.addEventListener("click", () => load(true).catch(toastError));

  clear(
    el,
    pageHeader("Activity", "Every action with its state (requested, sent, acknowledged, succeeded) and any error. Failed operations collect in the backlog."),
    tabStrip(TABS, tab, (id) => ctx.go(id === "backlog" ? "#/activity?tab=backlog" : "#/activity")),
    backlog ? h("div", { class: "banner banner-info" }, "Fix the cause first (for example, reconnect Zoho), then retry each operation.") : null,
    h("section", { class: "card" },
      backlog ? null : h("div", { class: "toolbar" }, category, state),
      listBox,
      h("div", { class: "btn-row" }, more),
    ),
  );
  await load();
}
