import { describe, expect, it } from "vitest";
import { cleanupUserMd } from "./cleanup-user-md.js";
import { USER_MD_MAX_CHARS } from "./persona.js";

const BLOATED = `# USER.md - About Your Human(s)

## Devon James

- **Name:** Devon James
- **What to call him:** Devon (casual) or Mr James (formal settings)
- **Pronouns:** he/him
- **Timezone:** America/Los_Angeles (PST/PDT)
- **Role:** Software developer, solopreneur
- **Business:** JF Customs — James Family Custom Computer Workstations and other Thinking Machines
- **Telegram:** @DevonOfAlexandria
- **Notes:** Marine Corps background. Appreciates competence above all.

## Amy James

- **Name:** Amy James
- **What to call her:** Amy (casual) or Mrs James (formal settings)
- **Pronouns:** she/her
- **Notes:** Devon's wife.

## Family

- **Son:** Matty (firstborn) — Born February 12, 2023
- **Amy's parents:** Mike and Carol — involved grandparents

---

Context will grow over time. Private things stay private.

<!-- alfred:ingest-export:start -->

## High-Priority Persistent Context

**Identity and family:** Devon James / Mr James; based in San Luis Obispo; wife Amy; young son Matty/Matthew. In September 2026 Devon expects to begin a roughly two-year federal assignment in Alexandria, Virginia while his family remains in California.

**Career:** Marine infantry Sergeant and Iraq invasion veteran; founder of Happy Owl Studio; Blockchain Technology Group founder/CEO; Alexandria Labs CTO; Web3 Working Group Co-Executive Director/Technology Director **2022–2024**; JF Custom Computer Workstations 2024–2026.

**Federal job:** USPTO role; OPM is hiring agency, not employer/position. GS-14 Step 8. First workday September 8, 2026.

**Alfred:** Agentic Linguistic Framework for Reasoning, Execution and Delegation. Fast conversational latency is critical.

**Corrections that must persist:** Web3WG ended in 2024; OPM is hiring agency for USPTO position; do not alter Alfred body structure when only color/material edits were requested.

## How to Work Effectively With Me

This section is intentionally operational.

<!-- alfred:ingest-export:end -->

<!-- alfred:ingest-export:openclaw:start -->

## High-Priority Persistent Context

Family: Wife Amy James. Son Matty (born Feb 12, 2023). Amy's parents Mike and Carol.

Primary projects:

1. Alfred:Home — AI home automation platform. Backend: Bun+Hono, SQLite. Ports: 3000/5173/3001. Repo: /Users/devon/Documents/development/alfred-home/. NEVER change ports manually — use stop-all.sh/start-all.sh.
2. Alfred Robot v1 — Raspberry Pi 5 desktop companion. SSH: alfred@100.115.52.14 (password: HHR8NZHA). PCA9685 servo driver at I2C 0x40.

Robot pricing: Base $1,199/$849 kit. Kickstarter target $50k.

Model providers: Venice, AkashML, Local Gemma, OpenAI, Anthropic.

Critical rules:

• Be direct, no sycophancy, competence above all
• Write everything to files — mental notes don't persist
• Never discard uncommitted git changes
• Use trash not rm

## How to Work Effectively With Me

• Be direct. No "Great question!" or "I'd be happy to help!"
• Be concise in chat. Devon types in short, lowercase bursts.
• When Devon corrects something, it's authoritative — update all records

## Negative Preferences

| Dislikes | Prefers Instead |
| --- | --- |
| Sycophancy | Just help. Actions over filler. |
| Verbose responses when brief was requested | Progressive refinement |

[8/6/26 10:00 PM] Alfred: | May 15, 2026 (01:50) | Wave choreography finalized (lift, wave, tuck); PCA9685 board arrived; board confirmed fried

<!-- alfred:ingest-export:openclaw:end -->
`;

describe("cleanupUserMd", () => {
  it("compresses bloated USER.md under inject budget and drops junk/credentials", () => {
    const result = cleanupUserMd(BLOATED, { targetChars: 6_000, maxChars: 10_000 });

    expect(result.afterChars).toBeLessThan(result.beforeChars);
    expect(result.afterChars).toBeLessThanOrEqual(USER_MD_MAX_CHARS);
    expect(result.text).toContain("Devon James");
    expect(result.text).toContain("How to work with Devon");
    expect(result.text).toContain("Persistent context");
    expect(result.text).not.toMatch(/password\s*[:=]\s*HHR8NZHA/i);
    expect(result.text).not.toMatch(/Wave choreography finalized/i);
    expect(result.text).not.toMatch(/\[\d+\/\d+\/\d+.*?\]\s*Alfred:/i);
    expect(result.droppedJunk).toBeGreaterThan(0);
  });

  it("keeps project headlines and parks deep hardware detail in overflow", () => {
    const result = cleanupUserMd(BLOATED);
    const joined = result.overflowNotes.map((n) => n.content).join("\n");
    expect(result.text).not.toMatch(/HHR8NZHA/);
    expect(result.text).toMatch(/Alfred:Home|Alfred Robot/i);
    expect(
      joined.length === 0 ||
        /I2C|Kickstarter|PCA9685|port|\$|servo|hardware/i.test(joined),
    ).toBe(true);
  });
});
