/**
 * Tenant policy layer (block B0.3) — public entry point.
 *
 * Owns: the single import surface for tenant policy. Engine, CLIs and doctor import
 * `#lib/policy/index.ts`; nothing outside this directory reads `tenant/policy.yml`.
 * Spec §5, §7, §8; plan §2.6.
 *
 * Public interface: everything exported by `schema.ts` (types + literal unions)
 * and `load.ts` (`loadPolicy`, `validatePolicy`, `isTemplatePolicy`,
 * `defaultPolicyPath`, `PolicyError`, filenames).
 */

export {
  CHANNEL_KINDS,
  ESCALATION_TARGETS,
  POLICY_SECTIONS,
  POLICY_TOP_LEVEL_KEYS,
} from '#lib/policy/schema.ts';
export type {
  AbsencePolicy,
  CadencePolicy,
  ChannelKind,
  ChannelsPolicy,
  EscalationPolicy,
  EscalationTarget,
  InterviewLoopPolicy,
  PolicySection,
  QuietHoursPolicy,
  ReviewCyclePolicy,
  StaggerDays,
  TenantIdentity,
  TenantPolicy,
} from '#lib/policy/schema.ts';

export {
  defaultPolicyPath,
  isTemplatePolicy,
  loadPolicy,
  PolicyError,
  POLICY_FILENAME,
  POLICY_TEMPLATE_FILENAME,
  validatePolicy,
} from '#lib/policy/load.ts';
