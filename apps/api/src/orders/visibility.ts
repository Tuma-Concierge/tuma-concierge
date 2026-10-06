/**
 * What each party is allowed to see of an order.
 *
 * Both helpers here exist because `SELECT o.*` is convenient and indiscriminate
 * — it hands every column to whoever asked, and two of those columns shouldn't
 * travel as far as the query does.
 */

type Row = Record<string, unknown>;

export type OrderViewer = { sub: string; role: "customer" | "rider" | "admin" };

/**
 * The handover PIN proves the customer physically received the goods. A rider
 * who can read it can claim a handover that never happened, which is the one
 * thing the PIN exists to prevent — so it only goes to the customer whose
 * order it is (and to admins, who need it for support).
 *
 * Handover is customer-driven today, so this isn't exploitable right now. It
 * becomes exploitable the moment handover moves into the rider's app, and the
 * fix costs nothing today.
 */
export function redactOrder(order: Row | undefined, viewer: OrderViewer): Row | undefined {
  if (!order) return order;
  if (viewer.role === "admin" || order.customer_id === viewer.sub) return order;
  const { pin_code: _pin, ...rest } = order;
  return rest;
}

export function redactOrders(orders: Row[], viewer: OrderViewer): Row[] {
  return orders.map((o) => redactOrder(o, viewer) as Row);
}

/** Coordinates rounded to ~100m. Enough to place a job on a map and judge
 * whether it's worth taking, not enough to identify a front door. */
function coarse(value: unknown): number | null {
  return typeof value === "number" ? Math.round(value * 1000) / 1000 : null;
}

/**
 * An open job is visible to *every* online rider, including all the ones who
 * never take it — so it carries the least that still lets a rider decide.
 * Full name, street address and exact coordinates are withheld until someone
 * actually claims the job and becomes accountable for it.
 */
export function toOpenJob(
  order: Row,
  extras: { distanceKm: number | null; outOfServiceRange: boolean; applied: boolean },
): Row {
  const fullName = (order.customer_name as string | null)?.trim();
  return {
    id: order.id,
    type: order.type,
    stage: order.stage,
    matching_mode: order.matching_mode,
    payment_rail: order.payment_rail,
    currency: order.currency,
    estimated_total: order.estimated_total,
    final_total: order.final_total,
    delivery_fee: order.delivery_fee,
    pickup_area: order.pickup_area,
    destination_area: order.destination_area,
    pickup_lat: coarse(order.pickup_lat),
    pickup_lng: coarse(order.pickup_lng),
    destination_lat: coarse(order.destination_lat),
    destination_lng: coarse(order.destination_lng),
    distance_km: order.distance_km,
    matched_out_of_range: order.matched_out_of_range,
    created_at: order.created_at,
    updated_at: order.updated_at,
    // First name only — enough to label the card ("Sharon's List"), not
    // enough to identify someone from a feed anyone can sign up to watch.
    customer_name: fullName ? fullName.split(/\s+/)[0] : null,
    ...extras,
  };
}
