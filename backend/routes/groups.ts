import { Hono } from "hono";
import { oneOf, readJson, str, uuidList, uuidParam } from "../lib/validate.ts";
import { type AppEnv, idempotencyKey, requireRole, requireSession } from "../middleware/auth.ts";
import {
  addDevicesToGroup,
  associateProfiles,
  createGroup,
  deleteGroup,
  disassociateProfiles,
  groupDetail,
  listGroups,
  removeDeviceFromGroup,
} from "../services/groups.ts";
import { eventResponse } from "./helpers.ts";

export function groupRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", requireSession);

  r.get("/", async (c) => c.json({ data: await listGroups(c.get("session").enterpriseId) }));
  r.get("/:id", async (c) => c.json({ data: await groupDetail(c.get("session").enterpriseId, uuidParam(c.req.param("id"))) }));

  r.post("/", requireRole("admin"), async (c) => {
    const b = await readJson(c.req.raw);
    const { groupId, event } = await createGroup(c.get("session"), {
      name: str(b, "name", { max: 100 }),
      kind: oneOf(b, "kind", ["department", "function", "baseline", "other"] as const, "department"),
      description: str(b, "description", { required: false, max: 300 }),
    }, idempotencyKey(c));
    return eventResponse(c, event, { groupId });
  });

  r.delete("/:id", requireRole("owner"), async (c) => {
    const { event } = await deleteGroup(c.get("session"), uuidParam(c.req.param("id")), idempotencyKey(c));
    return eventResponse(c, event);
  });

  // Devices -> group
  r.post("/:id/devices", requireRole("admin"), async (c) => {
    const b = await readJson(c.req.raw);
    const { event } = await addDevicesToGroup(c.get("session"), uuidParam(c.req.param("id")), uuidList(b, "deviceIds", { min: 1, max: 500 }), idempotencyKey(c));
    return eventResponse(c, event);
  });
  r.delete("/:id/devices/:deviceId", requireRole("admin"), async (c) => {
    const { event } = await removeDeviceFromGroup(
      c.get("session"),
      uuidParam(c.req.param("id")),
      uuidParam(c.req.param("deviceId"), "deviceId"),
      idempotencyKey(c),
    );
    return eventResponse(c, event);
  });

  // Profile -> group (and "remove group from profile")
  r.post("/:id/profiles", requireRole("admin"), async (c) => {
    const b = await readJson(c.req.raw);
    const { event } = await associateProfiles(c.get("session"), uuidParam(c.req.param("id")), uuidList(b, "profileIds", { min: 1, max: 50 }), idempotencyKey(c));
    return eventResponse(c, event);
  });
  r.post("/:id/profiles/remove", requireRole("admin"), async (c) => {
    const b = await readJson(c.req.raw);
    const { event } = await disassociateProfiles(c.get("session"), uuidParam(c.req.param("id")), uuidList(b, "profileIds", { min: 1, max: 50 }), idempotencyKey(c));
    return eventResponse(c, event);
  });

  return r;
}
