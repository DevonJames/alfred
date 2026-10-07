import { describe, expect, it } from "vitest";
import { contactKey, contactPersonName } from "./contact-names.js";

describe("contact keys", () => {
  it("matches a Messages number to a Contacts number", () => {
    expect(contactKey("+1 (555) 123-4567")).toBe("5551234567");
    expect(contactKey("5551234567")).toBe("5551234567");
    expect(contactKey("+15551234567")).toBe("5551234567");
  });

  it("matches email addresses without caring about case", () => {
    expect(contactKey("Ada@Example.com")).toBe("ada@example.com");
  });
});

describe("contact names", () => {
  it("uses the person's name, then the organization", () => {
    expect(contactPersonName("Ada", "Lovelace", "Analytical", null)).toBe("Ada Lovelace");
    expect(contactPersonName(null, null, "Analytical Engines", "Ada")).toBe("Analytical Engines");
    expect(contactPersonName("", "", "", "Ada")).toBe("Ada");
  });
});
