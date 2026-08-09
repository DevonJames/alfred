# Alfred Knowledge Export Prompt (JSON)

Use this prompt with ChatGPT / Claude / etc. to produce a machine-ingestible export for Alfred.

Paste the model’s **JSON only** response into a `.json` file, then upload it at `http://127.0.0.1:3000/memory/ingest` or run:

```bash
pnpm memory -- ingest-knowledge ./export.json
```

Markdown exports still work, but JSON produces much better entity / assertion linking.

---

## Prompt

```text
Alfred Knowledge Export (JSON v1)

I want you to create the most thorough, detailed, and useful export possible of everything you know about me based on our entire available conversation history, memories, saved context, project history, preferences, and any other user-specific context you have access to.

The purpose is to transfer your accumulated understanding of me into Alfred, a local AI assistant with:
1) a short always-on USER.md profile, and
2) a structured private memory graph of individual records (people, places, projects, facts, episodes, preferences, open loops).

Optimize for information preservation, accuracy, specificity, and usefulness — not brevity.
Do not invent missing information. Separate facts from inferences.

OUTPUT FORMAT (mandatory)
Return a single JSON object only. No markdown fences. No commentary before or after the JSON.
It MUST validate against this shape:

{
  "version": 1,
  "exportedAt": "YYYY-MM-DD",
  "source": "chatgpt|claude|other",
  "subjectName": "string",
  "userPatch": {
    "highPriorityPersistentContext": "string — concise always-on profile for another AI",
    "howToWorkEffectivelyWithMe": "string — operational instructions for assistants",
    "negativePreferences": "string — optional; dislikes / rejected styles / frustrations"
  },
  "entities": [
    {
      "tempId": "stable-local-id like person-amy",
      "schemaType": "https://schema.org/Person",
      "entityClass": "Person|Place|Organization|Product|Project|Thing",
      "name": "display name",
      "aliases": ["optional"],
      "summary": "one short paragraph",
      "confidence": "explicit|supported|tentative|superseded",
      "relationships": [
        { "predicate": "spouseOf|parentOf|worksAt|locatedIn|memberOf|relatedTo", "objectTempId": "other-tempId" }
      ]
    }
  ],
  "episodes": [
    {
      "tempId": "episode-…",
      "name": "short title",
      "summary": "what happened",
      "participantTempIds": ["person-…"],
      "locationTempId": "place-…",
      "involvedTempIds": ["product-…"],
      "start": "date or datetime if known",
      "end": "optional",
      "confidence": "explicit|supported|tentative|superseded"
    }
  ],
  "assertions": [
    {
      "tempId": "assertion-…",
      "subjectTempId": "entity tempId",
      "predicate": "livesIn|worksAt|prefers|owns|building|decided|uses|…",
      "objectTempId": "entity tempId if object is an entity",
      "objectText": "literal value if not an entity (e.g. filter size, price)",
      "summary": "human-readable fact sentence",
      "confidence": "explicit|supported|tentative|superseded",
      "validFrom": "optional date",
      "validUntil": "optional date or null if current",
      "topics": ["optional tags"]
    }
  ],
  "memories": [
    {
      "tempId": "memory-…",
      "kind": "fact|note|preference|project|open_loop|timeline|technical|business|creative",
      "title": "short title",
      "text": "self-contained detail (one atomic memory unit)",
      "confidence": "explicit|supported|tentative|superseded",
      "topics": ["…"],
      "relatedTempIds": ["entity or episode tempIds"],
      "validFrom": null,
      "validUntil": null,
      "staleRisk": false
    }
  ],
  "potentiallyStale": ["time-sensitive items that should be verified"],
  "knowledgeGaps": ["important unknowns / contradictions"]
}

CONTENT RULES
1. Use all available history you can access. Prefer concrete details over generalizations.
2. Put ONLY the highest-value always-on operating context into userPatch (keep it dense but not novel-length). Everything else belongs in entities / assertions / episodes / memories.
3. Make memories atomic: one discrete detail per memories[] item. Do not dump whole project chapters into a single memory.
4. Create Entity records for recurring people, places, organizations, products, and major projects. Link them with relationships and assertions.
5. Use confidence labels honestly. Never silently promote an inference to an explicit fact.
6. When information was corrected, prefer the corrected version and mark older conflicting items superseded or put them in potentiallyStale.
7. Preserve model numbers, prices, dates, domains, job titles, hardware specs, collaborator names, and rejected alternatives.
8. Do not include highly sensitive medical details in a general-purpose export.
9. tempId values must be stable within this document and used consistently for linking.
10. If you lack information for a field, omit it or use an empty array — do not fabricate.

QUALITY BAR
I would rather receive a very large JSON document with many small linked memories than a short summary that loses useful context.
```

---

## Minimal example

```json
{
  "version": 1,
  "exportedAt": "2026-08-09",
  "source": "chatgpt",
  "subjectName": "Devon James",
  "userPatch": {
    "highPriorityPersistentContext": "Devon James (casual: Devon). Lives in San Luis Obispo, CA. Wife Amy; son Matty. Building Alfred and robotics/AI products. Marine Corps background. Prefers competence; dislikes sycophancy.",
    "howToWorkEffectivelyWithMe": "Be direct and specific. Prefer one low-risk diagnostic step at a time. Separate facts, assumptions, and recommendations. Do not flatten him into a generic tech bio.",
    "negativePreferences": "Dislikes sycophancy, vague summaries, and invented details."
  },
  "entities": [
    {
      "tempId": "person-devon",
      "schemaType": "https://schema.org/Person",
      "entityClass": "Person",
      "name": "Devon James",
      "aliases": ["Devon", "Mr James"],
      "summary": "Primary user",
      "confidence": "explicit",
      "relationships": [
        { "predicate": "spouseOf", "objectTempId": "person-amy" }
      ]
    },
    {
      "tempId": "person-amy",
      "schemaType": "https://schema.org/Person",
      "entityClass": "Person",
      "name": "Amy",
      "aliases": ["Amy James"],
      "summary": "Devon's wife",
      "confidence": "explicit",
      "relationships": []
    },
    {
      "tempId": "place-slo",
      "schemaType": "https://schema.org/Place",
      "entityClass": "Place",
      "name": "San Luis Obispo",
      "aliases": ["SLO"],
      "summary": "Family home base in California",
      "confidence": "explicit",
      "relationships": []
    }
  ],
  "episodes": [],
  "assertions": [
    {
      "tempId": "assertion-lives-slo",
      "subjectTempId": "person-devon",
      "predicate": "livesIn",
      "objectTempId": "place-slo",
      "summary": "Devon lives in San Luis Obispo, California",
      "confidence": "explicit",
      "topics": ["location", "family"]
    }
  ],
  "memories": [
    {
      "tempId": "memory-matty",
      "kind": "fact",
      "title": "Son Matty",
      "text": "Devon and Amy's son is Matty (Matthew), born February 12, 2023.",
      "confidence": "explicit",
      "topics": ["family"],
      "relatedTempIds": ["person-devon", "person-amy"],
      "staleRisk": false
    }
  ],
  "potentiallyStale": [],
  "knowledgeGaps": []
}
```
