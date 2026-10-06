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

export function stageLabel(stage: string, type?: OrderRow["type"]): string {
  if (type === "parcel" && stage === "Shop") return "Picking up";
  return STAGE_LABELS[stage as OrderStageValue] ?? stage;
}

export function formatUgx(amount: number | null | undefined): string {
  if (amount == null) return "—";
  return `UGX ${amount.toLocaleString("en-UG")}`;
}

export function orderTitle(order: OrderRow): string {
  const noun = order.type === "parcel" ? "Parcel" : "Shopping list";
  const who = order.customer_name?.trim() || "Unknown customer";
  return order.destination_area ? `${who} · ${order.destination_area}` : `${who} · ${noun}`;
}

export function formatDate(iso: string): string {
  return new Date(`${iso.replace(" ", "T")}Z`).toLocaleString("en-UG", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
