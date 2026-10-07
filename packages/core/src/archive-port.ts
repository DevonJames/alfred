import type { ArchivePort } from "./ports.js";

interface ArchiveBody {
  handled?: boolean;
  speech?: string;
}

export function createHttpArchivePort(baseUrl: string): ArchivePort {
  const root = baseUrl.replace(/\/$/, "");
  const post = async (path: string, body: Record<string, unknown>): Promise<ArchiveBody> => {
    const response = await fetch(`${root}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Archive ${path} failed (${response.status})`);
    return (await response.json()) as ArchiveBody;
  };
  return {
    async search(query: string) {
      const body = await post("/api/archive/search", { query });
      return body.speech?.trim() || "Nothing in the Alexandria archive matched that.";
    },
    async openRecord(did: string) {
      const body = await post("/api/archive/record", { did });
      return body.speech?.trim() || "I could not open that record.";
    },
    async neighbors(did: string) {
      const body = await post("/api/archive/neighbors", { did });
      return body.speech?.trim() || "That record has no connections yet.";
    },
    async ask(question: string) {
      const body = await post("/api/archive/ask", { question });
      if (body.handled === false) return "";
      return body.speech?.trim() || "";
    },
  };
}
