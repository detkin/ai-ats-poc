/**
 * lib/adapters/rippling/index.ts — the `TL_ADAPTER=rippling` port set.
 *
 * Owns: `buildRipplingPorts` and `RipplingChannel`. The channel has no Rippling backing at
 * all — Rippling exposes no messaging surface (research 06), so the "rippling" runtime's
 * channel is Slack's own API and its stub points at `docs/QUESTIONS.md` Q3 rather than Q2.
 *
 * Nothing in this family talks to a network. Every method throws `RipplingNotConnectedError`
 * naming the exact call it would have made, which is the honest state of the POC: fixtures
 * run end to end, a real tenant is a conversation with the user (project mandate, "Rippling
 * MCP: … STOP, write the exact need to docs/QUESTIONS.md").
 *
 * Public interface: `buildRipplingPorts`, `RipplingChannel`, `CHANNEL_BACKING`, plus
 * re-exports of the MCP and REST stubs.
 *
 * Spec: docs/SPEC.md §2, §9, §11; docs/PLAN.md §2.3; docs/QUESTIONS.md Q2, Q3.
 */

import { RipplingNotConnectedError } from '#lib/adapters/rippling/mcp.ts';
import {
  RipplingAvailability,
  RipplingGraph,
  RipplingLedger,
  RipplingState,
} from '#lib/adapters/rippling/mcp.ts';
import { RipplingAts, RipplingBands } from '#lib/adapters/rippling/rest.ts';
import type {
  ChannelMessageInput,
  ChannelPort,
  DeliveryResult,
  DirectMessageInput,
  PostResult,
} from '#lib/ports/channel.ts';
import type { Ports } from '#lib/ports/index.ts';
import type { UntrustedDocument } from '#lib/types/tier1.ts';

export {
  CODEMODE_FUNCTIONS,
  MCP_BACKING,
  RIPPLING_QUESTION_REF,
  RipplingAvailability,
  RipplingGraph,
  RipplingLedger,
  RipplingNotConnectedError,
  RipplingState,
  codemode,
} from '#lib/adapters/rippling/mcp.ts';
export type { CodemodeFunction } from '#lib/adapters/rippling/mcp.ts';
export {
  REST_BACKING,
  REST_BASE_URL,
  REST_RESOURCES,
  RipplingAts,
  RipplingBands,
} from '#lib/adapters/rippling/rest.ts';

const SLACK_QUESTION_REF = 'docs/QUESTIONS.md Q3 (Slack and Google Calendar)';

/** Port method → the Slack API call that would serve it. Rippling has none. */
export const CHANNEL_BACKING = {
  sendDirect: 'slack.chat.postMessage (DM as the acting user)',
  postChannel: 'slack.chat.postMessage (channel)',
  readReplies: 'slack.conversations.replies',
} as const;

export class RipplingChannel implements ChannelPort {
  async sendDirect(_input: DirectMessageInput): Promise<DeliveryResult> {
    throw new RipplingNotConnectedError(CHANNEL_BACKING.sendDirect, SLACK_QUESTION_REF);
  }
  async postChannel(_input: ChannelMessageInput): Promise<PostResult> {
    throw new RipplingNotConnectedError(CHANNEL_BACKING.postChannel, SLACK_QUESTION_REF);
  }
  async readReplies(_threadRef: string): Promise<UntrustedDocument[]> {
    throw new RipplingNotConnectedError(CHANNEL_BACKING.readReplies, SLACK_QUESTION_REF);
  }
}

/** The seven ports for `TL_ADAPTER=rippling`. Constructing them is free; calling them is not. */
export function buildRipplingPorts(): Ports {
  return {
    graph: new RipplingGraph(),
    ats: new RipplingAts(),
    bands: new RipplingBands(),
    availability: new RipplingAvailability(),
    channel: new RipplingChannel(),
    state: new RipplingState(),
    ledger: new RipplingLedger(),
  };
}
