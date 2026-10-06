/**
 * Role-based access for the admin app, shared between the API (which
 * enforces it — see apps/api/src/admin/permissions.ts) and the admin
 * frontend (which uses the exact same map to hide what a role can't do,
 * for UX only; the backend check is what actually matters).
 */

export const ADMIN_ROLES = [
  "super_admin",
  "finance_manager",
  "customer_manager",
  "rider_manager",
  "support_manager",
  "operations_manager",
  "compliance_manager",
] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === "string" && (ADMIN_ROLES as readonly string[]).includes(value);
}

export const ADMIN_ROLE_LABELS: Record<AdminRole, string> = {
  super_admin: "Super Admin",
  finance_manager: "Finance Manager",
  customer_manager: "Customer Manager",
  rider_manager: "Rider Manager",
  support_manager: "Support / Disputes Manager",
  operations_manager: "Operations Manager",
  compliance_manager: "Compliance / Risk Manager",
};

export const ADMIN_ROLE_DESCRIPTIONS: Record<AdminRole, string> = {
  super_admin: "Full access, including staff management and the activity log.",
  finance_manager: "Payments, escrow, rider wallets and withdrawals, payment integration health.",
  customer_manager: "Customer accounts, order history, and support conversations.",
  rider_manager: "Rider applications, ID verification, and rider accounts.",
  support_manager: "Cross-cutting disputes and escalated chats — read access across customers and riders.",
  operations_manager: "Delivery pricing, service range, and rider-matching configuration.",
  compliance_manager: "Read-only oversight: rider documents, customer accounts, and the activity log.",
};

export type Permission =
  | "stats.view"
  | "orders.view"
  | "customers.view"
  | "customers.manage"
  | "riders.view"
  | "riders.verify"
  | "riders.manage"
  | "payments.view"
  | "payments.manage"
  | "wallets.manage"
  | "integrations.view"
  | "settings.view"
  | "settings.manage"
  | "staff.manage"
  | "activity_log.view"
  | "activity_log.revert"
  | "chat.view_support";

/**
 * Each role's permissions, spelled out explicitly rather than derived —
 * easier to audit at a glance than a clever composition, and this list
 * changes rarely enough that repetition costs little.
 */
const ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]> = {
  // super_admin is handled as "always true" in hasPermission, not by
  // listing every permission here — so a new permission added later is
  // automatically available to super_admin without this file needing an
  // edit at the same time, which is exactly the failure mode to avoid for
  // the one role that's supposed to mean "everything".
  super_admin: [],
  finance_manager: ["stats.view", "orders.view", "payments.view", "payments.manage", "wallets.manage", "integrations.view"],
  customer_manager: ["stats.view", "orders.view", "customers.view", "customers.manage", "chat.view_support"],
  rider_manager: ["stats.view", "orders.view", "riders.view", "riders.verify", "riders.manage"],
  support_manager: ["stats.view", "orders.view", "customers.view", "riders.view", "chat.view_support"],
  operations_manager: ["stats.view", "orders.view", "riders.view", "settings.view", "settings.manage", "integrations.view"],
  compliance_manager: ["stats.view", "orders.view", "riders.view", "customers.view", "activity_log.view"],
};

export function hasPermission(role: AdminRole | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  if (role === "super_admin") return true;
  return ROLE_PERMISSIONS[role].includes(permission);
}

const ALL_PERMISSIONS: Permission[] = [
  "stats.view",
  "orders.view",
  "customers.view",
  "customers.manage",
  "riders.view",
  "riders.verify",
  "riders.manage",
  "payments.view",
  "payments.manage",
  "wallets.manage",
  "integrations.view",
  "settings.view",
  "settings.manage",
  "staff.manage",
  "activity_log.view",
  "activity_log.revert",
  "chat.view_support",
];

export function permissionsFor(role: AdminRole | null | undefined): Permission[] {
  if (!role) return [];
  if (role === "super_admin") return [...ALL_PERMISSIONS];
  return [...ROLE_PERMISSIONS[role]];
}
