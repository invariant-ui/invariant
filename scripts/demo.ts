// The enforcement loop, end to end, in a scratch copy of the Acme fixture:
//   pnpm build && pnpm demo
import { playLoop, prepare } from "./demo-loop.ts"

const line = "─".repeat(72)
const say = (text = ""): void => console.log(text)

say("An agent is asked: build a settings page with a delete button.\n")
const dir = await prepare()
const { steps, report } = await playLoop(dir)
for (const [i, step] of steps.entries()) {
  say(line)
  say(`${i + 1}. ${step.intent}`)
  say(
    step.blocked
      ? "   invariant blocked the write. The agent reads:\n"
      : "   the write landed. The agent reads:\n"
  )
  say(step.card.replace(/^/gm, "   "))
  say()
}
say(line)
// Timestamps are the only thing that changes between runs, so the printed report drops them.
say(report.replace(/^\d{4}-\d{2}-\d{2}T\S+\s+/gm, ""))
