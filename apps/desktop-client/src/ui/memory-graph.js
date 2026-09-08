/**
 * Self-contained memory graph renderer (no CDN).
 * Simple force-directed layout + canvas.
 */
(() => {
  function apiUrl(path) {
    return typeof alfredUrl === "function" ? alfredUrl(path) : path;
  }

  const COLORS = {
    Entity: "#c4a35a",
    Organization: "#6b9ac4",
    Episode: "#6b9e78",
    Assertion: "#d4785a",
    Observation: "#7eb8c9",
    Artifact: "#9a9588",
  };

  const state = {
    raw: null,
    types: new Set(["Entity", "Episode", "Assertion", "Observation"]),
    query: "",
    queryB: "",
    queryDate: "",
    bridge: null,
    matchA: new Set(),
    matchB: new Set(),
    matchDate: new Set(),
    egoId: null,
    focusId: null,
    hoverId: null,
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
  const elQ2 = document.getElementById("q2");
  const elQDate = document.getElementById("qDate");
  const elBridgeHint = document.getElementById("bridge-hint");
  const elDateHint = document.getElementById("date-hint");

  function matchesDateHaystack(hay, query) {
    return window.AlfredDateQuery?.matchesDateHaystack?.(hay, query) === true;
  }

  function matchDateNodeIds(nodes, query) {
    const q = String(query || "").trim();
    if (!q) return new Set();
    const hits = new Set();
    for (const n of nodes) {
      const hay = `${n.label || ""} ${n.searchText || ""}`;
      if (matchesDateHaystack(hay, q)) hits.add(n.id);
    }
    return hits;
  }

  function typeColor(t) {
    return COLORS[t] || "#93a094";
  }

  function isOrganizationNode(node) {
    if (String(node?.type || "").trim() !== "Entity") return false;
    return String(node?.schemaType || "").toLowerCase().includes("organization");
  }

  /** Entity + optional Organization subtype (schema.org). */
  function nodePassesTypeFilter(node, types) {
    if (!types || types.size === 0) return true;
    const t = String(node.type || "").trim();
    if (t === "Entity") {
      const isOrg = isOrganizationNode(node);
      if (types.has("Organization") && !types.has("Entity")) return isOrg;
      if (types.has("Organization") && types.has("Entity")) return isOrg;
      if (types.has("Entity")) return true;
      return false;
    }
    return types.has(t);
  }

  function displayType(node) {
    return isOrganizationNode(node) ? "Organization" : String(node.type || "Entity").trim();
  }

  function expandNeighborhood(nodes, links, seedIds, hops = 1) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    let keep = new Set(seedIds);
    for (let i = 0; i < hops; i++) {
      const grow = new Set(keep);
      for (const l of links) {
        const s = linkEndId(l.source);
        const t = linkEndId(l.target);
        const tryAdd = (nid) => {
          if (keep.has(nid) || grow.has(nid)) return;
          const n = byId.get(nid);
          if (!n) return;
          // Ego view: keep structural neighbors (entities + assertions)
          if (n.type === "Entity" || n.type === "Assertion") grow.add(nid);
        };
        if (keep.has(s)) tryAdd(t);
        if (keep.has(t)) tryAdd(s);
      }
      keep = grow;
    }
    return keep;
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

  function linkKey(source, target, predicate) {
    return source < target
      ? `${source}|${target}|${predicate}`
      : `${target}|${source}|${predicate}`;
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function labelMatchesTokens(label, tokens) {
    const hay = String(label || "");
    return tokens.every((t) => {
      const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(t)}(?:[^a-z0-9]|$)`, "i");
      return re.test(hay);
    });
  }

  function matchNodeIds(nodes, q) {
    const tokens = q.split(/\s+/).filter(Boolean);
    if (!tokens.length) return new Set();
    const needle = tokens.join(" ");

    const labelHits = nodes.filter((n) => labelMatchesTokens(n.label || "", tokens));
    let entities = labelHits.filter((n) => n.type === "Entity");

    const exact = entities.filter(
      (n) => String(n.label || "").trim().toLowerCase() === needle,
    );
    if (exact.length) entities = exact;

    if (entities.length > 1) {
      const orgs = entities.filter((n) =>
        String(n.schemaType || "").toLowerCase().includes("organization"),
      );
      if (orgs.length) entities = orgs;
    }

    const preferred =
      entities.length > 0
        ? entities
        : labelHits.filter((n) => n.type !== "Assertion");
    const finalHits = preferred.length > 0 ? preferred : labelHits;
    if (finalHits.length > 0) return new Set(finalHits.map((n) => n.id));

    const hits = nodes.filter((n) => matchesQuery(n, q));
    const hitEntities = hits.filter((n) => n.type === "Entity");
    return new Set((hitEntities.length > 0 ? hitEntities : hits).map((n) => n.id));
  }

  function projectEntityLinks(nodes, links) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const byAssertion = new Map();

    const attach = (assertionId, endPred, entityId) => {
      const assertNode = byId.get(assertionId);
      if (!assertNode || assertNode.type !== "Assertion") return;
      const ent = byId.get(entityId);
      if (!ent || ent.type !== "Entity") return;
      let bucket = byAssertion.get(assertionId);
      if (!bucket) {
        const fromLabel =
          (String(assertNode.label || "").match(
            /\b(worksAt|worksWith|reportsTo|supervisorOf|colleagueOf|spouseOf|parentOf|partOf|runs|workplaceRole|relatedTo|hiredBy)\b/i,
          ) || [])[1] || "relatedTo";
        bucket = { subjects: [], objects: [], predicate: fromLabel };
        byAssertion.set(assertionId, bucket);
      }
      if (endPred === "subject") bucket.subjects.push(entityId);
      else if (endPred === "object") bucket.objects.push(entityId);
    };

    for (const l of links) {
      const s = byId.get(linkEndId(l.source));
      const t = byId.get(linkEndId(l.target));
      const pred = String(l.predicate || "").toLowerCase();
      const sid = linkEndId(l.source);
      const tid = linkEndId(l.target);
      if (s?.type === "Assertion" && (pred === "subject" || pred === "object")) {
        attach(sid, pred, tid);
      }
      if (t?.type === "Assertion" && (pred === "subject" || pred === "object")) {
        attach(tid, pred, sid);
      }
    }

    const projected = [];
    for (const [assertionId, bucket] of byAssertion) {
      for (const sub of bucket.subjects) {
        for (const obj of bucket.objects) {
          if (sub === obj) continue;
          projected.push({
            source: sub,
            target: obj,
            predicate: bucket.predicate,
            viaAssertion: assertionId,
          });
        }
      }
    }
    return projected;
  }

  function connectingSubgraph(links, fromIds, toIds) {
    const endpoints = new Set([...fromIds, ...toIds]);
    if (!fromIds.size || !toIds.size) {
      return { nodeIds: endpoints, linkKeys: new Set(), hops: null, viaAssertions: new Set() };
    }
    const onlyA = [...fromIds].filter((id) => !toIds.has(id));
    const onlyB = [...toIds].filter((id) => !fromIds.has(id));
    if (onlyA.length === 0 && onlyB.length === 0) {
      return { nodeIds: new Set(fromIds), linkKeys: new Set(), hops: 0, viaAssertions: new Set() };
    }

    const bfsFrom = new Set(onlyA.length ? onlyA : fromIds);
    const bfsTo = new Set(onlyB.length ? onlyB : toIds);

    const adj = new Map();
    for (const l of links) {
      const s = linkEndId(l.source);
      const t = linkEndId(l.target);
      const key = linkKey(s, t, l.predicate);
      if (!adj.has(s)) adj.set(s, []);
      if (!adj.has(t)) adj.set(t, []);
      adj.get(s).push({ other: t, key, via: l.viaAssertion });
      adj.get(t).push({ other: s, key, via: l.viaAssertion });
    }

    const parent = new Map();
    const dist = new Map();
    const queue = [];
    for (const id of bfsFrom) {
      parent.set(id, null);
      dist.set(id, 0);
      queue.push(id);
    }

    let minHops = null;
    const reachedTargets = [];
    for (let qi = 0; qi < queue.length; qi++) {
      const id = queue[qi];
      const d = dist.get(id) ?? 0;
      if (minHops != null && d > minHops) break;
      if (bfsTo.has(id)) {
        minHops = d;
        reachedTargets.push(id);
        continue;
      }
      for (const edge of adj.get(id) || []) {
        if (parent.has(edge.other)) continue;
        parent.set(edge.other, { prev: id, key: edge.key, via: edge.via });
        dist.set(edge.other, d + 1);
        queue.push(edge.other);
      }
    }

    if (minHops == null || !reachedTargets.length) {
      return { nodeIds: endpoints, linkKeys: new Set(), hops: null, viaAssertions: new Set() };
    }

    const pathNodes = new Set();
    const pathLinks = new Set();
    const viaAssertions = new Set();
    for (const target of reachedTargets) {
      if ((dist.get(target) ?? Infinity) > minHops) continue;
      let cur = target;
      pathNodes.add(cur);
      while (cur && !bfsFrom.has(cur)) {
        const step = parent.get(cur);
        if (!step) break;
        pathLinks.add(step.key);
        pathNodes.add(step.prev);
        if (step.via) viaAssertions.add(step.via);
        cur = step.prev;
      }
    }
    return { nodeIds: pathNodes, linkKeys: pathLinks, hops: minHops, viaAssertions };
  }

  function updateBridgeHint() {
    if (!elBridgeHint) return;
    elBridgeHint.classList.remove("ok", "miss");
    if (state.egoId) {
      const ego = state.raw?.nodes?.find((n) => n.id === state.egoId);
      elBridgeHint.classList.add("ok");
      elBridgeHint.textContent = `Showing connections for “${ego?.label || "selected node"}”.`;
      return;
    }
    const qA = state.query.trim();
    const qB = state.queryB.trim();
    if (!qA || !qB) {
      elBridgeHint.textContent = "Fill both to trace the path between them.";
      return;
    }
    const b = state.bridge;
    if (!b) {
      elBridgeHint.textContent = "";
      return;
    }
    if (b.matchA === 0 || b.matchB === 0) {
      elBridgeHint.classList.add("miss");
      elBridgeHint.textContent =
        b.matchA === 0 && b.matchB === 0
          ? "No matches for either term."
          : b.matchA === 0
            ? `No match for “${qA}”.`
            : `No match for “${qB}”.`;
      return;
    }
    if (!b.connected) {
      elBridgeHint.classList.add("miss");
      elBridgeHint.textContent = `Found both, but no path between “${qA}” and “${qB}”.`;
      return;
    }
    elBridgeHint.classList.add("ok");
    elBridgeHint.textContent =
      b.hops === 0
        ? `Same node matches both “${qA}” and “${qB}”.`
        : `${b.hops} hop${b.hops === 1 ? "" : "s"} between “${qA}” and “${qB}”.`;
  }

  function updateDateHint() {
    if (!elDateHint) return;
    elDateHint.classList.remove("ok", "miss");
    const q = state.queryDate.trim();
    if (!q) {
      elDateHint.textContent = "Month names and numbers match the same dates.";
      return;
    }
    const n = state.matchDate?.size ?? 0;
    if (n === 0) {
      elDateHint.classList.add("miss");
      elDateHint.textContent = `No date matches for “${q}”. Try August, 08, or 08/15.`;
      return;
    }
    elDateHint.classList.add("ok");
    elDateHint.textContent = `${n} date match${n === 1 ? "" : "es"} for “${q}” (names ↔ numbers).`;
  }

  function filteredGraph() {
    if (!state.raw?.nodes?.length) return { nodes: [], links: [] };
    const qA = state.query.trim().toLowerCase();
    const qB = state.queryB.trim().toLowerCase();
    const qDate = state.queryDate.trim();
    const rawLinks = state.raw.links || [];

    state.matchA = new Set();
    state.matchB = new Set();
    state.matchDate = new Set();
    state.bridge = null;

    const mapNode = (n) => ({
      id: n.id,
      label: n.label || n.type || n.id,
      type: String(n.type || "Entity").trim(),
      schemaType: n.schemaType ?? null,
      searchText: n.searchText || "",
      degree: n.degree || 0,
    });

    const linksAmong = (nodeList) => {
      const ids = new Set(nodeList.map((n) => n.id));
      return rawLinks
        .map((l) => ({
          source: linkEndId(l.source),
          target: linkEndId(l.target),
          predicate: l.predicate,
        }))
        .filter((l) => l.source && l.target && ids.has(l.source) && ids.has(l.target));
    };

    const applyDateLens = (nodeList) => {
      if (!qDate) return nodeList;
      const dateIds = matchDateNodeIds(state.raw.nodes, qDate);
      state.matchDate = dateIds;
      if (!dateIds.size) return [];
      // 2 hops: date Thing ← hasBirthDate ← Person (and nearby assertions)
      const keep = expandNeighborhood(state.raw.nodes, rawLinks, dateIds, 2);
      return nodeList.filter((n) => keep.has(n.id));
    };

    // Ego mode: 2 hops so Org → Assertion → Person (edges are Assertion↔ends)
    if (state.egoId) {
      const keep = expandNeighborhood(
        state.raw.nodes,
        rawLinks,
        new Set([state.egoId]),
        2,
      );
      let nodes = state.raw.nodes.filter((n) => keep.has(n.id));
      nodes = applyDateLens(nodes);
      state.matchA = new Set([state.egoId]);
      return { nodes: nodes.map(mapNode), links: linksAmong(nodes) };
    }

    let nodes = state.raw.nodes.filter((n) => nodePassesTypeFilter(n, state.types));
    if (!nodes.length && state.raw.nodes.length) nodes = [...state.raw.nodes];

    if (qA && qB) {
      const setA = matchNodeIds(state.raw.nodes, qA);
      const setB = matchNodeIds(state.raw.nodes, qB);
      state.matchA = setA;
      state.matchB = setB;
      const projected = projectEntityLinks(state.raw.nodes, rawLinks);
      const bridge = connectingSubgraph(projected, setA, setB);
      state.bridge = {
        hops: bridge.hops,
        matchA: setA.size,
        matchB: setB.size,
        connected: bridge.hops != null,
      };
      const keep = new Set(bridge.nodeIds);
      for (const id of bridge.viaAssertions || []) keep.add(id);
      if (bridge.hops == null) {
        for (const id of setA) keep.add(id);
        for (const id of setB) keep.add(id);
      }
      nodes = state.raw.nodes.filter((n) => keep.has(n.id));
      nodes = applyDateLens(nodes);
      return { nodes: nodes.map(mapNode), links: linksAmong(nodes) };
    }

    const q = qA || qB;
    if (q) {
      const hitIds = new Set(nodes.filter((n) => matchesQuery(n, q)).map((n) => n.id));
      if (qA) state.matchA = new Set(hitIds);
      if (qB) state.matchB = new Set(hitIds);
      for (const l of rawLinks) {
        const s = linkEndId(l.source);
        const t = linkEndId(l.target);
        if (hitIds.has(s)) hitIds.add(t);
        if (hitIds.has(t)) hitIds.add(s);
      }
      const allow = new Set(nodes.map((n) => n.id));
      nodes = state.raw.nodes.filter((n) => allow.has(n.id) && hitIds.has(n.id));
      nodes = applyDateLens(nodes);
      return { nodes: nodes.map(mapNode), links: linksAmong(nodes) };
    }

    if (qDate) {
      nodes = applyDateLens(state.raw.nodes.filter((n) => nodePassesTypeFilter(n, state.types)));
      return { nodes: nodes.map(mapNode), links: linksAmong(nodes) };
    }

    return { nodes: nodes.map(mapNode), links: linksAmong(nodes) };
  }

  function layoutMetrics() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // Use the shorter viewport axis so the cloud stays round on wide screens.
    const R = Math.min(w, h) * 0.38;
    return { w, h, cx: w / 2, cy: h / 2, R };
  }

  function buildSimulation(nodes, links) {
    const { cx, cy, R } = layoutMetrics();
    const byId = new Map();
    const count = Math.max(nodes.length, 1);
    // Fibonacci/golden-angle disc: fills a circle evenly instead of a ring or blob.
    const golden = Math.PI * (3 - Math.sqrt(5));
    const simNodes = nodes.map((n, i) => {
      const t = (i + 0.5) / count;
      const radius = R * Math.sqrt(t) * 0.92;
      const angle = i * golden;
      const node = {
        ...n,
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
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
    const { cx, cy, R } = layoutMetrics();

    // Charge (repulsion) — sampled for large graphs
    const sample = n > 250 ? 2 : 1;
    for (let i = 0; i < n; i += sample) {
      const a = nodes[i];
      for (let j = i + sample; j < n; j += sample) {
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist2 = dx * dx + dy * dy || 0.01;
        const force = 900 / dist2;
        const fx = dx * force;
        const fy = dy * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    // Springs — a bit shorter so clusters stay inside the sphere
    for (const l of links) {
      const dx = l.target.x - l.source.x;
      const dy = l.target.y - l.source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const ideal = 55;
      const k = 0.025 * (dist - ideal);
      const fx = (dx / dist) * k;
      const fy = (dy / dist) * k;
      l.source.vx += fx;
      l.source.vy += fy;
      l.target.vx -= fx;
      l.target.vy -= fy;
    }

    // Spherical bowl: soft pull toward a disc of radius R (not a point, not a box).
    for (const node of nodes) {
      if (state.dragging === node) continue;
      const dx = node.x - cx;
      const dy = node.y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const ux = dx / dist;
      const uy = dy / dist;

      // Mild outward pressure near the center so it doesn't collapse into a knot
      if (dist < R * 0.25) {
        node.vx += ux * 0.15;
        node.vy += uy * 0.15;
      }

      // Soft radial spring toward R * 0.72 (fills the circle)
      const target = R * 0.72;
      node.vx += ux * (target - dist) * 0.012;
      node.vy += uy * (target - dist) * 0.012;

      // Hard-ish containment past the rim
      if (dist > R) {
        const pull = (dist - R) * 0.08;
        node.vx -= ux * pull;
        node.vy -= uy * pull;
      }

      // Light centering so widescreen doesn't stretch into an ellipse
      node.vx += (cx - node.x) * 0.002;
      node.vy += (cy - node.y) * 0.002;

      node.vx *= 0.86;
      node.vy *= 0.86;
      node.x += node.vx * sim.alpha;
      node.y += node.vy * sim.alpha;
    }
    sim.alpha *= 0.988;
  }

  function screenToWorld(sx, sy) {
    const { x, y, k } = state.transform;
    return { x: (sx - x) / k, y: (sy - y) / k };
  }

  function nodeRadius(node) {
    return 4 + Math.min(10, (node.degree || 0) * 0.45);
  }

  function nodeFlags(node) {
    const focused = state.focusId === node.id;
    const hovered = state.hoverId === node.id;
    const isA = state.matchA.has(node.id);
    const isB = state.matchB.has(node.id);
    const isDate = state.matchDate.has(node.id);
    let linked = false;
    if (state.focusId && !focused) {
      linked = state.links.some(
        (l) =>
          (l.source.id === state.focusId && l.target.id === node.id) ||
          (l.target.id === state.focusId && l.source.id === node.id),
      );
    }
    const dimmed = !!(state.focusId && !focused && !linked);
    return { focused, hovered, isA, isB, isDate, linked, dimmed };
  }

  function labelRect(node, text, fontSize, k) {
    const r = nodeRadius(node);
    const width = ctx.measureText(text).width;
    const pad = 5 / k;
    const y = node.y + r + 12 / k;
    return {
      left: node.x - width / 2 - pad,
      right: node.x + width / 2 + pad,
      top: y - fontSize - pad,
      bottom: y + pad * 0.35,
    };
  }

  function rectsOverlap(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  function labelPriority(node, flags) {
    if (flags.focused) return 1e9;
    if (flags.hovered) return 1e8;
    if (flags.isA || flags.isB || flags.isDate) return 1e7 + (node.degree || 0);
    if (flags.linked) return 1e6 + (node.degree || 0);
    return node.degree || 0;
  }

  function pickVisibleLabels(k) {
    const fontSize = 12 / k;
    ctx.font = `${fontSize}px "DM Sans", system-ui, sans-serif`;
    const candidates = [];
    for (const node of state.nodes) {
      const flags = nodeFlags(node);
      if (flags.dimmed) continue;
      const must =
        flags.focused || flags.hovered || flags.linked || flags.isA || flags.isB || flags.isDate;
      const eligible =
        must ||
        state.transform.k > 1.3 ||
        (node.degree || 0) >= 4 ||
        state.nodes.length < 80;
      if (!eligible) continue;
      const text = truncate(node.label, 28);
      if (!text) continue;
      candidates.push({
        node,
        flags,
        must,
        text,
        priority: labelPriority(node, flags),
        rect: labelRect(node, text, fontSize, k),
      });
    }
    candidates.sort((a, b) => b.priority - a.priority || a.text.length - b.text.length);
    const placed = [];
    const visible = [];
    for (const item of candidates) {
      if (!item.must && placed.some((rect) => rectsOverlap(rect, item.rect))) continue;
      placed.push(item.rect);
      visible.push(item);
    }
    return visible;
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

    const bridging = !!(state.query.trim() && state.queryB.trim());

    // Links
    for (const l of state.links) {
      const focused =
        state.focusId &&
        (l.source.id === state.focusId || l.target.id === state.focusId);
      const onBridge = bridging;
      const dimmed = state.focusId && !focused;
      ctx.beginPath();
      ctx.moveTo(l.source.x, l.source.y);
      ctx.lineTo(l.target.x, l.target.y);
      ctx.strokeStyle = focused
        ? "rgba(196, 163, 90, 0.85)"
        : onBridge
          ? "rgba(196, 163, 90, 0.7)"
          : dimmed
            ? "rgba(147, 160, 148, 0.06)"
            : "rgba(147, 160, 148, 0.35)";
      ctx.lineWidth = focused || onBridge ? 2.25 / state.transform.k : 1 / state.transform.k;
      ctx.stroke();
    }

    // Nodes
    for (const node of state.nodes) {
      const { focused, isA, isB, isDate, dimmed } = nodeFlags(node);
      const r = nodeRadius(node) + (isA || isB || isDate ? 2 : 0);
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fillStyle = focused
        ? "#f0e6c8"
        : isA
          ? "#c4a35a"
          : isB
            ? "#7eb8c9"
            : isDate
              ? "#6b9e78"
              : dimmed
                ? "rgba(147,160,148,0.2)"
                : typeColor(displayType(node));
      ctx.fill();
      if (isA || isB || isDate) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 3 / state.transform.k, 0, Math.PI * 2);
        ctx.strokeStyle =
          isA && isB ? "#f0e6c8" : isA ? "#c4a35a" : isB ? "#7eb8c9" : "#6b9e78";
        ctx.lineWidth = 1.5 / state.transform.k;
        ctx.stroke();
      }
    }

    // Labels: keep the most central name in each screen region.
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const k = state.transform.k;
    for (const item of pickVisibleLabels(k)) {
      const r = nodeRadius(item.node);
      ctx.font = `${12 / k}px "DM Sans", system-ui, sans-serif`;
      ctx.fillStyle = item.flags.focused || item.flags.hovered
        ? "rgba(240, 230, 200, 0.96)"
        : "rgba(231, 238, 230, 0.9)";
      ctx.fillText(item.text, item.node.x, item.node.y + r + 12 / k);
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
    updateBridgeHint();
    updateDateHint();
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

  function renderFilePreview(file, fallbackName) {
    if (!file?.url) return "";
    const url = escapeHtml(apiUrl(file.url));
    const label = escapeHtml(file.filename || fallbackName || "original file");
    const kind = file.kind || (String(file.mimeType || "").startsWith("image/") ? "image" : "");
    const open = `<a class="detail-file-open" href="${url}" target="_blank" rel="noreferrer">Open original · ${label}</a>`;
    if (kind === "image") {
      return `<figure class="detail-photo"><img id="detail-photo" src="${url}" alt="${label}" /></figure>${open}`;
    }
    if (kind === "pdf") {
      return `<figure class="detail-file"><iframe id="detail-file" src="${url}" title="${label}"></iframe></figure>${open}`;
    }
    if (kind === "audio") {
      return `<figure class="detail-file"><audio id="detail-audio" controls src="${url}"></audio></figure>${open}`;
    }
    return `<figure class="detail-file"><pre class="detail-file-text" id="detail-file-text">Loading original…</pre></figure>${open}`;
  }

  async function fillTextFilePreview() {
    const pre = document.getElementById("detail-file-text");
    const link = elDetailBody.querySelector(".detail-file-open");
    if (!pre || !link?.href) return;
    try {
      const res = await fetch(link.href);
      const text = await res.text();
      pre.textContent = text || "(empty file)";
    } catch (err) {
      pre.textContent = err.message || "Could not load original file";
    }
    if (elOverlay?.classList.contains("open")) {
      syncDetailOverlay(document.getElementById("detail-title")?.textContent || "");
    }
  }

  async function selectNode(id) {
    state.focusId = id;
    draw();
    elDetail.classList.add("open");
    elDetailBody.innerHTML = "<p class='meta'>Loading…</p>";
    try {
      const res = await fetch(apiUrl(`/memory/graph/node/${encodeURIComponent(id)}`));
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
      const name = data.index?.name || rev.name || data.index?.record_type || "";
      const email = typeof schema.email === "string" ? schema.email : "";
      const telephone = typeof schema.telephone === "string" ? schema.telephone : "";
      const birthDate = typeof schema.birthDate === "string" ? schema.birthDate : "";
      const color = typeColor(
        isOrganizationNode({
          type: data.index.record_type,
          schemaType: data.index.schema_type,
        })
          ? "Organization"
          : data.index.record_type,
      );
      const typeLabel = isOrganizationNode({
        type: data.index.record_type,
        schemaType: data.index.schema_type,
      })
        ? "Organization"
        : data.index.record_type;
      const isPerson =
        String(schema["@type"] || "").toLowerCase() === "person" ||
        String(data.index.schema_type || "").includes("Person");
      const isSelf = !!(data.revision?.alfred && data.revision.alfred.isSelf);
      elDetailBody.innerHTML = [
        `<div class="type-pill" style="color:${color}">${escapeHtml(typeLabel)}${
          isSelf ? " · you" : ""
        }</div>`,
        `<h2 id="detail-title">${escapeHtml(name)}</h2>`,
        `<div class="meta">${escapeHtml(data.index.id)}${
          data.index.schema_type ? `<br>${escapeHtml(data.index.schema_type)}` : ""
        }</div>`,
        email || telephone || birthDate
          ? `<div class="contact-chip">${
              email ? `<div>✉ ${escapeHtml(email)}</div>` : ""
            }${telephone ? `<div>☎ ${escapeHtml(telephone)}</div>` : ""}${
              birthDate ? `<div>Birthday ${escapeHtml(birthDate)}</div>` : ""
            }</div>`
          : "",
        isSelf
          ? `<div class="contact-chip"><div>This is you — conversational facts (birthday, worksAt, …) attach here.</div></div>`
          : "",
        renderFilePreview(data.file || data.image, name),
        `<div class="edit-form" id="edit-form">
          <div>
            <label for="edit-name">Name</label>
            <input id="edit-name" name="name" type="text" value="${escapeHtml(name)}" autocomplete="off" />
          </div>
          <div>
            <div class="detail-label-row">
              <label for="edit-text">Details</label>
              <button type="button" class="detail-expand" id="btn-expand-details">Expand</button>
            </div>
            <textarea id="edit-text" name="text">${escapeHtml(String(text))}</textarea>
          </div>
          ${
            isPerson
              ? `<div>
            <label for="edit-email">Email</label>
            <input id="edit-email" name="email" type="text" value="${escapeHtml(email)}" autocomplete="off" />
          </div>
          <div>
            <label for="edit-telephone">Phone</label>
            <input id="edit-telephone" name="telephone" type="text" value="${escapeHtml(telephone)}" autocomplete="off" />
          </div>
          <div>
            <label for="edit-birthDate">Birthday</label>
            <input id="edit-birthDate" name="birthDate" type="text" value="${escapeHtml(birthDate)}" placeholder="YYYY-MM-DD or --MM-DD" autocomplete="off" />
          </div>`
              : ""
          }
          <div class="detail-actions">
            <button type="button" id="btn-connections">${
              state.egoId === id ? "Show full graph" : "Show connections"
            }</button>
            ${
              isPerson && !isSelf
                ? `<button type="button" id="btn-set-self">This is Me</button>`
                : ""
            }
            <button type="button" id="btn-save">Save changes</button>
            <button type="button" id="btn-center">Center</button>
            <button type="button" id="btn-delete" class="danger">Delete</button>
          </div>
          <div class="edit-status" id="edit-status"></div>
        </div>`,
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
      document.getElementById("btn-connections")?.addEventListener("click", () => {
        if (state.egoId === id) {
          state.egoId = null;
        } else {
          state.egoId = id;
          state.focusId = id;
        }
        render();
        requestAnimationFrame(() => {
          const node = state.nodes.find((n) => n.id === id);
          if (!node) return;
          state.transform.k = 1.6;
          state.transform.x = window.innerWidth / 2 - node.x * state.transform.k;
          state.transform.y = window.innerHeight / 2 - node.y * state.transform.k;
          draw();
        });
        // Refresh the panel so the button label toggles
        selectNode(id);
      });
      document.getElementById("btn-set-self")?.addEventListener("click", async () => {
        const label = name || id;
        const ok = window.confirm(
          `Mark “${label}” as you?\n\nFuture facts (birthday, worksAt, spouse, …) will attach here. The placeholder “User” node will be merged into this person.`,
        );
        if (!ok) return;
        const status = document.getElementById("edit-status");
        const btn = document.getElementById("btn-set-self");
        if (btn) btn.disabled = true;
        if (status) {
          status.className = "edit-status";
          status.textContent = "Linking self…";
        }
        try {
          const res = await fetch(apiUrl("/memory/graph/node/set-self"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            const hint =
              res.status === 404
                ? " API missing — restart the desktop server (pnpm desktop), then try again."
                : "";
            throw new Error((data.message || data.error || `Failed (${res.status})`) + hint);
          }
          await load(state.types.has("Artifact"), true);
          await selectNode(data.selfId || id);
          const st = document.getElementById("edit-status");
          if (st) {
            st.className = "edit-status ok";
            st.textContent = `You’re ${data.selfName || label}. Migrated ${data.migratedAssertions ?? 0} link(s).`;
          }
        } catch (err) {
          if (status) {
            status.className = "edit-status err";
            status.textContent = err.message || String(err);
          }
          if (btn) btn.disabled = false;
        }
      });
      document.getElementById("btn-delete")?.addEventListener("click", async () => {
        const label = name || id;
        const ok = window.confirm(
          `Delete “${label}” permanently from memory?\n\nThis cannot be undone.`,
        );
        if (!ok) return;
        const status = document.getElementById("edit-status");
        const deleteBtn = document.getElementById("btn-delete");
        const saveBtn = document.getElementById("btn-save");
        if (deleteBtn) deleteBtn.disabled = true;
        if (saveBtn) saveBtn.disabled = true;
        if (status) {
          status.className = "edit-status";
          status.textContent = "Deleting…";
        }
        try {
          const delRes = await fetch(apiUrl("/memory/graph/node/delete"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id }),
          });
          const delData = await delRes.json().catch(() => ({}));
          if (!delRes.ok) {
            const hint =
              delRes.status === 404
                ? " Delete API missing — restart the desktop server (pnpm desktop), then try again."
                : "";
            throw new Error(
              (delData.message || delData.error || `Delete failed (${delRes.status})`) + hint,
            );
          }
          state.focusId = null;
          state.egoId = null;
          closeDetail();
          // Reload from disk so we don't keep ghost nodes from a stale in-memory graph.
          await load(state.types.has("Artifact"), true);
        } catch (err) {
          if (status) {
            status.className = "edit-status err";
            status.textContent = err.message || String(err);
          }
          if (deleteBtn) deleteBtn.disabled = false;
          if (saveBtn) saveBtn.disabled = false;
        }
      });
      document.getElementById("btn-save")?.addEventListener("click", async () => {
        const status = document.getElementById("edit-status");
        const nameInput = document.getElementById("edit-name");
        const textInput = document.getElementById("edit-text");
        const emailInput = document.getElementById("edit-email");
        const telInput = document.getElementById("edit-telephone");
        const birthInput = document.getElementById("edit-birthDate");
        const saveBtn = document.getElementById("btn-save");
        if (!nameInput || !textInput) return;
        const nextName = nameInput.value.trim();
        const nextText = textInput.value.trim();
        const nextEmail = emailInput ? emailInput.value.trim() : undefined;
        const nextTel = telInput ? telInput.value.trim() : undefined;
        const nextBirth = birthInput ? birthInput.value.trim() : undefined;
        if (!nextName) {
          if (status) {
            status.className = "edit-status err";
            status.textContent = "Name can’t be empty.";
          }
          return;
        }
        if (saveBtn) saveBtn.disabled = true;
        if (status) {
          status.className = "edit-status";
          status.textContent = "Saving…";
        }
        try {
          const body = { id, name: nextName, text: nextText };
          if (emailInput) body.email = nextEmail;
          if (telInput) body.telephone = nextTel;
          if (birthInput) body.birthDate = nextBirth;
          const patchRes = await fetch(apiUrl("/memory/graph/node/update"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const patchData = await patchRes.json().catch(() => ({}));
          if (!patchRes.ok) {
            throw new Error(patchData.message || patchData.error || `Save failed (${patchRes.status})`);
          }
          if (state.raw?.nodes) {
            const n = state.raw.nodes.find((x) => x.id === id);
            if (n) {
              n.label = nextName;
              n.searchText = `${nextName} ${nextText} ${nextEmail || ""} ${nextTel || ""}`.trim();
            }
          }
          const simNode = state.nodes.find((x) => x.id === id);
          if (simNode) simNode.label = nextName;
          state.focusId = id;
          draw();
          await selectNode(id);
        } catch (err) {
          if (status) {
            status.className = "edit-status err";
            status.textContent = err.message || String(err);
          }
        } finally {
          if (saveBtn) saveBtn.disabled = false;
        }
      });
      elDetailBody.querySelectorAll(".neighbors li").forEach((li) => {
        li.addEventListener("click", () => selectNode(li.getAttribute("data-id")));
      });
      document.getElementById("btn-expand-details")?.addEventListener("click", () => {
        openDetailOverlay(name);
      });
      document.getElementById("detail-photo")?.addEventListener("click", () => {
        openDetailOverlay(name);
      });
      document.getElementById("detail-photo")?.addEventListener("error", (e) => {
        e.target.closest(".detail-photo")?.classList.add("missing");
      });
      fillTextFilePreview();
      const editText = document.getElementById("edit-text");
      editText?.addEventListener("input", () => {
        if (elOverlay?.classList.contains("open") && elOverlayText && editText) {
          elOverlayText.value = editText.value;
        }
      });
      if (elOverlay?.classList.contains("open")) {
        syncDetailOverlay(name);
      }
    } catch (e) {
      elDetailBody.innerHTML = `<p class="meta">${escapeHtml(e.message || String(e))}</p>`;
    }
  }

  const elOverlay = document.getElementById("detail-overlay");
  const elOverlayName = document.getElementById("detail-overlay-name");
  const elOverlayText = document.getElementById("detail-overlay-text");
  const elOverlayPhoto = document.getElementById("detail-overlay-photo");
  const elOverlayImg = document.getElementById("detail-overlay-img");
  const elOverlayFile = document.getElementById("detail-overlay-file");

  function syncDetailOverlay(title) {
    const editText = document.getElementById("edit-text");
    if (elOverlayName) elOverlayName.textContent = title || document.getElementById("detail-title")?.textContent || "";
    if (elOverlayText && editText) elOverlayText.value = editText.value;
    const photo = document.getElementById("detail-photo");
    if (elOverlayPhoto && elOverlayImg) {
      if (photo?.src && !photo.closest(".detail-photo")?.classList.contains("missing")) {
        elOverlayImg.src = photo.src;
        elOverlayImg.alt = photo.alt || "";
        elOverlayPhoto.hidden = false;
      } else {
        elOverlayImg.removeAttribute("src");
        elOverlayPhoto.hidden = true;
      }
    }
    if (elOverlayFile) {
      const frame = document.getElementById("detail-file");
      const pre = document.getElementById("detail-file-text");
      if (frame?.src) {
        elOverlayFile.innerHTML = `<iframe src="${escapeHtml(frame.src)}" title="${escapeHtml(frame.title || "original file")}"></iframe>`;
        elOverlayFile.hidden = false;
      } else if (pre) {
        elOverlayFile.innerHTML = `<pre>${escapeHtml(pre.textContent || "")}</pre>`;
        elOverlayFile.hidden = false;
      } else {
        elOverlayFile.innerHTML = "";
        elOverlayFile.hidden = true;
      }
    }
  }

  function openDetailOverlay(title) {
    if (!elOverlay) return;
    syncDetailOverlay(title);
    elOverlay.hidden = false;
    requestAnimationFrame(() => {
      elOverlay.classList.add("open");
      elOverlayText?.focus();
    });
  }

  function closeDetailOverlay() {
    if (!elOverlay) return;
    const editText = document.getElementById("edit-text");
    if (elOverlayText && editText) editText.value = elOverlayText.value;
    elOverlay.classList.remove("open");
    elOverlay.hidden = true;
  }

  function closeDetail() {
    closeDetailOverlay();
    elDetail.classList.remove("open");
  }

  async function load(includeArtifacts, forceRebuild) {
    elStats.textContent = forceRebuild ? "Rebuilding index…" : "Loading…";
    const params = new URLSearchParams();
    if (includeArtifacts) params.set("artifacts", "1");
    if (forceRebuild) params.set("rebuild", "1");
    const res = await fetch(apiUrl(`/memory/graph/data?${params}`));
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
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    if (state.dragging) {
      const p = screenToWorld(sx, sy);
      state.dragging.x = p.x;
      state.dragging.y = p.y;
      state.dragging.vx = 0;
      state.dragging.vy = 0;
      draw();
    } else if (state.panning) {
      state.transform.x = state.panning.tx + (e.clientX - state.panning.x);
      state.transform.y = state.panning.ty + (e.clientY - state.panning.y);
      draw();
    } else {
      const hit = hitTest(sx, sy);
      const nextId = hit?.id || null;
      canvas.style.cursor = hit ? "pointer" : "grab";
      if (nextId !== state.hoverId) {
        state.hoverId = nextId;
        draw();
      }
    }
  });

  canvas.addEventListener("pointerleave", () => {
    if (!state.hoverId) return;
    state.hoverId = null;
    canvas.style.cursor = "grab";
    draw();
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
  function onSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = elQ.value;
      state.queryB = elQ2?.value || "";
      state.queryDate = elQDate?.value || "";
      render();
    }, 160);
  }
  elQ.addEventListener("input", onSearchInput);
  elQ2?.addEventListener("input", onSearchInput);
  elQDate?.addEventListener("input", onSearchInput);

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
  const elJob = document.getElementById("job-progress");
  const elJobTitle = document.getElementById("job-progress-title");
  const elJobLabel = document.getElementById("job-progress-label");
  const elJobBar = document.getElementById("job-progress-bar");
  const elJobFill = document.getElementById("job-progress-fill");
  const elJobCount = document.getElementById("job-progress-count");
  const elJobPct = document.getElementById("job-progress-pct");

  function showJobProgress(title) {
    if (!elJob) return;
    elJob.hidden = false;
    elJob.classList.remove("err");
    requestAnimationFrame(() => elJob.classList.add("on"));
    if (elJobTitle) elJobTitle.textContent = title;
    setJobProgress({ label: "Starting…", percent: 0, current: 0, total: 0 });
  }

  function setJobProgress(progress) {
    if (!elJob) return;
    const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
    if (elJobLabel) elJobLabel.textContent = progress.label || "";
    if (elJobFill) elJobFill.style.width = `${percent}%`;
    if (elJobPct) elJobPct.textContent = `${percent}%`;
    const current = Number(progress.current) || 0;
    const total = Number(progress.total) || 0;
    if (elJobCount) {
      elJobCount.textContent = total > 0 ? `${current} / ${total}` : "";
    }
    if (elJobBar) {
      elJobBar.setAttribute("aria-valuenow", String(percent));
      elJobBar.setAttribute("aria-valuetext", progress.label || `${percent}%`);
    }
  }

  function hideJobProgress(delayMs) {
    if (!elJob) return;
    window.setTimeout(() => {
      elJob.classList.remove("on");
      window.setTimeout(() => {
        elJob.hidden = true;
      }, 200);
    }, delayMs ?? 900);
  }

  function failJobProgress(message) {
    if (!elJob) return;
    elJob.classList.add("err");
    setJobProgress({ label: message || "Clean failed", percent: 100, current: 0, total: 0 });
    hideJobProgress(3200);
  }

  async function readCleanIndexResponse(res, onProgress) {
    const ctype = res.headers.get("content-type") || "";
    if (ctype.includes("application/json")) {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const hint =
          res.status === 404
            ? " API missing — restart the desktop server (pnpm desktop), then try again."
            : "";
        throw new Error((data.message || data.error || `Clean failed (${res.status})`) + hint);
      }
      return data;
    }
    if (!res.body) {
      throw new Error(`Clean failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let result = null;
    let streamError = null;
    const consumeBlock = (chunk) => {
      let event = "message";
      const dataLines = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (!dataLines.length) return;
      const data = JSON.parse(dataLines.join("\n"));
      if (event === "progress") onProgress(data);
      else if (event === "done") result = data;
      else if (event === "error") streamError = data;
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const blocks = buf.split("\n\n");
      buf = blocks.pop() ?? "";
      for (const block of blocks) consumeBlock(block);
    }
    if (buf.trim()) consumeBlock(buf);
    if (streamError) {
      throw new Error(streamError.message || streamError.error || "Clean failed");
    }
    if (!res.ok && !result) {
      throw new Error(`Clean failed (${res.status})`);
    }
    return result || {};
  }

  document.getElementById("btn-clean")?.addEventListener("click", async () => {
    const ok = window.confirm(
      "Clean Index merges duplicate entities with the same name and type.\n\n" +
        "Connections are unioned onto the kept node (if one copy linked X and Y and another only X, the survivor keeps X and Y).\n\n" +
        "It also strips legacy “[superseded] …” prefixes from names. Duplicates stay hidden via metadata, not renamed. Continue?",
    );
    if (!ok) return;
    const btn = document.getElementById("btn-clean");
    if (btn) btn.disabled = true;
    elStats.textContent = "Cleaning duplicates…";
    showJobProgress("Clean Index");
    try {
      const res = await fetch(apiUrl("/memory/graph/clean-index"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: "{}",
      });
      const data = await readCleanIndexResponse(res, setJobProgress);
      setJobProgress({ label: "Reloading graph…", percent: 96, current: 1, total: 1 });
      await load(state.types.has("Artifact"), true);
      setJobProgress({ label: "Done", percent: 100, current: 1, total: 1 });
      const summary =
        `Cleaned ${data.groupsMerged ?? 0} group(s) · ` +
        `scrubbed ${data.namesScrubbed ?? 0} names · ` +
        `superseded ${data.entitiesSuperseded ?? 0} entities · ` +
        `retargeted ${data.assertionsRetargeted ?? 0} links · ` +
        `collapsed ${data.assertionsSuperseded ?? 0} duplicate assertions. `;
      elStats.textContent = summary + (elStats.textContent || "");
      hideJobProgress();
    } catch (err) {
      const message = err.message || String(err);
      elStats.textContent = message;
      failJobProgress(message);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  document.getElementById("btn-reset").addEventListener("click", () => {
    state.focusId = null;
    state.egoId = null;
    state.query = "";
    state.queryB = "";
    state.queryDate = "";
    state.bridge = null;
    state.matchA = new Set();
    state.matchB = new Set();
    state.matchDate = new Set();
    elQ.value = "";
    if (elQ2) elQ2.value = "";
    if (elQDate) elQDate.value = "";
    updateBridgeHint();
    updateDateHint();
    closeDetail();
    state.transform = { x: 0, y: 0, k: 1 };
    render();
  });
  document.getElementById("btn-ingest").addEventListener("click", () => {
    if (window.parent !== window && typeof window.alfredRequestShellNavigate === "function") {
      window.alfredRequestShellNavigate("ingest");
      return;
    }
    location.href = apiUrl("/memory/ingest");
  });
  document.getElementById("detail-close").addEventListener("click", () => {
    state.focusId = null;
    closeDetail();
    draw();
  });
  elOverlayText?.addEventListener("input", () => {
    const editText = document.getElementById("edit-text");
    if (editText) editText.value = elOverlayText.value;
  });
  document.getElementById("detail-overlay-close")?.addEventListener("click", closeDetailOverlay);
  document.getElementById("detail-overlay-done")?.addEventListener("click", closeDetailOverlay);
  document.getElementById("detail-overlay-save")?.addEventListener("click", () => {
    const editText = document.getElementById("edit-text");
    if (elOverlayText && editText) editText.value = elOverlayText.value;
    document.getElementById("btn-save")?.click();
  });
  elOverlay?.addEventListener("click", (e) => {
    if (e.target === elOverlay) closeDetailOverlay();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && elOverlay?.classList.contains("open")) {
      e.preventDefault();
      closeDetailOverlay();
    }
  });

  window.addEventListener("resize", resize);
  resize();

  load(false, false).catch((err) => {
    elStats.textContent = err.message;
    setEmpty(true, "Failed to load graph data", escapeHtml(err.message || String(err)));
  });
})();
