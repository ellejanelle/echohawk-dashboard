import { createRoot } from "react-dom/client";
import "../shared/base.css";
import "./console.css";
import { Console } from "./Console";

createRoot(document.getElementById("root")!).render(<Console />);
