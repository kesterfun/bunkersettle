import { useChain } from "./chain/ChainContext";
import { Header } from "./components/Header";
import { Toasts } from "./components/Toasts";
import { ActivityTicker } from "./components/ActivityTicker";
import { ActivityLog } from "./components/ActivityLog";
import { HarbourView } from "./components/HarbourView";
import { OrderScreen } from "./components/OrderScreen";
import { CreateOrderForm } from "./components/CreateOrderForm";
import { OracleConsole } from "./components/OracleConsole";
import { DisputesView } from "./components/DisputesView";
import { NetworkPanel } from "./components/NetworkPanel";
import { MarketPanel } from "./components/MarketPanel";

export function App() {
  const { view } = useChain();
  return (
    <>
      <Header />
      <main className="app-main">
        {view === "harbour" && (<><NetworkPanel /><HarbourView /></>)}
        {view === "order" && <OrderScreen />}
        {view === "create" && <CreateOrderForm />}
        {view === "oracle" && <OracleConsole />}
        {view === "disputes" && <DisputesView />}
        {view === "activity" && (
          <>
            <h1 className="page-title">
              Activity
              <small>Every contract event, newest first, decoded from the chain.</small>
            </h1>
            <ActivityLog />
          </>
        )}
        {view === "market" && <MarketPanel />}
      </main>
      <Toasts />
      <ActivityTicker />
    </>
  );
}
