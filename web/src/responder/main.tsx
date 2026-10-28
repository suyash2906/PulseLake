import { createRoot } from "react-dom/client";
import "../shared/theme.css";
import "./responder.css";
import { ResponderApp } from "./ResponderApp";

createRoot(document.getElementById("root")!).render(<ResponderApp />);
