import { createRoot } from "react-dom/client";
import "../shared/base.css";
import "./node.css";
import { Node } from "./Node";

createRoot(document.getElementById("root")!).render(<Node />);
