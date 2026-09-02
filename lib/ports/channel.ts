/**
 * lib/ports/channel.ts — the human channel (Slack in the POC).
 *
 * Owns: `ChannelPort`. Messages are sent *as the acting user* from templates with facts
 * injected; replies come back as `UntrustedDocument` and are data, never instructions.
 *
 * Public interface: `ChannelPort`, `DirectMessageInput`, `ChannelMessageInput`,
 * `DeliveryResult`, `PostResult`.
 *
 * Rippling backing: none — Rippling exposes no Slack or messaging surface (research 06).
 * The POC brings Slack's own API/MCP; `TL_ADAPTER=fixture` writes to `TL_DATA_DIR/outbox.jsonl`
 * and reads scripted replies from `TL_DATA_DIR/inbox.jsonl`.
 *
 * Spec: docs/SPEC.md §2, §7 (do), §9 (allowlist); docs/PLAN.md §2.3, §2.4.
 */

import type { UntrustedDocument, WorkerId } from '#lib/types/tier1.ts';

export interface DirectMessageInput {
  to_worker_id: WorkerId;
  text: string;
  template_id: string;
  thread_ref?: string;
}

export interface ChannelMessageInput {
  channel: string;
  text: string;
  template_id: string;
}

export interface DeliveryResult {
  delivered: boolean;
  message_ref: string;
}

export interface PostResult {
  message_ref: string;
}

export interface ChannelPort {
  /** Allowlisted write. Recipient must be in the cycle (policy check lives in the engine). */
  sendDirect(input: DirectMessageInput): Promise<DeliveryResult>;
  /** Allowlisted write. Summaries to the cycle owner's channel. */
  postChannel(input: ChannelMessageInput): Promise<PostResult>;
  /** Untrusted. Any imperative aimed at the agent is recorded as `tl_anomaly`. */
  readReplies(thread_ref: string): Promise<UntrustedDocument[]>;
}
