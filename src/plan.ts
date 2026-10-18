import { PlanAction, PlanChange } from './types';

export function parsePlan(json: string): PlanChange[] {
  const plan = JSON.parse(json);
  const changes: any[] = plan.resource_changes ?? [];
  return changes
    .map((rc) => ({
      address: rc.address as string,
      type: rc.type as string,
      action: toAction(rc.change?.actions ?? []),
      before: rc.change?.before ?? null,
      after: rc.change?.after ?? null,
    }))
    .filter((c) => c.action !== 'no-op' && c.action !== 'read');
}

export function toAction(actions: string[]): PlanAction {
  if (actions.includes('delete') && actions.includes('create')) return 'replace';
  if (actions.includes('delete')) return 'delete';
  if (actions.includes('create')) return 'create';
  if (actions.includes('update')) return 'update';
  if (actions.includes('read')) return 'read';
  return 'no-op';
}

export function summarizePlan(changes: PlanChange[]): string {
  return changes.map((c) => `${c.action.toUpperCase()} ${c.address}`).join('\n');
}
