import { describe, expect, it } from "vitest";
import {
  connectingSubgraph,
  filterGraph,
  matchNodeIds,
  nodePassesTypeFilter,
  projectEntityLinks,
  type GraphLink,
  type GraphNode,
} from "./memory-graph-sim";

function node(
  id: string,
  label: string,
  type = "Entity",
  schemaType: string | null = null,
): GraphNode {
  return {
    id,
    label,
    type,
    schemaType,
    searchText: label,
    degree: 0,
    updatedAt: null,
  };
}

describe("connectingSubgraph", () => {
  it("finds a shortest path between two endpoints", () => {
    const links: GraphLink[] = [
      { source: "devon", target: "assert1", predicate: "subject" },
      { source: "assert1", target: "uspto", predicate: "object" },
      { source: "devon", target: "noise", predicate: "relatedTo" },
    ];
    const got = connectingSubgraph(
      links,
      new Set(["devon"]),
      new Set(["uspto"]),
    );
    expect(got.hops).toBe(2);
    expect([...got.nodeIds].sort()).toEqual(["assert1", "devon", "uspto"]);
    expect(got.linkKeys.size).toBe(2);
  });

  it("returns endpoints with null hops when disconnected", () => {
    const links: GraphLink[] = [
      { source: "a", target: "b", predicate: "relatedTo" },
    ];
    const got = connectingSubgraph(links, new Set(["a"]), new Set(["z"]));
    expect(got.hops).toBeNull();
    expect(got.nodeIds.has("a")).toBe(true);
    expect(got.nodeIds.has("z")).toBe(true);
  });
});

describe("projectEntityLinks", () => {
  it("collapses assertion hubs into entity edges", () => {
    const nodes = [
      node("devon", "Devon James"),
      node("uspto", "USPTO"),
      node("assert1", "Devon James worksAt", "Assertion"),
    ];
    const links: GraphLink[] = [
      { source: "assert1", target: "devon", predicate: "subject" },
      { source: "assert1", target: "uspto", predicate: "object" },
    ];
    const got = projectEntityLinks(nodes, links);
    expect(got).toEqual([
      {
        source: "devon",
        target: "uspto",
        predicate: "worksAt",
        viaAssertion: "assert1",
      },
    ]);
  });
});

describe("nodePassesTypeFilter", () => {
  it("Organization filter shows only org entities", () => {
    const org = node("o", "USPTO", "Entity", "https://schema.org/Organization");
    const person = node("p", "James", "Entity", "https://schema.org/Person");
    const types = new Set(["Organization"]);
    expect(nodePassesTypeFilter(org, types)).toBe(true);
    expect(nodePassesTypeFilter(person, types)).toBe(false);
  });

  it("Entity alone still includes organizations", () => {
    const org = node("o", "USPTO", "Entity", "https://schema.org/Organization");
    expect(nodePassesTypeFilter(org, new Set(["Entity"]))).toBe(true);
  });

  it("Entity + Organization narrows to orgs only", () => {
    const org = node("o", "USPTO", "Entity", "https://schema.org/Organization");
    const person = node("p", "James", "Entity", "https://schema.org/Person");
    const types = new Set(["Entity", "Organization"]);
    expect(nodePassesTypeFilter(org, types)).toBe(true);
    expect(nodePassesTypeFilter(person, types)).toBe(false);
  });
});

describe("matchNodeIds", () => {
  it("prefers exact Organization USPTO over Collection", () => {
    const nodes = [
      node("col", "USPTO", "Entity", "https://schema.org/Collection"),
      node("org", "USPTO", "Entity", "https://schema.org/Organization"),
      node("long", "United States Patent and Trademark Office"),
    ];
    const ids = matchNodeIds(nodes, "uspto");
    expect([...ids]).toEqual(["org"]);
  });

  it("does not match Devon James when searching nosal", () => {
    const nodes = [
      node("devon", "Devon James"),
      node("james", "James Nosal"),
      node("a", "Devon James worksAt", "Assertion"),
      node("b", "James Nosal worksAt", "Assertion"),
    ];
    const ids = matchNodeIds(nodes, "nosal");
    expect([...ids]).toEqual(["james"]);
  });
});

