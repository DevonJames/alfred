import { describe, expect, it } from "vitest";
import { formatFitnessSpeech, speakFitnessPlan, type FitnessDayPlan } from "./fitness.js";

const plan: FitnessDayPlan = {
  date: "2026-10-14",
  timezone: "America/New_York",
  asOf: "2026-10-14T15:00:00.000Z",
  meals: [
    { id: "b", name: "Greek yogurt", mealType: "breakfast", status: "scheduled" },
    { id: "l", name: "chicken rice bowl", mealType: "lunch", status: "scheduled" },
    { id: "d", name: "salmon", mealType: "dinner", status: "completed" },
  ],
  workouts: [
    { id: "w", name: "Push day", status: "scheduled" },
    { id: "r", name: "30 minute run", status: "in_progress" },
  ],
};

describe("formatFitnessSpeech", () => {
  it("speaks upcoming meals and workouts after the agenda style", () => {
    expect(formatFitnessSpeech(plan)).toBe(
      "On your training plan today: Push day, and 30 minute run. Meals today: breakfast is Greek yogurt, and lunch is chicken rice bowl.",
    );
  });

  it("omits a stale or wrong-day snapshot", () => {
    expect(speakFitnessPlan(plan, new Date("2026-10-16T15:00:00.000Z"), "America/New_York")).toBe(
      "I don't have today's FitnessAlly plan.",
    );
    expect(speakFitnessPlan(plan, new Date("2026-10-14T16:00:00.000Z"), "America/New_York")).toMatch(
      /Greek yogurt/,
    );
  });
});
