/**
 * 3D memory graph (beta) — ForceGraph3D + amber nebula look.
 * Reuses classic /memory/graph/data and node APIs.
 */
(() => {
  function apiUrl(path) {
    return typeof alfredUrl === "function" ? alfredUrl(path) : path;
  }

  // Amber nebula family — slight hue shifts only, no rainbow types
  const COLORS = {
    Entity: "#e8c878",
    Organization: "#d4a84a",
    Episode: "#c9a05c",
    Assertion: "#b8893e",
    Observation: "#a87c48",
    Artifact: "#8f6d40",
  };

  const ACCENT_A = "#ffe9a8";
  const ACCENT_B = "#7ec8d6";
  const PATH_CORE = "#ffd978";
  const DIM = "rgba(48, 36, 22, 0.12)";
  const LINK_DIM = "rgba(48, 36, 22, 0.05)";
  const LINK_NEAR = "rgba(180, 140, 70, 0.22)";
  const LINK_HOT = "#ffe29a";
  const LINK_BASE = "rgba(196, 150, 70, 0.18)";
  const LINK_HIGHWAY = "rgba(232, 180, 90, 0.45)";

  const state = {
    raw: null,
    types: new Set(["Entity", "Assertion"]),
    query: "",
    queryB: "",
    queryDate: "",
    bridge: null,
    matchA: new Set(),
    matchB: new Set(),
    matchDate: new Set(),
    egoId: null,
    focusId: null,
    nodes: [],
    links: [],
    graph: null,
    bloomReady: false,
    cameraKey: "",
    pathCore: null,
    cameraPrimed: false,
    labelIds: new Set(),
  };

  const elStage = document.getElementById("graph-3d");
  const elStats = document.getElementById("stats");
  const elDetail = document.getElementById("detail");
  const elDetailBody = document.getElementById("detail-body");
  const elOverlay = document.getElementById("detail-overlay");
  const elOverlayName = document.getElementById("detail-overlay-name");
  const elOverlayText = document.getElementById("detail-overlay-text");
  const elEmpty = document.getElementById("empty");
  const elEmptyTitle = elEmpty.querySelector("h2");
  const elEmptyLead = document.getElementById("empty-lead");
  const elEmptyDiag = document.getElementById("empty-diag");
  const elQ = document.getElementById("q");
  const elQ2 = document.getElementById("q2");
  const elQDate = document.getElementById("qDate");
  const elBridgeHint = document.getElementById("bridge-hint");
  const elDateHint = document.getElementById("date-hint");
  const elJob = document.getElementById("job-progress");
  const elJobTitle = document.getElementById("job-progress-title");
  const elJobLabel = document.getElementById("job-progress-label");
  const elJobBar = document.getElementById("job-progress-bar");
  const elJobFill = document.getElementById("job-progress-fill");
  const elJobCount = document.getElementById("job-progress-count");
  const elJobPct = document.getElementById("job-progress-pct");

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
    return COLORS[t] || "#c4a35a";
  }

  function amberForNode(node) {
    const base = typeColor(displayType(node));
    const deg = node.degree || 0;
    // Hubs run hotter / brighter within the amber family
    if (deg >= 24) return "#ffe29a";
    if (deg >= 12) return "#e8c878";
    return base;
  }

  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < String(s).length; i++) h = (Math.imul(31, h) + String(s).charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  /** Pick stable long-range “highway” edges for particle streaks. */
  function pickHighwayKeys(nodes, links, budget) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const scored = [];
    for (const l of links) {
      const s = byId.get(linkEndId(l.source));
      const t = byId.get(linkEndId(l.target));
      if (!s || !t) continue;
      const same = displayType(s) === displayType(t);
      const deg = (s.degree || 1) * (t.degree || 1);
      // Prefer cross-type / hub bridges (read as long-range in the force layout)
      const score = (same ? deg * 0.15 : deg) + (same ? 0 : 400);
      if (score < 80) continue;
      const key = l.key || linkKey(s.id, t.id, l.predicate);
      scored.push({ key, score });
    }
    scored.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
    return new Set(scored.slice(0, budget).map((x) => x.key));
  }

  /** Top entity hubs (+ orgs) for floating monospace cluster labels. */
  function pickLabelIds(nodes, limit = 14) {
    const entities = nodes
      .filter((n) => n.type === "Entity" || displayType(n) === "Organization")
      .slice()
      .sort((a, b) => (b.degree || 0) - (a.degree || 0) || String(a.label).localeCompare(String(b.label)));
    const ids = new Set();
    for (const n of entities) {
      if (ids.size >= limit) break;
      const label = String(n.label || "").trim();
      if (!label || label.length < 2) continue;
      if (/^\[superseded\]/i.test(label)) continue;
      ids.add(n.id);
    }
    return ids;
  }

  function formatClusterLabel(label) {
    return String(label || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 28);
  }

  function fillRoundRect(ctx, x, y, w, h, r) {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  function makeClusterLabelSprite(text) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const fontSize = 32;
    const padX = 14;
    const height = 48;
    const font = `700 ${fontSize}px ui-sans-serif, -apple-system, "Segoe UI", sans-serif`;
    ctx.font = font;
    const width = Math.ceil(ctx.measureText(text).width) + padX * 2;
    canvas.width = Math.ceil(width * dpr);
    canvas.height = Math.ceil(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = font;
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(8, 6, 4, 0.92)";
    ctx.strokeStyle = "rgba(255, 236, 190, 0.4)";
    ctx.lineWidth = 1.25;
    fillRoundRect(ctx, 0.75, 0.75, width - 1.5, height - 1.5, 8);
    const x = padX;
    const y = height / 2 + 1;
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.lineWidth = 7;
    ctx.strokeStyle = "rgba(6, 4, 2, 0.95)";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = "#fff6de";
    ctx.fillText(text, x, y);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    if ("colorSpace" in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      depthWrite: false,
      transparent: true,
      opacity: 1,
    });
    if ("toneMapped" in mat) mat.toneMapped = false;
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(width / 9.5, height / 9.5, 1);
    sprite.position.y = 22;
    sprite.renderOrder = 2;
    return sprite;
  }

  /** Live sim node with coordinates (paint remaps lose x/y/z unless preserved). */
  function liveNode(id) {
    if (!id) return null;
    const fromGraph = state.graph?.graphData?.()?.nodes?.find((n) => n.id === id);
    if (fromGraph && Number.isFinite(fromGraph.x)) return fromGraph;
    const fromState = state.nodes.find((n) => n.id === id);
    if (fromState && Number.isFinite(fromState.x)) return fromState;
    return fromGraph || fromState || null;
  }

  function flyToNode(idOrNode, opts = {}) {
    const Graph = state.graph;
    if (!Graph) return;
    const node =
      typeof idOrNode === "string" || idOrNode == null
        ? liveNode(idOrNode)
        : Number.isFinite(idOrNode.x)
          ? idOrNode
          : liveNode(idOrNode.id);
    if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y) || !Number.isFinite(node.z)) {
      return;
    }
    const dist = opts.dist ?? 220;
    const ms = opts.ms ?? 700;
    // Keep look-at on the node; seat camera above/back so UI chrome doesn't cover it
    Graph.cameraPosition(
      {
        x: node.x + dist * 0.15,
        y: node.y + dist * 0.85,
        z: node.z + dist * 0.7,
      },
      { x: node.x, y: node.y, z: node.z },
      ms,
    );
  }

  function isOrganizationNode(node) {
    if (String(node?.type || "").trim() !== "Entity") return false;
    return String(node?.schemaType || "").toLowerCase().includes("organization");
  }

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
      entities.length > 0 ? entities : labelHits.filter((n) => n.type !== "Assertion");
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
            /\b(worksAt|worksWith|reportsTo|supervisorOf|colleagueOf|spouseOf|parentOf|partOf|runs|workplaceRole|relatedTo|hiredBy|inventorOf|founderOf|cofounderOf|hasBirthDate)\b/i,
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
      if (!s || !t) continue;
      const pred = String(l.predicate || "");
      if (s.type === "Assertion" && t.type === "Entity") {
        attach(s.id, pred === "object" ? "object" : "subject", t.id);
      } else if (t.type === "Assertion" && s.type === "Entity") {
        attach(t.id, pred === "object" ? "object" : "subject", s.id);
      }
    }

    const out = [];
    const seen = new Set();
    for (const [assertionId, bucket] of byAssertion) {
      for (const sub of bucket.subjects) {
        for (const obj of bucket.objects) {
          if (sub === obj) continue;
          const key = linkKey(sub, obj, bucket.predicate);
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            source: sub,
            target: obj,
            predicate: bucket.predicate,
            via: assertionId,
            key,
          });
        }
      }
    }
    return out;
  }

  function shortestBridge(fromIds, toIds, entityLinks) {
    const bfsFrom = new Set(fromIds);
    const bfsTo = new Set(toIds);
    for (const id of bfsFrom) {
      if (bfsTo.has(id)) {
        return {
          nodeIds: new Set([id]),
          linkKeys: new Set(),
          hops: 0,
          viaAssertions: new Set(),
        };
      }
    }

    const adj = new Map();
    for (const l of entityLinks) {
      const s = linkEndId(l.source);
      const t = linkEndId(l.target);
      if (!adj.has(s)) adj.set(s, []);
      if (!adj.has(t)) adj.set(t, []);
      adj.get(s).push({ other: t, key: l.key, via: l.via });
      adj.get(t).push({ other: s, key: l.key, via: l.via });
    }

    const parent = new Map();
    const dist = new Map();
    const queue = [];
    for (const id of bfsFrom) {
      dist.set(id, 0);
      queue.push(id);
    }

    let minHops = null;
    const reachedTargets = [];
    while (queue.length) {
      const id = queue.shift();
      const d = dist.get(id) ?? 0;
      if (minHops != null && d > minHops) break;
      if (bfsTo.has(id) && !bfsFrom.has(id)) {
        minHops = d;
        reachedTargets.push(id);
        continue;
      }
      for (const edge of adj.get(id) || []) {
        if (parent.has(edge.other) || bfsFrom.has(edge.other)) continue;
        if (dist.has(edge.other)) continue;
        parent.set(edge.other, { prev: id, key: edge.key, via: edge.via });
        dist.set(edge.other, d + 1);
        queue.push(edge.other);
      }
    }

    if (minHops == null || !reachedTargets.length) {
      return {
        nodeIds: new Set([...bfsFrom, ...bfsTo]),
        linkKeys: new Set(),
        hops: null,
        viaAssertions: new Set(),
      };
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

  function expandNeighborhood(nodes, links, seedIds, hops = 2) {
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
          if (n.type === "Entity" || n.type === "Assertion") grow.add(nid);
        };
        if (keep.has(s)) tryAdd(t);
        if (keep.has(t)) tryAdd(s);
      }
      keep = grow;
    }
    return keep;
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
    state.pathCore = null;

    const mapNode = (n) => ({
      id: n.id,
      label: n.label || n.type || n.id,
      type: String(n.type || "Entity").trim(),
      schemaType: n.schemaType ?? null,
      searchText: n.searchText || "",
      degree: n.degree || 0,
    });

    const typed = (state.raw.nodes || [])
      .filter((n) => nodePassesTypeFilter(n, state.types))
      .map(mapNode);

    const linksAmong = (nodeList) => {
      const ids = new Set(nodeList.map((n) => n.id));
      return rawLinks
        .map((l) => ({
          source: linkEndId(l.source),
          target: linkEndId(l.target),
          predicate: String(l.predicate || ""),
        }))
        .filter((l) => ids.has(l.source) && ids.has(l.target))
        .map((l) => ({
          ...l,
          key: linkKey(l.source, l.target, l.predicate),
        }));
    };

    const applyDateLens = (nodeList, allForExpand) => {
      if (!qDate) return nodeList;
      const dateIds = matchDateNodeIds(state.raw.nodes, qDate);
      state.matchDate = dateIds;
      if (!dateIds.size) return [];
      const keep = expandNeighborhood(allForExpand || typed, linksAmong(typed), dateIds, 2);
      return nodeList.filter((n) => keep.has(n.id));
    };

    if (state.egoId) {
      const keep = expandNeighborhood(typed, linksAmong(typed), new Set([state.egoId]), 2);
      state.matchA = new Set([state.egoId]);
      state.pathCore = new Set([state.egoId]);
      let nodes = typed.filter((n) => keep.has(n.id));
      nodes = applyDateLens(nodes);
      const ids = new Set(nodes.map((n) => n.id));
      return {
        nodes,
        links: linksAmong(nodes),
        highlight: ids,
        pathLinks: null,
        pathMode: false,
      };
    }

    if (qA && qB) {
      const matchATyped = matchNodeIds(typed, qA);
      const matchBTyped = matchNodeIds(typed, qB);
      state.matchA = matchATyped.size
        ? matchATyped
        : matchNodeIds(state.raw.nodes.map(mapNode), qA);
      state.matchB = matchBTyped.size
        ? matchBTyped
        : matchNodeIds(state.raw.nodes.map(mapNode), qB);

      const entityLinks = projectEntityLinks(
        state.raw.nodes.map(mapNode),
        rawLinks.map((l) => ({
          source: linkEndId(l.source),
          target: linkEndId(l.target),
          predicate: String(l.predicate || ""),
          key: linkKey(linkEndId(l.source), linkEndId(l.target), String(l.predicate || "")),
        })),
      );
      const bridge = shortestBridge(state.matchA, state.matchB, entityLinks);
      const connected = bridge.hops != null;
      state.bridge = {
        matchA: state.matchA.size,
        matchB: state.matchB.size,
        connected,
        hops: bridge.hops,
      };
      const pathCore = new Set([
        ...state.matchA,
        ...state.matchB,
        ...bridge.nodeIds,
        ...bridge.viaAssertions,
      ]);
      state.pathCore = pathCore;

      // Keep the nebula visible; dim everything outside the path
      let nodes = applyDateLens(typed);
      const highlight = pathCore;
      return {
        nodes,
        links: linksAmong(nodes),
        highlight,
        pathLinks: bridge.linkKeys,
        pathMode: true,
        viaAssertions: bridge.viaAssertions,
      };
    }

    if (qA || qB) {
      state.matchA = qA ? matchNodeIds(typed, qA) : new Set();
      state.matchB = qB ? matchNodeIds(typed, qB) : new Set();
      const seeds = new Set([...state.matchA, ...state.matchB]);
      state.pathCore = seeds;
      const expanded = expandNeighborhood(typed, linksAmong(typed), seeds, 1);
      let nodes = typed.filter((n) => expanded.has(n.id));
      nodes = applyDateLens(nodes);
      return {
        nodes,
        links: linksAmong(nodes),
        highlight: new Set(nodes.map((n) => n.id)),
        pathLinks: null,
        pathMode: false,
      };
    }

    if (qDate) {
      let nodes = applyDateLens(typed);
      const ids = new Set(nodes.map((n) => n.id));
      state.pathCore = state.matchDate;
      return {
        nodes,
        links: linksAmong(nodes),
        highlight: ids,
        pathLinks: null,
        pathMode: false,
      };
    }

    return {
      nodes: typed,
      links: linksAmong(typed),
      highlight: null,
      pathLinks: null,
      pathMode: false,
    };
  }

  function nodeVisualColor(node, highlight, pathMode) {
    if (state.matchA.has(node.id) && state.matchB.has(node.id)) return ACCENT_A;
    if (state.matchA.has(node.id)) return ACCENT_A;
    if (state.matchB.has(node.id)) return ACCENT_B;
    if (state.matchDate.has(node.id)) return ACCENT_A;
    if (state.focusId === node.id) return "#fff4d6";
    if (pathMode) {
      if (state.pathCore?.has(node.id) || highlight?.has(node.id)) return PATH_CORE;
      return DIM;
    }
    if (highlight && !highlight.has(node.id)) return DIM;
    return amberForNode(node);
  }

  function linkVisualColor(link, pathLinks, highlight, pathMode) {
    const key = link.key || linkKey(linkEndId(link.source), linkEndId(link.target), link.predicate);
    if (pathLinks && pathLinks.has(key)) return LINK_HOT;
    if (link.__highway) return LINK_HIGHWAY;
    if (pathMode) {
      const s = linkEndId(link.source);
      const t = linkEndId(link.target);
      if (state.pathCore?.has(s) && state.pathCore?.has(t)) return LINK_NEAR;
      return LINK_DIM;
    }
    if (highlight) {
      const s = linkEndId(link.source);
      const t = linkEndId(link.target);
      if (!highlight.has(s) || !highlight.has(t)) return LINK_DIM;
    }
    return LINK_BASE;
  }

  function ensureGraph() {
    if (state.graph) return state.graph;
    if (typeof ForceGraph3D !== "function") {
      throw new Error("ForceGraph3D failed to load");
    }

    const Graph = ForceGraph3D({ controlType: "orbit" })(elStage)
      .backgroundColor("#030201")
      .showNavInfo(false)
      .cooldownTicks(160)
      .d3AlphaDecay(0.022)
      .d3VelocityDecay(0.32)
      .nodeId("id")
      .nodeLabel((n) => `${n.label}\n${displayType(n)}`)
      .nodeRelSize(3.6)
      .nodeVal((n) => Math.max(0.8, Math.sqrt(n.degree || 1)))
      .nodeOpacity(0.95)
      .nodeColor((n) => n.__color || amberForNode(n))
      .linkColor((l) => l.__color || LINK_BASE)
      .linkWidth((l) => (l.__hot ? 2.6 : l.__highway ? 0.7 : 0.18))
      .linkOpacity(0.92)
      .linkDirectionalParticles((l) =>
        l.__hot ? 7 : l.__highway ? 4 : l.__spark ? 1 : 0,
      )
      .linkDirectionalParticleWidth((l) => (l.__hot ? 2.4 : l.__highway ? 1.6 : 0.8))
      .linkDirectionalParticleSpeed((l) => (l.__highway || l.__hot ? 0.0065 : 0.004))
      .linkDirectionalParticleColor((l) => (l.__hot ? "#fff0c0" : "#ffd978"))
      .onNodeClick((node, event) => {
        if (event?.shiftKey) {
          state.focusId = node.id;
          paintGraph({ forceCamera: false });
          flyToNode(node, { dist: 180, ms: 750 });
          return;
        }
        selectNode(node.id);
      })
      .onBackgroundClick(() => {
        closeDetail();
        state.focusId = null;
        paintGraph();
      });

    // Dense intra-type nebulae; long faint bridges between clusters
    Graph.d3Force("center")?.strength?.(0.12);
    Graph.d3Force("charge")?.strength((node) => {
      const deg = node.degree || 1;
      return -42 - Math.min(100, deg * 3.2);
    });
    Graph.d3Force("charge")?.distanceMax?.(420);
    Graph.d3Force("link")
      ?.distance((link) => {
        const s = typeof link.source === "object" ? link.source : null;
        const t = typeof link.target === "object" ? link.target : null;
        if (!s || !t) return 48;
        const same = displayType(s) === displayType(t);
        const hub = Math.max(s.degree || 1, t.degree || 1) >= 18;
        if (same) return hub ? 12 : 20;
        return 120 + Math.min(100, ((s.degree || 0) + (t.degree || 0)) * 0.8);
      })
      ?.strength((link) => {
        const s = typeof link.source === "object" ? link.source : null;
        const t = typeof link.target === "object" ? link.target : null;
        if (!s || !t) return 0.35;
        return displayType(s) === displayType(t) ? 1.15 : 0.1;
      });

    wireOrbitPan(Graph);
    tryEnableBloom(Graph);
    state.graph = Graph;
    return Graph;
  }

  /** ⌘ / ⌥ + drag pans; plain drag orbits. Right-drag also pans. */
  function wireOrbitPan(Graph) {
    try {
      const controls = Graph.controls?.();
      if (!controls) return;
      controls.enablePan = true;
      if ("screenSpacePanning" in controls) controls.screenSpacePanning = true;

      const mouse = typeof THREE !== "undefined" ? THREE.MOUSE : null;
      if (!mouse || !controls.mouseButtons) return;

      const setLeftMode = (pan) => {
        controls.mouseButtons.LEFT = pan ? mouse.PAN : mouse.ROTATE;
      };
      setLeftMode(false);

      const syncFromEvent = (e) => {
        setLeftMode(!!(e.metaKey || e.altKey));
      };

      // Capture so mode is set before OrbitControls sees the pointer.
      elStage.addEventListener("pointerdown", syncFromEvent, true);
      window.addEventListener("keydown", (e) => {
        if (e.key === "Meta" || e.key === "Alt" || e.metaKey || e.altKey) setLeftMode(true);
      });
      window.addEventListener("keyup", (e) => {
        if (e.key === "Meta" || e.key === "Alt" || (!e.metaKey && !e.altKey)) setLeftMode(false);
      });
      window.addEventListener("blur", () => setLeftMode(false));
    } catch (err) {
      console.warn("Orbit pan wiring failed:", err);
    }
  }

  function tryEnableBloom(Graph) {
    if (state.bloomReady) return;
    try {
      if (typeof THREE === "undefined" || !THREE.UnrealBloomPass) return;
      const composer = Graph.postProcessingComposer?.();
      if (!composer) return;
      // Keep bloom subtle so dense clusters stay readable
      const bloom = new THREE.UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        0.7,
        0.28,
        0.32,
      );
      composer.addPass(bloom);
      state.bloomReady = true;
    } catch (err) {
      console.warn("Bloom unavailable:", err);
    }
  }

  function paintGraph(opts = {}) {
    const { forceCamera = false } = opts;
    const filtered = filteredGraph();
    updateBridgeHint();
    updateDateHint();

    const highlight = filtered.highlight;
    const pathLinks = filtered.pathLinks;
    const pathMode = !!filtered.pathMode;
    const nodeCount = filtered.nodes.length;

    const highwayBudget =
      pathMode ? 0 : nodeCount > 1200 ? 28 : nodeCount > 600 ? 40 : 56;
    const highwayKeys = pickHighwayKeys(filtered.nodes, filtered.links, highwayBudget);
    const hubLabelIds = pickLabelIds(filtered.nodes, pathMode ? 8 : 16);
    state.labelIds = new Set([
      ...hubLabelIds,
      ...state.matchA,
      ...state.matchB,
      ...state.matchDate,
    ]);
    if (state.focusId) state.labelIds.add(state.focusId);
    if (pathMode && state.pathCore) {
      for (const id of state.pathCore) {
        const n = filtered.nodes.find((x) => x.id === id);
        if (n && (n.type === "Entity" || displayType(n) === "Organization")) {
          state.labelIds.add(id);
        }
      }
    }

    // Tiny ambient sparks (stable), separate from highways
    const sparkBudget = pathMode ? 0 : nodeCount > 800 ? 24 : 48;

    const prevById = new Map((state.nodes || []).map((n) => [n.id, n]));
    const nodes = filtered.nodes.map((n) => {
      const onPath = !!(state.pathCore?.has(n.id) || highlight?.has(n.id));
      const prev = prevById.get(n.id);
      const next = {
        ...n,
        __color: nodeVisualColor(n, highlight, pathMode),
        __path: pathMode && onPath,
        __label: state.labelIds.has(n.id),
        __valBoost: pathMode && onPath ? 2.4 : n.degree >= 20 ? 1.35 : 1,
      };
      // Keep sim positions so camera / layout don't jump to origin
      if (prev && Number.isFinite(prev.x)) {
        next.x = prev.x;
        next.y = prev.y;
        next.z = prev.z;
        if (Number.isFinite(prev.vx)) next.vx = prev.vx;
        if (Number.isFinite(prev.vy)) next.vy = prev.vy;
        if (Number.isFinite(prev.vz)) next.vz = prev.vz;
      }
      return next;
    });

    const links = filtered.links.map((l) => {
      const key = l.key || linkKey(l.source, l.target, l.predicate);
      const s = linkEndId(l.source);
      const t = linkEndId(l.target);
      const hot = !!(pathMode && state.pathCore?.has(s) && state.pathCore?.has(t));
      const highway = !hot && highwayKeys.has(key);
      const spark =
        !hot &&
        !highway &&
        sparkBudget > 0 &&
        hashStr(key) % Math.max(8, Math.floor(filtered.links.length / sparkBudget)) === 0;
      const linkObj = {
        ...l,
        key,
        __hot: hot,
        __highway: highway,
        __near: false,
        __spark: spark,
      };
      linkObj.__color = hot
        ? LINK_HOT
        : pathMode
          ? LINK_DIM
          : linkVisualColor(linkObj, pathLinks, highlight, pathMode);
      return linkObj;
    });

    state.nodes = nodes;
    state.links = links;

    const Graph = ensureGraph();
    Graph.nodeVal((n) => Math.max(0.8, Math.sqrt(n.degree || 1) * (n.__valBoost || 1)));

    // Floating cluster labels (hubs / search / path) — hover tooltip stays on nodeLabel
    Graph.nodeThreeObject((node) => {
      if (typeof THREE === "undefined") return undefined;
      if (!node.__label) return undefined;
      return makeClusterLabelSprite(formatClusterLabel(node.label));
    });
    Graph.nodeThreeObjectExtend(true);
    Graph.graphData({ nodes, links });

    setEmpty(
      nodes.length === 0,
      state.raw?.nodes?.length ? "Nothing matches filters" : "No memory graph yet",
      state.raw?.nodes?.length
        ? "Try enabling more types or clearing From/To/Date search."
        : undefined,
    );

    const cameraKey = [
      state.query.trim(),
      state.queryB.trim(),
      state.queryDate.trim(),
      state.egoId || "",
      pathMode ? "path" : "full",
      [...(state.pathCore || [])].slice(0, 8).join(","),
    ].join("|");

    const shouldFly =
      forceCamera ||
      (cameraKey !== state.cameraKey &&
        nodes.length &&
        (state.matchA.size ||
          state.matchB.size ||
          state.matchDate.size ||
          state.egoId ||
          (pathMode && state.pathCore?.size)));
    state.cameraKey = cameraKey;

    if (shouldFly) {
      const focusId =
        (state.focusId && state.pathCore?.has(state.focusId) ? state.focusId : null) ||
        [...state.matchA][0] ||
        [...state.matchB][0] ||
        [...state.matchDate][0] ||
        state.egoId ||
        [...(state.pathCore || [])][0];
      // Prefer live coords after graphData merge
      requestAnimationFrame(() => flyToNode(focusId, { dist: 260, ms: 900 }));
    } else if (!state.cameraPrimed && nodes.length) {
      state.cameraPrimed = true;
      // Wait for force layout to spread, then fit the whole cloud in view
      window.setTimeout(() => {
        if (!state.graph || state.query || state.queryB || state.queryDate || state.egoId) return;
        try {
          state.graph.zoomToFit(1400, 110);
        } catch {
          state.graph.cameraPosition({ x: 140, y: 980, z: 720 }, { x: 0, y: 0, z: 0 }, 1400);
        }
      }, 1400);
    }
  }

  function render(opts) {
    paintGraph(opts);
  }

  async function selectNode(id) {
    state.focusId = id;
    // Update highlights/labels only — do not fly the camera on click
    paintGraph({ forceCamera: false });
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
      const typeLabel = isOrganizationNode({
        type: data.index.record_type,
        schemaType: data.index.schema_type,
      })
        ? "Organization"
        : data.index.record_type;
      const color = typeColor(typeLabel === "Organization" ? "Organization" : data.index.record_type);
      const neighbors = Array.isArray(data.neighbors) ? data.neighbors : [];
      const isPerson =
        String(schema["@type"] || "").toLowerCase() === "person" ||
        String(data.index.schema_type || "").includes("Person");
      const isSelf = !!(data.revision?.alfred && data.revision.alfred.isSelf);

      const file = data.file || data.image;
      const filePreview = file?.url
        ? file.kind === "audio" || String(file.mimeType || "").startsWith("audio/")
          ? `<figure class="detail-file"><audio controls src="${escapeHtml(apiUrl(file.url))}"></audio></figure>
             <a class="detail-file-open" href="${escapeHtml(apiUrl(file.url))}" target="_blank" rel="noreferrer">Open original · ${escapeHtml(file.filename || name)}</a>`
          : file.kind === "image" || String(file.mimeType || "").startsWith("image/")
            ? `<figure class="detail-photo"><img src="${escapeHtml(apiUrl(file.url))}" alt="${escapeHtml(file.filename || name)}" /></figure>`
            : `<a class="detail-file-open" href="${escapeHtml(apiUrl(file.url))}" target="_blank" rel="noreferrer">Open original · ${escapeHtml(file.filename || name)}</a>`
        : "";

      elDetailBody.innerHTML = [
        `<div class="type-pill" style="color:${color}">${escapeHtml(typeLabel)}${
          isSelf ? " · you" : ""
        }</div>`,
        `<h2 id="detail-title">${escapeHtml(name)}</h2>`,
        filePreview,
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
          ? `<div class="contact-chip"><div>This is you — conversational facts attach here.</div></div>`
          : "",
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
            <button type="button" id="btn-ego">${
              state.egoId === id ? "Show full graph" : "Show connections"
            }</button>
            ${
              isPerson && !isSelf
                ? `<button type="button" id="btn-set-self">This is Me</button>`
                : ""
            }
            <button type="button" id="btn-save">Save changes</button>
            <button type="button" id="btn-center" class="ghost">Center</button>
            <button type="button" id="btn-delete" class="danger">Delete</button>
          </div>
          <div class="edit-status" id="edit-status"></div>
        </div>`,
        neighbors.length
          ? `<h3>Neighbors</h3>${neighbors
              .slice(0, 24)
              .map(
                (n) =>
                  `<button type="button" class="neighbor" data-id="${escapeHtml(n.id)}">${escapeHtml(
                    n.label || n.id,
                  )} <span class="meta">· ${escapeHtml(n.type || "")}</span></button>`,
              )
              .join("")}`
          : "",
      ].join("");

      elDetailBody.querySelectorAll(".neighbor").forEach((btn) => {
        btn.addEventListener("click", () => selectNode(btn.getAttribute("data-id")));
      });
      document.getElementById("btn-ego")?.addEventListener("click", () => {
        if (state.egoId === id) {
          state.egoId = null;
        } else {
          state.egoId = id;
          state.query = "";
          state.queryB = "";
          state.queryDate = "";
          elQ.value = "";
          elQ2.value = "";
          if (elQDate) elQDate.value = "";
        }
        render({ forceCamera: true });
        selectNode(id);
      });
      document.getElementById("btn-center")?.addEventListener("click", () => {
        flyToNode(id, { dist: 220, ms: 700 });
      });
      document.getElementById("btn-expand-details")?.addEventListener("click", () => {
        openDetailOverlay(name);
      });
      const editText = document.getElementById("edit-text");
      editText?.addEventListener("input", () => {
        if (elOverlay?.classList.contains("open") && elOverlayText && editText) {
          elOverlayText.value = editText.value;
        }
      });
      if (elOverlay?.classList.contains("open")) {
        syncDetailOverlay(name);
      }
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
          const setRes = await fetch(apiUrl("/memory/graph/node/set-self"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id }),
          });
          const setData = await setRes.json().catch(() => ({}));
          if (!setRes.ok) {
            throw new Error(setData.message || setData.error || `Failed (${setRes.status})`);
          }
          await load(state.types.has("Artifact"), true);
          await selectNode(setData.selfId || id);
          const st = document.getElementById("edit-status");
          if (st) {
            st.className = "edit-status ok";
            st.textContent = `You’re ${setData.selfName || label}. Migrated ${setData.migratedAssertions ?? 0} link(s).`;
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
        const ok = window.confirm(`Delete “${label}” permanently from memory?\n\nThis cannot be undone.`);
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
            throw new Error(delData.message || delData.error || `Delete failed (${delRes.status})`);
          }
          state.focusId = null;
          state.egoId = null;
          closeDetail();
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
          paintGraph();
          if (status) {
            status.className = "edit-status ok";
            status.textContent = "Saved.";
          }
          const title = document.getElementById("detail-title");
          if (title) title.textContent = nextName;
        } catch (err) {
          if (status) {
            status.className = "edit-status err";
            status.textContent = err.message || String(err);
          }
        } finally {
          if (saveBtn) saveBtn.disabled = false;
        }
      });
    } catch (err) {
      elDetailBody.innerHTML = `<p class="meta">${escapeHtml(err.message || String(err))}</p>`;
    }
  }

  function syncDetailOverlay(title) {
    const editText = document.getElementById("edit-text");
    if (elOverlayName) {
      elOverlayName.textContent =
        title || document.getElementById("detail-title")?.textContent || "";
    }
    if (elOverlayText && editText) elOverlayText.value = editText.value;
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
    if (elJobCount) elJobCount.textContent = total > 0 ? `${current} / ${total}` : "";
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
        throw new Error(data.message || data.error || `Clean failed (${res.status})`);
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
    const consumeBlock = (block) => {
      let event = "message";
      const dataLines = [];
      for (const line of block.split("\n")) {
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
    state.cameraKey = "";
    state.cameraPrimed = false;
    render({ forceCamera: false });
  }

  // Filters
  document.getElementById("filters")?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-type]");
    if (!btn) return;
    const t = btn.getAttribute("data-type");
    if (state.types.has(t)) {
      state.types.delete(t);
      btn.classList.remove("on");
    } else {
      state.types.add(t);
      btn.classList.add("on");
    }
    render();
  });

  let searchTimer = 0;
  function onSearchInput() {
    state.query = elQ.value || "";
    state.queryB = elQ2.value || "";
    state.queryDate = elQDate?.value || "";
    state.egoId = null;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => render({ forceCamera: true }), 180);
  }
  elQ?.addEventListener("input", onSearchInput);
  elQ2?.addEventListener("input", onSearchInput);
  elQDate?.addEventListener("input", onSearchInput);

  document.getElementById("btn-reload")?.addEventListener("click", () => {
    load(state.types.has("Artifact"), false).catch((err) => {
      elStats.textContent = err.message || String(err);
    });
  });
  document.getElementById("btn-rebuild")?.addEventListener("click", () => {
    load(state.types.has("Artifact"), true).catch((err) => {
      elStats.textContent = err.message || String(err);
    });
  });
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
  document.getElementById("btn-reset")?.addEventListener("click", () => {
    state.query = "";
    state.queryB = "";
    state.queryDate = "";
    state.egoId = null;
    state.focusId = null;
    state.pathCore = null;
    state.cameraKey = "";
    state.cameraPrimed = true;
    elQ.value = "";
    elQ2.value = "";
    if (elQDate) elQDate.value = "";
    closeDetail();
    render();
    window.setTimeout(() => {
      if (!state.graph) return;
      try {
        state.graph.zoomToFit(900, 110);
      } catch {
        state.graph.cameraPosition({ x: 140, y: 980, z: 720 }, { x: 0, y: 0, z: 0 }, 800);
      }
    }, 200);
  });
  document.getElementById("btn-ingest")?.addEventListener("click", () => {
    if (window.parent !== window && typeof window.alfredRequestShellNavigate === "function") {
      window.alfredRequestShellNavigate("ingest");
      return;
    }
    location.href = apiUrl("/memory/ingest");
  });
  document.getElementById("detail-close")?.addEventListener("click", () => {
    state.focusId = null;
    closeDetail();
    paintGraph();
  });
  document.getElementById("detail-overlay-close")?.addEventListener("click", closeDetailOverlay);
  document.getElementById("detail-overlay-done")?.addEventListener("click", closeDetailOverlay);
  document.getElementById("detail-overlay-save")?.addEventListener("click", () => {
    const editText = document.getElementById("edit-text");
    if (elOverlayText && editText) editText.value = elOverlayText.value;
    document.getElementById("btn-save")?.click();
  });
  elOverlayText?.addEventListener("input", () => {
    const editText = document.getElementById("edit-text");
    if (editText) editText.value = elOverlayText.value;
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

  window.addEventListener("resize", () => {
    if (state.graph) {
      state.graph.width(window.innerWidth);
      state.graph.height(window.innerHeight);
    }
  });

  load(false, false).catch((err) => {
    elStats.textContent = err.message || String(err);
    setEmpty(true, "Could not load graph", escapeHtml(err.message || String(err)));
  });
})();