describe("filterGraph dual query", () => {
  it("bridges devon ↔ uspto as one semantic hop without hub fan-out", () => {
    const nodes = [
      node("devon", "Devon James"),
      node("uspto", "USPTO", "Entity", "https://schema.org/Organization"),
      node("assert1", "Devon James worksAt", "Assertion"),
      node("other", "James Nosal"),
      node("super", "James Nosal supervisorOf", "Assertion"),
    ];
    const links: GraphLink[] = [
      { source: "assert1", target: "devon", predicate: "subject" },
      { source: "assert1", target: "uspto", predicate: "object" },
      { source: "super", target: "other", predicate: "subject" },
      { source: "super", target: "devon", predicate: "object" },
    ];
    const got = filterGraph(nodes, links, {
      types: new Set(["Entity", "Assertion"]),
      query: "devon",
      queryB: "uspto",
    });
    expect(got.bridge?.connected).toBe(true);
    expect(got.bridge?.hops).toBe(1);
    // Path only — do not pull James via Devon's other assertions
    expect(got.nodes.map((n) => n.id).sort()).toEqual([
      "assert1",
      "devon",
      "uspto",
    ]);
  });

  it("bridges uspto ↔ nosal directly without centering Devon James", () => {
    const nodes = [
      node("devon", "Devon James"),
      node("uspto", "USPTO", "Entity", "https://schema.org/Organization"),
      node("james", "James Nosal"),
      node("userWork", "Devon James worksAt", "Assertion"),
      node("jamesWork", "James Nosal worksAt", "Assertion"),
      node("super", "James Nosal supervisorOf", "Assertion"),
    ];
    const links: GraphLink[] = [
      { source: "userWork", target: "devon", predicate: "subject" },
      { source: "userWork", target: "uspto", predicate: "object" },
      { source: "jamesWork", target: "james", predicate: "subject" },
      { source: "jamesWork", target: "uspto", predicate: "object" },
      { source: "super", target: "james", predicate: "subject" },
      { source: "super", target: "devon", predicate: "object" },
    ];
    const got = filterGraph(nodes, links, {
      types: new Set(["Entity", "Assertion"]),
      query: "uspto",
      queryB: "nosal",
    });
    expect(got.bridge?.connected).toBe(true);
    expect(got.bridge?.hops).toBe(1);
    expect(got.nodes.some((n) => n.id === "devon")).toBe(false);
    expect(got.nodes.map((n) => n.id).sort()).toEqual([
      "james",
      "jamesWork",
      "uspto",
    ]);
  });

  it("does not collapse devon↔james when searchText mentions both", () => {
    const nodes = [
      node("devon", "Devon James"),
      {
        ...node("james", "James Nosal"),
        searchText: "James Nosal User's boss Devon James reportsTo",
      },
      node("reports", "Devon James reportsTo", "Assertion"),
      node("super", "James Nosal supervisorOf", "Assertion"),
    ];
    const links: GraphLink[] = [
      { source: "reports", target: "devon", predicate: "subject" },
      { source: "reports", target: "james", predicate: "object" },
      { source: "super", target: "james", predicate: "subject" },
      { source: "super", target: "devon", predicate: "object" },
    ];
    const got = filterGraph(nodes, links, {
      types: new Set(["Entity", "Assertion"]),
      query: "devon",
      queryB: "james nosal",
    });
    expect(got.bridge?.connected).toBe(true);
    expect(got.bridge?.hops).toBe(1);
    expect(got.nodes.some((n) => n.id === "devon")).toBe(true);
    expect(got.nodes.some((n) => n.id === "james")).toBe(true);
  });
});
