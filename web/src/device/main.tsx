import { createRoot } from "react-dom/client";
import "../shared/theme.css";
import "./device.css";
import { DeviceApp } from "./DeviceApp";

createRoot(document.getElementById("root")!).render(<DeviceApp />);
