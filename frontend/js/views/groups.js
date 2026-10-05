import { del, get, post } from "../api.js";
import { badge, clear, emptyState, field, h, icon, input, loading, modal, multiPicker, pageHeader, select, table, toastError, toastEvent } from "../ui.js";

const KINDS = [
  { value: "department", label: "Department (e.g. Finance, Sales)" },
  { value: "function", label: "Function (e.g. Kiosk POS, Field data)" },
  { value: "baseline", label: "Baseline (all corporate devices)" },
  { value: "other", label: "Other" },
];
// Where a profile ↔ group link came from (see database/003_profile_group_sync.sql).
const SOURCE = {
  zoho: { label: "from Zoho", hint: "Assigned in the Zoho console" },
  inferred: { label: "detected", hint: "Assigned in the Zoho console; seen on every device in this group" },
};
const kindTone = (k) => (k === "function" ? "info" : k === "baseline" ? "ok" : "muted");

export async function groupsView(el, ctx) {
  clear(el, loading());
  const groups = await get("/api/groups");
  const createBtn = ctx.can("admin") ? h("button", { class: "btn btn-primary", type: "button", onclick: () => createGroup(ctx) }, icon("plus"), "New group") : null;

  clear(
    el,
    pageHeader("Groups", "Settings go to groups, not single devices. A profile assigned to a group reaches every device in it.", [createBtn]),
    groups.length
      ? h("div", { class: "cards" }, groups.map((g) =>
        h("a", { class: "card group-card", href: `#/groups/${g.id}` },
          h("div", { class: "row" }, h("h2", {}, g.name), badge(g.kind, kindTone(g.kind))),
          g.description ? h("p", { class: "muted small" }, g.description) : null,
          h("div", { class: "meta" }, `${g.member_count} device(s) · ${(g.profile_groups ?? []).length} profile(s)`, g.zoho_group_id ? null : " · not yet in Zoho"),
          (g.profile_groups ?? []).length ? h("div", { class: "chips" }, g.profile_groups.map((pg) => badge(pg.profiles?.name ?? "profile", "info"))) : null,
        )))
      : h("section", { class: "card" }, emptyState("No groups yet", "Start with a baseline group for all corporate devices, then one group per department or function.", createBtn)),
  );
}

function createGroup(ctx) {
  const name = input({ maxlength: 100, placeholder: "Field Ops" });
  const kind = select(KINDS);
  const desc = input({ maxlength: 300 });
  modal("New group", h("div", { class: "stack" }, field("Name", name), field("Type", kind), field("Description", desc)), [
    { label: "Cancel" },
    { label: "Create", tone: "primary", onClick: async () => {
      const res = await post("/api/groups", { name: name.value, kind: kind.value, description: desc.value });
      toastEvent(res, "Group created in Zoho");
      const id = res.data?.groupId;
      ctx.go(id ? `#/groups/${id}` : "#/groups");
    } },
  ]);
}

