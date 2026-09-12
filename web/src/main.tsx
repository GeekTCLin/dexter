import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

// Read token from URL on load
const params = new URLSearchParams(window.location.search);
const token = params.get("token");
if (token) {
  // Persist to sessionStorage so it survives navigation but not tab close
  sessionStorage.setItem("dexter-token", token);
  // Clean URL
  window.history.replaceState({}, "", window.location.pathname);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
