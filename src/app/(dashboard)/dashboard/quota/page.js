import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import ProviderLimits from "../usage/components/ProviderLimits";
import FreeTierList from "../usage/components/FreeTierList";
import { listFreeTiers } from "open-sse/providers/freeTiers.js";

export default function QuotaPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <div className="flex flex-col gap-6">
        <ProviderLimits />
        <FreeTierList tiers={listFreeTiers()} />
      </div>
    </Suspense>
  );
}
