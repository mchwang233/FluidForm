// One person's messages in an automation's conversation, as turns (docs/design/chat-context.md, 节奏):
// one answered at a time. A new message takes the one before it along while nobody has seen anything
// of that one's answer (nothing written, no tool run): that one is stopped and both are answered as
// one. Once something was seen or done the new one waits; what waits is taken together the same way.
import type { Attachment } from "./models.js";
import { Cancelled } from "./tasks.js";

/** Why a turn was stopped: taken along by the next, or asked to by the person. */
export type Stopped = "superseded" | "stopped";

/** What a message that says nothing by itself says (files alone, an @ alone). */
export type Said = { text: string; attachments: Attachment[]; addressed: boolean };

export class Turn {
  readonly controller = new AbortController();
  /** What the person has seen of the answer. */
  written = "";
  seen = false;
  answered = false;
  stopped: Stopped | null = null;
  readonly done: Promise<void>;
  private release!: () => void;

  constructor(readonly conversation: string, readonly sender: string, readonly said: Said, private readonly before: Promise<void>[]) {
    this.done = new Promise<void>((done) => (this.release = done));
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Whether the next message may take it along. */
  get open(): boolean {
    return !this.seen && !this.answered && !this.stopped;
  }

  stop(why: Stopped): void {
    if (this.answered || this.stopped) return;
    this.stopped = why;
    this.controller.abort(new Cancelled(why));
  }

  /** Waits for this person's turns before it to be over. */
  async wait(): Promise<void> {
    await Promise.all(this.before);
  }

  /** The answer is there: the next may start, whatever is still done with this one (a task planned). */
  end(): void {
    this.answered = true;
    this.release();
  }
}

export class Turns {
  private readonly active = new Map<string, Turn[]>();

  /** A message's turn, begun as it arrives. ``nothing``: the texts that say nothing by themselves. */
  begin(place: string, conversation: string, sender: string, said: Said, nothing: Set<string>): Turn {
    const key = JSON.stringify([place, conversation, sender]);
    const turns = (this.active.get(key) ?? []).filter((turn) => !turn.answered);
    const last = turns.at(-1);
    let all = said;
    if (last?.open) {
      const texts = [last.said.text, said.text].filter((text) => text && !nothing.has(text));
      const files = new Map([...last.said.attachments, ...said.attachments].map((item) => [item.id, item]));
      // The same words again are said once: sent again because nothing seemed to happen.
      all = { text: [...new Set(texts)].join("\n") || said.text, attachments: [...files.values()], addressed: said.addressed || last.said.addressed };
      last.stop("superseded");
    }
    const turn = new Turn(conversation, sender, all, turns.map((item) => item.done));
    turns.push(turn);
    this.active.set(key, turns);
    void turn.done.then(() => {
      const left = (this.active.get(key) ?? []).filter((item) => item !== turn);
      if (left.length) this.active.set(key, left);
      else this.active.delete(key);
    });
    return turn;
  }

  /** The turns under way of ``sender`` in ``conversation``. */
  of(place: string, conversation: string, sender: string): Turn[] {
    return (this.active.get(JSON.stringify([place, conversation, sender])) ?? []).filter((turn) => !turn.answered && !turn.stopped);
  }
}
