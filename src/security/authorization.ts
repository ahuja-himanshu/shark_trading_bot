export interface TelegramIdentity {
  userId?: string;
  chatId?: string;
  chatType?: string;
  isForwarded: boolean;
}

export interface AuthorizationConfig {
  allowedUserId: string;
  allowedChatId: string;
}

export interface AuthorizationResult {
  allowed: boolean;
  reason?:
    | "MISSING_IDENTITY"
    | "NON_PRIVATE_CHAT"
    | "FORWARDED_MESSAGE"
    | "UNAUTHORISED_USER"
    | "UNAUTHORISED_CHAT";
}

export function authorizeTelegramIdentity(
  identity: TelegramIdentity,
  config: AuthorizationConfig,
): AuthorizationResult {
  if (!identity.userId || !identity.chatId) {
    return { allowed: false, reason: "MISSING_IDENTITY" };
  }
  if (identity.chatType !== "private") {
    return { allowed: false, reason: "NON_PRIVATE_CHAT" };
  }
  if (identity.isForwarded) {
    return { allowed: false, reason: "FORWARDED_MESSAGE" };
  }
  if (!safeIdEqual(identity.userId, config.allowedUserId)) {
    return { allowed: false, reason: "UNAUTHORISED_USER" };
  }
  if (!safeIdEqual(identity.chatId, config.allowedChatId)) {
    return { allowed: false, reason: "UNAUTHORISED_CHAT" };
  }
  return { allowed: true };
}

function safeIdEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

import { timingSafeEqual } from "node:crypto";
