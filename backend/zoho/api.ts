// Thin function wrappers over the MDM Cloud endpoints documented in MDM_Dev_Guide.pdf.
// Every function takes the enterprise id first (which Zoho account to use).
import { firstArray, zohoPaginate, zohoRequest } from "./client.ts";

type Id = string | number;
type Json = Record<string, unknown>;

// ------------------------------------------------------------------ devices
export const listDevices = (eid: string) => zohoPaginate<Json>(eid, "/devices", "devices", { exclude_removed: true });
export const getDevice = (eid: string, deviceId: Id) => zohoRequest<Json>(eid, { path: `/devices/${deviceId}` });
export const getDeviceSummary = (eid: string, deviceId: Id) =>
  zohoRequest<Json>(eid, { path: `/devices/${deviceId}/summary` });
export const getDeviceActions = (eid: string, deviceId: Id) =>
  zohoRequest<Json>(eid, { path: `/devices/${deviceId}/actions` });
export const runDeviceAction = (eid: string, deviceId: Id, action: string, body: Json = {}) =>
  zohoRequest<Json>(eid, { method: "POST", path: `/devices/${deviceId}/actions/${action}`, body });
export const runBulkAction = (eid: string, command: string, body: Json) =>
  zohoRequest<Json>(eid, { method: "POST", path: `/actions/${command}`, body });
export const getCommandHistory = (eid: string, deviceId: Id, query: { days?: number; limit?: number } = {}) =>
  zohoRequest<Json>(eid, { path: `/devices/${deviceId}/commandhistory`, query });
export const getRecentCommand = (eid: string, deviceId: Id) =>
  zohoRequest<Json>(eid, { path: `/devices/${deviceId}/actions/recent_command` });
export async function getDeviceLocations(eid: string, deviceId: Id): Promise<Json[]> {
  const data = await zohoRequest<Json>(eid, { path: `/devices/${deviceId}/locations` });
  return firstArray<Json>(data, "locations");
}

// ------------------------------------------------------------------- groups
export const listGroups = (eid: string) => zohoPaginate<Json>(eid, "/groups", "groups");
export const getGroup = (eid: string, groupId: Id) =>
  zohoRequest<Json>(eid, { path: `/groups/${groupId}`, query: { include: "member" } });
export const createGroup = (eid: string, name: string, description = "") =>
  zohoRequest<Json>(eid, { method: "POST", path: "/groups", body: { name, group_type: 6, description } });
export const deleteGroup = (eid: string, groupId: Id) =>
  zohoRequest<Json>(eid, { method: "DELETE", path: `/groups/${groupId}` });
export async function listGroupMembers(eid: string, groupId: Id): Promise<Json[]> {
  const data = await zohoRequest<Json>(eid, { path: `/groups/${groupId}/members` });
  return firstArray<Json>(data, "members");
}
export const addGroupMembers = (eid: string, groupId: Id, memberIds: Id[]) =>
  zohoRequest<Json>(eid, { method: "POST", path: `/groups/${groupId}/members`, body: { member_ids: memberIds } });
export const removeGroupMember = (eid: string, groupId: Id, memberId: Id) =>
  zohoRequest<Json>(eid, { method: "DELETE", path: `/groups/${groupId}/members/${memberId}` });
export const moveDevices = (eid: string, fromGroupId: Id, memberIds: Id[], targetGroupIds: Id[]) =>
  zohoRequest<Json>(eid, {
    method: "PUT",
    path: `/groups/${fromGroupId}/targetgroups`,
    body: { member_ids: memberIds, target_group_ids: targetGroupIds },
  });

// Profiles are associated to GROUPS only (design rule: no profile -> device).
export const associateProfilesToGroup = (eid: string, groupId: Id, profileIds: Id[]) =>
  zohoRequest<Json>(eid, { method: "POST", path: `/groups/${groupId}/profiles`, body: { profile_ids: profileIds } });
export const disassociateProfilesFromGroup = (eid: string, groupId: Id, profileIds: Id[]) =>
  zohoRequest<Json>(eid, { method: "DELETE", path: `/groups/${groupId}/profiles`, body: { profile_ids: profileIds } });

/**
 * Profiles associated to a group. Not in MDM_Dev_Guide.pdf (only POST/DELETE are),
 * so callers must treat ZOHO_NOT_FOUND / ZOHO_BAD_REQUEST as "endpoint not available".
 * Returns null when Zoho answers without a profile list.
 */
