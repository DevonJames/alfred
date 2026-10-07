export type BriefingDisplayLine = {
  text: string;
  newsIndex?: number;
  newsTitle?: string;
  newsUrl?: string;
};

export type BriefingDisplaySection = {
  id: string;
  title?: string;
  lines: BriefingDisplayLine[];
};

export type BriefingDisplay = {
  when: string;
  sections: BriefingDisplaySection[];
};

export type BriefingHeadlineClick = {
  index: number;
  title: string;
  url?: string;
};

/** Section headings that jump to a shell tab. */
const SECTION_NAV: Record<string, { screen: "agenda" | "reminders"; title: string }> = {
  agenda: { screen: "agenda", title: "Open Agenda" },
  due: { screen: "reminders", title: "Open Reminders" },
};

/**
 * Full-width Daily Brief layout that replaces the spoken caption paragraph.
 */
export class BriefingHud {
  private active = false;
  private onHeadline: ((hit: BriefingHeadlineClick) => void) | undefined;
  private onNavigate: ((screen: "agenda" | "reminders") => void) | undefined;

  constructor(
    private readonly root: HTMLElement,
    private readonly captionEl: HTMLElement,
  ) {
    this.root.hidden = true;
  }

  get isActive(): boolean {
    return this.active;
  }

  onHeadlineClick(handler: ((hit: BriefingHeadlineClick) => void) | undefined): void {
    this.onHeadline = handler;
  }

  onSectionNavigate(handler: ((screen: "agenda" | "reminders") => void) | undefined): void {
    this.onNavigate = handler;
  }

  show(display: BriefingDisplay): void {
    this.root.replaceChildren();
    const when = document.createElement("p");
    when.className = "briefing-when";
    when.textContent = display.when;
    this.root.appendChild(when);

    for (const section of display.sections) {
      const block = document.createElement("section");
      block.className = "briefing-section";
      block.dataset.id = section.id;
      if (section.title) {
        const nav = SECTION_NAV[section.id];
        if (nav) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "briefing-section-nav";
          btn.textContent = section.title;
          btn.title = nav.title;
          btn.addEventListener("click", (event) => {
            event.preventDefault();
            this.onNavigate?.(nav.screen);
          });
          const h = document.createElement("h3");
          h.appendChild(btn);
          block.appendChild(h);
        } else {
          const h = document.createElement("h3");
          h.textContent = section.title;
          block.appendChild(h);
        }
      }
      const list = document.createElement("ul");
      for (const line of section.lines) {
        const li = document.createElement("li");
        if (section.id === "headlines" && line.newsIndex != null && line.newsTitle) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "briefing-headline";
          btn.textContent = line.text;
          btn.title = "Hear more about this headline";
          const hit: BriefingHeadlineClick = {
            index: line.newsIndex,
            title: line.newsTitle,
            url: line.newsUrl,
          };
          btn.addEventListener("click", (event) => {
            event.preventDefault();
            this.onHeadline?.(hit);
          });
          li.appendChild(btn);
        } else {
          li.textContent = line.text;
        }
        list.appendChild(li);
      }
      block.appendChild(list);
      this.root.appendChild(block);
    }

    this.active = true;
    this.root.hidden = false;
    this.captionEl.hidden = true;
    document.body.dataset.briefing = "1";
    this.root.scrollTop = 0;
  }

  clear(): void {
    if (!this.active && this.root.hidden) return;
    this.active = false;
    this.root.hidden = true;
    this.root.replaceChildren();
    this.captionEl.hidden = false;
    delete document.body.dataset.briefing;
  }
}

function normalizeLine(raw: unknown): BriefingDisplayLine | null {
  if (typeof raw === "string") return { text: raw };
  if (!raw || typeof raw !== "object") return null;
  const value = raw as BriefingDisplayLine;
  if (typeof value.text !== "string") return null;
  const line: BriefingDisplayLine = { text: value.text };
  if (typeof value.newsIndex === "number" && Number.isFinite(value.newsIndex)) {
    line.newsIndex = Math.max(1, Math.floor(value.newsIndex));
  }
  if (typeof value.newsTitle === "string" && value.newsTitle.trim()) {
    line.newsTitle = value.newsTitle.trim();
  }
  if (typeof value.newsUrl === "string" && value.newsUrl.trim()) {
    line.newsUrl = value.newsUrl.trim();
  }
  return line;
}

export function parseBriefingDisplay(raw: unknown): BriefingDisplay | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as BriefingDisplay;
  if (typeof value.when !== "string" || !Array.isArray(value.sections)) return null;
  const sections: BriefingDisplaySection[] = [];
  for (const section of value.sections) {
    if (!section || typeof section !== "object" || typeof section.id !== "string") continue;
    if (!Array.isArray(section.lines)) continue;
    const lines = section.lines.map(normalizeLine).filter((line): line is BriefingDisplayLine => Boolean(line));
    sections.push({
      id: section.id,
      title: typeof section.title === "string" ? section.title : undefined,
      lines,
    });
  }
  return { when: value.when, sections };
}
