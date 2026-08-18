import type { Page } from "playwright-core";
import OpenAI from "openai";

type ComputerAction = {
  type?: string;
  x?: number;
  y?: number;
  text?: string;
  keys?: string[];
  scroll_x?: number;
  scroll_y?: number;
  button?: string;
};

/**
 * Drive the current Playwright page with OpenAI Computer Use until the model
 * stops requesting actions (or max steps). Used when DOM extract is empty/blocked.
 */
export async function runComputerUseFallback(page: Page, url: string): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return;

  const client = new OpenAI({ apiKey });
  const model = process.env.ALFRED_CUA_MODEL?.trim() || "computer-use-preview";
  const size = page.viewportSize() ?? { width: 1280, height: 900 };

  const screenshot = async (): Promise<string> => {
    const buf = await page.screenshot({ type: "png" });
    return Buffer.from(buf).toString("base64");
  };

  const execute = async (action: ComputerAction): Promise<void> => {
    const type = String(action.type ?? "");
    if (type === "click" || type === "double_click" || type === "left_click") {
      await page.mouse.click(Number(action.x ?? 0), Number(action.y ?? 0), {
        clickCount: type === "double_click" ? 2 : 1,
        button: (action.button as "left" | "right") ?? "left",
      });
    } else if (type === "scroll") {
      await page.mouse.wheel(Number(action.scroll_x ?? 0), Number(action.scroll_y ?? 800));
    } else if (type === "type" || type === "keypress") {
      if (action.text) await page.keyboard.type(action.text);
      for (const key of action.keys ?? []) await page.keyboard.press(key);
    } else if (type === "wait") {
      await page.waitForTimeout(1200);
    } else if (type === "screenshot") {
      /* no-op; caller always screenshots */
    }
    await page.waitForTimeout(400);
  };

  let input: unknown[] = [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text:
            `Open and fully reveal the X.com (Twitter) content at ${url}. ` +
            `Expand threads, click Show more, dismiss cookie banners, and scroll until the post/article body is visible. ` +
            `Do not log out. Stop when the main text is on screen.`,
        },
        {
          type: "input_image",
          image_url: `data:image/png;base64,${await screenshot()}`,
        },
      ],
    },
  ];

  for (let step = 0; step < 12; step++) {
    let response: {
      output?: Array<Record<string, unknown>>;
      id?: string;
    };
    try {
      response = (await (client as unknown as {
        responses: { create: (body: Record<string, unknown>) => Promise<typeof response> };
      }).responses.create({
        model,
        tools: [
          {
            type: "computer-preview",
            display_width: size.width,
            display_height: size.height,
            environment: "browser",
          },
        ],
        truncation: "auto",
        input,
      })) as typeof response;
    } catch {
      return;
    }

    const output = response.output ?? [];
    const calls = output.filter((item) => String(item.type) === "computer_call");
    if (!calls.length) return;

    const nextInput: unknown[] = [];
    for (const call of calls) {
      const action = (call.action ?? {}) as ComputerAction;
      await execute(action);
      nextInput.push({
        type: "computer_call_output",
        call_id: call.call_id,
        output: {
          type: "computer_screenshot",
          image_url: `data:image/png;base64,${await screenshot()}`,
        },
      });
    }
    input = nextInput;
  }
}
