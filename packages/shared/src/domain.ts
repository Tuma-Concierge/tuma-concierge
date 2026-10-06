/** Core domain DTOs — kept in sync with apps/api's real (non-stub) responses. */

import type { AdminRole } from "./permissions.js";

export type ListStatus = "draft" | "active" | "delivered" | "cancelled";

export type ListSummary = {
  id: string;
  listId: string;
  title: string;
  status: ListStatus;
  itemCount: number;
  updatedAt: string;
  /**
   * Set once this list's order has a rider assigned — the customer home
   * screen prefers "{riderFirstName} · {area}" over the list's own `title`
   * so recent orders read as "who delivered this and where" rather than a
   * generic "New shopping list". Null on a list with no order yet, or one
   * still waiting to be matched.
   */
  riderFirstName: string | null;
  riderId: string | null;
  riderHasPhoto: boolean;
  area: string | null;
  /** The order this list turned into, if any — links to the full order/delivery detail page instead of the bare item list. */
  orderId: string | null;
};

export type ListItem = {
  id: string;
  list_id: string;
  name: string;
  quantity: number;
  note: string | null;
  unit_price: number | null;
};

export type ListRow = {
  id: string;
  customer_id: string;
  title: string;
  status: ListStatus;
  created_at: string;
  updated_at: string;
};

export type ListDetail = {
  list: ListRow;
  items: ListItem[];
};

export type OrderType = "shopping" | "parcel";

export type OrderRow = {
  id: string;
  list_id: string;
  customer_id: string;
  customer_name: string | null;
  rider_id: string | null;
  rider_name: string | null;
  matching_mode: MatchingMode;
  stage: string;
  type: OrderType;
  payment_rail: "escrow" | "float" | null;
  currency: string;
  estimated_total: number | null;
  final_total: number | null;
  delivery_fee: number | null;
  pickup_area: string | null;
  pickup_address: string | null;
  pickup_lat: number | null;
  pickup_lng: number | null;
  destination_area: string | null;
  destination_address: string | null;
  destination_lat: number | null;
  destination_lng: number | null;
  distance_km: number | null;
  matched_out_of_range: number;
  voice_note_key: string | null;
  pin_code: string | null;
  eta_minutes: number | null;
  created_at: string;
  updated_at: string;
};

/**
 * An unmatched order as it appears in a rider's available-jobs list — every
 * order eventually reaches every verified/online rider, but the staged
 * radius broadcast means the nearest riders see it first (see
 * apps/api/src/orders/matching.ts): 1km, then 2km, then 3km, then everyone.
 * `distanceKm` is null when it can't be computed (rider or order missing
 * coordinates); `outOfServiceRange` flags a job worth warning the rider
 * (and, once claimed, the customer) may cost more than the normal rate.
 */
export type AvailableJob = Pick<
  OrderRow,
  | "id"
  | "type"
  | "stage"
  | "matching_mode"
  | "payment_rail"
  | "currency"
  | "estimated_total"
  | "final_total"
  | "delivery_fee"
  | "pickup_area"
  | "destination_area"
  | "pickup_lat"
  | "pickup_lng"
  | "destination_lat"
  | "destination_lng"
  | "distance_km"
  | "matched_out_of_range"
  | "created_at"
  | "updated_at"
> & {
  /**
   * Deliberately narrower than a full OrderRow. This feed goes to every
   * online rider, including all the ones who never take the job, so it
   * withholds what only the rider who claims it needs: `customer_name` is
   * the first name alone, street addresses are omitted entirely, and the
   * coordinates are rounded to roughly 100m. The full record arrives from
   * GET /v1/orders/:id once the job is claimed.
   */
  customer_name: string | null;
  distanceKm: number | null;
  outOfServiceRange: boolean;
  /** Set once this rider has already applied — only meaningful for "nearest_window"/"customer_selects"
   * jobs, where applying doesn't assign the job outright (unlike "first_to_claim"'s Claim button). */
  applied: boolean;
};

/**
 * How a rider gets assigned to an order — admin picks which of these are on
 * offer at all (packages/shared/src/domain.ts: DeliverySettings.matchingModesEnabled),
 * and when more than one is enabled, the customer's own default preference
 * (see AuthUser-adjacent account settings) decides which applies to their
 * orders. See apps/api/src/orders/matching.ts for the full behavior.
 */
export type MatchingMode = "first_to_claim" | "nearest_window" | "customer_selects";

export const MATCHING_MODE_LABELS: Record<MatchingMode, string> = {
  first_to_claim: "First rider to accept",
  nearest_window: "Nearest available",
  customer_selects: "Let me choose",
};

