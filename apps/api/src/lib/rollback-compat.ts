/** Honor fees already agreed before rollback; new orders have no fee row. */
export function legacyPayout(collected: number, fees?: Record<string, unknown>): number {
  if (!fees) return collected;
  return Math.max(0, collected - ['service_fee', 'processing_fee_customer', 'processing_fee_rider', 'delivery_commission']
    .reduce((sum, key) => sum + (Number(fees[key]) || 0), 0));
}

/** Later service orders remain stored but cannot enter the older delivery flow. */
export function supportsLegacyOrder(order: Record<string, unknown>): boolean {
  return !Number(order.is_ride) && !order.restaurant_id && !order.merchant_id;
}
