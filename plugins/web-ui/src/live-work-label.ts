import { AsyncDirective } from "lit/async-directive.js";
import { directive } from "lit/directive.js";
import { workPausedForApproval, type WorkBlock } from "./core-bridge.ts";
import { currentTextPhase } from "./timeline.ts";
import { sheenLabel } from "./ui.ts";
import { workedLabel, workSeconds } from "./work-duration.ts";

class LiveWorkLabel extends AsyncDirective {
  private timer: ReturnType<typeof setInterval> | undefined;
  private work!: WorkBlock;

  render(work: WorkBlock) {
    this.work = work;
    const ticking =
      this.isConnected &&
      work.status === "working" &&
      !work.stale &&
      !workPausedForApproval(work) &&
      currentTextPhase(work)?.phase !== "final_answer";
    if (ticking && !this.timer) this.timer = setInterval(() => this.setValue(this.label()), 50);
    else if (!ticking) this.disconnected();
    return this.label();
  }

  private label() {
    return sheenLabel(workedLabel("Working", workSeconds(this.work)), true);
  }

  protected disconnected() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  protected reconnected() {
    this.setValue(this.render(this.work));
  }
}

export const liveWorkLabel = directive(LiveWorkLabel);
