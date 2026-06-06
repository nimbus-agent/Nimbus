import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { App } from "./App";

// getElementById returns HTMLElement|null; the #root element is guaranteed present in index.html.
const rootElement = document.getElementById("root") as HTMLElement; // NOSONAR S4325: required non-null DOM assertion
ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
