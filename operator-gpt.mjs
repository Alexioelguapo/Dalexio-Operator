import { createRequire } from "module";
import { OpenAIPlanner } from "./agents/openai-planner.mjs";

const require = createRequire(import.meta.url);

const BrowserController = require("./browser/controller");
const BrowserExecutor = require("./browser/executor");

async function runOperator(objective) {
  const controller = new BrowserController();
  const executor = new BrowserExecutor(controller);
  const planner = new OpenAIPlanner();

  const MAX_STEPS = 12;

  let observation = {
    url: null,
    title: null,
    text: "",
    links: [],
    buttons: [],
    inputs: [],
    headings: []
  };

  try {
    console.log("\nOBJECTIVE:", objective);

    for (let step = 1; step <= MAX_STEPS; step++) {
      console.log(`\n--- STEP ${step} ---`);

      const decision = await planner.plan({
        objective,
        observation
      });

      console.log("DECISION:", decision);

      if (!decision || !decision.action) {
        throw new Error("Planner returned no action.");
      }

      if (decision.action === "done") {
        console.log("\nDONE");
        console.log(decision.answer || "Task completed.");
        return;
      }

      const result = await executor.execute(decision);
      console.log("RESULT:", result);

      observation = await executor.execute({
        action: "observe"
      });

      console.log("PAGE:", {
        url: observation.url,
        title: observation.title
      });
    }

    console.log("\nSTOPPED: maximum step count reached.");
  } catch (error) {
    console.error("\nOPERATOR ERROR:", error);
  } finally {
    await controller.close();
  }
}

const objective =
  process.argv.slice(2).join(" ") ||
  "Open English Wikipedia";

runOperator(objective);