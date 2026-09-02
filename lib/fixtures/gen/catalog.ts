/**
 * lib/fixtures/gen/catalog.ts — the fixed skeleton of the Acme Robotics fixture tenant.
 *
 * Owns: the levels, locations, department and team specs, the title tables and the
 * hand-pinned worker ids the demo scenarios reference by name. Nothing here is random:
 * worker ids are allocated in the order declared below (CEO, department heads, team leads,
 * then ICs team by team), which is what lets `fixtures/README.md` name specific rows.
 *
 * Public interface: `LEVELS`, `LOCATIONS`, `DEPARTMENT_SPECS`, `TEAM_SPECS`, `EXEC_TEAM`,
 * `IC_TITLES`, `MANAGER_TITLE_BY_LEVEL`, `FUNCTION_LABEL`, `PINNED`, `workerId`.
 *
 * Spec: docs/SPEC.md §5 (fixture tenant), §8; docs/PLAN.md §3 block B0.4.
 */

import type { DepartmentId, JobFunction, Level, Location, TeamId } from '#lib/types/tier1.ts';

export const LEVELS: Level[] = [
  { id: 'lvl_L3', name: 'L3', track: 'IC', rank: 3 },
  { id: 'lvl_L4', name: 'L4', track: 'IC', rank: 4 },
  { id: 'lvl_L5', name: 'L5', track: 'IC', rank: 5 },
  { id: 'lvl_L6', name: 'L6', track: 'IC', rank: 6 },
  { id: 'lvl_L7', name: 'L7', track: 'IC', rank: 7 },
  { id: 'lvl_M1', name: 'M1', track: 'M', rank: 5 },
  { id: 'lvl_M2', name: 'M2', track: 'M', rank: 6 },
  { id: 'lvl_M3', name: 'M3', track: 'M', rank: 7 },
  { id: 'lvl_E1', name: 'E1', track: 'E', rank: 8 },
];

export const LOCATIONS: Location[] = [
  {
    id: 'loc_sf',
    name: 'San Francisco',
    country: 'US',
    timezone: 'America/Los_Angeles',
    work_hours: { start: '09:00', end: '18:00' },
    location_group: 'US',
  },
  {
    id: 'loc_nyc',
    name: 'New York',
    country: 'US',
    timezone: 'America/New_York',
    work_hours: { start: '09:00', end: '18:00' },
    location_group: 'US',
  },
  {
    id: 'loc_blr',
    name: 'Bangalore',
    country: 'IN',
    timezone: 'Asia/Kolkata',
    work_hours: { start: '10:00', end: '19:00' },
    location_group: 'IN',
  },
  {
    id: 'loc_remote_us',
    name: 'Remote (US)',
    country: 'US',
    timezone: 'America/Chicago',
    work_hours: { start: '09:00', end: '17:30' },
    location_group: 'US',
  },
];

/** Weights over `LOCATIONS`, in the same order. */
export const LOCATION_WEIGHTS = [40, 20, 25, 15] as const;

export interface DepartmentSpec {
  id: DepartmentId;
  name: string;
  job_function: JobFunction;
  /** Total headcount, including the department head and its team leads. */
  headcount: number;
  /** Level of the department head. `null` for G&A, whose head is the CEO. */
  head_level_id: string | null;
}

/** Declaration order fixes department-head worker ids w_0002…w_0006 (G&A's head is w_0001). */
export const DEPARTMENT_SPECS: DepartmentSpec[] = [
  {
    id: 'dept_eng',
    name: 'Engineering',
    job_function: 'engineering',
    headcount: 45,
    head_level_id: 'lvl_M3',
  },
  {
    id: 'dept_product',
    name: 'Product',
    job_function: 'product',
    headcount: 12,
    head_level_id: 'lvl_M2',
  },
  {
    id: 'dept_design',
    name: 'Design',
    job_function: 'design',
    headcount: 8,
    head_level_id: 'lvl_M2',
  },
  {
    id: 'dept_sales',
    name: 'Sales',
    job_function: 'sales',
    headcount: 25,
    head_level_id: 'lvl_M3',
  },
  {
    id: 'dept_cs',
    name: 'Customer Success',
    job_function: 'customer_success',
    headcount: 15,
    head_level_id: 'lvl_M2',
  },
  { id: 'dept_ga', name: 'G&A', job_function: 'ga', headcount: 15, head_level_id: null },
];

export interface TeamSpec {
  id: TeamId;
  name: string;
  department_id: DepartmentId;
  lead_level_id: string;
  /** Individual contributors reporting to the team lead. */
  ic_count: number;
  /** Overrides the derived title for the team lead. */
  lead_title?: string;
}

