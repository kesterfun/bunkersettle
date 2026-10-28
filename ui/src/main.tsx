import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChainProvider } from "./chain/ChainContext";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ChainProvider>
      <App />
    </ChainProvider>
  </StrictMode>,
);
