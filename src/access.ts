import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

// Owners come from ALLOWED_USER_IDS and can invite/remove others.
// Invited users and outstanding invites live in a JSON file, so they survive restarts and deploys.

const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

export interface InvitedUser {
  id: string;
  name: string;
  invitedBy: string;
  addedAt: string;
}

interface Invite {
  createdBy: string;
  expiresAt: number;
}

interface AccessState {
  users: InvitedUser[];
  invites: Record<string, Invite>;
}

const stateFile = join(config.dataDir, "access.json");

function load(): AccessState {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8")) as AccessState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { users: [], invites: {} };
    throw err;
  }
}

const state = load();

// Write to a temp file and rename, so a crash mid-write can't leave a truncated file.
function save(): void {
  mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${stateFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, stateFile);
}

export function isOwner(userId: string): boolean {
  return config.allowedUserIds.has(userId);
}

export function isAllowed(userId: string): boolean {
  return isOwner(userId) || state.users.some((user) => user.id === userId);
}

export function listInvitedUsers(): InvitedUser[] {
  return [...state.users];
}

// Returns a single-use token for a t.me/<bot>?start=<token> link.
// base64url fits Telegram's start-parameter alphabet (A-Z, a-z, 0-9, _ and -).
export function createInvite(createdBy: string): string {
  const now = Date.now();
  for (const [token, invite] of Object.entries(state.invites)) {
    if (invite.expiresAt <= now) delete state.invites[token];
  }
  const token = randomBytes(12).toString("base64url");
  state.invites[token] = { createdBy, expiresAt: now + INVITE_TTL_MS };
  save();
  return token;
}

// Consumes the invite and adds the user. Returns the inviter's id, or null if the token is unknown/expired.
export function redeemInvite(token: string, userId: string, name: string): string | null {
  const invite = state.invites[token];
  if (!invite) return null;
  delete state.invites[token];
  if (invite.expiresAt <= Date.now()) {
    save();
    return null;
  }
  if (!isAllowed(userId)) {
    state.users.push({ id: userId, name, invitedBy: invite.createdBy, addedAt: new Date().toISOString() });
  }
  save();
  return invite.createdBy;
}

export function removeInvitedUser(userId: string): InvitedUser | null {
  const index = state.users.findIndex((user) => user.id === userId);
  if (index === -1) return null;
  const [removed] = state.users.splice(index, 1);
  save();
  return removed;
}

export const inviteTtlHours = INVITE_TTL_MS / (60 * 60 * 1000);
