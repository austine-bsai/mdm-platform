import { del, get, post } from "../api.js";
import { ago, badge, clear, emptyState, field, h, icon, input, loading, modal, pageHeader, responsive, select, toast, toastError, toastEvent } from "../ui.js";

let catalogCache = null;

export async function profilesView(el, ctx) {
  clear(el, loading());
  const [profiles, catalog] = await Promise.all([get("/api/profiles"), (catalogCache ??= get("/api/profiles/catalog"))]);
  const admin = ctx.can("admin");
  const newBtn = admin ? h("button", { class: "btn btn-primary", type: "button", onclick: () => profileWizard(el, ctx, catalog) }, icon("plus"), "New profile") : null;

  clear(
    el,
    pageHeader("Profiles", "One purpose per profile: restrictions, kiosk, passcode or factory-reset protection. Create it, publish it, then assign it to groups.", [newBtn]),
    profiles.length
      ? h("section", { class: "card card-flush" }, h("div", { class: "table-wrap" }, responsive(h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Purpose"), h("th", {}, "State"), h("th", {}, "Groups"), h("th", {}, "Updated"), h("th", {}, ""))),
        h("tbody", {}, profiles.map((p) =>
          h("tr", {},
            h("td", {}, h("strong", {}, p.name), p.description ? h("div", { class: "muted" }, p.description) : null),
            h("td", {}, p.purpose, h("div", { class: "muted small" }, (p.payload_names ?? []).join(", "))),
            h("td", {}, badge(p.state)),
            h("td", {}, (p.profile_groups ?? []).map((pg) => badge(pg.groups?.name ?? "", "muted"))),
            h("td", { class: "muted" }, ago(p.updated_at)),
            h("td", { class: "actions" },
              admin && p.state !== "published" ? h("button", { class: "btn btn-sm btn-primary", type: "button", onclick: async () => {
                try {
                  toastEvent(await post(`/api/profiles/${p.id}/publish`, {}), "Published");
                  profilesView(el, ctx);
                } catch (err) {
                  toastError(err);
                }
              } }, p.state === "modified" ? "Re-publish" : "Publish") : null,
              admin ? h("button", { class: "btn btn-sm", type: "button", onclick: () => profileWizard(el, ctx, catalog, p) }, "Add policy") : null,
              ctx.can("owner") ? h("button", { class: "btn btn-sm btn-ghost", type: "button", onclick: () => modal("Delete profile?", h("p", {}, `Delete "${p.name}" in Zoho? It is removed from all groups.`), [
                { label: "Cancel" },
                { label: "Delete", tone: "danger", onClick: async () => {
                  toastEvent(await del(`/api/profiles/${p.id}`), "Profile deleted");
                  profilesView(el, ctx);
                } },
              ]) }, "Delete") : null,
            ),
          )
        )),
      ))))
      : emptyState("No profiles yet", "Start with a Baseline – Security profile: restrictions + passcode.", newBtn),
  );
}

