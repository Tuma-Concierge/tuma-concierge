import { ORDER_STAGES, type OrderRow, type OrderStageValue } from "@tuma/shared";

export const STAGE_LABELS: Record<OrderStageValue, string> = {
  Create: "Building order",
  Match: "Finding rider",
  Fund: "Funding",
  Shop: "Shopping",
  Substitute: "Substitution review",
  Approve: "Approved",
  Deliver: "En route",
  Arrived: "Rider has arrived",
  Handover: "Handover",
  Settle: "Delivered",
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

export function orderTitle(order: OrderRow): string {
  const noun = order.type === "parcel" ? "Parcel" : "Order";
  return order.destination_area ? `${noun} to ${order.destination_area}` : `${noun} #${order.id.slice(-6)}`;
}

/** SQLite's `datetime('now')` is "YYYY-MM-DD HH:MM:SS" in UTC with no timezone marker — normalize to ISO 8601. */
function parseDbTimestamp(ts: string): Date {
  const iso = /Z|[+-]\d\d:\d\d$/.test(ts) ? ts : `${ts.replace(" ", "T")}Z`;
  return new Date(iso);
}

export function formatDateTime(ts: string): string {
  return parseDbTimestamp(ts).toLocaleString("en-UG", { dateStyle: "medium", timeStyle: "short" });
}

/** How long between two SQLite timestamps, in a compact "1h 20m" / "45 min" form. */
export function formatDuration(startTs: string, endTs: string): string {
  const minutes = Math.max(0, Math.round((parseDbTimestamp(endTs).getTime() - parseDbTimestamp(startTs).getTime()) / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
}
