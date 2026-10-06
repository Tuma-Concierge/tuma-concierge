"use client";

import { useState } from "react";
import { ParcelCard } from "./ParcelCard";
import { ParcelModal } from "./ParcelModal";
import { ShoppingListCard } from "./ShoppingListCard";
import { ShoppingListModal } from "./ShoppingListModal";

export function OrderTypeCards() {
  const [open, setOpen] = useState<"shopping" | "parcel" | null>(null);

  return (
    <>
      <div className="flex flex-col gap-3">
        <ShoppingListCard onClick={() => setOpen("shopping")} />
        <ParcelCard onClick={() => setOpen("parcel")} />
      </div>
      {open === "shopping" && <ShoppingListModal onClose={() => setOpen(null)} />}
      {open === "parcel" && <ParcelModal onClose={() => setOpen(null)} />}
    </>
  );
}
