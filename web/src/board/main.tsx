import { createRoot } from "react-dom/client";
import "../shared/base.css";
import "./board.css";
import { Board } from "./Board";

createRoot(document.getElementById("root")!).render(<Board />);
