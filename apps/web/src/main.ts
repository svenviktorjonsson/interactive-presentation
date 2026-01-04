import "katex/dist/katex.min.css";
import "./styles.css";

// Expose KaTeX as a global for @cellmax/katex-renderer (it expects `globalThis.katex`).
import katex from "katex";
(globalThis as any).katex = katex;

import { bootstrap } from "./ip/bootstrap";

void bootstrap();