export const MATCHING_MODE_DESCRIPTIONS: Record<MatchingMode, string> = {
  first_to_claim: "Whichever rider taps \"Claim\" first gets your order — usually the fastest option.",
  nearest_window: "The app collects nearby riders for a short window, then auto-assigns whoever's closest.",
  customer_selects: "See who's offered to take your order — their ratings, reviews, and recommendations — and pick one yourself.",
};

/** Which dataset the whole platform currently reads/writes — see
 * PATCH .../admin/platform-environment and
 * apps/api/src/lib/settings.ts's platform_environment. */
export type PlatformEnvironment = "live" | "sandbox";

/** Admin-tunable delivery pricing/matching numbers (packages/shared/src/api-client.ts: getSettings/adminUpdateSettings). */
export type DeliverySettings = {
  /** Which environment's orders/wallets/lists everyone currently sees —
   * read-only here (GET /settings); change it with
   * adminSetPlatformEnvironment. */
  platformEnvironment: PlatformEnvironment;
  deliveryRatePerKm: number;
  serviceRangeKm: number;
  /** Flat delivery fee (UGX) added on top of a shopping order's item costs
   * — see apps/api/src/lib/settings.ts for why shopping can't be priced by
   * distance the way a parcel ride is. */
  shoppingDeliveryFee: number;
  enabledModes: MatchingMode[];
  nearestWindowSeconds: number;
  maxAssignmentMinutes: number;
  paymentsActiveProviders: PaymentProviderIdentity[];
  /** Demo/sandbox mode — every payment runs through the mock adapters
   * regardless of saved credentials. See PaymentProviderInfo/IntegrationsStatus. */
  paymentsDemoMode: boolean;
  walletUnverifiedCap: number;
  walletVerifiedCap: number;
  walletMaxTopup: number;
  /** How long any voice recording may run before it auto-stops — a shopping
   * list, an order note, a fee-proposal reason, or a chat voice message. */
  voiceNoteMaxSeconds: number;
};

export type OrderEvent = {
  id: string;
  order_id: string;
  stage: string;
  note: string | null;
  actor_id: string | null;
  created_at: string;
};

export type Substitution = {
  id: string;
  order_id: string;
  item_id: string | null;
  original_name: string;
  substitute_name: string;
  price_delta: number;
  status: "pending" | "approved" | "rejected";
  batch_id: string | null;
  created_at: string;
};

export type Payment = {
  id: string;
  order_id: string;
  type: "collection" | "disbursement" | "refund";
  provider: string;
  provider_ref: string | null;
  msisdn: string | null;
  network: string | null;
  amount: number;
  currency: string;
  status: "pending" | "successful" | "failed";
  created_at: string;
};

export type ChatMessage = {
  id: string;
  order_id: string;
  sender_id: string;
  sender_role: "customer" | "rider" | "admin";
  body: string;
  type: "text" | "image" | "voice";
  media_key: string | null;
  created_at: string;
  /** Set once the recipient's client has fetched this message. */
  delivered_at: string | null;
  /** Set once the recipient has actually played a voice message — not
   * meaningful for other message types. */
  played_at: string | null;
  /** Whether the recipient has read up to this message — only meaningful
   * on a message the viewer themself sent (drives their own tick color). */
  read: boolean;
};

/** One row in the Chat tab's conversation list — the other party in a customer/rider pair, and their last message. */
export type ChatThread = {
  counterpartId: string;
  counterpartName: string;
  counterpartHasPhoto: boolean;
  lastMessagePreview: string;
  lastMessageAt: string;
  unread: boolean;
};

/** Opening a conversation by counterpart (not by a specific order) — the whole shared history, plus which order a new message attaches to. */
export type ChatThreadDetail = {
  orderId: string;
  counterpartName: string;
  counterpartHasPhoto: boolean;
  messages: ChatMessage[];
};

export type Rider = {
  user_id: string;
  verified: number;
  is_online: number;
  area: string | null;
  vehicle_info: string | null;
  rating: number;
  momo_msisdn: string | null;
  first_name: string | null;
  last_name: string | null;
  alt_phone: string | null;
  stage_address: string | null;
  home_address: string | null;
  stage_lat: number | null;
  stage_lng: number | null;
  stage_name: string | null;
  stage_chairman_name: string | null;
  stage_chairman_contact: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  national_id_key: string | null;
  profile_photo_key: string | null;
  profile_completed_at: string | null;
};

/** The fields a rider must fill in (incl. their motorcycle reg. via `vehicle_info`,
 * a National ID scan, a face photo, and a stage location picked on the map)
 * before they're eligible for admin verification/approval to take jobs. */
