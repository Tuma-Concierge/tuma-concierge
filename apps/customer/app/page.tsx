import { ActiveOrderCard } from "../components/home/ActiveOrderCard";
import { Greeting } from "../components/home/Greeting";
import { LocationOnboarding } from "../components/home/LocationOnboarding";
import { OrderTypeCards } from "../components/home/OrderTypeCards";
import { RecentLists } from "../components/home/RecentLists";
import { TrustBanner } from "../components/home/TrustBanner";

export default function HomePage() {
  return (
    <div className="space-y-5 px-4 pb-6 pt-2">
      <Greeting />
      <OrderTypeCards />
      <TrustBanner />
      <ActiveOrderCard />
      <RecentLists />
      <LocationOnboarding />
    </div>
  );
}