/** Create a profile, or add a policy to an existing one (when `existing` is passed). */
function profileWizard(el, ctx, catalog, existing) {
  const name = input({ maxlength: 100, placeholder: "Baseline – Security", value: existing?.name ?? "" });
  const desc = input({ maxlength: 300 });
  const platform = select([{ value: "android", label: "Android" }, { value: "ios", label: "Apple (custom payload only)" }]);
  const purpose = select(catalog.purposes.map((p) => ({ value: p.id, label: p.label })));
  platform.addEventListener("change", () => {
    if (platform.value === "ios") purpose.value = "custom";
    renderForm();
  });
  const formBox = h("div", { class: "stack" });
  let collect = () => ({});

  const renderForm = () => {
    const kind = purpose.value;
    if (kind === "restrictions") {
      const choices = {};
      const rows = catalog.restrictions.map((r) => {
        const s = select([{ value: "", label: "Not managed" }, { value: "allow", label: "Allow" }, { value: "restrict", label: "Restrict" }], { "aria-label": r.label });
        choices[r.key] = s;
        return h("div", { class: "restriction" }, h("span", {}, r.label, h("span", { class: "muted small" }, ` · ${r.category}`)), s);
      });
      const preset = h("button", { class: "btn btn-sm", type: "button", onclick: () => {
        for (const r of catalog.restrictions) choices[r.key].value = r.recommended;
        toast("Recommended corporate baseline applied", "info");
      } }, "Use recommended baseline");
      clear(formBox, h("div", { class: "row" }, h("h3", {}, "Restrictions"), preset), h("div", { class: "restrictions" }, rows));
      collect = () => {
        const restrictions = {};
        for (const [k, s] of Object.entries(choices)) if (s.value) restrictions[k] = s.value;
        return { restrictions };
      };
    } else if (kind === "kiosk") {
      const mode = select([{ value: "single", label: "Single app" }, { value: "multi", label: "Multiple apps" }]);
      const appsBox = h("div", { class: "stack" }, h("p", { class: "muted" }, "Loading apps from Zoho…"));
      const picks = [];
      get("/api/apps").then((apps) => {
        const android = apps.filter((a) => Number(a.platform_type) === 2 || a.platform_type === undefined);
        clear(appsBox, android.length
          ? android.map((a) => {
            const cb = h("input", { type: "checkbox" });
            const pkg = input({ placeholder: "package name, e.g. com.acme.pos", value: a.bundle_identifier ?? a.identifier ?? "" });
            picks.push({ a, cb, pkg });
            return h("div", { class: "kiosk-app" }, h("label", { class: "pick" }, cb, h("span", {}, a.app_name)), pkg);
          })
          : h("p", { class: "muted" }, "No apps in the Zoho app repository yet. Add the app in Zoho first."));
      }).catch((err) => {
        clear(appsBox, h("p", { class: "muted" }, "Could not load apps from Zoho."));
        toastError(err);
      });
      const statusBar = h("input", { type: "checkbox" });
      clear(formBox, field("Mode", mode), h("h3", {}, "Apps"), appsBox, h("label", { class: "pick" }, statusBar, h("span", {}, "Allow status bar")));
      collect = () => ({
        mode: mode.value,
        apps: picks.filter((p) => p.cb.checked).map((p) => ({ appId: String(p.a.app_id), packageName: p.pkg.value.trim(), name: p.a.app_name })),
        allowStatusBar: statusBar.checked,
      });
    } else if (kind === "passcode") {
      const type = select([{ value: "2", label: "Numbers" }, { value: "4", label: "Alphanumeric" }, { value: "5", label: "Complex" }]);
      const len = input({ type: "number", min: 4, max: 16, value: 6 });
      const wipe = input({ type: "number", min: -1, max: 16, value: 10 });
      const lock = input({ type: "number", min: 5, max: 1800, value: 300 });
      clear(formBox,
        field("Passcode type", type),
        field("Minimum length", len),
        field("Wipe after failed attempts", wipe, "4–16 wrong attempts fully wipe the device. −1 disables wipe."),
        field("Auto-lock after (seconds)", lock));
      collect = () => ({ passcodeType: Number(type.value), minLength: Number(len.value), maxFailedAttempts: Number(wipe.value), autoLockSeconds: Number(lock.value) });
    } else if (kind === "frp") {
      const id = input({ placeholder: "Google account user id (from Zoho FRP help)" });
      const em = input({ type: "email", placeholder: "frp-admin@company.co.tz" });
      clear(formBox, h("p", { class: "muted" }, "After a factory reset, only this Google account can set the device up again."), field("Account user id", id), field("Account email", em));
      collect = () => ({ accounts: [{ emailUserId: id.value.trim(), email: em.value.trim() }] });
    } else {
      const pn = input({ placeholder: "e.g. ANDROID_WIFI_POLICY" });
      const json = h("textarea", { rows: 10, class: "mono", placeholder: '{ "ssid": "Office" }' });
      clear(formBox, h("p", { class: "muted" }, "Payload name and fields exactly as in the MDM developer guide."), field("Payload name", pn), field("Payload JSON", json));
      collect = () => {
        try {
          return { payloadName: pn.value.trim(), payload: JSON.parse(json.value || "{}") };
        } catch {
          throw Object.assign(new Error("Payload JSON is not valid"), { code: "VALIDATION_FAILED" });
        }
      };
    }
  };
  purpose.addEventListener("change", renderForm);
  renderForm();

  const header = existing
    ? [h("p", { class: "muted" }, `Adds another policy to "${existing.name}". Re-publish afterwards to apply it.`), field("Policy", purpose)]
    : [field("Name", name), field("Description", desc), field("Platform", platform), field("Purpose", purpose)];

  modal(existing ? "Add policy" : "New profile", h("div", { class: "stack" }, header, formBox), [
    { label: "Cancel" },
    {
      label: existing ? "Add policy" : "Create draft",
      tone: "primary",
      onClick: async () => {
        const config = collect();
        const res = existing
          ? await post(`/api/profiles/${existing.id}/policies`, { purpose: purpose.value, config })
          : await post("/api/profiles", { name: name.value, description: desc.value, platform: platform.value, purpose: purpose.value, config });
        toastEvent(res, existing ? "Policy added — re-publish to apply" : "Profile created as draft — publish it next");
        profilesView(el, ctx);
      },
    },
  ]);
}
