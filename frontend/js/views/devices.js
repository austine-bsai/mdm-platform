import { get, newIdempotencyKey, post } from "../api.js";
import { confirmDestructive, DESTRUCTIVE } from "../confirm.js";
import { ago, badge, clear, emptyState, field, fmtTime, h, icon, input, jsonBlock, loading, modal, pageHeader, select, table, toast, toastError, toastEvent } from "../ui.js";

let actionsCache = null;
const actions = async () => (actionsCache ??= await get("/api/devices/actions"));
const platformName = (p) => ({ ios: "Apple", android: "Android", macos: "macOS", windows: "Windows", chrome: "ChromeOS" }[p] ?? p ?? "—");

// Device is "stale" when it hasn't checked in to Zoho for > STALE_HOURS.
// Match the backend DEVICE_STALE_HOURS default. Only shown for not-removed devices.
const STALE_HOURS = 48;
const isStale = (d) => {
  if (d.is_removed || !d.last_contact_at) return false;
  const ms = Date.now() - Date.parse(d.last_contact_at);
  return ms > STALE_HOURS * 3600_000;
};

// Management mode: which authority the MDM agent has on the device.
// Returned as { label, tone, hint } or null if unknown. Hint explains what the
// mode can/can't enforce — surfaces WHY a policy might not apply to this device.
function adminMode(d) {
  if (d.is_profileowner === true) {
    return { label: "work profile", tone: "info", hint: "Agent only controls the work-profile container. Device-wide restrictions won't apply." };
  }
  if (d.is_supervised === true) {
    return { label: "supervised", tone: "ok", hint: "Agent has device-wide authority. All profile restrictions should apply." };
  }
  if (d.owned_by === 2) {
    return { label: "personal", tone: "warn", hint: "BYOD / personal device. Most device-wide restrictions won't apply." };
  }
  if (d.is_supervised === false) {
    return { label: "unmanaged", tone: "warn", hint: "Agent lacks supervision. Many restrictions silently ignored by Android." };
  }
  return null;
}