export async function listGroupProfiles(eid: string, groupId: Id): Promise<Json[] | null> {
  const data = await zohoRequest<unknown>(eid, { path: `/groups/${groupId}/profiles` });
  if (Array.isArray(data)) return data as Json[];
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    // Zoho has used several keys for this: "profiles", "group_profiles",
    // "profile_ids", "data". Return whichever array shows up first; only
    // signal "endpoint not available" when the response has no array at all.
    for (const v of Object.values(o)) {
      if (Array.isArray(v)) return v as Json[];
    }
  }
  return null;
}
export async function listDeviceProfiles(eid: string, deviceId: Id): Promise<Json[]> {
  return firstArray<Json>(await zohoRequest<Json>(eid, { path: `/devices/${deviceId}/profiles` }), "profiles");
}

// ----------------------------------------------------------------- profiles
export const listProfiles = (eid: string) => zohoPaginate<Json>(eid, "/profiles", "profiles");
export const getProfile = (eid: string, profileId: Id) => zohoRequest<Json>(eid, { path: `/profiles/${profileId}` });
export const createProfile = (
  eid: string,
  p: { name: string; description?: string; platformType: 1 | 2 | 3 | 4; scope?: 0 | 1 | 2 },
) =>
  zohoRequest<Json>(eid, {
    method: "POST",
    path: "/profiles",
    body: {
      profile_name: p.name,
      profile_description: p.description ?? "",
      platform_type: p.platformType,
      scope: p.scope ?? 0,
    },
  });
export const deleteProfiles = (eid: string, profileIds: Id[]) =>
  zohoRequest<Json>(eid, { method: "DELETE", path: "/profiles", body: { profile_ids: profileIds } });
export const listPayloads = (eid: string, profileId: Id) =>
  zohoRequest<Json>(eid, { path: `/profiles/${profileId}/payloads` });
export const addPayload = (eid: string, profileId: Id, payloadName: string, body: Json) =>
  zohoRequest<Json>(eid, { method: "POST", path: `/profiles/${profileId}/payloads/${payloadName}`, body });
export const removePayload = (eid: string, profileId: Id, payloadName: string) =>
  zohoRequest<Json>(eid, { method: "DELETE", path: `/profiles/${profileId}/payloads/${payloadName}` });
export const publishProfile = (eid: string, profileId: Id) =>
  zohoRequest<Json>(eid, { method: "POST", path: `/profiles/${profileId}/publish`, body: {} });
export const pushProfileUpdate = (eid: string, profileId: Id) =>
  zohoRequest<Json>(eid, { method: "PUT", path: `/profiles/${profileId}/update_all`, body: {} });

// --------------------------------------------------------------------- apps
export const listApps = (eid: string) => zohoPaginate<Json>(eid, "/apps", "apps");

// -------------------------------------------------------------------- users
export const listUsers = (eid: string) => zohoPaginate<Json>(eid, "/users", "users");

// ------------------------------------------------------------ announcements
export async function listAnnouncements(eid: string): Promise<Json[]> {
  const data = await zohoRequest<Json>(eid, { path: "/announcements" });
  return firstArray<Json>(data, "announcement");
}
export const createAnnouncement = (eid: string, a: {
  name: string;
  format: number;
  title: string;
  detailMessage: string;
  nbarMessage?: string;
  titleColor?: string;
  needsAck: boolean;
  ackButton?: string;
}) =>
  zohoRequest<Json>(eid, {
    method: "POST",
    path: "/announcements",
    body: {
      announcement_name: a.name,
      announcement_format: a.format,
      announcement_detail: {
        title_color: a.titleColor ?? "#1F3A5F",
        title: a.title,
        nbar_icon: "/images/announcement/nbaricon/info.png",
        detail_message: a.detailMessage,
        nbar_message: a.nbarMessage ?? a.title,
        needs_acknowledgement: a.needsAck,
        ack_button: a.ackButton ?? "Got it",
      },
    },
  });
export const deleteAnnouncement = (eid: string, announcementId: Id) =>
  zohoRequest<Json>(eid, { method: "DELETE", path: `/announcements/${announcementId}` });
export const sendAnnouncementToGroups = (eid: string, announcementId: Id, groupIds: Id[]) =>
  zohoRequest<Json>(eid, {
    method: "POST",
    path: `/announcements/${announcementId}/groups`,
    body: { group_ids: groupIds.map(String) },
  });
export const sendAnnouncementToDevices = (eid: string, announcementId: Id, deviceIds: Id[]) =>
  zohoRequest<Json>(eid, {
    method: "POST",
    path: `/announcements/${announcementId}/devices`,
    body: { device_ids: deviceIds.map(String) },
  });
export const getAnnouncementDeviceStatus = (eid: string, announcementId: Id) =>
  zohoRequest<Json>(eid, { path: `/announcements/${announcementId}/device` });

// ---------------------------------------------------------- compliance / geofence policies
export async function listCompliancePolicies(eid: string): Promise<Json[]> {
  const data = await zohoRequest<Json>(eid, { path: "/compliance" });
  return firstArray<Json>(data, "compliance_policies");
}
