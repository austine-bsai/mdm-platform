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
              h("button", { class: "btn btn-sm", type: "button", onclick: () => viewProfile(ctx, catalog, p.id) }, "View"),
              admin && p.state !== "published" ? h("button", { class: "btn btn-sm btn-primary", type: "button", onclick: async () => {
                try {
                  toastEvent(await post(`/api/profiles/${p.id}/publish`, {}), "Published");
                  profilesView(el, ctx);
                } catch (err) {
                  toastError(err);
                }
              } }, p.state === "modified" ? "Re-publish" : "Publish") : null,
              admin ? h("button", { class: "btn btn-sm", type: "button", onclick: () => profileWizard(el, ctx, catalog, p) }, "Add policy") : null,
              ctx.can("owner") ? h("button", { class: "btn btn-sm btn-ghost", type: "button", onclick: () => modal("Delete profile?", h("p", {}, `Delete "${p.name}"? It is removed from all groups and hidden from this view immediately.`), [
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
      // Per restriction kind: binary / enum use <select>, integer uses <input type=number>,
      // boolean uses a tri-state <select> (not managed / on / off) so admins can still skip it.
      const choices = {};
      const read = {};
      const apply = {};
      const rowFor = (r) => {
        let control;
        if (r.kind === "boolean") {
          const s = select([{ value: "", label: "Not managed" }, { value: "true", label: "On" }, { value: "false", label: "Off" }], { "aria-label": r.label });
          control = s;
          read[r.key] = () => s.value === "" ? undefined : s.value === "true";
          apply[r.key] = (v) => { s.value = v === undefined ? "" : (v ? "true" : "false"); };
        } else if (r.kind === "integer") {
          const inp = input({ type: "number", min: r.min, max: r.max, placeholder: `${r.min}–${r.max}` });
          control = inp;
          read[r.key] = () => inp.value === "" ? undefined : Number(inp.value);
          apply[r.key] = (v) => { inp.value = v === undefined ? "" : String(v); };
        } else if (r.kind === "enum") {
          const opts = [{ value: "", label: "Not managed" }, ...r.options.map((o) => ({ value: String(o.value), label: o.label }))];
          const s = select(opts, { "aria-label": r.label });
          control = s;
          read[r.key] = () => {
            if (s.value === "") return undefined;
            const match = r.options.find((o) => String(o.value) === s.value);
            return match ? match.value : s.value;
          };
          apply[r.key] = (v) => { s.value = v === undefined ? "" : String(v); };
        } else {
          const s = select([{ value: "", label: "Not managed" }, { value: "allow", label: "Allow" }, { value: "restrict", label: "Restrict" }], { "aria-label": r.label });
          control = s;
          read[r.key] = () => s.value || undefined;
          apply[r.key] = (v) => { s.value = v ?? ""; };
        }
        choices[r.key] = control;
        const unit = r.kind === "integer" && r.unit ? h("span", { class: "muted small" }, ` ${r.unit}`) : null;
        const hint = r.hint ? h("div", { class: "muted small" }, r.hint) : null;
        return h("div", { class: "restriction" },
          h("span", {}, r.label, h("span", { class: "muted small" }, ` · ${r.category}`), hint),
          h("span", {}, control, unit),
        );
      };
      // Group rows by category so the long list stays navigable.
      const byCat = catalog.restrictions.reduce((acc, r) => {
        (acc[r.category] ??= []).push(r);
        return acc;
      }, {});
      const sections = Object.entries(byCat).map(([cat, defs]) =>
        h("div", { class: "stack" }, h("h4", { class: "section-head" }, cat), h("div", { class: "restrictions" }, defs.map(rowFor))),
      );
      const preset = h("button", { class: "btn btn-sm", type: "button", onclick: () => {
        for (const r of catalog.restrictions) if (r.recommended !== undefined) apply[r.key](r.recommended);
        toast("Recommended corporate baseline applied", "info");
      } }, "Use recommended baseline");
      clear(formBox, h("div", { class: "row" }, h("h3", {}, "Restrictions"), preset), ...sections);
      collect = () => {
        const restrictions = {};
        for (const [k, get] of Object.entries(read)) {
          const v = get();
          if (v !== undefined) restrictions[k] = v;
        }
        return { restrictions };
      };
    } else if (kind === "kiosk") {
      const mode = select([{ value: "single", label: "Single app" }, { value: "multi", label: "Multiple apps" }]);
      const appsBox = h("div", { class: "stack" }, h("p", { class: "muted" }, "Loading apps from Zoho…"));
      // Each pick: Zoho-repo entry (cb + pkg) or manual entry (name + pkg, always on).
      const picks = [];
      let nextManualId = 1;

      const manualRow = () => {
        const id = `manual-${Date.now()}-${nextManualId++}`;
        const name = input({ placeholder: "App display name" });
        const pkg = input({ placeholder: "package name, e.g. com.acme.pos" });
        const row = h("div", { class: "kiosk-app" },
          h("span", {}, "✱ manual"),
          name,
          pkg,
          h("button", { class: "btn btn-xs", type: "button", onclick: () => { picks.splice(picks.findIndex((p) => p.a.app_id === id), 1); row.remove(); } }, "Remove"),
        );
        picks.push({ a: { app_id: id, app_name: null }, cb: { checked: true }, pkg, name, manual: true });
        return row;
      };

      const addManual = h("button", { class: "btn btn-sm", type: "button", onclick: () => appsBox.appendChild(manualRow()) }, "+ Add app by package name");

      get("/api/apps").then((apps) => {
        const android = apps.filter((a) => Number(a.platform_type) === 2 || a.platform_type === undefined);
        if (android.length) {
          clear(appsBox, ...android.map((a) => {
            const cb = h("input", { type: "checkbox" });
            const pkg = input({ placeholder: "package name, e.g. com.acme.pos", value: a.bundle_identifier ?? a.identifier ?? "" });
            picks.push({ a, cb, pkg, manual: false });
            return h("div", { class: "kiosk-app" }, h("label", { class: "pick" }, cb, h("span", {}, a.app_name)), pkg);
          }), addManual);
        } else {
          clear(appsBox,
            h("p", { class: "muted small" }, "The Zoho app repository is empty. Upload the kiosk app there, OR add it below by its Android package name (works if the app is already installed on the device)."),
            addManual,
          );
        }
      }).catch((err) => {
        clear(appsBox, h("p", { class: "muted" }, "Could not load apps from Zoho. You can still add by package name:"), addManual);
        toastError(err);
      });

      // Hardware buttons — Zoho defaults all true; most kiosk deployments restrict most.
      const statusBar = h("input", { type: "checkbox" });
      const statusBarExpansion = h("input", { type: "checkbox" });
      const homeButton = h("input", { type: "checkbox", checked: true });
      const backButton = h("input", { type: "checkbox", checked: true });
      const powerButton = h("input", { type: "checkbox", checked: true });
      const volumeButton = h("input", { type: "checkbox", checked: true });
      const shutdown = h("input", { type: "checkbox", checked: true });
      const keyGuard = h("input", { type: "checkbox", checked: true });
      // UI chrome
      const notification = h("input", { type: "checkbox", checked: true });
      const recentApps = h("input", { type: "checkbox", checked: true });
      const taskManager = h("input", { type: "checkbox", checked: true });
      const systemError = h("input", { type: "checkbox" });
      const customSettings = h("input", { type: "checkbox", checked: true });
      const mdmApp = h("input", { type: "checkbox", checked: true });
      // Launcher / display
      const launcher = select([{ value: "2", label: "MDM launcher" }, { value: "1", label: "Default device launcher" }]);
      const orientation = select([{ value: "2", label: "User controlled" }, { value: "1", label: "Auto rotate" }, { value: "3", label: "Portrait" }, { value: "4", label: "Landscape" }]);
      const timeout = select([
        { value: "0", label: "User controlled" }, { value: "15", label: "15 seconds" }, { value: "30", label: "30 seconds" }, { value: "60", label: "1 minute" },
        { value: "300", label: "5 minutes" }, { value: "1800", label: "30 minutes" }, { value: "2147483647", label: "Always on" },
      ]);

      const checkbox = (el, label) => h("label", { class: "pick" }, el, h("span", {}, label));

      const lockdown = h("button", { class: "btn btn-sm", type: "button", onclick: () => {
        // Classic kiosk lockdown: hide every button + chrome, keep power + volume.
        statusBar.checked = false; statusBarExpansion.checked = false;
        homeButton.checked = false; backButton.checked = false;
        powerButton.checked = true; volumeButton.checked = true; shutdown.checked = false; keyGuard.checked = false;
        notification.checked = false; recentApps.checked = false; taskManager.checked = false;
        systemError.checked = false; customSettings.checked = false; mdmApp.checked = false;
        launcher.value = "2"; orientation.value = "2"; timeout.value = "2147483647";
        toast("Lockdown preset applied", "info");
      } }, "Use lockdown preset");

      clear(formBox,
        field("Mode", mode),
        h("h3", {}, "Apps"),
        appsBox,
        h("div", { class: "row" }, h("h3", {}, "Device behavior"), lockdown),
        h("h4", { class: "section-head" }, "launcher"),
        field("Launcher", launcher),
        field("Screen orientation", orientation),
        field("Screen timeout", timeout),
        h("h4", { class: "section-head" }, "hardware buttons"),
        h("div", { class: "restrictions" },
          checkbox(statusBar, "Allow status bar"),
          checkbox(statusBarExpansion, "Allow pulling status bar down for quick settings"),
          checkbox(homeButton, "Allow home button"),
          checkbox(backButton, "Allow back button"),
          checkbox(powerButton, "Allow power button"),
          checkbox(volumeButton, "Allow volume buttons"),
          checkbox(shutdown, "Allow shutdown"),
          checkbox(keyGuard, "Allow unlock without passcode (key guard)"),
        ),
        h("h4", { class: "section-head" }, "ui chrome"),
        h("div", { class: "restrictions" },
          checkbox(notification, "Allow notifications"),
          checkbox(recentApps, "Allow recent apps switcher"),
          checkbox(taskManager, "Allow task manager"),
          checkbox(systemError, "Show app crash dialogs"),
          checkbox(customSettings, "Allow MDM custom settings app"),
          checkbox(mdmApp, "Show ME MDM app on home screen"),
        ),
      );

      collect = () => ({
        mode: mode.value,
        apps: picks
          .filter((p) => p.cb.checked && p.pkg.value.trim())
          .map((p) => ({
            appId: String(p.a.app_id),
            packageName: p.pkg.value.trim(),
            name: p.manual ? (p.name.value.trim() || p.pkg.value.trim()) : p.a.app_name,
          })),
        allowStatusBar: statusBar.checked,
        allowStatusBarExpansion: statusBarExpansion.checked,
        allowHomeButton: homeButton.checked,
        allowBackButton: backButton.checked,
        allowPowerButton: powerButton.checked,
        allowVolumeButton: volumeButton.checked,
        allowShutdown: shutdown.checked,
        allowKeyGuard: keyGuard.checked,
        allowNotification: notification.checked,
        allowRecentApps: recentApps.checked,
        allowTaskManager: taskManager.checked,
        allowSystemErrorDialog: systemError.checked,
        allowCustomSettings: customSettings.checked,
        showMeMdmApp: mdmApp.checked,
        launcherType: Number(launcher.value),
        screenOrientation: Number(orientation.value),
        screenTimeout: Number(timeout.value),
      });
    } else if (kind === "passcode") {
      const type = select([{ value: "2", label: "Numbers" }, { value: "4", label: "Alphanumeric" }, { value: "5", label: "Complex" }]);
      const len = input({ type: "number", min: 4, max: 16, value: 6 });
      const wipe = input({ type: "number", min: -1, max: 16, value: 10 });
      const lock = input({ type: "number", min: 5, max: 1800, value: 300 });
      const grace = input({ type: "number", min: 1, max: 1000, value: 60 });
      const fingerprint = h("input", { type: "checkbox", checked: true });
      const faceUnlock = h("input", { type: "checkbox", checked: true });
      clear(formBox,
        h("p", { class: "muted small" }, "Enforces passcode rules only — it does not create a passcode. To actually set one, use ", h("strong", {}, "Set passcode on all members"), " from the group page."),
        field("Passcode type", type),
        field("Minimum length", len),
        field("Wipe after failed attempts", wipe, "4–16 wrong attempts fully wipe the device. −1 disables wipe."),
        field("Auto-lock after (seconds)", lock),
        field("Grace period (minutes)", grace, "Minutes before Android starts prompting the user to comply."),
        h("label", { class: "pick" }, fingerprint, h("span", {}, "Allow fingerprint unlock")),
        h("label", { class: "pick" }, faceUnlock, h("span", {}, "Allow face unlock")),
      );
      collect = () => ({
        passcodeType: Number(type.value),
        minLength: Number(len.value),
        maxFailedAttempts: Number(wipe.value),
        autoLockSeconds: Number(lock.value),
        gracePeriodMinutes: Number(grace.value),
        allowFingerprint: fingerprint.checked ? 1 : 0,
        allowFaceUnlock: faceUnlock.checked,
      });
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

// --------------------------------------------- read-only payload inspector
// Shows what's actually stored in a profile's payloads. Uses the restrictions
// catalog to map raw Zoho keys/values back to human labels when it recognises
// them; falls back to raw key: value otherwise.
async function viewProfile(ctx, catalog, profileId) {
  let p;
  try {
    p = await get(`/api/profiles/${profileId}`);
  } catch (err) {
    toastError(err);
    return;
  }
  const restrictionBy = Object.fromEntries((catalog.restrictions ?? []).map((r) => [r.key, r]));
  const prettyRestriction = (key, val) => {
    const def = restrictionBy[key];
    if (!def) return [key, String(val)];
    if (def.kind === "binary") {
      const label = Number(val) === def.allow ? "Allow" : Number(val) === def.restrict ? "Restrict" : String(val);
      return [def.label, label];
    }
    if (def.kind === "enum") {
      const match = def.options.find((o) => String(o.value) === String(val));
      return [def.label, match ? match.label : String(val)];
    }
    if (def.kind === "integer") {
      return [def.label, def.unit ? `${val} ${def.unit}` : String(val)];
    }
    return [def.label, val ? "On" : "Off"];
  };

  const payloadCfg = p.payload_config ?? {};
  const payloadNames = (p.payload_names ?? []).length ? p.payload_names : Object.keys(payloadCfg);

  const sections = payloadNames.length ? payloadNames.map((pname) => {
    const body = payloadCfg[pname] ?? {};
    const entries = Object.entries(body).filter(([k]) => k !== "payload_id");
    if (!entries.length) {
      return h("section", { class: "card" },
        h("h3", {}, pname),
        h("p", { class: "muted" }, "No values mirrored yet. Trigger a sync, then re-open."),
      );
    }
    const isRestrictions = pname === "androidrestrictionspolicy";
    const rows = entries.map(([k, v]) => {
      const [label, display] = isRestrictions ? prettyRestriction(k, v) : [k, typeof v === "object" ? JSON.stringify(v) : String(v)];
      return h("tr", {},
        h("td", {}, label),
        h("td", { class: "mono small" }, display),
      );
    });
    return h("section", { class: "card" },
      h("h3", {}, pname, h("span", { class: "muted small" }, ` · ${entries.length} field${entries.length === 1 ? "" : "s"}`)),
      h("table", { class: "kv" }, h("tbody", {}, rows)),
    );
  }) : [h("p", { class: "muted" }, "No payloads on this profile.")];

  modal(`${p.name}`, h("div", { class: "stack" },
    h("p", { class: "muted small" }, `Values mirrored from Zoho${p.last_synced_at ? ` · last synced ${new Date(p.last_synced_at).toLocaleString()}` : ""}. Use "Add policy" or edit in the Zoho console to change them.`),
    ...sections,
  ), [{ label: "Close" }]);
}
