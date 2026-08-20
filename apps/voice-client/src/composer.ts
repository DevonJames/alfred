/** Chat-layout composer: type, dictate-into-box, send on return. */
export class Composer {
  private typedPrefix = "";
  private dictated = "";
  private dictating = false;

  constructor(
    private readonly form: HTMLFormElement,
    private readonly input: HTMLTextAreaElement,
    private readonly dictateBtn: HTMLButtonElement,
  ) {
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.form.requestSubmit();
      }
    });
    this.input.addEventListener("input", () => this.autosize());
  }

  get dictationActive(): boolean {
    return this.dictating;
  }

  startDictate(): void {
    this.typedPrefix = this.input.value.trim();
    this.dictated = "";
    this.dictating = true;
    this.input.readOnly = true;
    this.dictateBtn.setAttribute("aria-pressed", "true");
    this.dictateBtn.classList.add("active");
  }

  applyDictation(text: string): void {
    if (!this.dictating) return;
    this.dictated = text.trim();
    this.input.value = this.composed();
    this.autosize();
  }

  stopDictate(): void {
    if (!this.dictating) return;
    this.input.value = this.composed();
    this.typedPrefix = this.input.value;
    this.dictated = "";
    this.dictating = false;
    this.input.readOnly = false;
    this.dictateBtn.setAttribute("aria-pressed", "false");
    this.dictateBtn.classList.remove("active");
    this.autosize();
  }

  consume(): string {
    this.stopDictate();
    const text = this.input.value.trim();
    this.input.value = "";
    this.typedPrefix = "";
    this.dictated = "";
    this.autosize();
    return text;
  }

  reset(): void {
    this.stopDictate();
    this.input.value = "";
    this.typedPrefix = "";
    this.dictated = "";
    this.autosize();
  }

  private composed(): string {
    const dictated = this.dictated.trim();
    const prefix = this.dictating ? this.typedPrefix : this.input.value;
    if (!dictated) return prefix;
    if (!prefix) return dictated;
    return `${prefix} ${dictated}`;
  }

  private autosize(): void {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(this.input.scrollHeight, 160)}px`;
  }
}
