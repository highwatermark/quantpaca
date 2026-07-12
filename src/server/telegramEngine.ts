import { createHash, randomBytes } from "node:crypto";

export type TelegramRole = "viewer" | "operator" | "trader" | "admin";

const commandRoles: Record<string, TelegramRole> = {
  "/status": "viewer",
  "/health": "viewer",
  "/positions": "viewer",
  "/orders": "viewer",
  "/trades": "viewer",
  "/risk": "viewer",
  "/regime": "viewer",
  "/sync": "operator",
  "/dry_run": "operator",
  "/pause": "operator",
  "/resume": "operator",
  "/block_buys": "operator",
  "/close_all": "admin",
  "/breaker_reset": "admin",
};

const roleRank: Record<TelegramRole, number> = {
  viewer: 1,
  operator: 2,
  trader: 3,
  admin: 4,
};

const consumedTokenIds = new Set<string>();

export function authorizeTelegramCommand(input: {
  userId: string;
  command: string;
  roles: Record<string, TelegramRole>;
}) {
  const role = input.roles[input.userId];
  const requiredRole = commandRoles[input.command] || "admin";
  if (!role) return { allowed: false, reason: "unauthorized_user", requiredRole };
  if (roleRank[role] < roleRank[requiredRole]) return { allowed: false, reason: "insufficient_role", role, requiredRole };
  return { allowed: true, role, requiredRole };
}

export type ConfirmationToken = {
  id: string;
  token: string;
  userId: string;
  action: string;
  expiresAt: string;
};

export function createConfirmationToken(input: {
  userId: string;
  action: string;
  now?: Date;
  ttlMs?: number;
}): ConfirmationToken {
  const now = input.now || new Date();
  const raw = `${input.userId}:${input.action}:${now.toISOString()}:${randomBytes(8).toString("hex")}`;
  return {
    id: createHash("sha256").update(raw).digest("hex").slice(0, 16),
    token: createHash("sha256").update(`${raw}:token`).digest("hex").slice(0, 10).toUpperCase(),
    userId: input.userId,
    action: input.action,
    expiresAt: new Date(now.getTime() + (input.ttlMs || 5 * 60 * 1000)).toISOString(),
  };
}

export function consumeConfirmationToken(input: {
  token: ConfirmationToken;
  userId: string;
  action: string;
  now?: Date;
}) {
  const now = input.now || new Date();
  if (consumedTokenIds.has(input.token.id)) return { accepted: false, reason: "replayed" };
  if (input.token.userId !== input.userId) return { accepted: false, reason: "wrong_user" };
  if (input.token.action !== input.action) return { accepted: false, reason: "wrong_action" };
  if (Date.parse(input.token.expiresAt) < now.getTime()) return { accepted: false, reason: "expired" };
  consumedTokenIds.add(input.token.id);
  return { accepted: true };
}

export function parseTelegramAdminRoles(envValue?: string): Record<string, TelegramRole> {
  const roles: Record<string, TelegramRole> = {};
  for (const item of (envValue || "").split(",")) {
    const [id, role] = item.split(":").map((part) => part?.trim());
    if (id && isRole(role)) roles[id] = role;
  }
  return roles;
}

function isRole(value: string | undefined): value is TelegramRole {
  return value === "viewer" || value === "operator" || value === "trader" || value === "admin";
}
