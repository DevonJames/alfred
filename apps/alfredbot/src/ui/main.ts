import { api, type BootState, type WifiNetwork } from "./api.js";
import { botQrSvg } from "./bot-qr-svg.js";
import { AlfredFace } from "./face.js";
import { TalkSession, type CaptionMsg, type UserMsg } from "./voice.js";
import { LiveWaveform } from "./waveform.js";

const root = document.querySelector<HTMLElement>("#app")!;

const LETTER_ROWS = ["1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm"];
const SYMBOL_ROWS = ["1234567890", "!@#$%^&*()", "-_=+[]{}|\\", ";:'\",.<>/?"];

let boot: BootState | null = null;
let talk: TalkSession | undefined;
let face: AlfredFace | undefined;
let stopPoll: (() => void) | undefined;
let expressionTimerLabel = "calm";

function watchScreen(): void {
  stopPoll?.();
  const timer = setInterval(() => {
    void api.status().then((next) => {
      if (next.screen === boot?.screen) return;
      boot = next;
      void render();
    });
  }, 1500);
  stopPoll = () => clearInterval(timer);
}

function pillLabel(state: BootState): string {
  if (state.connectionType === "lan") return "Local";
  if (state.connectionType === "wan") return "Direct";
  if (state.connectionType === "relay") return "Relay";
  return state.wifi.connected ? "Online" : "No Wi-Fi";
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("status timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function paintBoot(): void {
  if (root.querySelector(".screen")) return;
  root.innerHTML = `<section class="screen face-screen" style="background:#000"><header class="top"><div class="brand">ALFREDBOT<span>Starting…</span></div></header></section>`;
}

async function refresh(): Promise<void> {
  paintBoot();
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      boot = await withTimeout(api.status(), 4000);
      await render();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  throw new Error("AlfredBot host did not answer. Power-cycle the robot.");
}

function fadingLine(el: HTMLElement): { show: (text: string) => void; hideSoon: (delayMs?: number) => void } {
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  const hideSoon = (delayMs = 2800) => {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => el.classList.remove("visible"), delayMs);
  };
  return {
    show(text: string) {
      if (hideTimer) clearTimeout(hideTimer);
      el.textContent = text;
      el.classList.add("visible");
    },
    hideSoon,
  };
}

function header(title: string, sub: string): string {
  const pill = boot ? pillLabel(boot) : "…";
  return `<header class="top"><div class="brand">${title}<span>${sub}</span></div><div class="pill">${pill}</div></header>`;
}

