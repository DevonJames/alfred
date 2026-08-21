import { describe, expect, it } from "vitest";
import { emptyExtraction, parseExtractionJson } from "./extract.js";

describe("docs extraction JSON", () => {
  it("parses schema-shaped JSON and rejects prose", () => {
    const parsed = parseExtractionJson(`{
      "entities": [{"tempId":"e1","name":"OIP","entityClass":"Thing","quote":"OIP memory"}],
      "assertions": [{"subjectTempId":"e1","predicate":"stores","object":"revisions","quote":"append-only"}]
    }`);
    expect(parsed.entities).toHaveLength(1);
    expect(parsed.assertions).toHaveLength(1);
    expect(parseExtractionJson("sorry I cannot")).toEqual(emptyExtraction());
  });
});
