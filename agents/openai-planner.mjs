import OpenAI from "openai";

const client = new OpenAI();

export class OpenAIPlanner {
  async plan({ objective, observation }) {
    const compactObservation = {
      url: observation.url,
      title: observation.title,
      text: observation.text?.slice(0, 8000),
      headings: observation.headings?.slice(0, 30),
      links: observation.links?.slice(0, 60),
      buttons: observation.buttons?.slice(0, 40),
      inputs: observation.inputs?.slice(0, 40)
    };

    const prompt = `
You are the browser planner for Dalexio Operator.

OBJECTIVE:
${objective}

CURRENT BROWSER STATE:
${JSON.stringify(compactObservation, null, 2)}

Return exactly ONE JSON object.

Allowed actions:

{"action":"navigate","url":"https://..."}
{"action":"click_ref","ref":"link-0"}
{"action":"type_ref","ref":"input-0","text":"..."}
{"action":"screenshot","path":"optional-name.png"}
{"action":"done","answer":"final answer"}

Rules:
- No markdown.
- No explanation outside JSON.
- Use only refs present in the observation.
- Never invent refs.
- Take one browser action at a time.
- Mark done only when the objective is complete.
`;

    const response = await client.responses.create({
      model: "gpt-5.6-sol",
      input: prompt,
      store: false
    });

    const raw = response.output_text.trim();

    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`Planner returned invalid JSON:\n${raw}`);
    }
  }
}