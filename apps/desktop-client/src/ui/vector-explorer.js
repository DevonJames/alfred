/**
 * Vector Explorer — Vectors (arrows) + Semantic Map (neighborhood points).
 * Original cosine similarity is authoritative; projections are lossy labels only.
 */
(() => {
  function apiUrl(path) {
    return typeof alfredUrl === "function" ? alfredUrl(path) : path;
  }

  const SLOT_COLORS = ["#d4a017", "#c45a3a", "#3d8f5a", "#3a9bb0", "#c44a9a"];
  const GROUP_COLORS = {
    badge_access: "#d4a017",
    vpn_remote: "#3a9bb0",
    expense_reimburse: "#3d8f5a",
    outlier: "#c44a9a",
    av_rooms: "#c45a3a",
    other: "#9a9080",
  };
  const NEUTRAL = "#c4a35a";
  const DIM = "rgba(80,70,55,0.22)";

  const FIVE_DEMO = [
    "The heavy rain forced us to cancel the outdoor concert scheduled for Saturday evening.",
    "Because of the downpour, we had to call off Saturday evening’s open-air music event.",
    "Severe rainfall caused us to abandon the planned outdoor live performance on Saturday night.",
    "We canceled the Saturday evening open-air concert because the rainfall was too heavy to proceed.",
    "At Saturday evening’s outdoor concert, we recorded the sound of heavy rain to use as an atmospheric effect in a film project.",
  ];

  const FIVE_DEMO_TRADEMARK = [
    "Applicants frequently misunderstand when additional evidence of use is required, resulting in avoidable delays during examination.",
    "A recurring source of processing delays is customer confusion about when they need to provide further proof that a mark is being used in commerce.",
    "Many filers do not realize that more documentation showing commercial use may be necessary, which often slows review of their applications.",
    "Examination is regularly held up because applicants are unclear about the circumstances requiring supplementary materials demonstrating use of the mark.",
    "Examining attorneys reviewing applications for similar marks may need to consider whether the goods or services create a likelihood of confusion.",
  ];

  const state = {
    mode: "semantic-map", // semantic-map | vectors
    dataset: "custom-five",
    projectionMethod: "mds-cosine",
    projectionDims: 2,
    knnK: 3,
    simThreshold: 0.55,
    showEdges: true,
    revealGroups: false,
    showOutliers: false,
    graph: null,
    bloomReady: false,
    payload: null,
    selectedId: null,
    timeCutoff: null, // ISO date string or null = all
    timeDates: [],
  };

  const elSlots = document.getElementById("slots");
  const elStats = document.getElementById("stats");
  const elDisc = document.getElementById("disclaimer");
  const elMetrics = document.getElementById("metrics");
  const elPair = document.getElementById("pairwise");
  const elInspect = document.getElementById("inspect");
  const elEmpty = document.getElementById("empty");
  const elStage = document.getElementById("graph-3d");
  const elCustom = document.getElementById("custom-panel");
  const elMapControls = document.getElementById("map-controls");
  const elTimeControls = document.getElementById("time-controls");
  const elDataset = document.getElementById("dataset");
  const textareas = [];

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function fmt(n, digits = 3) {
    if (n == null || Number.isNaN(n)) return "—";
    return Number(n).toFixed(digits);
  }

  function pointColor(p, opts = {}) {
    const { selected, neighborIds } = opts;
    if (state.selectedId) {
      if (p.id === state.selectedId) return "#ffe9a8";
      if (neighborIds?.has(p.id)) return state.revealGroups
        ? GROUP_COLORS[p.category] || NEUTRAL
        : "#e8c878";
      return DIM;
    }
    if (state.showOutliers && p.isOutlier) return "#ff6b8a";
    if (state.revealGroups && p.category) return GROUP_COLORS[p.category] || NEUTRAL;
    return NEUTRAL;
  }

  function buildSlots() {
    elSlots.innerHTML = "";
    textareas.length = 0;
    for (let i = 0; i < 5; i++) {
      const wrap = document.createElement("div");
      wrap.className = "slot";
      wrap.innerHTML = `
        <div class="slot-head">
          <span class="swatch" style="background:${SLOT_COLORS[i]}"></span>
          <span>Ex ${i + 1}${i === 4 ? " · contrast" : " · paraphrase"}</span>
        </div>`;
      const ta = document.createElement("textarea");
      ta.rows = 2;
      ta.placeholder = `Sentence ${i + 1}…`;
      wrap.appendChild(ta);
      elSlots.appendChild(wrap);
      textareas.push(ta);
    }
  }

  function loadFiveDemo(which = "rain") {
    const demo = which === "trademark" ? FIVE_DEMO_TRADEMARK : FIVE_DEMO;
    for (let i = 0; i < 5; i++) textareas[i].value = demo[i] || "";
    elDataset.value = "custom-five";
    state.dataset = "custom-five";
    syncPanels();
    elStats.textContent =
      which === "trademark"
        ? "Trademark demo loaded (Ex 1–4: evidence-of-use delays; Ex 5: likelihood of confusion) — hit Visualize."
        : "Rain/concert demo loaded — hit Visualize.";
  }

  function syncPanels() {
    const isMap = state.mode === "semantic-map";
    elMapControls.hidden = !isMap;
    elCustom.classList.toggle("on", state.dataset === "custom-five");
    document.querySelectorAll("#mode-seg button").forEach((b) => {
      b.classList.toggle("on", b.getAttribute("data-mode") === state.mode);
    });
    document.querySelectorAll("#proj-seg button").forEach((b) => {
      b.classList.toggle("on", b.getAttribute("data-proj") === state.projectionMethod);
    });
    document.querySelectorAll("#dim-seg button").forEach((b) => {
      b.classList.toggle("on", Number(b.getAttribute("data-dims")) === state.projectionDims);
    });
  }

  function visiblePoints(payload) {
    const pts = payload?.points || [];
    if (!state.timeCutoff) return pts;
    return pts.filter((p) => !p.timestamp || p.timestamp <= state.timeCutoff);
  }

  function makeLabelSprite(text, color) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const fontSize = 28;
    const padX = 14;
    const padY = 9;
    const height = fontSize + padY * 2;
    const font = `650 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.font = font;
    const width = Math.ceil(ctx.measureText(text).width) + padX * 2;
    canvas.width = Math.ceil(width * dpr);
    canvas.height = Math.ceil(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = font;
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#000";
    ctx.strokeStyle = color || "rgba(232,200,120,0.5)";
    ctx.lineWidth = 1.5;
    const r = 10;
    ctx.beginPath();
    ctx.moveTo(r, 1);
    ctx.arcTo(width - 1, 1, width - 1, height - 1, r);
    ctx.arcTo(width - 1, height - 1, 1, height - 1, r);
    ctx.arcTo(1, height - 1, 1, 1, r);
    ctx.arcTo(1, 1, width - 1, 1, r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#f5f0e6";
    ctx.fillText(text, padX, height / 2 + 1);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(width / 10, height / 10, 1);
    sprite.position.y = 18;
    sprite.renderOrder = 10;
    return sprite;
  }

  function makeVectorObject(node) {
    const group = new THREE.Group();
    const color = new THREE.Color(node.__color || NEUTRAL);
    const from = new THREE.Vector3(-(node.x || 0), -(node.y || 0), -(node.z || 0));
    const dir = new THREE.Vector3(0, 0, 0).sub(from);
    const len = dir.length();
    if (len < 1e-6) return group;
    dir.normalize();
    const headLen = Math.min(18, len * 0.18);
    const shaftLen = Math.max(2, len - headLen);
    const mat = new THREE.MeshBasicMaterial({ color });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.1, shaftLen, 12), mat);
    shaft.position.copy(from).addScaledVector(dir, shaftLen / 2);
    shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    group.add(shaft);
    const head = new THREE.Mesh(new THREE.ConeGeometry(5.8, headLen, 16), mat);
    head.position.copy(from).addScaledVector(dir, shaftLen + headLen / 2);
    head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    group.add(head);
    const label = makeLabelSprite(node.label, node.__color);
    label.position.set(0, 26, 0);
    group.add(label);
    return group;
  }

  function makePointObject(node) {
    const group = new THREE.Group();
    const color = new THREE.Color(node.__color || NEUTRAL);
    const r = node.id === state.selectedId ? 7 : node.__neighbor ? 5.5 : 4.2;
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(r, 16, 16),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: node.__dimmed ? 0.25 : 1 }),
    );
    group.add(sphere);
    if (state.revealGroups || node.id === state.selectedId || node.__neighbor) {
      const label = makeLabelSprite(node.label, node.__color);
      group.add(label);
    }
    return group;
  }

  function tryEnableBloom(Graph) {
    if (state.bloomReady) return;
    try {
      if (!THREE.UnrealBloomPass) return;
      const composer = Graph.postProcessingComposer?.();
      if (!composer) return;
      composer.addPass(
        new THREE.UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.12, 0.28, 0.9),
      );
      state.bloomReady = true;
    } catch (err) {
      console.warn("Bloom unavailable:", err);
    }
  }

  function ensureGraph() {
    if (state.graph) return state.graph;
    const Graph = ForceGraph3D({ controlType: "orbit" })(elStage)
      .backgroundColor("#030201")
      .showNavInfo(false)
      .cooldownTicks(0)
      .nodeId("id")
      .nodeOpacity(0)
      .linkVisibility(true)
      .enableNodeDrag(false)
      .nodeLabel((n) => {
        if (n.isOrigin) return "Origin";
        const bits = [`<div><strong>${escapeHtml(n.label)}</strong></div>`, `<div>${escapeHtml(n.text)}</div>`];
        if (state.revealGroups && n.categoryLabel) {
          bits.push(`<div style="opacity:.8;margin-top:4px">Expected: ${escapeHtml(n.categoryLabel)}</div>`);
        }
        return bits.join("");
      })
      .nodeThreeObject((node) => {
        if (typeof THREE === "undefined") return undefined;
        if (node.isOrigin) {
          return new THREE.Mesh(
            new THREE.SphereGeometry(4, 12, 12),
            new THREE.MeshBasicMaterial({ color: "#f5f0e6" }),
          );
        }
        if (state.mode === "vectors") return makeVectorObject(node);
        return makePointObject(node);
      })
      .nodeThreeObjectExtend(false)
      .linkColor((l) => l.__color || "rgba(196,163,90,0.35)")
      .linkWidth((l) => l.__width || 0.4)
      .linkOpacity(0.85)
      .onNodeClick((node) => {
        if (!node || node.isOrigin) return;
        selectPoint(node.id);
      })
      .onBackgroundClick(() => {
        state.selectedId = null;
        elInspect.hidden = true;
        paint();
      });

    Graph.d3Force("charge")?.strength?.(0);
    Graph.d3Force("link")?.strength?.(0);
    Graph.d3Force("center")?.strength?.(0);
    tryEnableBloom(Graph);
    state.graph = Graph;
    return Graph;
  }

  function buildLinks(points) {
    if (state.mode !== "semantic-map" || !state.showEdges) return [];
    const byId = new Map(points.map((p) => [p.id, p]));
    const seen = new Set();
    const links = [];
    for (const p of points) {
      for (const nb of p.neighbors || []) {
        if (nb.cosine < state.simThreshold) continue;
        if (!byId.has(nb.id)) continue;
        const a = p.id;
        const b = nb.id;
        const key = a < b ? `${a}::${b}` : `${b}::${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const t = Math.max(0, Math.min(1, (nb.cosine - state.simThreshold) / Math.max(0.01, 1 - state.simThreshold)));
        links.push({
          source: a,
          target: b,
          cosine: nb.cosine,
          __width: 0.35 + t * 2.2,
          __color: `rgba(232, 200, 120, ${0.15 + t * 0.7})`,
        });
      }
    }
    return links;
  }

  function paint() {
    const payload = state.payload;
    if (!payload) return;
    const Graph = ensureGraph();
    const points = visiblePoints(payload);
    const neighborIds = new Set();
    if (state.selectedId) {
      const sel = points.find((p) => p.id === state.selectedId);
      for (const nb of sel?.neighbors || []) neighborIds.add(nb.id);
    }

    if (state.mode === "vectors") {
      Graph.numDimensions?.(3);
      const origin = {
        id: "origin",
        isOrigin: true,
        label: "origin",
        x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 0,
      };
      const nodes = [
        origin,
        ...points.map((p) => ({
          ...p,
          __color: SLOT_COLORS[(p.index - 1) % SLOT_COLORS.length],
          fx: p.x, fy: p.y, fz: p.z, vx: 0, vy: 0, vz: 0,
        })),
      ];
      Graph.graphData({ nodes, links: [] });
    } else {
      Graph.numDimensions?.(state.projectionDims);
      const nodes = points.map((p) => {
        const isSel = p.id === state.selectedId;
        const isNb = neighborIds.has(p.id);
        const dimmed = !!(state.selectedId && !isSel && !isNb);
        return {
          ...p,
          __color: pointColor(p, { neighborIds }),
          __neighbor: isNb,
          __dimmed: dimmed,
          fx: p.x,
          fy: p.y,
          fz: state.projectionDims === 2 ? 0 : p.z,
          z: state.projectionDims === 2 ? 0 : p.z,
          vx: 0, vy: 0, vz: 0,
        };
      });
      Graph.graphData({ nodes, links: buildLinks(points) });
      if (state.projectionDims === 2) {
        Graph.cameraPosition({ x: 0, y: 0, z: 520 }, { x: 0, y: 0, z: 0 }, 600);
      }
    }
  }

  function renderInspect(point) {
    if (!point) {
      elInspect.hidden = true;
      return;
    }
    const nb = (point.neighbors || [])
      .map(
        (n) =>
          `<li><strong>${escapeHtml(n.label)}</strong> — cosine <strong>${fmt(n.cosine)}</strong>` +
          ` · projected dist <span title="Visualization only">${fmt(n.projectedDistance, 1)}</span></li>`,
      )
      .join("");
    elInspect.hidden = false;
    elInspect.innerHTML = `
      <h3>Selected observation</h3>
      <div class="body">${escapeHtml(point.text)}</div>
      ${
        state.revealGroups && point.categoryLabel
          ? `<div>Expected group: <strong>${escapeHtml(point.categoryLabel)}</strong></div>`
          : `<div>Expected group: <em>hidden</em> (enable Reveal)</div>`
      }
      ${point.timestamp ? `<div>Timestamp: <strong>${escapeHtml(point.timestamp)}</strong></div>` : ""}
      ${point.isOutlier ? `<div><strong>Flagged outlier</strong> (low nearest-neighbor cosine)</div>` : ""}
      <div style="margin-top:0.45rem">Nearest neighbors <em>(original cosine)</em>:</div>
      <ol class="nb-list">${nb || "<li>None above current settings</li>"}</ol>
    `;
  }

  function selectPoint(id) {
    state.selectedId = id;
    const point = state.payload?.points?.find((p) => p.id === id);
    renderInspect(point);
    paint();
  }

  function renderMeta(payload) {
    const method = payload.projection?.method || "?";
    const dims = payload.projection?.dims || "?";
    elStats.textContent =
      `${payload.points?.length ?? 0} observations · ${payload.model} · ${method} → ${dims}D · session-only`;
    elDisc.hidden = false;
    elDisc.textContent = payload.projection?.disclaimer || "";

    const m = payload.metrics || {};
    const hasCats = (payload.points || []).some((p) => p.category);
    elMetrics.hidden = false;
    elMetrics.innerHTML =
      `<div class="sec-label" style="margin:0 0 0.25rem">Integrity metrics (original cosine)</div>` +
      `<div>Within-group cosine: <strong>${fmt(m.withinGroupCosine)}</strong></div>` +
      `<div>Between-group cosine: <strong>${fmt(m.betweenGroupCosine)}</strong></div>` +
      `<div>NN category accuracy: <strong>${m.nnCategoryAccuracy == null ? "—" : `${(m.nnCategoryAccuracy * 100).toFixed(0)}%`}</strong>${hasCats ? "" : " (needs labels)"}</div>` +
      `<div>Silhouette (cosine dist): <strong>${fmt(m.silhouetteCosine)}</strong></div>` +
      `<div>Projection neighborhood retention: <strong>${m.projectionNeighborhoodRetention == null ? "—" : `${(m.projectionNeighborhoodRetention * 100).toFixed(0)}%`}</strong></div>` +
      `<div>Outliers flagged: <strong>${m.outlierCount ?? 0}</strong></div>`;

    const pairs = (payload.pairwise || []).slice(0, state.mode === "vectors" ? 10 : 8);
    elPair.hidden = pairs.length === 0;
    elPair.innerHTML =
      `<div class="sec-label" style="margin:0 0 0.25rem">Top cosine pairs (original space)</div>` +
      pairs.map((row) => `<div>#${row.a} ↔ #${row.b}: <strong>${fmt(row.cosine)}</strong></div>`).join("");
  }

  function setupTimeSlider(payload) {
    const dates = [...new Set((payload.points || []).map((p) => p.timestamp).filter(Boolean))].sort();
    state.timeDates = dates;
    const has = dates.length > 0 && state.dataset === "emerging-cluster";
    elTimeControls.hidden = !has;
    if (!has) {
      state.timeCutoff = null;
      return;
    }
    const slider = document.getElementById("time-slider");
    slider.value = "100";
    state.timeCutoff = null;
    document.getElementById("time-slider-val").textContent = "all";
  }

  async function visualize() {
    const btn = document.getElementById("btn-visualize");
    if (btn) btn.disabled = true;
    elStats.textContent = "Embedding…";
    try {
      const body = {
        view: state.mode,
        projectionMethod: state.projectionMethod,
        projectionDims: state.projectionDims,
        knnK: state.knnK,
      };
      if (state.dataset === "custom-five") {
        body.texts = textareas.map((ta) => ta.value.trim()).filter(Boolean);
      } else {
        body.datasetId = state.dataset;
      }

      const res = await fetch(apiUrl("/vector-explorer/embed"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || `Embed failed (${res.status})`);

      state.payload = data;
      state.selectedId = null;
      elInspect.hidden = true;
      elEmpty.classList.remove("show");
      setupTimeSlider(data);
      renderMeta(data);
      paint();
      window.setTimeout(() => {
        try {
          state.graph?.zoomToFit(800, 70);
        } catch {
          /* ignore */
        }
      }, 120);
    } catch (err) {
      elStats.textContent = err.message || String(err);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // --- wire controls ---
  buildSlots();
  loadFiveDemo();
  syncPanels();

  document.getElementById("mode-seg")?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-mode]");
    if (!btn) return;
    state.mode = btn.getAttribute("data-mode");
    syncPanels();
    if (state.payload) {
      // re-embed with new view geometry
      visualize();
    }
  });

  document.getElementById("proj-seg")?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-proj]");
    if (!btn) return;
    state.projectionMethod = btn.getAttribute("data-proj");
    syncPanels();
    if (state.payload && state.mode === "semantic-map") visualize();
  });

  document.getElementById("dim-seg")?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-dims]");
    if (!btn) return;
    state.projectionDims = Number(btn.getAttribute("data-dims"));
    syncPanels();
    if (state.payload && state.mode === "semantic-map") visualize();
  });

  elDataset?.addEventListener("change", () => {
    state.dataset = elDataset.value;
    syncPanels();
  });

  const knnEl = document.getElementById("knn-k");
  knnEl?.addEventListener("input", () => {
    state.knnK = Number(knnEl.value);
    document.getElementById("knn-k-val").textContent = String(state.knnK);
  });
  knnEl?.addEventListener("change", () => {
    if (state.payload && state.mode === "semantic-map") visualize();
  });

  const thrEl = document.getElementById("sim-threshold");
  thrEl?.addEventListener("input", () => {
    state.simThreshold = Number(thrEl.value);
    document.getElementById("sim-threshold-val").textContent = state.simThreshold.toFixed(2);
    paint();
  });

  document.getElementById("show-edges")?.addEventListener("change", (e) => {
    state.showEdges = !!e.target.checked;
    paint();
  });
  document.getElementById("reveal-groups")?.addEventListener("change", (e) => {
    state.revealGroups = !!e.target.checked;
    paint();
    if (state.selectedId) {
      renderInspect(state.payload?.points?.find((p) => p.id === state.selectedId));
    }
  });
  document.getElementById("show-outliers")?.addEventListener("change", (e) => {
    state.showOutliers = !!e.target.checked;
    paint();
  });

  document.getElementById("time-slider")?.addEventListener("input", (e) => {
    const dates = state.timeDates;
    if (!dates.length) return;
    const pct = Number(e.target.value);
    if (pct >= 100) {
      state.timeCutoff = null;
      document.getElementById("time-slider-val").textContent = "all";
    } else {
      const idx = Math.max(0, Math.min(dates.length - 1, Math.floor((pct / 100) * dates.length)));
      state.timeCutoff = dates[idx];
      document.getElementById("time-slider-val").textContent = state.timeCutoff;
    }
    paint();
  });

  document.getElementById("btn-visualize")?.addEventListener("click", () => visualize());
  document.getElementById("btn-demo")?.addEventListener("click", () => loadFiveDemo("rain"));
  document.getElementById("btn-demo-tm")?.addEventListener("click", () => loadFiveDemo("trademark"));
  document.getElementById("btn-clear")?.addEventListener("click", () => {
    state.selectedId = null;
    elInspect.hidden = true;
    paint();
  });
  document.getElementById("btn-reset")?.addEventListener("click", () => {
    try {
      state.graph?.zoomToFit(700, 70);
    } catch {
      /* ignore */
    }
  });

  window.addEventListener("resize", () => {
    if (!state.graph) return;
    state.graph.width(window.innerWidth);
    state.graph.height(window.innerHeight);
  });
})();