function escapeKeyLabel(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function keyButton(opts: { action: string; label: string; insert?: string; span?: number; mod?: boolean }): string {
  const span = opts.span && opts.span > 1 ? ` style="grid-column:span ${opts.span}"` : "";
  const cls = opts.mod ? "key mod" : "key";
  const insert = opts.insert ?? "";
  return `<button type="button" class="${cls}" data-action="${opts.action}" data-insert="${encodeURIComponent(insert)}"${span}>${escapeKeyLabel(opts.label)}</button>`;
}

function passwordKeyboardHtml(page: "letters" | "symbols", shift: boolean, caps: boolean): string {
  const rows = page === "letters" ? LETTER_ROWS : SYMBOL_ROWS;
  const letterKeys = rows
    .flatMap((row) =>
      [...row].map((ch) => {
        const upper = page === "letters" && /[a-z]/.test(ch) && (shift || caps);
        const glyph = upper ? ch.toUpperCase() : ch;
        return keyButton({ action: "insert", insert: glyph, label: glyph });
      }),
    )
    .join("");
  const shiftLabel = caps ? "CAPS" : "⇧";
  const pageLabel = page === "letters" ? "?123" : "abc";
  return `<div class="keyboard qwerty" data-page="${page}">
    ${letterKeys}
    ${keyButton({ action: "shift", label: shiftLabel, mod: true })}
    ${keyButton({ action: "page", label: pageLabel, mod: true })}
    ${keyButton({ action: "insert", insert: " ", label: "space", span: 3 })}
    ${keyButton({ action: "insert", insert: "@", label: "@" })}
    ${keyButton({ action: "insert", insert: "`", label: "`" })}
    ${keyButton({ action: "insert", insert: "~", label: "~" })}
    ${keyButton({ action: "backspace", label: "⌫", mod: true })}
    ${keyButton({ action: "ok", label: "OK", mod: true })}
  </div>`;
}

async function renderWifi(): Promise<void> {
  root.innerHTML = `<section class="screen">${header("ALFREDBOT", "NETWORK")}<div class="copy"><h1>Join a network</h1><p>No usable Wi-Fi. Pick a network, then type the password on the glass.</p><div id="nets" class="stack"></div><p class="notice" id="err"></p></div></section>`;
  const err = root.querySelector("#err")!;
  const nets = root.querySelector("#nets")!;
  try {
    const { networks } = await api.scanWifi();
    nets.innerHTML = networks
      .map(
        (n: WifiNetwork) =>
          `<button class="card" data-ssid="${n.ssid}"><strong>${n.ssid}</strong>${n.secure ? "secured" : "open"} · ${n.signal}%</button>`,
      )
      .join("");
  } catch (e) {
    err.textContent = e instanceof Error ? e.message : String(e);
  }
  nets.querySelectorAll<HTMLButtonElement>("[data-ssid]").forEach((btn) => {
    btn.addEventListener("click", () => void renderWifiPassword(btn.dataset.ssid ?? ""));
  });
}

async function renderWifiPassword(ssid: string): Promise<void> {
  let page: "letters" | "symbols" = "letters";
  let shift = false;
  let caps = false;
  root.innerHTML = `<section class="screen wifi-pass">${header("ALFREDBOT", "NETWORK")}
    <div class="copy">
      <h1>${escapeKeyLabel(ssid)}</h1>
      <div class="field pwd-field">
        <input id="pwd" type="password" autocomplete="off" placeholder="Password" />
        <button type="button" class="btn ghost pwd-toggle" id="reveal">Show</button>
      </div>
      <div id="kb"></div>
      <p class="notice" id="err"></p>
      <button class="btn ghost" id="back">Back</button>
    </div>
  </section>`;
  const input = root.querySelector<HTMLInputElement>("#pwd")!;
  const err = root.querySelector("#err")!;
  const kb = root.querySelector("#kb")!;
  const reveal = root.querySelector<HTMLButtonElement>("#reveal")!;
  const join = async () => {
    try {
      const result = await api.joinWifi(ssid, input.value);
      boot = { ...(boot as BootState), wifi: result.wifi, screen: result.screen };
      await render();
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : String(e);
    }
  };

  const paintKeys = () => {
    kb.innerHTML = passwordKeyboardHtml(page, shift, caps);
    kb.querySelectorAll<HTMLButtonElement>(".key").forEach((key) => {
      if (key.dataset.action === "shift") key.classList.toggle("on", shift || caps);
      key.addEventListener("click", () => {
        const action = key.dataset.action ?? "";
        if (action === "backspace") {
          input.value = input.value.slice(0, -1);
          return;
        }
        if (action === "ok") {
          void join();
          return;
        }
        if (action === "page") {
          page = page === "letters" ? "symbols" : "letters";
          shift = false;
          paintKeys();
          return;
        }
        if (action === "shift") {
          if (caps) {
            caps = false;
            shift = false;
          } else if (shift) {
            caps = true;
          } else {
            shift = true;
          }
          paintKeys();
          return;
        }
        const glyph = decodeURIComponent(key.dataset.insert ?? "");
        if (!glyph) return;
        input.value += glyph;
        if (shift && !caps && page === "letters" && /[A-Za-z]/.test(glyph)) {
          shift = false;
          paintKeys();
        }
      });
    });
  };

  root.querySelector("#back")!.addEventListener("click", () => void renderWifi());
  reveal.addEventListener("click", () => {
    const hidden = input.type === "password";
    input.type = hidden ? "text" : "password";
    reveal.textContent = hidden ? "Hide" : "Show";
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") void join();
  });
  paintKeys();
}

async function renderClaim(): Promise<void> {
  root.innerHTML = `<section class="screen claim-screen">${header("ALFREDBOT", "CLAIM")}
    <div class="qr-wrap">
      <div id="qr" class="qr" aria-label="AlfredBot claim code"></div>
      <p class="viewfinder-hint" id="hint">Scan this with the Alfred app on your iPhone</p>
    </div>
    <div class="claim-bar">
      <p id="err" class="notice"></p>
    </div>
  </section>`;
  const hint = root.querySelector("#hint")!;
  const err = root.querySelector("#err")!;
  const qr = root.querySelector("#qr")!;
  try {
    const identity = await api.identity();
    qr.innerHTML = await botQrSvg(identity.uri);
    hint.textContent = `Scan with iPhone · ${identity.name}`;
  } catch (e) {
    err.textContent = e instanceof Error ? e.message : String(e);
  }
  watchScreen();
}

function renderPin(): void {
  const name = boot?.desktopName ?? "your Mac";
  root.innerHTML = `<section class="screen">${header("ALFREDBOT", "PAIR")}
    <div class="copy wait-copy">
      <h1>Finish on iPhone</h1>
      <p>Alfred on the phone is pairing this robot to <strong>${name}</strong>. Type the six-digit PIN from the Mac there — not on this glass.</p>
    </div>
  </section>`;
  watchScreen();
}

function renderFace(): void {
  stopPoll?.();
  const localAudio = boot?.audioSource === "local";
  const name = boot?.desktopName ?? "Alfred";
  root.innerHTML = `<section class="screen face-screen">${header("ALFREDBOT", name)}
    <div class="face-stage">
      <canvas id="face"></canvas>
      <div class="face-captions">
        <p class="face-line you" id="face-user"></p>
        <p class="face-line alfred" id="face-caption"></p>
      </div>
    </div>
    <div class="wave-wrap"><canvas id="wave"></canvas></div>
    ${localAudio ? `<button class="face-talk" id="face-talk" type="button" aria-label="Start talking">Talk</button>` : ""}
    <video id="pip" class="pip" playsinline muted></video>
    <div class="log-sheet" id="log-sheet">
      <button class="log-tab" id="log-tab" type="button" aria-label="Open last said"><span></span></button>
      <div class="log-panel">
        <h2>LAST SAID</h2>
        <div class="transcript">
          <div class="bubble"><div class="tag">YOU</div><p id="user">Listening…</p></div>
          <div class="bubble"><div class="tag">ALFRED · <span id="expr">${expressionTimerLabel}</span></div><p id="caption">Awaiting signal…</p></div>
        </div>
      </div>
    </div>
    <button class="drawer-tab" id="drawer-tab" type="button" aria-label="Open controls"><span></span></button>
    <button class="drawer-scrim" id="drawer-scrim" type="button" aria-label="Close controls"></button>
    <aside class="drawer" id="drawer">
      <h2>CONTROLS</h2>
      <div class="actions">
        <button class="btn" id="talk">Talk</button>
        ${localAudio ? `<button class="btn ghost" id="mute">Mute</button>` : ""}
        <button class="btn ghost" id="unpair">Unpair</button>
        <span class="pill" id="status">Idle</span>
      </div>
    </aside>
    <div id="remote-audio" hidden></div>
  </section>`;

  const faceCanvas = root.querySelector<HTMLCanvasElement>("#face")!;
  const waveCanvas = root.querySelector<HTMLCanvasElement>("#wave")!;
  const userEl = root.querySelector("#user")!;
  const captionEl = root.querySelector("#caption")!;
  const faceUser = fadingLine(root.querySelector("#face-user")!);
  const faceCaption = fadingLine(root.querySelector("#face-caption")!);
  const exprEl = root.querySelector("#expr")!;
  const statusEl = root.querySelector("#status")!;
  const talkBtn = root.querySelector<HTMLButtonElement>("#talk")!;
  const faceTalkBtn = root.querySelector<HTMLButtonElement>("#face-talk");
  const muteBtn = root.querySelector<HTMLButtonElement>("#mute");
  const pip = root.querySelector<HTMLVideoElement>("#pip")!;
  face?.stop();
  void faceCanvas.offsetHeight;
  face = new AlfredFace(faceCanvas);
  face.start();
  const waveform = new LiveWaveform(waveCanvas);
  waveform.setLevelHandler((rms) => face?.setLevel(rms));
  let muted = false;
  talk = new TalkSession(face, waveform, root.querySelector("#remote-audio")!, pip, {
    localAudio,
    onStatus: (text) => {
      statusEl.textContent = text;
      const live = Boolean(talk?.linked);
      talkBtn.textContent = live ? "End" : "Talk";
      if (faceTalkBtn) {
        faceTalkBtn.textContent = live ? "End" : "Talk";
        faceTalkBtn.classList.toggle("live", live);
        faceTalkBtn.setAttribute("aria-label", live ? "Stop talking" : "Start talking");
      }
    },
    onCaption: (msg: CaptionMsg) => {
      if (msg.type === "end") {
        faceCaption.hideSoon();
        return;
      }
      const text = msg.text || "…";
      captionEl.textContent = text;
      faceCaption.show(text);
      faceCaption.hideSoon(msg.type === "reveal" ? 4200 : 5200);
    },
    onUser: (msg: UserMsg) => {
      const text = msg.text || "Listening…";
      userEl.textContent = text;
      if (!msg.text) return;
      faceUser.show(msg.text);
      faceUser.hideSoon(msg.type === "final" ? 2800 : 4500);
    },
    onExpression: (event) => {
      expressionTimerLabel = event.face;
      exprEl.textContent = event.body !== "none" ? `${event.face} · ${event.body}` : event.face;
    },
    onCameraError: (message) => {
      statusEl.textContent = message;
    },
  });
  let joinedConversationId = -1;
  let toggling = false;
  const setTalkBusy = (busy: boolean) => {
    toggling = busy;
    faceTalkBtn && (faceTalkBtn.disabled = busy);
    talkBtn.disabled = busy;
  };
  const toggleTalk = async () => {
    if (toggling || talk?.busy) return;
    setTalkBusy(true);
    try {
      if (talk?.linked) {
        await talk.disconnect();
        if (localAudio) await api.talkStop().catch(() => undefined);
        joinedConversationId = -1;
        statusEl.textContent = "Idle";
        return;
      }
      if (localAudio) await api.talkStart();
      statusEl.textContent = "Joining…";
      await talk?.connect();
      if (talk?.linked) {
        const next = await api.status().catch(() => null);
        joinedConversationId = Number(next?.conversationId ?? 0);
      }
    } catch (e) {
      statusEl.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      setTalkBusy(false);
    }
  };
  talkBtn.addEventListener("click", () => void toggleTalk());
  faceTalkBtn?.addEventListener("click", () => void toggleTalk());
  muteBtn?.addEventListener("click", async () => {
    muted = !muted;
    await talk?.setMuted(muted);
    muteBtn.textContent = muted ? "Unmute" : "Mute";
  });
  const screenEl = root.querySelector(".face-screen")!;
  const toggleDrawer = (open: boolean) => {
    screenEl.classList.toggle("drawer-open", open);
    if (open) screenEl.classList.remove("log-open");
  };
  const toggleLog = (open: boolean) => {
    screenEl.classList.toggle("log-open", open);
    if (open) screenEl.classList.remove("drawer-open");
  };
  root.querySelector("#drawer-tab")!.addEventListener("click", () => {
    toggleDrawer(!screenEl.classList.contains("drawer-open"));
  });
  root.querySelector("#log-tab")!.addEventListener("click", () => {
    toggleLog(!screenEl.classList.contains("log-open"));
  });
  root.querySelector("#drawer-scrim")!.addEventListener("click", () => {
    toggleDrawer(false);
    toggleLog(false);
  });
  root.querySelector("#unpair")!.addEventListener("click", async () => {
    await talk?.disconnect();
    boot = await api.unpair();
    await render();
  });
  let syncing = false;
  const syncConversation = async () => {
    if (syncing) return;
    syncing = true;
    try {
      const next = await api.status();
      if ((next.audioSource === "local") !== localAudio) {
        boot = next;
        await render();
        return;
      }
      boot = next;
      const want = next.conversation === true;
      const cid = Number(next.conversationId ?? 0);
      if (toggling || talk?.busy) return;
      if (!want) {
        const joinedForPhone = joinedConversationId >= 0;
        if (talk?.linked && (joinedForPhone || !localAudio)) {
          await talk.disconnect();
          statusEl.textContent = "Idle";
        }
        joinedConversationId = -1;
        return;
      }
      if (talk?.linked) {
        if (cid > 0) joinedConversationId = cid;
        return;
      }
      statusEl.textContent = "Joining…";
      faceCaption.show("Joining Alfred…");
      await talk?.connect();
      if (talk?.linked) {
        joinedConversationId = cid;
        faceCaption.hideSoon(800);
      }
    } catch (e) {
      statusEl.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      syncing = false;
    }
  };
  const timer = setInterval(() => void syncConversation(), 1500);
  stopPoll = () => clearInterval(timer);
  void syncConversation();
}

async function render(): Promise<void> {
  stopPoll?.();
  try {
    const screen = boot?.screen ?? "wifi";
    if (screen === "wifi") return renderWifi();
    if (screen === "claim") return renderClaim();
    if (screen === "pin") return renderPin();
    renderFace();
  } catch (err) {
    root.innerHTML = `<section class="screen"><div class="copy"><h1>AlfredBot</h1><p class="notice">${err instanceof Error ? err.message : String(err)}</p></div></section>`;
  }
}

void refresh().catch((err) => {
  root.innerHTML = `<section class="screen"><div class="copy"><h1>AlfredBot</h1><p class="notice">${err instanceof Error ? err.message : String(err)}</p></div></section>`;
});