// ------------------------------------------------------------------ list
export async function devicesView(el, ctx, params) {
  clear(el, loading());
  const [devices, groups] = await Promise.all([get("/api/devices"), get("/api/groups")]);
  const selected = new Set();

  const search = input({ type: "search", placeholder: "Name, model or user", "aria-label": "Search devices", value: params?.get("q") ?? "" });
  const platform = select([{ value: "", label: "All platforms" }, { value: "android", label: "Android" }, { value: "ios", label: "Apple" }], { "aria-label": "Platform" });
  const groupSel = select([{ value: "", label: "All groups" }, ...groups.map((g) => ({ value: g.id, label: g.name }))], { "aria-label": "Group" });
  const lostOnly = h("input", { type: "checkbox", checked: params?.get("lost") === "1" });
  const tableBox = h("div");
  const selBar = h("div", { class: "selection-bar", hidden: true });

  const refreshSel = () => {
    selBar.hidden = !selected.size || !ctx.can("admin");
    clear(selBar,
      h("strong", {}, `${selected.size} selected`),
      h("div", { class: "spacer" }),
      h("button", { class: "btn btn-sm", type: "button", onclick: bulkGroup }, "Add to group"),
      h("button", { class: "btn btn-sm", type: "button", onclick: bulkCmd }, "Send command"),
      h("button", { class: "btn btn-sm", type: "button", onclick: () => { selected.clear(); draw(); } }, "Clear"),
    );
  };

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const rows = devices.filter((d) =>
      (!platform.value || d.platform === platform.value) &&
      (!groupSel.value || (d.group_devices ?? []).some((g) => g.groups?.id === groupSel.value)) &&
      (!lostOnly.checked || d.is_lost_mode) &&
      (!q || `${d.device_name} ${d.model} ${d.mdm_users?.user_name ?? ""}`.toLowerCase().includes(q))
    );
    const cols = [
      ctx.can("admin") ? { label: "Select", class: "check", cell: (d) => h("input", {
        type: "checkbox", "aria-label": `Select ${d.device_name}`, checked: selected.has(d.id),
        onchange: (e) => { e.target.checked ? selected.add(d.id) : selected.delete(d.id); refreshSel(); },
      }) } : null,
      { label: "Device", primary: true, cell: (d) => {
        const mode = adminMode(d);
        return h("div", {},
          h("a", { class: "link", href: `#/devices/${d.id}` }, d.device_name ?? "Unnamed"),
          d.is_lost_mode ? [" ", badge("lost mode", "warn")] : null,
          isStale(d) ? [" ", badge("stale", "warn")] : null,
          mode ? [" ", h("span", { title: mode.hint }, badge(mode.label, mode.tone))] : null,
          h("div", { class: "cell-sub" }, `${platformName(d.platform)} · ${d.model ?? "unknown model"}`));
      } },
      { label: "User", cell: (d) => d.mdm_users?.user_name ?? h("span", { class: "muted" }, "Unassigned") },
      { label: "Groups", cell: (d) => (d.group_devices ?? []).length ? h("span", { class: "chips" }, d.group_devices.map((g) => badge(g.groups?.name ?? "", g.groups?.kind === "function" ? "info" : "muted"))) : h("span", { class: "muted" }, "None") },
      { label: "Last seen", cell: (d) => h("span", { class: isStale(d) ? "warn nowrap" : "muted nowrap" }, d.last_contact_at ? ago(d.last_contact_at) : "never") },
    ].filter(Boolean);
    clear(tableBox,
      h("p", { class: "muted small" }, `${rows.length} of ${devices.length} devices`),
      table(cols, rows, { empty: "No devices match these filters." }),
    );
    refreshSel();
  };
  for (const c of [search, platform, groupSel, lostOnly]) c.addEventListener(c === search ? "input" : "change", draw);

  function bulkGroup() {
    const pick = select(groups.map((g) => ({ value: g.id, label: `${g.name} (${g.kind})` })));
    if (!groups.length) return toast("Create a group first", "warn");
    modal("Add devices to group", field("Group", pick, "Profiles attached to the group install automatically."), [
      { label: "Cancel" },
      { label: "Add", tone: "primary", onClick: async () => {
        toastEvent(await post(`/api/groups/${pick.value}/devices`, { deviceIds: [...selected] }), "Devices added to group");
        devicesView(el, ctx, params);
      } },
    ]);
  }
  async function bulkCmd() {
    // Never offer wipes/passcodes in bulk, even if the server's flags were changed.
    const list = (await actions()).filter((a) => !a.confirm && !DESTRUCTIVE.has(a.id) && !/kiosk/.test(a.id) && ctx.can(a.minRole));
    const pick = select(list.map((a) => ({ value: a.id, label: a.label })));
    modal(`Command for ${selected.size} device(s)`, field("Action", pick, "Wipe and passcode actions run one device at a time from the device page."), [
      { label: "Cancel" },
      { label: "Send", tone: "primary", onClick: async () => toastEvent(await post("/api/commands", { deviceIds: [...selected], action: pick.value }), "Command sent") },
    ]);
  }

  clear(
    el,
    pageHeader("Devices", "Devices enrolled in Zoho. Enrol new phones with the Zoho QR code or afw#memdm, then sync."),
    devices.length
      ? h("section", { class: "card" },
        h("div", { class: "toolbar" }, search, platform, groupSel, h("label", { class: "pick" }, lostOnly, "Lost mode only")),
        selBar,
        tableBox,
      )
      : h("section", { class: "card" }, emptyState("No devices yet", "Connect Zoho in Settings, enrol a device, then press Sync now.", h("a", { class: "btn btn-primary", href: "#/settings?tab=connection" }, "Go to connection settings"))),
  );
  if (devices.length) draw();
}

