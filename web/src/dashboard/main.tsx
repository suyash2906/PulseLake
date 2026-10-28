import { createRoot } from "react-dom/client";
import "../shared/theme.css";
import "./dashboard.css";
import "./v3.css";
import { Dashboard } from "./Dashboard";

createRoot(document.getElementById("root")!).render(<Dashboard />);
