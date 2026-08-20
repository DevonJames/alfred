/**
 * Conversation session (PRD §9).
 *
 * The desktop owns the state machine. This hook is a *view* of it: it joins a
 * session, polls the event stream, and renders whatever ledger states come
 * back. It never decides that a turn is delivered, superseded or cancelled —
 * only the desktop does that (§9.3).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import {
  conversationEvents,
  desktopErrorMessage,
  endSession as endSessionCall,
  interruptSession,
  isNotBuiltYet,
  sessionToken,
  transcript as transcriptCall,
} from "./desktop-api";
import type { ConversationTurn, SessionEvent, SessionToken } from "./types";

export type SessionState = "idle" | "listening" | "thinking" | "speaking";

interface SessionStore {
  token: SessionToken | null;
  state: SessionState;
  turns: ConversationTurn[];
  /** Partial user caption while speech is still being recognised on the Mac. */
  partial: string | null;
  cursor: number;
  error: string | null;
  /**
   * The Mac answered 404: conversation isn't in its build yet. Distinct from
   * `error`, because there is nothing to retry — polling must stop rather than
   * ask a missing endpoint every 2.5 seconds forever.
   */
  unavailable: boolean;
  set: (patch: Partial<SessionStore>) => void;
  applyEvents: (events: SessionEvent[]) => void;
  reset: () => void;
}

export const useSession = create<SessionStore>((set) => ({
  token: null,
  state: "idle",
  turns: [],
  partial: null,
  cursor: 0,
  error: null,
  unavailable: false,

  set: (patch) => set(patch),

  applyEvents: (events) =>
    set((current) => {
      let turns = current.turns;
      let partial = current.partial;

      for (const event of events) {
        const payload = event.payload as Record<string, any>;

        if (event.type === "caption.user") {
          if (payload.final) {
            partial = null;
            turns = upsertTurn(turns, payload.turn as ConversationTurn);
          } else {
            partial = String(payload.text ?? "");
          }
        }

        if (event.type === "caption.assistant") {
          turns = upsertTurn(turns, payload.turn as ConversationTurn);
        }

        if (event.type === "ledger") {
          // Ledger transitions are authoritative — a turn the desktop marked
          // superseded must stop reading as the current answer (§9.3).
          turns = turns.map((t) =>
            t.id === payload.turnId ? { ...t, ledger: payload.ledger ?? t.ledger } : t
          );
        }
      }

      return { turns, partial };
    }),

  reset: () =>
    set({
      token: null,
      state: "idle",
      turns: [],
      partial: null,
      cursor: 0,
      error: null,
      unavailable: false,
    }),
}));

function upsertTurn(turns: ConversationTurn[], turn: ConversationTurn | undefined) {
  if (!turn?.id) return turns;
  const index = turns.findIndex((t) => t.id === turn.id);
  if (index === -1) return [...turns, turn];
  const next = [...turns];
  next[index] = { ...next[index], ...turn };
  return next;
}

/**
 * Joins a session and keeps the event stream flowing. Polling rather than a
 * socket is deliberate: it survives the relay hop and resumes cleanly from a
 * cursor after the phone sleeps.
 */
export function useConversationSession(active: boolean) {
  const [joining, setJoining] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = useRef(false);

  const join = useCallback(async () => {
    if (useSession.getState().token) return useSession.getState().token;
    setJoining(true);
    try {
      const token = await sessionToken("voice");
      useSession.getState().set({ token, error: null, unavailable: false });
      // Backfilling old turns is a nicety. The desktop's first mobile API build
      // has token/turn/events but no /transcript, and a missing history must
      // not take down a session that is otherwise working.
      const history = await transcriptCall(token.sessionId).catch(() => null);
      if (history) useSession.getState().set({ turns: history.turns });
      return token;
    } catch (err) {
      // A raw "404 Not Found" tells the user nothing and reads like a broken
      // app; say which part is missing and stop retrying it.
      useSession.getState().set({
        error: desktopErrorMessage(err, "Your Mac isn't reachable right now."),
        unavailable: isNotBuiltYet(err),
      });
      return null;
    } finally {
      setJoining(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    running.current = true;

    (async () => {
      await join();
      // Nothing to stream from a Mac that has no conversation endpoint.
      if (useSession.getState().unavailable) return;
      poll();
    })();

    async function poll() {
      if (!running.current) return;
      const { cursor, token } = useSession.getState();
      try {
        const result = await conversationEvents(cursor, token?.sessionId);
        if (result.events.length) useSession.getState().applyEvents(result.events);
        useSession.getState().set({
          cursor: result.cursor,
          state: (result.state as SessionState) ?? "idle",
        });
      } catch (err) {
        // A missing endpoint will still be missing in 2.5 seconds. Stop, rather
        // than filling the log with 404s the user can do nothing about.
        if (isNotBuiltYet(err)) {
          useSession.getState().set({
            error: desktopErrorMessage(err, "Your Mac isn't reachable right now."),
            unavailable: true,
          });
          return;
        }
        // Transport failures are already surfaced by the connection pill; the
        // stream just resumes from the same cursor once a path comes back.
      }
      // Idle sessions don't need a tight loop; an active one wants to feel live.
      const delay = useSession.getState().state === "idle" ? 2500 : 900;
      timer.current = setTimeout(poll, delay);
    }

    return () => {
      running.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [active, join]);

  const end = useCallback(async () => {
    const { token } = useSession.getState();
    if (token) await endSessionCall(token.sessionId).catch(() => {});
    useSession.getState().reset();
  }, []);

  /** Barge-in: tell the desktop to stop speaking. It decides what that means. */
  const interrupt = useCallback(async () => {
    await interruptSession("user_barge_in").catch(() => {});
  }, []);

  return { join, end, interrupt, joining };
}
