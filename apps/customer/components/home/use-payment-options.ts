"use client";
import {useEffect, useState} from "react";
import type {DeliverySettings} from "@tuma/shared";
import {api, errorMessage} from "../../lib/api";

export function usePaymentOptions() {
  const [paymentRail, setPaymentRail] = useState<"float" | "escrow">("float");
  const [rails, setRails] = useState<("float" | "escrow")[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<DeliverySettings | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.getSettings().then(({settings}) => {
      if (cancelled) return;
      const enabled: ("float" | "escrow")[] = [];
      if (settings.paymentMethods.includes("cash")) enabled.push("float");
      if (settings.paymentMethods.includes("mobile_money")) enabled.push("escrow");
      setRails(enabled);setPaymentRail(enabled[0]);setSettings(settings);
    }).catch((err) => {if (!cancelled) setError(errorMessage(err));});
    return () => {cancelled = true;};
  }, []);
  return {paymentRail, setPaymentRail, rails, settings, paymentOptionsError:error, paymentOptionsReady:rails.length > 0};
}
