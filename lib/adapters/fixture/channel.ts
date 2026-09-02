/**
 * lib/adapters/fixture/channel.ts — Slack, simulated by two files.
 *
 * Owns: `FixtureChannelAdapter`. Outbound messages are appended to `TL_DATA_DIR/outbox.jsonl`
 * (nothing leaves the machine); scripted replies are read from `TL_DATA_DIR/inbox.jsonl` and
 * returned as `UntrustedDocument` — free human text that is data, never instructions (spec §9).
 *
 * A line in `outbox.jsonl`:
 *   { ts, actor, to_worker_id | channel, template_id, text, message_ref }
 * A line in `inbox.jsonl` (hand-written or seeded by a test/demo script):
 *   { ts, thread_ref, from_worker_id?, text, message_ref? }
 *
 * Public interface: `FixtureChannelAdapter` (implements `ChannelPort`), `OutboxLine`,
 * `InboxLine`, `OUTBOX_FILENAME`, `INBOX_FILENAME`.
 *
 * Rippling calls this stands in for: none — Rippling exposes no messaging surface
 * (docs/research/rippling-06-api-mcp-surface.md). A real deployment brings Slack's own API.
 *
 * Spec: docs/SPEC.md §2, §7 step 2, §9; docs/PLAN.md §2.3, §2.8.
 */

import { join } from 'node:path';

import {
  appendJsonLine,
  randomHex,
  readJsonLines,
  toInstant,
} from '#lib/adapters/fixture/ledger.ts';
import type {
  ChannelMessageInput,
  ChannelPort,
  DeliveryResult,
  DirectMessageInput,
  PostResult,
} from '#lib/ports/channel.ts';
import type { InstantISO, UntrustedDocument, WorkerId } from '#lib/types/tier1.ts';

export const OUTBOX_FILENAME = 'outbox.jsonl';
export const INBOX_FILENAME = 'inbox.jsonl';

/** One sent message. `actor` is the acting worker — the agent never speaks as itself. */
export interface OutboxLine {
  ts: InstantISO;
  actor: WorkerId;
  to_worker_id?: WorkerId;
  channel?: string;
  template_id: string;
  text: string;
  message_ref: string;
  thread_ref?: string;
}

/** One scripted inbound reply. */
export interface InboxLine {
  ts?: InstantISO;
  thread_ref: string;
  from_worker_id?: WorkerId;
  text: string;
  message_ref?: string;
}

export class FixtureChannelAdapter implements ChannelPort {
  private readonly outboxPath: string;
  private readonly inboxPath: string;
  private readonly actorWorkerId: WorkerId;
  private readonly now: () => Date;

  constructor(dataDir: string, actorWorkerId: WorkerId, now: () => Date) {
    this.outboxPath = join(dataDir, OUTBOX_FILENAME);
    this.inboxPath = join(dataDir, INBOX_FILENAME);
    this.actorWorkerId = actorWorkerId;
    this.now = now;
  }

  async sendDirect(input: DirectMessageInput): Promise<DeliveryResult> {
    const message_ref = `msg_${randomHex(4)}`;
    const line: OutboxLine = {
      ts: toInstant(this.now()),
      actor: this.actorWorkerId,
      to_worker_id: input.to_worker_id,
      template_id: input.template_id,
      text: input.text,
      message_ref,
      ...(input.thread_ref === undefined ? {} : { thread_ref: input.thread_ref }),
    };
    appendJsonLine(this.outboxPath, line);
    return { delivered: true, message_ref };
  }

  async postChannel(input: ChannelMessageInput): Promise<PostResult> {
    const message_ref = `msg_${randomHex(4)}`;
    const line: OutboxLine = {
      ts: toInstant(this.now()),
      actor: this.actorWorkerId,
      channel: input.channel,
      template_id: input.template_id,
      text: input.text,
      message_ref,
    };
    appendJsonLine(this.outboxPath, line);
    return { message_ref };
  }

  /** Replies on one thread, in file order. Always untrusted — the caller scans them. */
  async readReplies(thread_ref: string): Promise<UntrustedDocument[]> {
    return readJsonLines<InboxLine>(this.inboxPath)
      .filter((line) => line.thread_ref === thread_ref)
      .map((line, index) => ({
        ref: line.message_ref ?? `${thread_ref}#${index}`,
        text: typeof line.text === 'string' ? line.text : '',
        source: 'slack' as const,
        untrusted: true as const,
      }));
  }
}
