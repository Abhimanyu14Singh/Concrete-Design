import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import Popout from "./Popout.jsx";
import { isPopoutWindow, popoutKind } from "./popoutBus.js";
import "./ui.css";
import "./starter.css";

// One bundle, one entry, two roles. A popped-out window loads the SAME page with
// ?popout=<kind> and returns early here, so the whole main-window app — toolbar, table,
// keyboard handlers — never mounts behind a single panel.
const root = createRoot(document.getElementById("root"));
root.render(isPopoutWindow() ? <Popout kind={popoutKind()} /> : <App />);