export async function groupDetailView(el, ctx, id) {
  clear(el, loading());
  const [g, allDevices, allProfiles] = await Promise.all([get(`/api/groups/${id}`), get("/api/devices"), get("/api/profiles")]);
  const memberIds = new Set(g.devices.map((x) => x.devices?.id));
  const attachedIds = new Set(g.profiles.map((x) => x.profiles?.id));
  const admin = ctx.can("admin");
  const reload = () => groupDetailView(el, ctx, id);
  const guard = (fn) => async () => {
    try {
      await fn();
      reload();
    } catch (err) {
      toastError(err);
    }
  };

  const addDevices = () => {
    const picker = multiPicker(allDevices.filter((d) => !memberIds.has(d.id)), { label: (d) => `${d.device_name} · ${d.mdm_users?.user_name ?? "unassigned"}`, empty: "All devices are already in this group" });
    modal(`Add devices to ${g.name}`, picker.el, [{ label: "Cancel" }, { label: "Add", tone: "primary", onClick: async () => {
      toastEvent(await post(`/api/groups/${id}/devices`, { deviceIds: picker.values() }), "Devices added");
      reload();
    } }]);
  };
  const addProfiles = () => {
    const ready = allProfiles.filter((p) => p.state === "published" && !attachedIds.has(p.id));
    const picker = multiPicker(ready, { label: (p) => `${p.name} (${p.purpose})`, empty: "No published profiles left. Publish one in Profiles first." });
    modal(`Assign profiles to ${g.name}`, picker.el, [{ label: "Cancel" }, { label: "Assign", tone: "primary", onClick: async () => {
      toastEvent(await post(`/api/groups/${id}/profiles`, { profileIds: picker.values() }), "Profiles assigned");
      reload();
    } }]);
  };
  const deleteGroup = () => modal("Delete group?", h("p", {}, `Delete "${g.name}" in Zoho? Devices stay enrolled but lose this group's profiles.`), [
    { label: "Cancel" },
    { label: "Delete", tone: "danger", onClick: async () => {
      toastEvent(await del(`/api/groups/${id}`), "Group deleted");
      ctx.go("#/groups");
    } },
  ]);

  const deviceCols = [
    { label: "Device", primary: true, cell: (x) => h("a", { class: "link", href: `#/devices/${x.devices?.id}` }, x.devices?.device_name ?? "device") },
    { label: "User", cell: (x) => x.devices?.mdm_users?.user_name ?? h("span", { class: "muted" }, "Unassigned") },
    admin ? { label: "", class: "actions", cell: (x) => h("button", { class: "btn btn-xs", type: "button", onclick: guard(async () => toastEvent(await del(`/api/groups/${id}/devices/${x.devices.id}`), "Device removed from group")) }, "Remove") } : null,
  ].filter(Boolean);

  clear(
    el,
    pageHeader(g.name, g.description || null, [
      admin ? h("button", { class: "btn btn-primary", type: "button", onclick: addDevices }, icon("plus"), "Add devices") : null,
      admin ? h("button", { class: "btn", type: "button", onclick: addProfiles }, "Assign profiles") : null,
    ], { href: "#/groups", label: "Groups" }),
    h("p", { class: "chips" }, badge(g.kind, kindTone(g.kind)), badge(`${g.devices.length} device(s)`, "muted"), g.zoho_group_id ? badge(`Zoho id ${g.zoho_group_id}`, "muted") : badge("not yet in Zoho", "warn")),
    h("div", { class: "split" },
      h("section", { class: "card card-flush" },
        h("div", { class: "card-head" }, h("h2", {}, "Devices")),
        h("div", { class: "table-wrap" }, table(deviceCols, g.devices, { empty: "No devices in this group yet." })),
      ),
      h("div", {},
        h("section", { class: "card" },
          h("div", { class: "card-head" }, h("h2", {}, "Profiles")),
          g.profiles.length
            ? h("ul", { class: "list" }, g.profiles.map((x) =>
              h("li", {}, h("span", {}, x.profiles?.name, " ", badge(x.profiles?.purpose ?? "", "muted"), SOURCE[x.source] ? badge(SOURCE[x.source].label, "info") : null,
                SOURCE[x.source] ? h("div", { class: "cell-sub" }, SOURCE[x.source].hint) : null),
                admin ? h("button", { class: "btn btn-xs", type: "button", onclick: guard(async () => toastEvent(await post(`/api/groups/${id}/profiles/remove`, { profileIds: [x.profiles.id] }), "Profile removed from group")) }, "Remove") : null)))
            : h("p", { class: "muted" }, g.devices.length
              ? "No profiles assigned. Devices in this group get no settings from it yet."
              : "No profiles found. Profiles assigned in the Zoho console show up after a sync once the group has devices."),
        ),
        ctx.can("owner") ? h("section", { class: "card danger-zone" },
          h("div", { class: "card-head" }, h("h2", {}, "Delete group")),
          h("p", { class: "muted small" }, "Removes the group in Zoho. Devices stay enrolled."),
          h("button", { class: "btn btn-sm btn-danger", type: "button", onclick: deleteGroup }, "Delete group"),
        ) : null,
      ),
    ),
  );
}