// ------------------------------------------------------------------ detail page
export async function deviceDetailView(el, ctx, id) {
  clear(el, loading());
  const [d, acts, alerts] = await Promise.all([
    get(`/api/devices/${id}`),
    actions(),
    get(`/api/alerts?status=active&device_id=${encodeURIComponent(id)}`).catch(() => []),
  ]);
  // Only show actions the device's platform supports — Zoho otherwise answers
  // COM0007 "Command not applicable for Device". Android shutdown/restart need Samsung Knox.
  const supports = (a) => {
    if (!a.platforms?.length) return true;
    if (!a.platforms.includes(d.platform)) return false;
    if (d.platform === "android" && a.knoxOnlyAndroid && !d.is_knox) return false;
    return true;
  };
  const allowed = acts.filter((a) => ctx.can(a.minRole) && supports(a));
  const isDanger = (a) => a.confirm || DESTRUCTIVE.has(a.id);
  // Kiosk commands only when one of the device's groups gives it a kiosk profile (Zoho rejects them otherwise).
  const safe = allowed.filter((a) => !isDanger(a) && (d.kiosk || !/kiosk/.test(a.id)));
  const danger = allowed.filter(isDanger);
  const reload = () => deviceDetailView(el, ctx, id);
  const historyBox = h("div");
  const appsBox = h("div");

  const facts = [
    ["Platform", platformName(d.platform)],
    ["Model", d.model],
    ["OS version", d.os_version],
    ["User", d.mdm_users ? [d.mdm_users.user_name, d.mdm_users.email].filter(Boolean).join(" · ") : "Unassigned"],
    ["Ownership", d.owned_by === 1 ? "Corporate" : d.owned_by === 2 ? "Personal (work profile)" : "—"],
    ["Management mode", (() => {
      const m = adminMode(d);
      return m ? [badge(m.label, m.tone), h("div", { class: "muted small" }, m.hint)] : h("span", { class: "muted" }, "unknown");
    })()],
    ["IMEI", d.imei],
    ["Serial", d.serial_number],
    ["Zoho device id", d.zoho_device_id],
    ["Enrolled", fmtTime(d.added_at)],
    ["Last contact (device → Zoho)", d.last_contact_at ? [ago(d.last_contact_at), isStale(d) ? [" ", badge("stale", "warn")] : null] : h("span", { class: "muted" }, "never")],
    ["Last synced (Zoho → us)", ago(d.last_synced_at)],
  ];

  clear(
    el,
    pageHeader(d.device_name ?? "Device", null, [
      ctx.can("admin") ? h("a", { class: "btn", href: `#/locations` }, icon("locations"), "Locations") : null,
    ], { href: "#/devices", label: "Devices" }),
    h("div", { class: "card" }, h("div", { class: "detail-head" },
      h("div", { class: "device-glyph" }, icon("devices")),
      h("div", {},
        h("div", { class: "cell-title" }, `${platformName(d.platform)} · ${d.model ?? "unknown model"}`),
        h("div", { class: "chips" },
          d.is_lost_mode ? badge("lost mode", "warn") : null,
          d.is_removed ? badge("removed from Zoho", "bad") : badge("enrolled", "ok"),
          (d.group_devices ?? []).map((g) => h("a", { href: `#/groups/${g.groups?.id}`, class: "badge badge-info" }, g.groups?.name)),
        ),
      ),
    )),
    alerts.length
      ? h("div", { class: "banner banner-warn" }, icon("alerts"), h("div", {}, h("strong", {}, `${alerts.length} open alert(s): `), alerts.map((a) => a.title).join(" · "), " ", h("a", { href: "#/alerts" }, "Review")))
      : null,
    h("div", { class: "split" },
      h("div", {},
        safe.length ? h("section", { class: "card" },
          h("div", { class: "card-head" }, h("h2", {}, "Remote actions")),
          h("div", { class: "action-grid" }, safe.map((a) => h("button", { class: "btn", type: "button", onclick: () => runAction(d, a, reload) }, a.label))),
        ) : null,
        h("section", { class: "card" },
          h("div", { class: "card-head" }, h("h2", {}, "Installed apps")),
          h("p", { class: "muted small" }, "Live from Zoho when loaded. Not stored locally."),
          h("div", { class: "btn-row" }, h("button", { class: "btn btn-sm", type: "button", onclick: async () => {
            clear(appsBox, loading());
            try {
              const apps = await get(`/api/devices/${id}/apps`);
              clear(appsBox, apps.length
                ? h("ul", { class: "list" }, apps.map((a) => h("li", {},
                  h("strong", {}, a.app_name ?? "App"),
                  h("span", { class: "muted small" }, ` · ${a.identifier ?? ""} · v${a.app_version ?? "?"}`),
                )))
                : h("p", { class: "muted" }, "No apps reported for this device."));
            } catch (err) {
              clear(appsBox);
              toastError(err);
            }
          } }, "Fetch installed apps")),
          appsBox,
        ),
        h("section", { class: "card" },
          h("div", { class: "card-head" }, h("h2", {}, "Recent events"), h("a", { href: "#/activity" }, "All activity")),
          d.events.length
            ? h("ul", { class: "feed" }, d.events.slice(0, 15).map((e) => h("li", {}, badge(e.state), h("span", { class: "feed-action" }, e.action.replace(/_/g, " ")), e.error_message ? h("span", { class: "muted small" }, e.error_message) : null, h("span", { class: "muted feed-time" }, ago(e.action_time)))))
            : h("p", { class: "muted" }, "No actions on this device yet."),
          h("div", { class: "btn-row" }, h("button", { class: "btn btn-sm", type: "button", onclick: async () => {
            clear(historyBox, loading());
            try {
              clear(historyBox, jsonBlock(await get(`/api/devices/${id}/history?days=14`)));
            } catch (err) {
              clear(historyBox);
              toastError(err);
            }
          } }, "Load 14-day command history from Zoho")),
          historyBox,
        ),
      ),
      h("div", {},
        h("section", { class: "card" },
          h("div", { class: "card-head" }, h("h2", {}, "Details")),
          h("dl", { class: "facts" }, facts.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v ?? "—")])),
          ctx.can("admin") ? h("p", { class: "hint" }, "Profiles reach this device through its groups. To change its settings, change its group.") : null,
        ),
        danger.length ? h("section", { class: "card danger-zone" },
          h("div", { class: "card-head" }, h("h2", {}, "Destructive actions")),
          h("p", { class: "muted small" }, `Each needs a code from your email and the last 4 characters of the ${d.confirm_tag?.source ?? "serial number"}, so two phones with the same name can't be mixed up.`),
          h("div", { class: "btn-row" }, danger.map((a) => h("button", { class: "btn btn-sm btn-danger", type: "button", onclick: () => runAction(d, a, reload) }, a.label))),
        ) : null,
      ),
    ),
  );
}

