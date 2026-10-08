// Tenant-scoped row lookups. Every query filters by enterprise_id so one enterprise
// can never touch another enterprise's rows, even with a guessed id.
import { db, run } from "../lib/db.ts";
import { fail } from "../lib/errors.ts";

export type DeviceRow = {
  id: string;
  enterprise_id: string;
  zoho_device_id: string;
  device_name: string | null;
  platform: string;
  model: string | null;
  owned_by: number | null;
  is_lost_mode: boolean;
  is_removed: boolean;
  is_supervised?: boolean | null;
  is_profileowner?: boolean | null;
  is_knox?: boolean | null;
  serial_number?: string | null;
  imei?: string | null;
  assigned_user_id?: string | null;
};

export type GroupRow = {
  id: string;
  enterprise_id: string;
  zoho_group_id: string | null;
  name: string;
  kind: string;
  description: string | null;
};

export type ProfileRow = {
  id: string;
  enterprise_id: string;
  zoho_profile_id: string | null;
  name: string;
  description: string | null;
  platform: "android" | "ios";
  purpose: string;
  state: "draft" | "published" | "modified" | "deleted";
  payload_names: string[];
  payload_config: Record<string, Record<string, unknown>>;
};

export type AnnouncementRow = {
  id: string;
  enterprise_id: string;
  zoho_announcement_id: string | null;
  name: string;
  title: string;
  detail_message: string;
  nbar_message: string | null;
  title_color: string | null;
  format: number;
  needs_ack: boolean;
  ack_button: string | null;
};

export async function getDevice(eid: string, id: string): Promise<DeviceRow> {
  return await run<DeviceRow>(db().from("devices").select("*").eq("enterprise_id", eid).eq("id", id).single());
}

export async function getDevices(eid: string, ids: string[]): Promise<DeviceRow[]> {
  const rows = await run<DeviceRow[]>(db().from("devices").select("*").eq("enterprise_id", eid).in("id", ids));
  if (rows.length !== ids.length) fail("NOT_FOUND", "One or more devices were not found");
  return rows;
}

export async function getGroup(eid: string, id: string): Promise<GroupRow> {
  return await run<GroupRow>(db().from("groups").select("*").eq("enterprise_id", eid).eq("id", id).single());
}

export async function getProfile(eid: string, id: string): Promise<ProfileRow> {
  return await run<ProfileRow>(db().from("profiles").select("*").eq("enterprise_id", eid).eq("id", id).single());
}

export async function getProfiles(eid: string, ids: string[]): Promise<ProfileRow[]> {
  const rows = await run<ProfileRow[]>(db().from("profiles").select("*").eq("enterprise_id", eid).in("id", ids));
  if (rows.length !== ids.length) fail("NOT_FOUND", "One or more profiles were not found");
  return rows;
}

export async function getAnnouncement(eid: string, id: string): Promise<AnnouncementRow> {
  return await run<AnnouncementRow>(
    db().from("announcements").select("*").eq("enterprise_id", eid).eq("id", id).single(),
  );
}

export function requireZohoId<T extends string | number | null | undefined>(value: T, what: string): string {
  if (value === null || value === undefined || value === "") fail("CONFLICT", `${what} is not created in Zoho yet — wait for its event to finish`);
  return String(value);
}
