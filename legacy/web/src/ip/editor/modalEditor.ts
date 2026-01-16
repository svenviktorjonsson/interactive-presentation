import type { PresentationModel } from "@interactive/content";
import type { Engine } from "@interactive/engine";

export async function openNodeEditorModal(opts: {
  engine: Engine;
  nodeId: string;
  cloneModel: (m: PresentationModel) => PresentationModel;
  applySelection: () => void;
  commit: (before: PresentationModel) => Promise<void>;
  hydrateQrImages: (engine: Engine, model: PresentationModel) => Promise<void>;
  hydrateTextMath: (engine: Engine, model: PresentationModel) => void;
  renderTextWithKatexToHtml: (input: string) => string;
}) {
  const { engine, nodeId } = opts;
  const model = engine.getModel();
  if (!model) return;
  const node = model.nodes.find((n) => n.id === nodeId);
  if (!node) return;

  const before = opts.cloneModel(model);
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "modal";
  backdrop.appendChild(modal);

  let activeTab: "data" | "geometry" | "animations" = "data";

  const header = document.createElement("div");
  header.className = "modal-header";
  header.innerHTML = `<div class="modal-title">Edit: ${node.type} (${node.id})</div>`;

  const tabs = document.createElement("div");
  tabs.className = "tabs";
  const tabData = document.createElement("button");
  tabData.className = "tab is-active";
  tabData.type = "button";
  tabData.textContent = "Data";
  const tabGeom = document.createElement("button");
  tabGeom.className = "tab";
  tabGeom.type = "button";
  tabGeom.textContent = "Geometry";
  const tabAnim = document.createElement("button");
  tabAnim.className = "tab";
  tabAnim.type = "button";
  tabAnim.textContent = "Animations";
  tabs.append(tabData, tabGeom, tabAnim);
  header.appendChild(tabs);

  const body = document.createElement("div");
  body.className = "modal-body";

  const footer = document.createElement("div");
  footer.className = "modal-footer";
  const btnCancel = document.createElement("button");
  btnCancel.className = "btn";
  btnCancel.type = "button";
  btnCancel.textContent = "Cancel";
  const btnSave = document.createElement("button");
  btnSave.className = "btn primary";
  btnSave.type = "button";
  btnSave.textContent = "Save";
  footer.append(btnCancel, btnSave);

  modal.append(header, body, footer);
  document.body.appendChild(backdrop);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state: any = JSON.parse(JSON.stringify(node));

  const render = () => {
    body.innerHTML = "";
    tabData.classList.toggle("is-active", activeTab === "data");
    tabGeom.classList.toggle("is-active", activeTab === "geometry");
    tabAnim.classList.toggle("is-active", activeTab === "animations");

    if (activeTab === "data") {
      const common = document.createElement("div");
      common.style.display = "grid";
      common.style.gridTemplateColumns = "repeat(2, 1fr)";
      common.style.gap = "12px";

      const mkText = (label: string, key: string, placeholder = "") => {
        const f = document.createElement("div");
        f.className = "field";
        f.innerHTML = `<label>${label}</label>`;
        const i = document.createElement("input");
        i.type = "text";
        i.placeholder = placeholder;
        i.value = String(state[key] ?? "");
        i.addEventListener("input", () => (state[key] = i.value));
        f.appendChild(i);
        return f;
      };
      const mkNum = (label: string, key: string, o?: { step?: string; min?: string; max?: string }) => {
        const f = document.createElement("div");
        f.className = "field";
        f.innerHTML = `<label>${label}</label>`;
        const i = document.createElement("input");
        i.type = "number";
        if (o?.step) i.step = o.step;
        if (o?.min) i.min = o.min;
        if (o?.max) i.max = o.max;
        i.value = state[key] == null || state[key] === "" ? "" : String(state[key]);
        i.addEventListener("input", () => {
          const v = i.value.trim();
          if (!v) delete state[key];
          else state[key] = Number(v);
        });
        f.appendChild(i);
        return f;
      };
      const mkBool = (label: string, key: string) => {
        const f = document.createElement("div");
        f.className = "field";
        f.innerHTML = `<label>${label}</label>`;
        const wrap = document.createElement("div");
        wrap.style.display = "flex";
        wrap.style.alignItems = "center";
        wrap.style.gap = "10px";
        const i = document.createElement("input");
        i.type = "checkbox";
        i.checked = state[key] !== false;
        i.addEventListener("change", () => (state[key] = i.checked));
        const txt = document.createElement("div");
        txt.className = "preview";
        txt.style.padding = "8px 10px";
        txt.textContent = i.checked ? "on" : "off";
        i.addEventListener("change", () => (txt.textContent = i.checked ? "on" : "off"));
        wrap.append(i, txt);
        f.appendChild(wrap);
        return f;
      };

      common.append(
        mkText("bgColor", "bgColor", "e.g. #ff00ff / rgba(...) / 'red'"),
        mkNum("bgAlpha", "bgAlpha", { step: "0.05", min: "0", max: "1" }),
        mkNum("borderRadius", "borderRadius", { step: "1", min: "0" }),
        mkNum("opacity", "opacity", { step: "0.05", min: "0", max: "1" }),
        mkNum("zIndex", "zIndex", { step: "1" }),
        mkBool("visible", "visible")
      );
      body.appendChild(common);

      if (state.type === "text") {
        const f = document.createElement("div");
        f.className = "field";
        f.innerHTML = `<label>Text (use $$...$$ for KaTeX)</label>`;
        const ta = document.createElement("textarea");
        ta.value = state.text ?? "";
        ta.style.fontSize = "18px";
        ta.style.lineHeight = "1.35";
        const prev = document.createElement("div");
        prev.className = "preview";
        prev.innerHTML = opts.renderTextWithKatexToHtml(ta.value).replaceAll("\n", "<br/>");
        ta.addEventListener("input", () => {
          state.text = ta.value;
          prev.innerHTML = opts.renderTextWithKatexToHtml(ta.value).replaceAll("\n", "<br/>");
        });
        f.append(ta, prev);
        body.appendChild(f);
        return;
      }

      if (state.type === "qr") {
        const info = document.createElement("div");
        info.className = "field";
        info.innerHTML = `<label>Join QR</label><div class="preview">Default behavior: /join (public tunnel URL is injected at runtime).</div>`;
        body.append(info);
        body.append(mkText("url", "url", "/join"));
        return;
      }

      if (state.type === "image") {
        body.append(mkText("src", "src", "/media/<name>.png"));
        return;
      }

      if (state.type === "htmlFrame") {
        body.append(mkText("src", "src", "https://..."));
        return;
      }

      if (state.type === "video") {
        body.append(mkText("src", "src", "YouTube URL or /media/<file>.mp4 (or just <file>.mp4)"));
        body.append(mkText("thumbnail", "thumbnail", 'Optional: "MM:SS" / "HH:MM:SS" / "/media/thumb.jpg" / "https://..."'));
        return;
      }

      if (state.type === "bullets") {
        const f = document.createElement("div");
        f.className = "field";
        f.innerHTML = `<label>Bullet items (one per line)</label>`;
        const ta = document.createElement("textarea");
        ta.value = (state.items ?? []).join("\n");
        ta.style.fontSize = "18px";
        ta.style.lineHeight = "1.35";

        const styleWrap = document.createElement("div");
        styleWrap.className = "field";
        styleWrap.innerHTML = `<label>Marker style</label>`;
        const sel = document.createElement("select");
        ["A", "a", "1", "X", "i", ".", "-"].forEach((opt) => {
          const o = document.createElement("option");
          o.value = opt;
          o.textContent = opt;
          if ((state as any).bullets === opt) o.selected = true;
          sel.appendChild(o);
        });

        ta.addEventListener("input", () => {
          state.items = ta.value.split(/\r?\n/);
        });
        sel.addEventListener("change", () => {
          (state as any).bullets = sel.value;
        });

        styleWrap.appendChild(sel);
        const fontWrap = document.createElement("div");
        fontWrap.className = "field";
        fontWrap.innerHTML = `<label>fontPx</label>`;
        const fontI = document.createElement("input");
        fontI.type = "number";
        fontI.step = "1";
        fontI.value = state.fontPx == null ? "" : String(state.fontPx);
        fontI.addEventListener("input", () => {
          const v = fontI.value.trim();
          if (!v) delete state.fontPx;
          else state.fontPx = Number(v);
        });
        fontWrap.append(fontI);

        f.append(ta, styleWrap, fontWrap);
        body.append(f);
        return;
      }

      if (state.type === "table") {
        const delimF = document.createElement("div");
        delimF.className = "field";
        delimF.innerHTML = `<label>delimiter</label>`;
        const delimI = document.createElement("input");
        delimI.type = "text";
        delimI.value = String(state.delimiter ?? ";");
        delimI.addEventListener("input", () => (state.delimiter = delimI.value || ";"));
        delimF.append(delimI);

        const rowsF = document.createElement("div");
        rowsF.className = "field";
        rowsF.innerHTML = `<label>rows (one row per line)</label>`;
        const ta = document.createElement("textarea");
        ta.value = (state.rows ?? []).map((r: any[]) => (r ?? []).join(String(state.delimiter ?? ";"))).join("\n");
        ta.style.fontSize = "16px";
        ta.style.lineHeight = "1.35";
        ta.addEventListener("input", () => {
          const delim = String(state.delimiter ?? ";") || ";";
          state.rows = ta.value
            .split(/\r?\n/)
            .filter((ln) => ln.length > 0)
            .map((ln) => ln.split(delim).map((c) => c.trim()));
        });
        rowsF.append(ta);
        body.append(delimF, rowsF);
        return;
      }

      if (state.type === "graph") {
        const grid = document.createElement("div");
        grid.style.display = "grid";
        grid.style.gridTemplateColumns = "repeat(2, 1fr)";
        grid.style.gap = "12px";
        const mkText2 = (label: string, key: string, placeholder = "") => {
          const f = document.createElement("div");
          f.className = "field";
          f.innerHTML = `<label>${label}</label>`;
          const i = document.createElement("input");
          i.type = "text";
          i.placeholder = placeholder;
          i.value = String((state as any)[key] ?? "");
          i.addEventListener("input", () => ((state as any)[key] = i.value));
          f.appendChild(i);
          return f;
        };
        const mkSel = (label: string, key: string, options: string[]) => {
          const f = document.createElement("div");
          f.className = "field";
          f.innerHTML = `<label>${label}</label>`;
          const s = document.createElement("select");
          for (const o0 of options) {
            const o = document.createElement("option");
            o.value = o0;
            o.textContent = o0;
            s.appendChild(o);
          }
          s.value = String((state as any)[key] ?? options[0]);
          s.addEventListener("change", () => ((state as any)[key] = s.value));
          f.appendChild(s);
          return f;
        };
        grid.append(
          mkText2("color", "color", "white"),
          mkText2("xSource", "xSource", "t_table.c1"),
          mkText2("ySource", "ySource", "t_table.c2"),
          mkText2("xLabel", "xLabel", "x"),
          mkText2("yLabel", "yLabel", "y"),
          mkSel("grid", "grid", ["on", "off"])
        );
        body.append(grid);
        return;
      }

      if (state.type === "timer") {
        const grid = document.createElement("div");
        grid.style.display = "grid";
        grid.style.gridTemplateColumns = "repeat(2, 1fr)";
        grid.style.gap = "12px";
        const mkText2 = (label: string, key: string, placeholder = "") => {
          const f = document.createElement("div");
          f.className = "field";
          f.innerHTML = `<label>${label}</label>`;
          const i = document.createElement("input");
          i.type = "text";
          i.placeholder = placeholder;
          i.value = String(state[key] ?? "");
          i.addEventListener("input", () => (state[key] = i.value));
          f.appendChild(i);
          return f;
        };
        const mkNum2 = (label: string, key: string, o?: { step?: string; min?: string; max?: string }) => {
          const f = document.createElement("div");
          f.className = "field";
          f.innerHTML = `<label>${label}</label>`;
          const i = document.createElement("input");
          i.type = "number";
          if (o?.step) i.step = o.step;
          if (o?.min) i.min = o.min;
          if (o?.max) i.max = o.max;
          i.value = state[key] == null || state[key] === "" ? "" : String(state[key]);
          i.addEventListener("input", () => {
            const v = i.value.trim();
            if (!v) delete state[key];
            else state[key] = Number(v);
          });
          f.appendChild(i);
          return f;
        };
        const mkBool2 = (label: string, key: string) => {
          const f = document.createElement("div");
          f.className = "field";
          f.innerHTML = `<label>${label}</label>`;
          const wrap = document.createElement("div");
          wrap.style.display = "flex";
          wrap.style.alignItems = "center";
          wrap.style.gap = "10px";
          const i = document.createElement("input");
          i.type = "checkbox";
          i.checked = state[key] !== false;
          i.addEventListener("change", () => (state[key] = i.checked));
          const txt = document.createElement("div");
          txt.className = "preview";
          txt.style.padding = "8px 10px";
          txt.textContent = i.checked ? "on" : "off";
          i.addEventListener("change", () => (txt.textContent = i.checked ? "on" : "off"));
          wrap.append(i, txt);
          f.appendChild(wrap);
          return f;
        };
        grid.append(
          mkBool2("showTime", "showTime"),
          mkText2("barColor", "barColor", "orange"),
          mkText2("lineColor", "lineColor", "green"),
          mkNum2("lineWidth", "lineWidth", { step: "0.5", min: "0" }),
          mkNum2("minS", "minS", { step: "0.1" }),
          mkNum2("maxS", "maxS", { step: "0.1" }),
          mkNum2("binSizeS", "binSizeS", { step: "0.1", min: "0" })
        );
        const statF = document.createElement("div");
        statF.className = "field";
        statF.innerHTML = `<label>stat</label>`;
        const statS = document.createElement("select");
        for (const v of ["gaussian"]) {
          const o = document.createElement("option");
          o.value = v;
          o.textContent = v;
          statS.appendChild(o);
        }
        statS.value = String(state.stat ?? "gaussian");
        statS.addEventListener("change", () => (state.stat = statS.value));
        statF.append(statS);
        body.append(grid, statF);
        return;
      }

      if (state.type === "arrow" || (state as any).type === "line") {
        const grid = document.createElement("div");
        grid.style.display = "grid";
        grid.style.gridTemplateColumns = "repeat(2, 1fr)";
        grid.style.gap = "12px";
        grid.append(mkText("color", "color", "white"), mkNum("width", "width", { step: "0.5", min: "1" }));
        body.append(grid);
        return;
      }

      if (state.type === "choices") {
        const qF = document.createElement("div");
        qF.className = "field";
        qF.innerHTML = `<label>Question</label>`;
        const taQ = document.createElement("textarea");
        taQ.value = String(state.question ?? "");
        taQ.style.fontSize = "18px";
        taQ.style.lineHeight = "1.35";
        taQ.addEventListener("input", () => (state.question = taQ.value));
        qF.append(taQ);

        const grid = document.createElement("div");
        grid.style.display = "grid";
        grid.style.gridTemplateColumns = "repeat(2, 1fr)";
        grid.style.gap = "12px";

        const bulletsF = document.createElement("div");
        bulletsF.className = "field";
        bulletsF.innerHTML = `<label>bullets</label>`;
        const bulletsS = document.createElement("select");
        for (const b of ["A", "a", "1", "I"]) {
          const o = document.createElement("option");
          o.value = b;
          o.textContent = b;
          bulletsS.appendChild(o);
        }
        bulletsS.value = String(state.bullets ?? "A");
        bulletsS.addEventListener("change", () => (state.bullets = bulletsS.value));
        bulletsF.append(bulletsS);

        const chartF = document.createElement("div");
        chartF.className = "field";
        chartF.innerHTML = `<label>chart</label>`;
        const chartS = document.createElement("select");
        for (const c of ["pie"]) {
          const o = document.createElement("option");
          o.value = c;
          o.textContent = c;
          chartS.appendChild(o);
        }
        chartS.value = String(state.chart ?? "pie");
        chartS.addEventListener("change", () => (state.chart = chartS.value));
        chartF.append(chartS);

        grid.append(bulletsF, chartF);

        const optsF = document.createElement("div");
        optsF.className = "field";
        optsF.innerHTML = `<label>Options (one per line: label:color)</label>`;
        const ta = document.createElement("textarea");
        const curOpts: any[] = Array.isArray(state.options) ? state.options : [];
        ta.value = curOpts.map((o) => `${o?.label ?? ""}${o?.color ? ":" + o.color : ""}`).join("\n");
        ta.style.fontSize = "16px";
        ta.style.lineHeight = "1.35";
        const slug = (label: string) => {
          const s = String(label || "option").trim().replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_]/g, "");
          return s || "option";
        };
        ta.addEventListener("input", () => {
          const lines = ta.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          const seen = new Set<string>();
          const out: any[] = [];
          for (const ln of lines) {
            const [labRaw, colRaw] = ln.includes(":") ? (ln.split(":", 2) as any) : [ln, ""];
            const label = String(labRaw ?? "").trim();
            const color = String(colRaw ?? "").trim();
            if (!label) continue;
            let id = slug(label);
            let n = 2;
            while (seen.has(id)) id = `${slug(label)}${n++}`;
            seen.add(id);
            out.push({ id, label, color: color || undefined });
          }
          state.options = out;
        });
        optsF.append(ta);

        body.append(qF, grid, optsF);
        return;
      }

      body.textContent = "No editable data for this node type.";
      return;
    }

    if (activeTab === "geometry") {
      const t = (state.transform ??= {});
      const grid = document.createElement("div");
      grid.style.display = "grid";
      grid.style.gridTemplateColumns = "repeat(2, 1fr)";
      grid.style.gap = "12px";

      const num = (label: string, key: string) => {
        const f = document.createElement("div");
        f.className = "field";
        f.innerHTML = `<label>${label}</label>`;
        const i = document.createElement("input");
        i.type = "number";
        i.value = String(t[key] ?? 0);
        i.addEventListener("input", () => (t[key] = Number(i.value)));
        f.appendChild(i);
        return f;
      };

      grid.append(num("x", "x"), num("y", "y"), num("w", "w"), num("h", "h"), num("rotationDeg", "rotationDeg"));

      const anchorF = document.createElement("div");
      anchorF.className = "field";
      anchorF.innerHTML = `<label>anchor</label>`;
      const anchorS = document.createElement("select");
      for (const a of ["topLeft", "topCenter", "topRight", "centerLeft", "centerCenter", "centerRight", "bottomLeft", "bottomCenter", "bottomRight"]) {
        const o = document.createElement("option");
        o.value = a;
        o.textContent = a;
        anchorS.appendChild(o);
      }
      anchorS.value = (t.anchor ?? "topLeft") === "top" ? "topCenter" : (t.anchor ?? "topLeft") === "bottom" ? "bottomCenter" : (t.anchor ?? "topLeft");
      anchorS.addEventListener("change", () => (t.anchor = anchorS.value));
      anchorF.appendChild(anchorS);

      const alignF = document.createElement("div");
      alignF.className = "field";
      alignF.innerHTML = `<label>alignment (text)</label>`;
      const alignS = document.createElement("select");
      for (const a of ["left", "center", "right"]) {
        const o = document.createElement("option");
        o.value = a;
        o.textContent = a;
        alignS.appendChild(o);
      }
      alignS.value = state.align === "right" ? "right" : state.align === "center" ? "center" : "left";
      alignS.addEventListener("change", () => (state.align = alignS.value));
      alignF.appendChild(alignS);
      alignF.querySelector("label")!.textContent = "Horizontal alignment (text)";

      const vAlignF = document.createElement("div");
      vAlignF.className = "field";
      vAlignF.innerHTML = `<label>Vertical alignment (text)</label>`;
      const vAlignS = document.createElement("select");
      for (const a of ["top", "center", "bottom"]) {
        const o = document.createElement("option");
        o.value = a;
        o.textContent = a;
        vAlignS.appendChild(o);
      }
      vAlignS.value = String(state.vAlign ?? "top");
      vAlignS.addEventListener("change", () => (state.vAlign = vAlignS.value));
      vAlignF.appendChild(vAlignS);

      body.append(grid, anchorF, alignF, vAlignF);
      return;
    }

    if (activeTab === "animations") {
      const mkAnimEditor = (label: string, key: "appear" | "disappear") => {
        const wrap = document.createElement("div");
        wrap.className = "field";
        wrap.innerHTML = `<label>${label}</label>`;

        const a = (state[key] ??= { kind: "none" });

        const typeS = document.createElement("select");
        for (const k of ["none", "sudden", "fade", "pixelate", "appear"]) {
          const o = document.createElement("option");
          o.value = k;
          o.textContent = k;
          typeS.appendChild(o);
        }
        typeS.value = String(a.kind ?? "none");
        typeS.addEventListener("change", () => {
          const v = typeS.value;
          if (v === "none") state[key] = { kind: "none" };
          else if (v === "sudden") state[key] = { kind: "sudden" };
          else if (v === "fade") state[key] = { kind: "fade", durationMs: 800, from: "all", borderFrac: 0.2, delayMs: 0 };
          else if (v === "pixelate") state[key] = { kind: "pixelate", durationMs: 800, delayMs: 0 };
          else if (v === "appear") state[key] = { kind: "appear", durationMs: 0 };
          render();
        });
        wrap.appendChild(typeS);

        const cur = state[key];
        if (cur?.kind === "fade") {
          const grid = document.createElement("div");
          grid.style.display = "grid";
          grid.style.gridTemplateColumns = "repeat(2, 1fr)";
          grid.style.gap = "12px";

          const num = (lab: string, prop: string, step = "1") => {
            const f = document.createElement("div");
            f.className = "field";
            f.innerHTML = `<label>${lab}</label>`;
            const i = document.createElement("input");
            i.type = "number";
            i.step = step;
            i.value = String(cur[prop] ?? 0);
            i.addEventListener("input", () => (cur[prop] = Number(i.value)));
            f.appendChild(i);
            return f;
          };
          grid.append(num("durationMs", "durationMs", "10"), num("delayMs", "delayMs", "10"), num("borderFrac", "borderFrac", "0.05"));

          const fromF = document.createElement("div");
          fromF.className = "field";
          fromF.innerHTML = `<label>from</label>`;
          const fromS = document.createElement("select");
          for (const f of ["all", "left", "right", "top", "bottom"]) {
            const o = document.createElement("option");
            o.value = f;
            o.textContent = f;
            fromS.appendChild(o);
          }
          fromS.value = cur.from ?? "all";
          fromS.addEventListener("change", () => (cur.from = fromS.value));
          fromF.appendChild(fromS);

          wrap.append(grid, fromF);
        } else if (cur?.kind === "pixelate") {
          const grid = document.createElement("div");
          grid.style.display = "grid";
          grid.style.gridTemplateColumns = "repeat(2, 1fr)";
          grid.style.gap = "12px";
          const num = (lab: string, prop: string) => {
            const f = document.createElement("div");
            f.className = "field";
            f.innerHTML = `<label>${lab}</label>`;
            const i = document.createElement("input");
            i.type = "number";
            i.step = "10";
            i.value = String(cur[prop] ?? 0);
            i.addEventListener("input", () => (cur[prop] = Number(i.value)));
            f.appendChild(i);
            return f;
          };
          grid.append(num("durationMs", "durationMs"), num("delayMs", "delayMs"));
          wrap.appendChild(grid);
        }

        return wrap;
      };

      body.append(mkAnimEditor("Enter (appear)", "appear"), mkAnimEditor("Exit (disappear)", "disappear"));
      return;
    }
  };

  const close = () => backdrop.remove();

  tabData.addEventListener("click", () => {
    activeTab = "data";
    render();
  });
  tabGeom.addEventListener("click", () => {
    activeTab = "geometry";
    render();
  });
  tabAnim.addEventListener("click", () => {
    activeTab = "animations";
    render();
  });

  btnCancel.addEventListener("click", () => close());
  modal.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  backdrop.addEventListener("pointerdown", (ev) => {
    if (ev.target === backdrop) close();
  });

  btnSave.addEventListener("click", async () => {
    engine.updateNode(nodeId, state);
    const m2 = engine.getModel();
    if (m2) {
      await opts.hydrateQrImages(engine, m2);
      opts.hydrateTextMath(engine, m2);
    }
    opts.applySelection();
    await opts.commit(before);
    close();
  });

  (btnSave as HTMLButtonElement).focus();
  render();
}

