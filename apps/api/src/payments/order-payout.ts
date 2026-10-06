import {db} from "../db/client.js";
import {detectMobileMoneyNetwork} from "@tuma/shared";
import {legacyPayout} from "../lib/rollback-compat.js";
import {getSetting} from "../lib/settings.js";
import {resolveProvider, initiateDisbursement, checkPaymentStatus} from "./service.js";

type Row = Record<string, unknown>;
type PayoutState = {kind: "order_payout"; state: "reserved" | "submitting" | "submitted" | "unknown"; forceMock:boolean; error?:string};

/** Unique payment IDs plus a compare-and-set claim prevent duplicate sends.
 * Unknown network outcomes are retained for provider reconciliation, never resent. */
export async function startOrderPayout(orderId:string, send:typeof initiateDisbursement=initiateDisbursement):Promise<Row> {
  const order=(await db.execute({sql:"SELECT * FROM orders WHERE id = ?",args:[orderId]})).rows[0] as Row | undefined;
  if (!order || !order.rider_id || !["Handover","Settle"].includes(String(order.stage))) throw new Error("This order is not ready for payout.");
  if (order.payment_rail !== "escrow") throw new Error("Cash orders do not need a mobile-money payout.");
  const existing=(await db.execute({sql:"SELECT * FROM payments WHERE order_id = ? AND type = 'disbursement' AND id GLOB ? ORDER BY rowid DESC",args:[orderId,`payout_${orderId}_*`]})).rows as Row[];
  const previous=existing[0];
  if (previous && previous.status !== "failed") return submitReserved(previous,send);
  if (order.stage === "Settle" && !previous) throw new Error("Historical wallet-settled orders cannot be paid out again.");
  const collections=(await db.execute({sql:"SELECT * FROM payments WHERE order_id = ? AND type = 'collection' AND status = 'successful'",args:[orderId]})).rows as Row[];
  const refunds=(await db.execute({sql:"SELECT COALESCE(SUM(amount),0) AS amount FROM payments WHERE order_id = ? AND type IN ('refund','disbursement') AND status = 'successful'",args:[orderId]})).rows[0];
  const collected=collections.reduce((sum,row)=>sum+Number(row.amount),0)-Number(refunds?.amount ?? 0);
  if (collected <= 0) throw new Error("No collected funds are available for this payout.");
  const fees=(await db.execute({sql:"SELECT * FROM order_fees WHERE order_id = ?",args:[orderId]})).rows[0] as Row | undefined;
  const amount=legacyPayout(collected,fees);
  const rider=(await db.execute({sql:"SELECT momo_msisdn FROM riders WHERE user_id = ?",args:[String(order.rider_id)]})).rows[0];
  const msisdn=String(rider?.momo_msisdn ?? "");
  if (amount > 0 && !detectMobileMoneyNetwork(msisdn)) throw new Error("The rider needs a valid MTN or Airtel mobile-money number before payout.");
  const forceMock=order.environment === "sandbox" || collections.every((row)=>String(row.provider).endsWith("_mock"));
  const provider=await resolveProvider("disbursement",{forceMock});
  if (!forceMock && provider.endsWith("_mock")) throw new Error("A live mobile-money payout provider must be configured. Funds remain held by Tuma.");
  const id=`payout_${orderId}_${existing.length}`;
  const state:PayoutState={kind:"order_payout",state:"reserved",forceMock};
  await db.execute({sql:"INSERT OR IGNORE INTO payments(id,order_id,type,provider,msisdn,amount,status,raw_payload) VALUES(?,?,'disbursement',?,?,?, ?,?)",args:[id,orderId,provider,msisdn,amount,amount===0?"successful":"pending",JSON.stringify(state)]});
  const payment=(await db.execute({sql:"SELECT * FROM payments WHERE id = ?",args:[id]})).rows[0] as Row;
  return submitReserved(payment,send);
}

async function submitReserved(payment:Row, send:typeof initiateDisbursement=initiateDisbursement):Promise<Row> {
  let state:PayoutState;
  try {state=JSON.parse(String(payment.raw_payload)) as PayoutState;} catch {return payment;}
  if (payment.status !== "pending" || state.kind !== "order_payout" || state.state !== "reserved") return payment;
  const claimed=await db.execute({sql:"UPDATE payments SET raw_payload = ?, updated_at=datetime('now') WHERE id = ? AND status = 'pending' AND raw_payload = ?",args:[JSON.stringify({...state,state:"submitting"}),String(payment.id),String(payment.raw_payload)]});
  if (!claimed.rowsAffected) return (await db.execute({sql:"SELECT * FROM payments WHERE id = ?",args:[String(payment.id)]})).rows[0] as Row;
  try {
    const result=await send({referenceId:String(payment.id),msisdn:String(payment.msisdn),amount:Number(payment.amount),forceMock:state.forceMock,providerOverride:String(payment.provider) as Parameters<typeof initiateDisbursement>[0]["providerOverride"]});
    if (!result.providerRef && result.status !== "failed") throw new Error("Provider did not return a transaction reference.");
    await db.execute({sql:"UPDATE payments SET provider_ref = ?, status = ?, raw_payload = ?, updated_at=datetime('now') WHERE id = ? AND status = 'pending'",args:[result.providerRef || null,result.status ?? "pending",JSON.stringify({...state,state:"submitted"}),String(payment.id)]});
  } catch {
    console.warn(JSON.stringify({event:"order_payout_confirmation_required",paymentId:String(payment.id)}));
    await db.execute({sql:"UPDATE payments SET raw_payload = ?, updated_at=datetime('now') WHERE id = ?",args:[JSON.stringify({...state,state:"unknown",error:"Provider confirmation required before any retry."}),String(payment.id)]});
  }
  return (await db.execute({sql:"SELECT * FROM payments WHERE id = ?",args:[String(payment.id)]})).rows[0] as Row;
}

export async function reconcileOrderPayouts(check:typeof checkPaymentStatus=checkPaymentStatus):Promise<void> {
  const seconds=Number(await getSetting("payout_check_seconds")) || 120;
  const rows=(await db.execute({sql:"SELECT * FROM payments WHERE type = 'disbursement' AND status = 'pending' AND (provider_ref IS NOT NULL OR raw_payload LIKE '%\"state\":\"reserved\"%') AND updated_at <= datetime('now', ?) ORDER BY updated_at LIMIT 25",args:[`-${seconds} seconds`]})).rows as Row[];
  for (const payment of rows) {
    try {
      const submitted=await submitReserved(payment);
      if (!submitted.provider_ref) continue;
      const status=await check({provider:String(submitted.provider),provider_ref:String(submitted.provider_ref),created_at:String(submitted.created_at)});
      await db.execute({sql:"UPDATE payments SET status = ?, updated_at=datetime('now') WHERE id = ? AND status = 'pending'",args:[status,String(submitted.id)]});
    } catch { console.warn(JSON.stringify({event:"order_payout_status_unavailable",paymentId:String(payment.id)})); }
  }
}
