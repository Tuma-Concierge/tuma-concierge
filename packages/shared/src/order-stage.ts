/** Canonical order journey stages (UX 2026-09-10). */
export const OrderStage = {
  Create: "Create",
  Match: "Match",
  Fund: "Fund",
  Shop: "Shop",
  Substitute: "Substitute",
  Approve: "Approve",
  Deliver: "Deliver",
  Arrived: "Arrived",
  Handover: "Handover",
  Settle: "Settle",
} as const;

export type OrderStage = (typeof OrderStage)[keyof typeof OrderStage];

export const ORDER_STAGES: readonly OrderStage[] = [
  OrderStage.Create,
  OrderStage.Match,
  OrderStage.Fund,
  OrderStage.Shop,
  OrderStage.Substitute,
  OrderStage.Approve,
  OrderStage.Deliver,
  OrderStage.Arrived,
  OrderStage.Handover,
  OrderStage.Settle,
] as const;