export function isRiderProfileComplete(rider: Rider | null | undefined): boolean {
  if (!rider) return false;
  return Boolean(
    rider.first_name &&
      rider.last_name &&
      rider.vehicle_info &&
      rider.stage_address &&
      rider.stage_lat != null &&
      rider.stage_lng != null &&
      rider.home_address &&
      rider.stage_name &&
      rider.stage_chairman_name &&
      rider.stage_chairman_contact &&
      rider.emergency_contact_name &&
      rider.emergency_contact_phone &&
      rider.national_id_key &&
      rider.profile_photo_key,
  );
}

/** Shape returned by the admin rider-listing endpoints: a `Rider` row joined with its user record. */
export type AdminRider = Rider & {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  status: UserStatus;
};

export type SavedLocation = {
  id: string;
  user_id: string;
  label: string;
  area: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  created_at: string;
};

export type UserStatus = "active" | "suspended";

export type AuthUser = {
  id: string;
  phone: string | null;
  email: string | null;
  name: string;
  role: "customer" | "rider" | "admin";
  status: UserStatus;
  phoneVerifiedAt: string | null;
  emailVerifiedAt: string | null;
  defaultMatchingMode: MatchingMode | null;
  /** False only for a Google-only account that has never reset its password
   * — its password_hash is a random value nobody was ever shown, so a
   * "change password" form has nothing valid to check the current one
   * against. Such an account gains one through "forgot password" instead
   * (an OTP to its verified email, same as any other reset). */
  passwordSet: boolean;
  /** Non-null only for role === "admin" — which kind of staff member this
   * is. See @tuma/shared's permissions.ts for what each role can do. */
  adminRole: AdminRole | null;
  /** True right after a staff account is invited or has its password reset
   * by another admin. The API rejects nearly everything else while this is
   * true — the admin app should route straight to a "set your password"
   * screen rather than let a request fail first. */
  forcePasswordChange: boolean;
  /** A customer's own photo, shown to the rider assigned to their order —
   * the same trust signal riders already give customers, the other way
   * round. Also used for a staff member's own avatar. */
  hasProfilePhoto: boolean;
};

/** True once either phone or email has been confirmed via OTP — the two
 * channels are interchangeable, only one needs to succeed. */
export function isUserVerified(user: AuthUser | null | undefined): boolean {
  return !!user && (!!user.phoneVerifiedAt || !!user.emailVerifiedAt);
}

export type AdminCustomer = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  status: UserStatus;
  created_at: string;
  order_count: number;
};

export type AdminStats = {
  totalCustomers: number;
  totalRiders: number;
  verifiedRiders: number;
  onlineRiders: number;
  ordersByStage: Record<string, number>;
  paymentsByStatus: Record<string, number>;
  settledGmv: number;
};

export type IntegrationsStatus = {
  mobileMoney: {
    activeProviders: PaymentProviderIdentity[];
    /** Forces every payment through the mock adapters regardless of saved
     * credentials — see apps/api/src/payments/service.ts resolveProvider(). */
    demoMode: boolean;
    providers: PaymentProviderInfo[];
    collection: { provider: string; live: boolean };
    disbursement: { provider: string; live: boolean };
    networks: string[];
  };
  storage: { configured: boolean };
};

export type FailedPayment = {
  id: string;
  order_id: string;
  type: "collection" | "disbursement" | "refund";
  amount: number;
  currency: string;
  msisdn: string | null;
  created_at: string;
};

/** `OrderRow` joined with the assigned rider's name, as returned by admin listings. */
export type AdminOrderRow = OrderRow & { rider_name: string | null };

export type OrderRating = {
  rating: number;
  comment: string | null;
  recommended: boolean;
};

/** A rider who's offered to take a "customer_selects" order, with enough of their track record
 * (see order_ratings) for the customer to actually compare candidates before picking one. */
export type RiderApplicant = {
  riderId: string;
  riderName: string;
  distanceKm: number | null;
  outOfServiceRange: boolean;
  avgRating: number | null;
  reviewCount: number;
  recommendCount: number;
  recentComments: string[];
};

/** A rider-suggested total (e.g. after an out-of-range match) awaiting the customer's accept/reject. */
export type FeeProposal = {
  id: string;
  order_id: string;
  previous_total: number;
  proposed_total: number;
  reason: string | null;
  reason_voice_key: string | null;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  updated_at: string;
};

export type OrderDetail = {
  order: OrderRow;
  items: ListItem[];
  events: OrderEvent[];
  substitutions: Substitution[];
  payments: Payment[];
  rating: OrderRating | null;
  feeProposals: FeeProposal[];
};

