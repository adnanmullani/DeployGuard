
import { Finding, PlanChange } from './types';

const STATEFUL = new Set([
  'aws_db_instance', 'aws_rds_cluster', 'aws_dynamodb_table', 'aws_s3_bucket', 'aws_efs_file_system',
  'aws_elasticache_cluster', 'aws_elasticache_replication_group', 'aws_kms_key', 'aws_ebs_volume',
  'aws_redshift_cluster', 'aws_opensearch_domain', 'aws_msk_cluster',
  'google_sql_database_instance', 'google_storage_bucket', 'azurerm_mssql_database', 'azurerm_storage_account',
  'kubernetes_persistent_volume_claim',
]);

const SG_TYPES = new Set(['aws_security_group', 'aws_security_group_rule', 'aws_vpc_security_group_ingress_rule']);
const WORLD = ['0.0.0.0/0', '::/0'];

export function planRules(changes: PlanChange[]): Finding[] {
  const out: Finding[] = [];
  for (const c of changes) {
    const stateful = STATEFUL.has(c.type);
    if (c.action === 'delete') {
      out.push({
        id: 'plan-delete', severity: stateful ? 'high' : 'medium', location: c.address,
        title: `${c.address} will be DESTROYED`,
        detail: stateful ? 'Stateful resource: data loss is possible.' : 'Resource removal can break dependents.',
      });
    } else if (c.action === 'replace') {
      out.push({
        id: 'plan-replace', severity: stateful ? 'high' : 'medium', location: c.address,
        title: `${c.address} will be REPLACED`,
        detail: stateful
          ? 'Destroy and recreate: expect downtime and possible data loss.'
          : 'Destroy and recreate: expect a brief interruption.',
      });
    }
    if (c.action === 'delete' || !c.after) continue;
    const a = c.after;

    if (SG_TYPES.has(c.type) && hasWorldIngress(c)) {
      out.push({ id: 'open-ingress', severity: 'high', location: c.address, title: `${c.address} allows ingress from 0.0.0.0/0`, detail: 'Restrict the CIDR to known ranges.' });
    }
    if (
      c.type === 'aws_s3_bucket_public_access_block' &&
      ['block_public_acls', 'block_public_policy', 'ignore_public_acls', 'restrict_public_buckets'].some((k) => a[k] === false)
    ) {
      out.push({ id: 's3-public-block-off', severity: 'high', location: c.address, title: `${c.address} disables S3 public access protections`, detail: 'The bucket may become publicly readable.' });
    }
    if ((c.type === 'aws_s3_bucket' || c.type === 'aws_s3_bucket_acl') && /^public-read/.test(String(a.acl ?? ''))) {
      out.push({ id: 's3-public-acl', severity: 'high', location: c.address, title: `${c.address} uses a public ACL`, detail: `acl = ${a.acl}` });
    }
    if (c.type.startsWith('aws_iam_') && typeof a.policy === 'string' && wildcardPolicy(a.policy)) {
      out.push({ id: 'iam-wildcard', severity: 'high', location: c.address, title: `${c.address} grants Action "*" on Resource "*"`, detail: 'Apply least privilege.' });
    }
    if ((c.type === 'aws_db_instance' || c.type === 'aws_rds_cluster') && a.publicly_accessible === true) {
      out.push({ id: 'rds-public', severity: 'high', location: c.address, title: `${c.address} is publicly accessible`, detail: 'Databases should live in private subnets.' });
    }
    if (
      ((c.type === 'aws_db_instance' || c.type === 'aws_rds_cluster') && a.storage_encrypted === false) ||
      (c.type === 'aws_ebs_volume' && a.encrypted === false)
    ) {
      out.push({ id: 'unencrypted-storage', severity: 'medium', location: c.address, title: `${c.address} has encryption disabled`, detail: 'Enable storage encryption.' });
    }
  }
  return out;
}

function hasWorldIngress(c: PlanChange): boolean {
  const a = c.after ?? {};
  if (c.type === 'aws_security_group_rule' && a.type !== 'ingress') return false;
  if (WORLD.includes(a.cidr_ipv4) || WORLD.includes(a.cidr_ipv6)) return true;
  const lists = [a.cidr_blocks, a.ipv6_cidr_blocks];
  if (lists.some((l) => Array.isArray(l) && l.some((x: string) => WORLD.includes(x)))) return true;
  if (Array.isArray(a.ingress)) {
    return a.ingress.some((i: any) =>
      [...(i.cidr_blocks ?? []), ...(i.ipv6_cidr_blocks ?? [])].some((x: string) => WORLD.includes(x)),
    );
  }
  return false;
}

function wildcardPolicy(policy: string): boolean {
  try {
    const doc = JSON.parse(policy);
    const stmts = Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement];
    return stmts.some((s: any) => s?.Effect === 'Allow' && has(s.Action, '*') && has(s.Resource, '*'));
  } catch {
    return false;
  }
}
const has = (v: unknown, x: string) => (Array.isArray(v) ? v.includes(x) : v === x);

