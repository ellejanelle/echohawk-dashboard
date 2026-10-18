import { createRoot } from "react-dom/client";
import "../shared/base.css";
import "./replay.css";
import { Replay } from "./Replay";

createRoot(document.getElementById("root")!).render(<Replay />);
