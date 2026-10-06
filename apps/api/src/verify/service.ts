import { db } from "../db/client.js";
import { newId } from "../lib/ids.js";
import { generateCode, generateLinkToken, hashCode } from "./otp.js";
import { isResendConfigured, sendVerificationEmail } from "./email.js";
import { isAfricasTalkingConfigured, sendVerificationSms } from "./sms.js";

const CODE_TTL_MINUTES = 10;

/** Which frontend to send a clicked verification link back to — resolved by
 * the confirming user's role, since customer/rider/admin are separate apps
 * on separate domains. */
export function appBaseUrl(role: string | null | undefined): string {
  const isProd = (process.env.ENVIRONMENT ?? "development") !== "development";
  if (role === "rider") return process.env.RIDER_APP_URL ?? (isProd ? "https://rider.tumaffe.online" : "http://localhost:3001");
  if (role === "admin") return process.env.ADMIN_APP_URL ?? (isProd ? "https://admin.tumaffe.online" : "http://localhost:3002");
  return process.env.CUSTOMER_APP_URL ?? (isProd ? "https://tumaffe.online" : "http://localhost:3000");
}

export function maskTarget(channel: "sms" | "email", target: string): string {
  if (channel === "email") {
    const [local, domain] = target.split("@");
    if (!domain) return target;
    return `${local.slice(0, 2)}***@${domain}`;
  }
  return target.length > 4 ? `${"•".repeat(target.length - 4)}${target.slice(-4)}` : target;
}

/** Creates a fresh OTP and dispatches it via the configured provider for
 * the channel. Falls back to logging the code when no provider is
 * configured (local dev, or staging before API keys are set) so the flow
 * stays fully testable end-to-end — the caller can surface `devCode` in
 * that case. Email "verify" codes also get a one-click confirmation link;
 * "reset" codes (any channel) and SMS codes stay code-only. */
export async function createAndSendOtp(
  userId: string,
  channel: "sms" | "email",
  target: string,
  purpose: "verify" | "reset" = "verify",
): Promise<{ devCode?: string }> {
  const code = generateCode();
  const codeHash = await hashCode(code);
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString();

  let linkToken: string | undefined;
  let linkTokenHash: string | null = null;
  if (channel === "email" && purpose === "verify") {
    linkToken = generateLinkToken();
    linkTokenHash = await hashCode(linkToken);
  }

  await db.execute({
    sql: `INSERT INTO otp_codes (id, user_id, channel, target, code_hash, expires_at, purpose, link_token_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [newId("otp"), userId, channel, target, codeHash, expiresAt, purpose, linkTokenHash],
  });

  if (channel === "email" && isResendConfigured()) {
    const verifyLink = linkToken
      ? `${process.env.PUBLIC_API_URL ?? "https://tuma-api.doxalight-inc.workers.dev"}/v1/auth/verify/confirm-link?token=${linkToken}`
      : undefined;
    await sendVerificationEmail(target, code, verifyLink);
    return {};
  }
  if (channel === "sms" && isAfricasTalkingConfigured()) {
    await sendVerificationSms(target, code);
    return {};
  }

  console.log(`[verify] ${channel} code for ${target}: ${code}`);
  return { devCode: code };
}