function runAction(device, action, done) {
  const extra = [];
  const get = [];
  if (action.params.includes("lock_message")) {
    const msg = input({ maxlength: 200, placeholder: "e.g. This phone belongs to Acme. Call +255…" });
    extra.push(field("Lock-screen message", msg));
    get.push(() => (msg.value ? { lock_message: msg.value } : {}));
  }
  if (action.id === "reset_passcode") {
    const pw = input({ type: "password", minlength: 4, maxlength: 16, autocomplete: "new-password", placeholder: "4–16 characters" });
    extra.push(field("New passcode", pw, "Leave empty to let Zoho clear it so the user sets a new one."));
    get.push(() => (pw.value ? { passcode: pw.value, email_sent_to_user: true } : {}));
  }
  const params = () => Object.assign({}, ...get.map((g) => g()));

  if (!action.confirm && !DESTRUCTIVE.has(action.id)) {
    const go = async () => {
      const res = await post("/api/commands", { deviceIds: [device.id], action: action.id, params: params() });
      toastEvent(res, `${action.label} sent`);
      done?.();
    };
    if (!extra.length) return go().catch(toastError);
    return modal(action.label, h("div", { class: "stack" }, extra), [{ label: "Cancel" }, { label: "Send", tone: "primary", onClick: go }]);
  }

  // Two-step: (1) server emails a code to your sign-in email, (2) code + serial tail (confirm.js).
  const idem = newIdempotencyKey();
  const tag = device.confirm_tag;
  modal(`${action.label}?`, h("div", { class: "stack" },
    h("p", {}, `This runs "${action.label}" on `, h("strong", {}, device.device_name ?? "this device"),
      tag ? ` (${tag.source} ending ${tag.tag})` : "", ". ",
      action.id === "complete_wipe" ? "Everything on the phone is erased and cannot be recovered." : ""),
    ...extra,
    h("p", { class: "muted" }, "Step 1 of 2: we email a confirmation code to your sign-in email."),
  ), [
    { label: "Cancel" },
    { label: "Email me the code", tone: "danger", onClick: async () => {
      const res = await post("/api/commands", { deviceIds: [device.id], action: action.id, params: params() }, { idem });
      confirmDestructive(res, action.label, () => done?.());
    } },
  ]);
}
