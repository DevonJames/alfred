/**
 * Synthetic employee-observation demos for Vector Explorer.
 * Category / timestamp metadata is ground truth for evaluation only —
 * never fed into the embedding model or the projection.
 */

export interface DemoObservation {
  id: string;
  text: string;
  /** Ground-truth label for reveal / metrics only. */
  category: string;
  /** ISO date for emerging-cluster demo; optional. */
  timestamp?: string;
}

export interface DemoDataset {
  id: string;
  title: string;
  description: string;
  observations: DemoObservation[];
}

/** ~37 observations: 3 operational issues + outliers. */
export const CLUSTER_DEMO: DemoDataset = {
  id: "cluster-ops",
  title: "Cluster demo (ops issues)",
  description:
    "~37 employee notes on three recurring operational problems plus a few unusual reports. " +
    "Categories are hidden until you reveal them — they are not used to build the map.",
  observations: [
    // --- Issue A: badge / door access failures (~12) ---
    {
      id: "a01",
      category: "badge_access",
      text: "Couldn't get into Building C this morning — my badge just blinked red at every reader I tried.",
    },
    {
      id: "a02",
      category: "badge_access",
      text: "Security desk had to print me a temp pass again. Lobby turnstiles keep rejecting my card since Monday.",
    },
    {
      id: "a03",
      category: "badge_access",
      text: "The second-floor lab door won't unlock for anyone on our team even though access was approved last week.",
    },
    {
      id: "a04",
      category: "badge_access",
      text: "Badge works fine at the garage but fails on the office floors. Standing in the hallway waiting for someone to let me in.",
    },
    {
      id: "a05",
      category: "badge_access",
      text: "Visitor escort process fell apart because employee badges aren't opening the suite door reliably.",
    },
    {
      id: "a06",
      category: "badge_access",
      text: "After the overnight access-system update, half our group is locked out of the shared project room.",
    },
    {
      id: "a07",
      category: "badge_access",
      text: "I badge in, hear a click, then nothing — door stays locked. Happened three times before stand-up.",
    },
    {
      id: "a08",
      category: "badge_access",
      text: "Facilities says my credentials look active in the portal, but physical readers still deny entry.",
    },
    {
      id: "a09",
      category: "badge_access",
      text: "New contractor badges were provisioned incorrectly; they're stuck outside until IT reissues them.",
    },
    {
      id: "a10",
      category: "badge_access",
      text: "Elevator badge reader on the east bank is offline, so people are crowding the west elevators.",
    },
    {
      id: "a11",
      category: "badge_access",
      text: "Weekend shift couldn't open the loading dock with their usual cards — production got delayed.",
    },
    {
      id: "a12",
      category: "badge_access",
      text: "My phone wallet pass disappeared from the reader whitelist after I reset the phone; door access is dead.",
    },

    // --- Issue B: VPN / remote login failures (~12) ---
    {
      id: "b01",
      category: "vpn_remote",
      text: "VPN connects for about thirty seconds then drops. Can't stay on long enough to open the ticket system.",
    },
    {
      id: "b02",
      category: "vpn_remote",
      text: "Remote desktop auth keeps looping back to the login screen when I'm offsite.",
    },
    {
      id: "b03",
      category: "vpn_remote",
      text: "Split tunnel seems broken — once on VPN I lose access to local printers and our cloud drive.",
    },
    {
      id: "b04",
      category: "vpn_remote",
      text: "Duo push never arrives when dialing in from home. Stuck at MFA with no fallback that works.",
    },
    {
      id: "b05",
      category: "vpn_remote",
      text: "Got connected overnight but every internal URL times out. Feels like DNS inside the tunnel is wrong.",
    },
    {
      id: "b06",
      category: "vpn_remote",
      text: "Laptop shows 'secure gateway unreachable' whenever I'm on hotel Wi-Fi. Same network works for email.",
    },
    {
      id: "b07",
      category: "vpn_remote",
      text: "After the client update, the VPN icon sits spinning and never reaches a connected state.",
    },
    {
      id: "b08",
      category: "vpn_remote",
      text: "Can join Zoom fine, but any attempt to hit the intranet over VPN fails with certificate warnings.",
    },
    {
      id: "b09",
      category: "vpn_remote",
      text: "Password reset went through, yet remote access still rejects me as unauthorized.",
    },
    {
      id: "b10",
      category: "vpn_remote",
      text: "Working from the airport lounge: tunnel establishes, then kills every SSH session within a minute.",
    },
    {
      id: "b11",
      category: "vpn_remote",
      text: "Help desk walked me through reinstalling the VPN profile twice. Still can't reach file shares remotely.",
    },
    {
      id: "b12",
      category: "vpn_remote",
      text: "On cellular hotspot the VPN handshake never completes; on home fiber it sometimes does.",
    },

    // --- Issue C: expense / reimbursement friction (~8) ---
    {
      id: "c01",
      category: "expense_reimburse",
      text: "Submitted travel receipts two weeks ago and the report is still sitting in 'manager review' with no ping.",
    },
    {
      id: "c02",
      category: "expense_reimburse",
      text: "Card charges posted, but the expense tool won't OCR the hotel folio — keep getting validation errors.",
    },
    {
      id: "c03",
      category: "expense_reimburse",
      text: "Policy says meals under $75 don't need itemization, yet the form rejects anything without line items.",
    },
    {
      id: "c04",
      category: "expense_reimburse",
      text: "Reimbursement for the client dinner came back short; mileage rate in the portal looks outdated.",
    },
    {
      id: "c05",
      category: "expense_reimburse",
      text: "Can't attach PDFs larger than a few MB, so the conference invoice won't upload at all.",
    },
    {
      id: "c06",
      category: "expense_reimburse",
      text: "Finance bounced my report because the cost center code changed and the dropdown still shows the old one.",
    },
    {
      id: "c07",
      category: "expense_reimburse",
      text: "Out-of-pocket Uber rides from last month still aren't reimbursed despite three follow-ups.",
    },
    {
      id: "c08",
      category: "expense_reimburse",
      text: "The mobile expense app crashes whenever I try to photograph a receipt in landscape mode.",
    },

    // --- Outliers (~5) ---
    {
      id: "o01",
      category: "outlier",
      text: "Someone left a live python in the third-floor supply closet. Facilities has been notified; please avoid that hallway.",
    },
    {
      id: "o02",
      category: "outlier",
      text: "The lobby espresso machine started playing Morse code this afternoon. Not urgent, just extremely weird.",
    },
    {
      id: "o03",
      category: "outlier",
      text: "I think my standing desk is slowly migrating toward the window overnight. Measured it — six inches this week.",
    },
    {
      id: "o04",
      category: "outlier",
      text: "Customer mailed us a handwritten thank-you note wrapped around a USB drive labeled 'do not plug in.' Quarantined.",
    },
    {
      id: "o05",
      category: "outlier",
      text: "Parking structure Level B2 smells strongly of popcorn every Tuesday at 3pm. No events scheduled down there.",
    },
  ],
};

