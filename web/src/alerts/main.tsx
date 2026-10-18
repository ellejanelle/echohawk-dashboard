import { createRoot } from "react-dom/client";
import "../shared/base.css";
import "./alerts.css";
import { Alerts } from "./Alerts";

createRoot(document.getElementById("root")!).render(<Alerts />);
