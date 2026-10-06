import { ORDER_STAGES, type OrderRow, type OrderStageValue } from "@tuma/shared";

export const STAGE_LABELS: Record<OrderStageValue, string> = {
  Create: "New order",
  Match: "Matched",
  Fund: "Awaiting funding",
  Shop: "Shopping",
  Substitute: "Substitution review",
  Approve: "Approved",
  Deliver: "Delivering",
  Arrived: "Arrived",
  Handover: "Handover",
  Settle: "Completed",
};

export function stageIndex(stage: string): number {
  const i = ORDER_STAGES.indexOf(stage as OrderStageValue);
  return i === -1 ? 0 : i;
}

export function stageProgressPct(stage: string): number {
  return Math.round(((stageIndex(stage) + 1) / ORDER_STAGES.length) * 100);
}

export function stageLabel(stage: string, type?: OrderRow["type"]): string {
  if (type === "parcel" && stage === "Shop") return "Picking up";
  return STAGE_LABELS[stage as OrderStageValue] ?? stage;
}

export function formatUgx(amount: number | null | undefined): string {
  if (amount == null) return "—";
  return `UGX ${amount.toLocaleString("en-UG")}`;
}

/** Takes only the four fields it reads, so it works for both a full order
 * and the deliberately thinner AvailableJob from the open-jobs feed. */
type TitleableOrder = Pick<OrderRow, "id" | "type" | "customer_name" | "destination_area">;

export function jobTitle(order: TitleableOrder): string {
  if (order.type !== "parcel") {
    const firstName = order.customer_name?.trim().split(/\s+/)[0];
    if (firstName) return `${firstName}'s List`;
  }
  const noun = order.type === "parcel" ? "Parcel" : "Delivery";
  return order.destination_area ? `${noun} to ${order.destination_area}` : `Job #${order.id.slice(-6)}`;
}