/** Declaration order fixes team-lead worker ids w_0007…w_0022, then ICs w_0023…w_0120. */
export const TEAM_SPECS: TeamSpec[] = [
  {
    id: 'team_platform',
    name: 'Platform',
    department_id: 'dept_eng',
    lead_level_id: 'lvl_M2',
    ic_count: 9,
    lead_title: 'Director, Platform Engineering',
  },
  {
    id: 'team_product_eng',
    name: 'Product Engineering',
    department_id: 'dept_eng',
    lead_level_id: 'lvl_M2',
    ic_count: 8,
  },
  {
    id: 'team_infra',
    name: 'Infrastructure',
    department_id: 'dept_eng',
    lead_level_id: 'lvl_M1',
    ic_count: 8,
  },
  {
    id: 'team_data',
    name: 'Data',
    department_id: 'dept_eng',
    lead_level_id: 'lvl_M1',
    ic_count: 7,
  },
  {
    id: 'team_mobile',
    name: 'Mobile',
    department_id: 'dept_eng',
    lead_level_id: 'lvl_M1',
    ic_count: 7,
  },
  {
    id: 'team_product_core',
    name: 'Core Product',
    department_id: 'dept_product',
    lead_level_id: 'lvl_M1',
    ic_count: 5,
  },
  {
    id: 'team_product_growth',
    name: 'Growth Product',
    department_id: 'dept_product',
    lead_level_id: 'lvl_M1',
    ic_count: 4,
  },
  {
    id: 'team_design',
    name: 'Product Design',
    department_id: 'dept_design',
    lead_level_id: 'lvl_M1',
    ic_count: 6,
  },
  {
    id: 'team_sales_enterprise',
    name: 'Enterprise Sales',
    department_id: 'dept_sales',
    lead_level_id: 'lvl_M2',
    ic_count: 7,
  },
  {
    id: 'team_sales_midmarket',
    name: 'Mid-Market Sales',
    department_id: 'dept_sales',
    lead_level_id: 'lvl_M1',
    ic_count: 7,
  },
  {
    id: 'team_sales_smb',
    name: 'SMB Sales',
    department_id: 'dept_sales',
    lead_level_id: 'lvl_M1',
    ic_count: 7,
  },
  {
    id: 'team_cs_enterprise',
    name: 'Enterprise Customer Success',
    department_id: 'dept_cs',
    lead_level_id: 'lvl_M1',
    ic_count: 6,
  },
  {
    id: 'team_cs_smb',
    name: 'SMB Customer Success',
    department_id: 'dept_cs',
    lead_level_id: 'lvl_M1',
    ic_count: 6,
  },
  {
    id: 'team_finance',
    name: 'Finance',
    department_id: 'dept_ga',
    lead_level_id: 'lvl_M1',
    ic_count: 4,
  },
  {
    id: 'team_people',
    name: 'People',
    department_id: 'dept_ga',
    lead_level_id: 'lvl_M1',
    ic_count: 4,
    lead_title: 'HR Business Partner',
  },
  {
    id: 'team_legal',
    name: 'Legal & Workplace',
    department_id: 'dept_ga',
    lead_level_id: 'lvl_M1',
    ic_count: 3,
  },
];

/** The CEO's team. Has no lead of its own — the CEO leads it. */
export const EXEC_TEAM = { id: 'team_exec', name: 'Executive', department_id: 'dept_ga' } as const;

/** IC titles by job function, indexed by level rank 3…7. */
export const IC_TITLES: Record<JobFunction, readonly string[]> = {
  engineering: [
    'Software Engineer',
    'Software Engineer II',
    'Senior Software Engineer',
    'Staff Software Engineer',
    'Principal Software Engineer',
  ],
  product: [
    'Associate Product Manager',
    'Product Manager',
    'Senior Product Manager',
    'Staff Product Manager',
    'Principal Product Manager',
  ],
  design: [
    'Product Designer',
    'Product Designer II',
    'Senior Product Designer',
    'Staff Product Designer',
    'Principal Product Designer',
  ],
  sales: [
    'Sales Development Representative',
    'Account Executive',
    'Senior Account Executive',
    'Enterprise Account Executive',
    'Strategic Account Executive',
  ],
  customer_success: [
    'Associate Customer Success Manager',
    'Customer Success Manager',
    'Senior Customer Success Manager',
    'Staff Customer Success Manager',
    'Principal Customer Success Manager',
  ],
  ga: [
    'Business Analyst',
    'Business Analyst II',
    'Senior Business Analyst',
    'Staff Business Analyst',
    'Principal Business Analyst',
  ],
};

export const FUNCTION_LABEL: Record<JobFunction, string> = {
  engineering: 'Engineering',
  product: 'Product',
  design: 'Design',
  sales: 'Sales',
  customer_success: 'Customer Success',
  ga: 'G&A',
};

export const MANAGER_TITLE_BY_LEVEL: Record<string, string> = {
  lvl_M1: 'Manager',
  lvl_M2: 'Director',
  lvl_M3: 'VP',
};

/** `w_0001`-style ids; 1-based, zero-padded to four digits. */
export function workerId(oneBasedIndex: number): string {
  return `w_${String(oneBasedIndex).padStart(4, '0')}`;
}

/**
 * The rows the demo scenarios and `fixtures/README.md` name. Pinning them by id keeps the
 * README stable across regenerations even though every other person is drawn from the PRNG.
 */
export const PINNED = {
  /** Chief Executive Officer, the root of the org chart. */
  ceo: 'w_0001',
  /** VP, Engineering. */
  vp_engineering: 'w_0002',
  /** Director, Platform Engineering — hiring manager on `req_staff_eng`. */
  hiring_manager: 'w_0007',
  /** Product Engineering manager — the calibration outlier (prior ratings skew high). */
  outlier_manager: 'w_0008',
  /** Infrastructure manager — approved PTO over the anchor, returns 2026-09-04. */
  pto_manager_short: 'w_0009',
  /** Enterprise Sales director — approved PTO over the anchor, returns 2026-09-09. */
  pto_manager_long: 'w_0015',
  /** HR Business Partner — default acting identity and owner of the H2 review cycle. */
  hrbp: 'w_0021',
  /** Technical Recruiter — recruiter of record on every open requisition. */
  recruiter: 'w_0114',
  /** Product Engineering IC on parental leave through 2026-10-31. */
  parental_leave: 'w_0033',
  /** Deliberately paid below their band minimum. */
  below_band: ['w_0026', 'w_0043', 'w_0088', 'w_0101', 'w_0111'],
  /** Deliberately paid above their band maximum. */
  above_band: ['w_0024', 'w_0050', 'w_0079', 'w_0116', 'w_0012'],
  /** Engaged as contractors rather than employees. */
  contractors: ['w_0053', 'w_0060', 'w_0096', 'w_0103', 'w_0113', 'w_0120'],
} as const;
