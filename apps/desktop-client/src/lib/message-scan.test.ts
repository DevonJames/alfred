import { describe, expect, it } from "vitest";
import {
  appleDateCutoff,
  appleDateScale,
  appleSeconds,
  chatIsGroup,
  commitmentPrompt,
  isoFromAppleSeconds,
  looksLikeCommitment,
  looksLikeFollowUp,
  looksLikeObligation,
  looksLikeRequest,
  looksLikeSolicitation,
  messageLookbackDays,
  messagePlainText,
  normalizeDueYear,
  parseCommitmentReply,
  shouldDraftMessage,
  textFromAttributedBody,
  type IncomingMessage,
} from "./message-scan.js";

describe("looksLikeCommitment", () => {
  it("catches an explicit promise and skips a maybe", () => {
    expect(looksLikeCommitment("Ok I'll take care of that on Monday")).toBe(true);
    expect(looksLikeCommitment("Maybe I'll look at it later")).toBe(false);
    expect(looksLikeCommitment("Sounds good")).toBe(false);
    const bill =
      "I need to call the utility about the letter dated Sept 14 that says the closing bill is due and will be referred for collections if not paid within 25 days.";
    expect(looksLikeObligation(bill)).toBe(true);
    expect(looksLikeCommitment(bill)).toBe(true);
    expect(shouldDraftMessage({ fromMe: true, text: bill })).toBe(true);
    expect(shouldDraftMessage({ fromMe: false, selfNote: true, text: "i need to add unity spark to the rockhoppers prd" })).toBe(
      true,
    );
    expect(shouldDraftMessage({ fromMe: false, text: "i need to add unity spark to the rockhoppers prd" })).toBe(false);
    expect(looksLikeCommitment("I have to pay that invoice by Friday")).toBe(true);
    expect(looksLikeCommitment("Maybe I need to call them tomorrow")).toBe(false);
  });
});

describe("looksLikeFollowUp", () => {
  it("catches a dated ask and skips a request with no deadline", () => {
    const mailbox =
      "Please keep an eye on the mailbox in the later half of next week. A letter is coming that I need, and it expires after a few weeks.";
    expect(looksLikeFollowUp(mailbox)).toBe(true);
    expect(shouldDraftMessage({ fromMe: true, text: mailbox })).toBe(true);
    expect(looksLikeFollowUp("Can you send the form by Friday?")).toBe(true);
    expect(looksLikeFollowUp("Please grab milk")).toBe(false);
    expect(looksLikeFollowUp("See you next week")).toBe(false);
    expect(looksLikeFollowUp("Maybe you could look next week")).toBe(false);
  });
});

describe("normalizeDueYear", () => {
  it("uses the current year when the message never writes one", () => {
    expect(normalizeDueYear("2024-10-15", "Please sign the form by October 15", 2026)).toBe("2026-10-15");
    expect(normalizeDueYear("2026-10-15", "Please sign the form by October 15", 2026)).toBe("2026-10-15");
    expect(normalizeDueYear("2025-04-15", "Your 2025 return is due April 15", 2026)).toBe("2026-04-15");
    expect(normalizeDueYear("2025-04-15", "File it by April 15, 2025", 2026)).toBe("2025-04-15");
    expect(normalizeDueYear("2020-03-01", "Check back next year", 2026)).toBe("2027-03-01");
    expect(normalizeDueYear(null, "no date", 2026)).toBeNull();
  });
});

describe("parseCommitmentReply", () => {
  it("keeps a dated title and drops a non-commitment", () => {
    expect(parseCommitmentReply('{"commit":true,"title":"Send the form","due":"2026-10-06"}')).toEqual({
      title: "Send the form",
      due: "2026-10-06",
    });
    expect(parseCommitmentReply('{"commit":false,"title":"Nope"}')).toBeNull();
  });
});

describe("message lookback", () => {
  it("treats unset and zero as no history", () => {
    expect(messageLookbackDays(undefined)).toBe(0);
    expect(messageLookbackDays("")).toBe(0);
    expect(messageLookbackDays("0")).toBe(0);
    expect(messageLookbackDays("14")).toBe(14);
    expect(messageLookbackDays("14.9")).toBe(14);
  });

  it("builds an Apple date cutoff in the stored unit", () => {
    const now = Date.UTC(2026, 9, 5, 14, 0, 0);
    expect(appleDateScale(8e8)).toBe("seconds");
    expect(appleDateScale(8e17)).toBe("nanoseconds");
    expect(appleDateCutoff(now, "seconds")).toBe(Math.floor((now - Date.UTC(2001, 0, 1)) / 1000));
    expect(appleDateCutoff(now, "nanoseconds")).toBe(Math.floor(((now - Date.UTC(2001, 0, 1)) / 1000) * 1e9));
    const seconds = appleSeconds(now);
    expect(seconds).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(seconds).toBe(Math.floor((now - Date.UTC(2001, 0, 1)) / 1000));
    expect(isoFromAppleSeconds(seconds)).toBe(new Date(now).toISOString());
  });
});

