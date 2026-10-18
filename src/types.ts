export type Risk = 'low' | 'medium' | 'high';

export interface Finding {
  id: string;
  severity: Risk;
  title: string;
  detail: string;
  location?: string;
}

export type PlanAction = 'create' | 'update' | 'delete' | 'replace' | 'read' | 'no-op';

export interface PlanChange {
  address: string;
  type: string;
  action: PlanAction;
  before: Record<string, any> | null;
  after: Record<string, any> | null;
}

export interface ChangedFile {
  filename: string;
  status: string;
  patch?: string;
}

export interface AiReview {
  risk: Risk;
  summary: string;
  blastRadius: string[];
  rollback: string[];
}

export const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

export function maxRisk(a: Risk, b: Risk): Risk {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}
