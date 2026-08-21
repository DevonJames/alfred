/** Prefer schema.org types; Alfred custom types only when needed. */

export const SCHEMA_ORG = {
  Person: "https://schema.org/Person",
  Place: "https://schema.org/Place",
  Product: "https://schema.org/Product",
  Organization: "https://schema.org/Organization",
  Event: "https://schema.org/Event",
  CreativeWork: "https://schema.org/CreativeWork",
  SocialMediaPosting: "https://schema.org/SocialMediaPosting",
  Article: "https://schema.org/Article",
  VideoObject: "https://schema.org/VideoObject",
  Collection: "https://schema.org/Collection",
  DigitalDocument: "https://schema.org/DigitalDocument",
  Thing: "https://schema.org/Thing",
} as const;

export type SchemaOrgType = (typeof SCHEMA_ORG)[keyof typeof SCHEMA_ORG];

export function schemaOrgPerson(name: string, aliases: string[] = []): Record<string, unknown> {
  return {
    "@type": "Person",
    name,
    ...(aliases.length ? { alternateName: aliases } : {}),
  };
}

export function schemaOrgPlace(name: string): Record<string, unknown> {
  return { "@type": "Place", name };
}

export function schemaOrgProduct(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { "@type": "Product", name, ...extra };
}

export function schemaOrgEvent(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { "@type": "Event", name, ...extra };
}

/** Extract a human-readable label from schema / record fields. */
export function displayLabel(record: {
  name?: string;
  text?: string;
  schema?: Record<string, unknown>;
  predicate?: string;
  object?: unknown;
}): string {
  if (record.name) return record.name;
  if (typeof record.schema?.name === "string") return record.schema.name;
  if (record.text) return record.text;
  if (record.predicate && record.object != null) {
    return `${record.predicate} ${String(record.object)}`;
  }
  return "";
}