describe("attributed bodies", () => {
  function archive(text: string): Buffer {
    const bytes = Buffer.from(text, "utf8");
    const marker = Buffer.from([0x84, 0x01, 0x2b]);
    if (bytes.length < 128) return Buffer.concat([marker, Buffer.from([bytes.length]), bytes]);
    const length = Buffer.alloc(3);
    length[0] = 0x81;
    length.writeUInt16LE(bytes.length, 1);
    return Buffer.concat([marker, length, bytes]);
  }

  it("reads a short archived string and a longer one", () => {
    expect(textFromAttributedBody(archive("I'll call the IRS"))).toBe("I'll call the IRS");
    const long = `I'll take care of that. ${"tax ".repeat(40)}bill`;
    expect(textFromAttributedBody(archive(long))).toBe(long);
    expect(textFromAttributedBody(Buffer.from("nope"))).toBeNull();
  });

  it("keeps a plain text column ahead of the archive", () => {
    expect(messagePlainText("I'll call", archive("other"))).toBe("I'll call");
    expect(messagePlainText("", archive("I'll call the IRS"))).toBe("I'll call the IRS");
  });
});

describe("incoming requests", () => {
  const tax =
    "We are still waiting on your signed e-file authorization. Please log in to the client portal and complete the forms. To stop these notices, reply NONOTIFY.";
  const clinic =
    "We can help schedule your first appointment. Please reply with your email and preferred day and time.";
  const campaign = "Vote yes on Prop 45. Paid for by Example Fund. STOP to opt-out.";
  const pac = "It's Tyler from Example PAC. 1 chaser = 300 ballots banked. Reply STOP to Opt-Out.";

  it("keeps account work and appointment requests", () => {
    expect(looksLikeRequest(tax)).toBe(true);
    expect(looksLikeSolicitation(tax)).toBe(false);
    expect(shouldDraftMessage({ fromMe: false, text: tax })).toBe(true);
    expect(looksLikeRequest(clinic)).toBe(true);
    expect(looksLikeSolicitation(clinic)).toBe(false);
    expect(looksLikeRequest("Your package was delivered")).toBe(false);
    expect(looksLikeRequest("Your security code is 441190")).toBe(false);
  });

  it("drops political and opt-out blasts", () => {
    expect(looksLikeSolicitation(campaign)).toBe(true);
    expect(shouldDraftMessage({ fromMe: false, text: campaign })).toBe(false);
    expect(looksLikeSolicitation(pac)).toBe(true);
    expect(shouldDraftMessage({ fromMe: false, text: pac })).toBe(false);
    expect(looksLikeSolicitation("Please stop by the office and sign the form")).toBe(false);
  });

  it("tells the model an incoming message is not the user's promise", () => {
    const prompt = commitmentPrompt({
      id: 2,
      text: clinic,
      fromMe: false,
      handle: "+15551212",
      priorText: null,
      priorFromMe: false,
      priorHandle: null,
      isGroup: false,
      chatName: null,
      participantCount: 1,
      sentAt: null,
    });
    expect(prompt).toContain("direct message from +15551212");
    expect(prompt).toContain("Message sent to the user");
    expect(prompt).not.toContain("\nUser:\n");
  });
});

describe("group conversations", () => {
  it("treats style 43 and multi-person chats as groups", () => {
    expect(chatIsGroup(43, 1)).toBe(true);
    expect(chatIsGroup(45, 1)).toBe(false);
    expect(chatIsGroup(45, 4)).toBe(true);
  });

  it("tells the model a promise in a group is to the group", () => {
    const message: IncomingMessage = {
      id: 1,
      text: "Ok I'll take care of that on Monday",
      fromMe: true,
      handle: null,
      priorText: "Can someone book the van?",
      priorFromMe: false,
      priorHandle: "+15551212",
      isGroup: true,
      chatName: "Cabin",
      participantCount: 4,
      sentAt: null,
    };
    const prompt = commitmentPrompt(message);
    expect(prompt).toContain('group conversation named "Cabin"');
    expect(prompt).toContain("not a private chat");
    expect(prompt).toContain("Earlier message from +15551212");
    expect(prompt).not.toContain("direct conversation");
  });

  it("tells the model a note to yourself is the user's own task", () => {
    const message: IncomingMessage = {
      id: 2,
      text: "i need to add unity spark to the rockhoppers prd",
      fromMe: true,
      selfNote: true,
      handle: null,
      priorText: null,
      priorFromMe: false,
      priorHandle: null,
      isGroup: false,
      chatName: null,
      participantCount: 1,
      sentAt: null,
    };
    expect(commitmentPrompt(message)).toContain("sent to themself");
    expect(commitmentPrompt(message)).toContain("i need to add unity spark");
  });
});
