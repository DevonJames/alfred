/**
 * Self-contained memory graph renderer (no CDN).
 * Simple force-directed layout + canvas.
 */
(() => {
  const COLORS = {
    Entity: "#c4a35a",
    Episode: "#6b9e78",
    Assertion: "#d4785a",
    Observation: "#7eb8c9",
    Artifact: "#9a9588",
  };

  const state = {
    raw: null,
    types: new Set(["Entity", "Episode", "Assertion", "Observation"]),
    query: "",
    focusId: null,
    nodes: [],
    links: [],
    sim: null,
    raf: 0,
    transform: { x: 0, y: 0, k: 1 },
    dragging: null,
    panning: null,
  };

  const canvas = document.getElementById("graph-canvas");
  const ctx = canvas.getContext("2d");
  const elStats = document.getElementById("stats");
  const elDetail = document.getElementById("detail");
  const elDetailBody = document.getElementById("detail-body");
  const elEmpty = document.getElementById("empty");
  const elEmptyTitle = elEmpty.querySelector("h2");
  const elEmptyLead = document.getElementById("empty-lead");
  const elEmptyDiag = document.getElementById("empty-diag");
  const elQ = document.getElementById("q");

  function typeColor(t) {
    return COLORS[t] || "#93a094";
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function setEmpty(show, title, lead) {
    elEmpty.classList.toggle("show", !!show);
    if (title) elEmptyTitle.textContent = title;
    if (lead != null) elEmptyLead.innerHTML = lead;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function linkEndId(end) {
    if (end == null) return "";
    return typeof end === "object" ? String(end.id || "") : String(end);
  }

  function matchesQuery(node, q) {
    if (!q) return true;
    const hay = `${node.label || ""} ${node.searchText || ""} ${node.type || ""}`.toLowerCase();
    return q.split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
  }

  function filteredGraph() {
    if (!state.raw?.nodes?.length) return { nodes: [], links: [] };
    const q = state.query.trim().toLowerCase();
    let nodes = state.raw.nodes.filter((n) => {
      const t = String(n.type || "").trim();
      return state.types.size === 0 || state.types.has(t);
    });
    if (!nodes.length && state.raw.nodes.length) nodes = [...state.raw.nodes];

    if (q) {
      const hitIds = new Set(nodes.filter((n) => matchesQuery(n, q)).map((n) => n.id));
      for (const l of state.raw.links || []) {
        const s = linkEndId(l.source);
        const t = linkEndId(l.target);
        if (hitIds.has(s)) hitIds.add(t);
        if (hitIds.has(t)) hitIds.add(s);
      }
      const allow = new Set(nodes.map((n) => n.id));
      nodes = state.raw.nodes.filter((n) => allow.has(n.id) && hitIds.has(n.id));
    }

    const ids = new Set(nodes.map((n) => n.id));
    const links = (state.raw.links || [])
      .map((l) => ({
        source: linkEndId(l.source),
        target: linkEndId(l.target),
        predicate: l.predicate,
      }))
      .filter((l) => l.source && l.target && ids.has(l.source) && ids.has(l.target));

    return {
      nodes: nodes.map((n) => ({
        id: n.id,
        label: n.label || n.type || n.id,
        type: String(n.type || "Entity").trim(),
        schemaType: n.schemaType ?? null,
        searchText: n.searchText || "",
        degree: n.degree || 0,
      })),
      links,
    };
  }

  function buildSimulation(nodes, links) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const byId = new Map();
    const simNodes = nodes.map((n, i) => {
      const angle = (i / Math.max(nodes.length, 1)) * Math.PI * 2;
      const r = Math.min(w, h) * 0.28;
      const node = {
        ...n,
        x: w / 2 + Math.cos(angle) * r * (0.7 + Math.random() * 0.6),
        y: h / 2 + Math.sin(angle) * r * (0.7 + Math.random() * 0.6),
        vx: 0,
        vy: 0,
      };
      byId.set(n.id, node);
      return node;
    });
    const simLinks = links
      .map((l) => ({
        source: byId.get(l.source),
        target: byId.get(l.target),
        predicate: l.predicate,
      }))
      .filter((l) => l.source && l.target);

    return { nodes: simNodes, links: simLinks, alpha: 1 };
  }

  function tick(sim) {
    const { nodes, links } = sim;
    const n = nodes.length;
    if (!n) return;

    // Charge (repulsion) — sampled for large graphs
    const sample = n > 250 ? 2 : 1;
    for (let i = 0; i < n; i += sample) {
      const a = nodes[i];
      for (let j = i + sample; j < n; j += sample) {
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist2 = dx * dx + dy * dy || 0.01;
        const force = 1200 / dist2;
        const fx = dx * force;
        const fy = dy * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    // Springs
    for (const l of links) {
      const dx = l.target.x - l.source.x;
      const dy = l.target.y - l.source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const ideal = 70;
      const k = 0.02 * (dist - ideal);
      const fx = (dx / dist) * k;
      const fy = (dy / dist) * k;
      l.source.vx += fx;
      l.source.vy += fy;
      l.target.vx -= fx;
      l.target.vy -= fy;
    }

    // Center gravity
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    for (const node of nodes) {
      if (state.dragging === node) continue;
      node.vx += (cx - node.x) * 0.005;
      node.vy += (cy - node.y) * 0.005;
      node.vx *= 0.85;
      node.vy *= 0.85;
      node.x += node.vx * sim.alpha;
      node.y += node.vy * sim.alpha;
    }
    sim.alpha *= 0.985;
  }

  function screenToWorld(sx, sy) {
    const { x, y, k } = state.transform;
    return { x: (sx - x) / k, y: (sy - y) / k };
  }

  function nodeRadius(node) {
    return 4 + Math.min(10, (node.degree || 0) * 0.45);
  }

  function hitTest(sx, sy) {
    const p = screenToWorld(sx, sy);
    let best = null;
    let bestD = Infinity;
    for (const node of state.nodes) {
      const dx = node.x - p.x;
      const dy = node.y - p.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const r = nodeRadius(node) + 4;
      if (d <= r && d < bestD) {
        best = node;
        bestD = d;
      }
    }
    return best;
  }

  function draw() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(state.transform.x, state.transform.y);
    ctx.scale(state.transform.k, state.transform.k);

    // Links
    for (const l of state.links) {
      const focused =
        state.focusId &&
        (l.source.id === state.focusId || l.target.id === state.focusId);
      const dimmed = state.focusId && !focused;
      ctx.beginPath();
      ctx.moveTo(l.source.x, l.source.y);
      ctx.lineTo(l.target.x, l.target.y);
      ctx.strokeStyle = focused
        ? "rgba(196, 163, 90, 0.75)"
        : dimmed
          ? "rgba(147, 160, 148, 0.06)"
          : "rgba(147, 160, 148, 0.35)";
      ctx.lineWidth = focused ? 2 / state.transform.k : 1 / state.transform.k;
      ctx.stroke();
    }

    // Nodes
    for (const node of state.nodes) {
      const focused = state.focusId === node.id;
      let linked = false;
      if (state.focusId && !focused) {
        linked = state.links.some(
          (l) =>
            (l.source.id === state.focusId && l.target.id === node.id) ||
            (l.target.id === state.focusId && l.source.id === node.id),
        );
      }
      const dimmed = state.focusId && !focused && !linked;
      const r = nodeRadius(node);
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fillStyle = focused
        ? "#f0e6c8"
        : dimmed
          ? "rgba(147,160,148,0.2)"
          : typeColor(node.type);
      ctx.fill();

      // Labels for high-degree / focused / zoomed-in
      const showLabel =
        focused ||
        linked ||
        state.transform.k > 1.3 ||
        (node.degree || 0) >= 4 ||
        state.nodes.length < 80;
      if (showLabel && !dimmed) {
        ctx.font = `${12 / state.transform.k}px "DM Sans", system-ui, sans-serif`;
        ctx.fillStyle = "rgba(231, 238, 230, 0.9)";
        ctx.textAlign = "center";
        ctx.fillText(truncate(node.label, 28), node.x, node.y + r + 12 / state.transform.k);
      }
    }
    ctx.restore();
  }

  function truncate(s, n) {
    const t = String(s || "");
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  }

  function loop() {
    if (state.sim && state.sim.alpha > 0.02) {
      tick(state.sim);
      draw();
      state.raf = requestAnimationFrame(loop);
    } else {
      draw();
      state.raf = 0;
    }
  }

  function restartSim() {
    if (state.raf) cancelAnimationFrame(state.raf);
    const data = filteredGraph();
    state.sim = buildSimulation(data.nodes, data.links);
    state.nodes = state.sim.nodes;
    state.links = state.sim.links;
    state.raf = requestAnimationFrame(loop);
  }

  function render() {
    const rawCount = state.raw?.nodes?.length || 0;
    if (!rawCount) {
      setEmpty(
        true,
        "No memory graph yet",
        "If you just ingested, click <strong>Rebuild index</strong>. Confirm the data root matches your ingest root.",
      );
      return;
    }
    setEmpty(false);
    restartSim();
    // Fit-ish: reset transform
    state.transform = { x: 0, y: 0, k: 1 };
    draw();
  }

  async function selectNode(id) {
    state.focusId = id;
    draw();
    elDetail.classList.add("open");
    elDetailBody.innerHTML = "<p class='meta'>Loading…</p>";
    try {
      const res = await fetch(`/memory/graph/node/${encodeURIComponent(id)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Not found");
      const rev = data.revision || {};
      const schema = rev.schema || {};
      const text =
        rev.text ||
        schema.description ||
        schema.text ||
        (rev.predicate ? `${rev.predicate} → ${rev.object ?? ""}` : "") ||
        data.index?.search_text ||
        "";
      const color = typeColor(data.index.record_type);
      elDetailBody.innerHTML = [
        `<div class="type-pill" style="color:${color}">${escapeHtml(data.index.record_type)}</div>`,
        `<h2>${escapeHtml(data.index.name || data.index.record_type)}</h2>`,
        `<div class="meta">${escapeHtml(data.index.id)}${
          data.index.schema_type ? `<br>${escapeHtml(data.index.schema_type)}` : ""
        }</div>`,
        `<div class="body">${escapeHtml(String(text).slice(0, 1200))}</div>`,
        `<div class="detail-actions"><button type="button" id="btn-center">Center</button></div>`,
        `<h3>Connections (${data.neighbors.length})</h3>`,
        `<ul class="neighbors">${data.neighbors
          .slice(0, 40)
          .map(
            (n) =>
              `<li data-id="${escapeHtml(n.id)}"><span class="pred">${
                n.direction === "out" ? "→" : "←"
              } ${escapeHtml(n.predicate)}</span><span class="dir">${escapeHtml(
                n.type,
              )}</span><span class="n-label">${escapeHtml(n.label)}</span></li>`,
          )
          .join("")}</ul>`,
      ].join("");
      document.getElementById("btn-center")?.addEventListener("click", () => {
        const node = state.nodes.find((n) => n.id === id);
        if (!node) return;
        state.transform.k = 1.8;
        state.transform.x = window.innerWidth / 2 - node.x * state.transform.k;
        state.transform.y = window.innerHeight / 2 - node.y * state.transform.k;
        draw();
      });
      elDetailBody.querySelectorAll(".neighbors li").forEach((li) => {
        li.addEventListener("click", () => selectNode(li.getAttribute("data-id")));
      });
    } catch (e) {
      elDetailBody.innerHTML = `<p class="meta">${escapeHtml(e.message || String(e))}</p>`;
    }
  }

  function closeDetail() {
    elDetail.classList.remove("open");
  }

  async function load(includeArtifacts, forceRebuild) {
    elStats.textContent = forceRebuild ? "Rebuilding index…" : "Loading…";
    const params = new URLSearchParams();
    if (includeArtifacts) params.set("artifacts", "1");
    if (forceRebuild) params.set("rebuild", "1");
    const res = await fetch(`/memory/graph/data?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "Failed to load graph");
    state.raw = {
      ...data,
      nodes: (data.nodes || []).map((n) => ({ ...n })),
      links: (data.links || []).map((l) => ({ ...l })),
    };
    const s = data.stats;
    elStats.textContent =
      `${s.nodes} nodes · ${s.links} links\n` +
      `${s.packagesOnDisk} packages on disk · ${s.recordsIndexed} indexed` +
      (s.rebuilt ? " · rebuilt" : "") +
      `\n${data.root}`;
    if (elEmptyDiag) {
      const sampleTypes = [...new Set((data.nodes || []).slice(0, 40).map((n) => n.type))].join(
        ", ",
      );
      elEmptyDiag.textContent = `root: ${data.root}\npackagesOnDisk: ${s.packagesOnDisk}\nrecordsIndexed: ${s.recordsIndexed}\nnodes: ${s.nodes}\nsampleTypes: ${sampleTypes || "(none)"}`;
    }
    render();
  }

  // Pointer interactions
  canvas.addEventListener("pointerdown", (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const hit = hitTest(sx, sy);
    if (hit) {
      state.dragging = hit;
      canvas.setPointerCapture(e.pointerId);
      if (state.sim) state.sim.alpha = Math.max(state.sim.alpha, 0.3);
      if (!state.raf) state.raf = requestAnimationFrame(loop);
    } else {
      state.panning = {
        x: e.clientX,
        y: e.clientY,
        tx: state.transform.x,
        ty: state.transform.y,
      };
      canvas.setPointerCapture(e.pointerId);
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    const rect = canvas.getBoundingClientRect();
    if (state.dragging) {
      const p = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      state.dragging.x = p.x;
      state.dragging.y = p.y;
      state.dragging.vx = 0;
      state.dragging.vy = 0;
      draw();
    } else if (state.panning) {
      state.transform.x = state.panning.tx + (e.clientX - state.panning.x);
      state.transform.y = state.panning.ty + (e.clientY - state.panning.y);
      draw();
    }
  });

  canvas.addEventListener("pointerup", (e) => {
    const wasDrag = state.dragging;
    const pan = state.panning;
    state.dragging = null;
    state.panning = null;
    if (wasDrag && pan == null) {
      // treat as click if little movement — always select on pointerup from node
      selectNode(wasDrag.id);
    }
  });

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const before = screenToWorld(sx, sy);
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      state.transform.k = Math.min(4, Math.max(0.25, state.transform.k * factor));
      state.transform.x = sx - before.x * state.transform.k;
      state.transform.y = sy - before.y * state.transform.k;
      draw();
    },
    { passive: false },
  );

  canvas.addEventListener("dblclick", (e) => {
    const rect = canvas.getBoundingClientRect();
    const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) return;
    state.transform.k = 2;
    state.transform.x = window.innerWidth / 2 - hit.x * state.transform.k;
    state.transform.y = window.innerHeight / 2 - hit.y * state.transform.k;
    draw();
  });

  document.getElementById("filters").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-type]");
    if (!btn) return;
    const t = btn.getAttribute("data-type");
    if (state.types.has(t)) state.types.delete(t);
    else state.types.add(t);
    btn.classList.toggle("on", state.types.has(t));
    if (t === "Artifact" && state.types.has("Artifact")) {
      load(true, false).catch((err) => {
        elStats.textContent = err.message;
      });
    } else {
      render();
    }
  });

  let searchTimer;
  elQ.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = elQ.value;
      render();
    }, 160);
  });

  document.getElementById("btn-reload").addEventListener("click", () => {
    load(state.types.has("Artifact"), false).catch((err) => {
      elStats.textContent = err.message;
    });
  });
  document.getElementById("btn-rebuild").addEventListener("click", () => {
    load(state.types.has("Artifact"), true).catch((err) => {
      elStats.textContent = err.message;
    });
  });
  document.getElementById("btn-reset").addEventListener("click", () => {
    state.focusId = null;
    state.query = "";
    elQ.value = "";
    closeDetail();
    state.transform = { x: 0, y: 0, k: 1 };
    render();
  });
  document.getElementById("btn-ingest").addEventListener("click", () => {
    location.href = "/memory/ingest";
  });
  document.getElementById("detail-close").addEventListener("click", () => {
    state.focusId = null;
    closeDetail();
    draw();
  });

  window.addEventListener("resize", resize);
  resize();

  load(false, false).catch((err) => {
    elStats.textContent = err.message;
    setEmpty(true, "Failed to load graph data", escapeHtml(err.message || String(err)));
  });
})();
