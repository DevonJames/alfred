import { getBriefingDayKey } from "./day.js";

export type FitnessItemStatus = "scheduled" | "in_progress" | "completed" | "skipped";
export type FitnessMealType = "breakfast" | "lunch" | "dinner" | "snack";

export interface FitnessMeal {
  id: string;
  name: string;
  mealType: FitnessMealType;
  servings?: number;
  status: FitnessItemStatus;
  notes?: string;
}

export interface FitnessWorkout {
  id: string;
  name: string;
  status: FitnessItemStatus;
  notes?: string;
}

/** Snapshot FitnessAlly pushes. Alfred does not keep the recipe or exercise catalog. */
export interface FitnessDayPlan {
  date: string;
  timezone: string;
  asOf: string;
  meals: FitnessMeal[];
  workouts: FitnessWorkout[];
}

const MEAL_ORDER: FitnessMealType[] = ["breakfast", "lunch", "dinner", "snack"];
const STATUSES: FitnessItemStatus[] = ["scheduled", "in_progress", "completed", "skipped"];
const PLAN_TTL_MS = 36 * 60 * 60 * 1000;

export function fitnessPlanIsCurrent(
  plan: FitnessDayPlan,
  now: Date,
  timezone: string,
  dayStart = "04:30",
): boolean {
  const asOf = Date.parse(plan.asOf);
  if (!Number.isFinite(asOf)) return false;
  const age = now.getTime() - asOf;
  if (age > PLAN_TTL_MS || age < -5 * 60 * 1000) return false;
  return plan.date === getBriefingDayKey(now, timezone, dayStart);
}

export function formatFitnessSpeech(plan: FitnessDayPlan): string | null {
  const parts: string[] = [];
  const workouts = plan.workouts.filter(isUpcoming).map((item) => item.name);
  if (workouts.length) {
    parts.push(`On your training plan today: ${joinSpoken(workouts)}.`);
  }
  const meals = [...plan.meals].filter(isUpcoming).sort(byMealType);
  if (meals.length) {
    const spoken = meals.map((meal) => `${meal.mealType} is ${meal.name}`);
    parts.push(`Meals today: ${joinSpoken(spoken)}.`);
  }
  return parts.length ? parts.join(" ") : null;
}

export function formatFitnessMarkdown(plan: FitnessDayPlan): string {
  const sections: string[] = [];
  if (plan.workouts.length) {
    sections.push(
      "## Training",
      "",
      ...plan.workouts.map((item) => `- ${item.name}${statusSuffix(item.status)}`),
    );
  }
  if (plan.meals.length) {
    if (sections.length) sections.push("");
    sections.push(
      "## Meals",
      "",
      ...[...plan.meals].sort(byMealType).map((meal) => {
        const title = meal.mealType.charAt(0).toUpperCase() + meal.mealType.slice(1);
        return `- ${title}: ${meal.name}${statusSuffix(meal.status)}`;
      }),
    );
  }
  return sections.join("\n");
}

export function fitnessDisplayLines(plan: FitnessDayPlan): { training: string[]; meals: string[] } {
  return {
    training: plan.workouts.map((item) => `${item.name}${statusSuffix(item.status)}`),
    meals: [...plan.meals]
      .sort(byMealType)
      .map((meal) => {
        const title = meal.mealType.charAt(0).toUpperCase() + meal.mealType.slice(1);
        return `${title}: ${meal.name}${statusSuffix(meal.status)}`;
      }),
  };
}

/** Spoken answer for "what's for lunch?" / "what am I training?". */
export function speakFitnessPlan(plan: FitnessDayPlan | null, now: Date, timezone: string, dayStart?: string): string {
  if (!plan || !fitnessPlanIsCurrent(plan, now, timezone, dayStart)) {
    return "I don't have today's FitnessAlly plan.";
  }
  return formatFitnessSpeech(plan) ?? "Nothing is still scheduled in today's FitnessAlly plan.";
}

export function isFitnessItemStatus(value: string): value is FitnessItemStatus {
  return (STATUSES as string[]).includes(value);
}

export function isFitnessMealType(value: string): value is FitnessMealType {
  return (MEAL_ORDER as string[]).includes(value);
}

function isUpcoming(item: { status: FitnessItemStatus }): boolean {
  return item.status === "scheduled" || item.status === "in_progress";
}

function byMealType(a: FitnessMeal, b: FitnessMeal): number {
  return MEAL_ORDER.indexOf(a.mealType) - MEAL_ORDER.indexOf(b.mealType);
}

function statusSuffix(status: FitnessItemStatus): string {
  if (status === "scheduled") return "";
  if (status === "in_progress") return " — in progress";
  if (status === "completed") return " — done";
  return " — skipped";
}

function joinSpoken(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}