/** Emerging cluster: one issue grows over 8 weeks. */
export const EMERGING_DEMO: DemoDataset = {
  id: "emerging-cluster",
  title: "Emerging cluster (over time)",
  description:
    "Observations across eight weeks. A 'meeting-room A/V failure' theme becomes more common. " +
    "Use the time slider — categories stay hidden until revealed.",
  observations: [
    // Early weeks: sparse A/V + other noise
    {
      id: "e01",
      category: "av_rooms",
      timestamp: "2026-01-06",
      text: "Conference Room 4B had no audio on the far-end call; we switched rooms mid-meeting.",
    },
    {
      id: "e02",
      category: "other",
      timestamp: "2026-01-08",
      text: "Kitchen dishwasher flooded again; facilities mopped and put up a wet-floor sign.",
    },
    {
      id: "e03",
      category: "other",
      timestamp: "2026-01-14",
      text: "Printer on 2 east is out of toner and the replacement drawer is empty.",
    },
    {
      id: "e04",
      category: "av_rooms",
      timestamp: "2026-01-21",
      text: "HDMI laptop link in Hudson flickered the whole QBR — had to present from the room PC.",
    },
    {
      id: "e05",
      category: "other",
      timestamp: "2026-01-28",
      text: "Bike cage lock is sticky; took five minutes to get my bike out after work.",
    },
    {
      id: "e06",
      category: "av_rooms",
      timestamp: "2026-02-03",
      text: "Teams room console froze before the board sync; soft reset fixed it but we lost ten minutes.",
    },
    {
      id: "e07",
      category: "other",
      timestamp: "2026-02-05",
      text: "Visitor Wi-Fi password on the reception card is wrong — guests can't get online.",
    },
    {
      id: "e08",
      category: "av_rooms",
      timestamp: "2026-02-11",
      text: "Ceiling mics in River picked up nothing from the left side of the table during the partner call.",
    },
    {
      id: "e09",
      category: "av_rooms",
      timestamp: "2026-02-12",
      text: "Content share from MacBook to the barco failed twice; Android phone cast worked as a backup.",
    },
    {
      id: "e10",
      category: "other",
      timestamp: "2026-02-18",
      text: "Thermostat in open office is stuck at 78F; people are complaining about heat.",
    },
    {
      id: "e11",
      category: "av_rooms",
      timestamp: "2026-02-20",
      text: "Camera in Studio A pointed at the ceiling after 'someone cleaned.' Remote attendees saw lights only.",
    },
    {
      id: "e12",
      category: "av_rooms",
      timestamp: "2026-02-25",
      text: "Another dead display in 3C — power light on, no signal no matter which cable we try.",
    },
    {
      id: "e13",
      category: "av_rooms",
      timestamp: "2026-02-26",
      text: "Wireless presentation clicker batteries were dead in three rooms on the same floor today.",
    },
    {
      id: "e14",
      category: "other",
      timestamp: "2026-03-02",
      text: "Coffee subscription ran out and nobody reordered; afternoon slump is real.",
    },
    {
      id: "e15",
      category: "av_rooms",
      timestamp: "2026-03-04",
      text: "Hybrid all-hands: room speakers clipped whenever someone on Zoom spoke. Painful.",
    },
    {
      id: "e16",
      category: "av_rooms",
      timestamp: "2026-03-05",
      text: "Booking showed Room North free, but the panel still said occupied and wouldn't start the AV stack.",
    },
    {
      id: "e17",
      category: "av_rooms",
      timestamp: "2026-03-10",
      text: "Echo cancellation failed in Harbor — remote folks heard themselves with a half-second delay.",
    },
    {
      id: "e18",
      category: "av_rooms",
      timestamp: "2026-03-11",
      text: "Fourth report this week of the same 'no camera / black tile' issue in East Huddle.",
    },
    {
      id: "e19",
      category: "av_rooms",
      timestamp: "2026-03-12",
      text: "Projector lamp warning in Training 2; image dim enough that slides were unreadable.",
    },
    {
      id: "e20",
      category: "av_rooms",
      timestamp: "2026-03-18",
      text: "We abandoned 5D entirely for external calls until AV is fixed — moving everything to Zoom-from-desk.",
    },
    {
      id: "e21",
      category: "other",
      timestamp: "2026-03-19",
      text: "Lost-and-found is overflowing with umbrellas; please claim yours by Friday.",
    },
    {
      id: "e22",
      category: "av_rooms",
      timestamp: "2026-03-24",
      text: "Stand-up room tablet won't wake; can't start the meeting or adjust volume without IT on-site.",
    },
    {
      id: "e23",
      category: "av_rooms",
      timestamp: "2026-03-25",
      text: "Customer demo nearly cancelled because the room PC wouldn't join the scheduled Teams meeting.",
    },
    {
      id: "e24",
      category: "av_rooms",
      timestamp: "2026-03-26",
      text: "Same AV failure pattern across three floors now — screens on, no input, endless 'searching for devices.'",
    },
  ],
};

export const DEMO_DATASETS: DemoDataset[] = [CLUSTER_DEMO, EMERGING_DEMO];

export function getDemoDataset(id: string): DemoDataset | undefined {
  return DEMO_DATASETS.find((d) => d.id === id);
}

export const CATEGORY_LABELS: Record<string, string> = {
  badge_access: "Badge / door access",
  vpn_remote: "VPN / remote access",
  expense_reimburse: "Expense / reimbursement",
  outlier: "Unusual / outlier",
  av_rooms: "Meeting-room A/V",
  other: "Other facility notes",
};
