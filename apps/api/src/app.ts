import { Hono } from "hono";
import { cors } from "hono/cors";
import { adminRoutes } from "./admin/routes.js";
import { authRoutes } from "./auth/routes.js";
import { locationRoutes } from "./locations/routes.js";
import { orderRoutes } from "./orders/routes.js";
import { paymentRoutes } from "./payments/routes.js";
import { pushRoutes } from "./push/routes.js";
import { riderRoutes } from "./riders/routes.js";
import { settingsRoutes } from "./settings/routes.js";
import { userRoutes } from "./users/routes.js";
import { verifyRoutes } from "./verify/routes.js";
import { voiceRoutes } from "./voice/routes.js";
import { walletRoutes } from "./wallet/routes.js";

/** Hono app shared by the Node entry (local dev) and the Cloudflare Worker entry. */
const app = new Hono();

const devOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002", // apps/admin dev server
];

const defaultOrigins = ["https://tuma-customer-staging.onrender.com", "https://tuma-rider-staging.onrender.com"];

/** Anything a developer runs on their own machine can call the API from the
 * browser — which is exactly what you want locally, and exactly what you
 * don't want in production, where it means any page a victim opens on their
 * own laptop can talk to the live API as them. Localhost is allowed only
 * when ENVIRONMENT says development, whatever CORS_ORIGINS happens to list. */
function isLocalhost(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin.trim());
}

app.use("*", (c, next) => {
  const isDev = (process.env.ENVIRONMENT ?? "development") === "development";
  const configured = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const base = configured.length > 0 ? configured : defaultOrigins;
  const allowOrigins = isDev ? [...new Set([...base, ...devOrigins])] : base.filter((o) => !isLocalhost(o));

  return cors({
    origin: allowOrigins,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })(c, next);
});

app.get("/", (c) =>
  c.json({
    service: "tuma-api",
    message: "bootstrap",
    health: "/health",
    v1: "/v1",
  }),
);

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "tuma-api",
    env: process.env.ENVIRONMENT ?? "development",
  }),
);

app.get("/v1", (c) =>
  c.json({
    name: "tuma-api",
    version: "0.1.0",
    status: "live",
    note: "Auth, orders, matching, mobile money escrow via Yo! Payments (mock by default), chat, rider verification",
    endpoints: [
      "POST /v1/auth/register",
      "POST /v1/auth/login",
      "POST /v1/auth/logout",
      "GET /v1/auth/me",
      "POST /v1/auth/verify/request",
      "POST /v1/auth/verify/confirm",
      "GET /v1/auth/verify/confirm-link",
      "POST /v1/auth/password/reset/request",
      "POST /v1/auth/password/reset/confirm",
      "POST /v1/auth/password/change",
      "PUT /v1/me/matching-preference",
      "POST /v1/lists",
      "GET /v1/lists/recent",
      "GET /v1/lists/:id",
      "POST /v1/orders",
      "GET /v1/orders/active",
      "GET /v1/orders/:id",
      "POST /v1/orders/:id/voice-note",
      "GET /v1/orders/:id/voice-note",
      "POST /v1/orders/:id/match",
      "POST /v1/orders/:id/claim",
      "POST /v1/orders/:id/apply",
      "GET /v1/orders/:id/applicants",
      "POST /v1/orders/:id/applicants/:riderId/select",
      "POST /v1/orders/:id/cancel",
      "POST /v1/orders/:id/fund",
      "POST /v1/orders/:id/substitutions",
      "POST /v1/orders/:id/substitutions/:subId/decision",
      "POST /v1/orders/:id/substitutions/batch",
      "POST /v1/orders/:id/substitutions/batch/:batchId/decision",
      "POST /v1/orders/:id/fee-proposals",
      "POST /v1/orders/:id/fee-proposals/:proposalId/decision",
      "POST /v1/orders/:id/deliver",
      "POST /v1/orders/:id/arrived",
      "POST /v1/orders/:id/handover",
      "POST /v1/orders/:id/settle",
      "POST /v1/orders/:id/rate",
      "GET /v1/orders/:id/chat",
      "POST /v1/orders/:id/chat",
      "GET /v1/chat/media/:messageId",
      "GET /v1/chat/threads",
      "GET /v1/chat/threads/:counterpartId",
      "POST /v1/orders/:id/chat/read",
      "POST /v1/push/subscribe",
      "POST /v1/push/unsubscribe",
      "GET /v1/payments/:id/refresh",
      "POST /v1/payments/yo/callback",
      "POST /v1/payments/flutterwave/callback",
      "GET /v1/wallet",
      "POST /v1/wallet/topup",
      "GET /v1/wallet/topups/:id/refresh",
      "POST /v1/riders/apply",
      "POST /v1/riders/status",
      "GET /v1/riders/me",
      "GET /v1/riders/me/orders",
      "GET /v1/riders/jobs/available",
      "GET /v1/riders/jobs/:id/preview",
      "POST /v1/riders/profile-photo",
      "GET /v1/riders/:userId/photo",
      "POST /v1/users/me/profile-photo",
      "DELETE /v1/users/me/profile-photo",
      "GET /v1/users/:userId/photo",
      "GET /v1/admin/riders",
      "GET /v1/admin/riders/:userId/id-document",
      "POST /v1/admin/riders/:userId/verify",
      "GET /v1/admin/stats",
      "GET /v1/admin/integrations",
      "GET /v1/admin/customers",
      "GET /v1/admin/customers/:id",
      "POST /v1/admin/orders/:id/refund-to-wallet",
      "GET /v1/admin/orders",
      "POST /v1/admin/users/:id/status",
      "GET /v1/admin/staff",
      "GET /v1/admin/staff/roles",
      "POST /v1/admin/staff",
      "POST /v1/admin/staff/:id/role",
      "POST /v1/admin/staff/:id/status",
      "POST /v1/admin/staff/:id/reset-password",
      "GET /v1/admin/activity",
      "POST /v1/admin/activity/:id/revert",
      "GET /v1/locations",
      "POST /v1/locations",
      "DELETE /v1/locations/:id",
      "GET /v1/settings",
      "PUT /v1/admin/settings",
      "POST /v1/voice/transcribe",
    ],
  }),
);

app.route("/v1/auth", authRoutes);
app.route("/v1/auth", verifyRoutes);
app.route("/v1", orderRoutes);
app.route("/v1", paymentRoutes);
app.route("/v1", pushRoutes);
app.route("/v1", riderRoutes);
app.route("/v1", userRoutes);
app.route("/v1", locationRoutes);
app.route("/v1", settingsRoutes);
app.route("/v1", walletRoutes);
// adminRoutes' admin gate is scoped to /admin/* (see admin/routes.ts), so
// mount order here is no longer load-bearing — it used to be registered as
// "*" on this shared /v1 router, which meant anything mounted after it
// inherited the admin-only check.
app.route("/v1", voiceRoutes);
app.route("/v1", adminRoutes);

export default app;