/** A rider's mobile-money cash-out of their wallet balance. */
export type WalletWithdrawal = {
  id: string;
  rider_id: string;
  amount: number;
  provider: string;
  provider_ref: string | null;
  msisdn: string | null;
  network: string | null;
  status: "pending" | "successful" | "failed";
  created_at: string;
  updated_at: string;
};

export type Wallet = {
  balance: number;
  withdrawals: WalletWithdrawal[];
};

/** A customer's own top-up/spend history entry — the audit trail behind
 * their wallet_balance (see apps/api/src/wallet/service.ts).
 * `actor_id`/`actor_name` are who actually triggered the entry when
 * that's not the wallet owner (someone spending via a shared-wallet
 * grant); `counterparty_id`/`counterparty_name` are the other side of a
 * transfer_out/transfer_in pair. Both are null for every other type. */
export type WalletLedgerEntry = {
  id: string;
  user_id: string;
  type: "topup" | "order_payment" | "refund" | "adjustment" | "transfer_out" | "transfer_in";
  amount: number;
  balance_after: number;
  order_id: string | null;
  topup_id: string | null;
  counterparty_id: string | null;
  counterparty_name: string | null;
  actor_id: string | null;
  actor_name: string | null;
  note: string | null;
  created_at: string;
};

/** One top-up attempt — mirrors WalletWithdrawal's shape on the rider side. */
export type WalletTopup = {
  id: string;
  user_id: string;
  amount: number;
  provider: string;
  provider_ref: string | null;
  method: "mobile_money" | "card";
  msisdn: string | null;
  network: string | null;
  status: "pending" | "successful" | "failed";
  created_at: string;
  updated_at: string;
};

/** Closed-loop store credit — top up and spend, no cash-out. Balance is
 * capped by verification tier (see PaymentProviderInfo/wallet settings). */
export type CustomerWallet = {
  balance: number;
  cap: number;
  verified: boolean;
  ledger: WalletLedgerEntry[];
};

export type WalletShareStatus = "pending" | "active" | "revoked" | "declined";

/** A wallet-sharing grant this customer extended to someone else — shown
 * on the owner's side so they can see who they've invited/allowed and
 * revoke it. */
export type WalletShareGranted = {
  id: string;
  grantee_id: string;
  grantee_name: string;
  status: WalletShareStatus;
  created_at: string;
  responded_at: string | null;
};

/** A wallet-sharing grant extended to this customer by someone else —
 * `owner_balance` is only populated once `status` is "active" (an owner's
 * balance isn't shown to an invite that hasn't been accepted yet). */
export type WalletShareReceived = {
  id: string;
  owner_id: string;
  owner_name: string;
  status: WalletShareStatus;
  created_at: string;
  responded_at: string | null;
  owner_balance: number | null;
};

export type WalletShares = {
  granted: WalletShareGranted[];
  received: WalletShareReceived[];
};

/** Which payment aggregator identity — the underlying provider a payment
 * settled through, independent of live-vs-simulated. */
export type PaymentProviderIdentity = "yo" | "flutterwave";

/** One credential field's admin-facing status — never the value itself,
 * just enough to render a form and show what's already set. */
export type PaymentCredentialFieldStatus = {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder?: string;
  helpText?: string;
  set: boolean;
};

export type PaymentProviderInfo = {
  key: PaymentProviderIdentity;
  displayName: string;
  configured: boolean;
  supportsDisbursement: boolean;
  active: boolean;
  /** Position in the admin's priority order, or -1 if not active. */
  priority: number;
  /** This provider's real API credential fields (from the provider's own
   * requirements — see apps/api/src/payments/credentials.ts) and whether
   * each is currently set, DB-stored or env-var fallback alike. */
  credentialFields: PaymentCredentialFieldStatus[];
};

export type CreateListBody = {
  title?: string;
  items?: Array<{ name: string; quantity?: number; unitCost?: number; note?: string }>;
};

export type CreateListResponse = {
  id: string;
  listId: string;
  title: string;
  status: "draft";
  itemCount: number;
  createdAt: string;
  nextPath: string;
};

/** A staff account, as listed on the admin Staff page. */
export type StaffMember = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  status: UserStatus;
  admin_role: AdminRole;
  force_password_change: number;
  invited_at: string | null;
  invited_by_name: string | null;
  last_login_at: string | null;
};

/**
 * One row from the admin activity log. before_json/after_json are raw JSON
 * strings (or null, for actions that don't capture a snapshot) — parse them
 * only where a UI actually needs to render the diff.
 */
export type ActivityLogEntry = {
  id: string;
  actor_id: string;
  actor_name: string;
  actor_role: AdminRole | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  summary: string;
  before_json: string | null;
  after_json: string | null;
  revertible: number;
  reverted_at: string | null;
  reverted_by: string | null;
  created_at: string;
};
