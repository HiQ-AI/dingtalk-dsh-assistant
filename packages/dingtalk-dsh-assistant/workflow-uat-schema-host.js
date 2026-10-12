import { executionDigest, executionError } from './execution-artifacts.js'
import { validateUatSchemaTarget, validateUatSchemaSql } from './workflow-uat-schema-migration.js'
const fail = code => { throw executionError(code) }
const canonicalDefinition = text => text.replace(/::(?:character varying|text)(?:\[\])?/g, '').replace(/[\s()]/g, '')
function approvedShape(columns, constraints, indexes) {
  const shared = ['tenant_id','version_id','submission_id']
  const names = {
    te_activity_merge_candidate: ['tenant_id','version_id','candidate_snapshot_id','created_by','snapshot_json','created_at'],
    te_activity_merge_submission: [...shared,'acknowledged','request_json','created_by','created_at'],
    te_activity_merge_outcome: [...shared,'group_key','activity_name','selected_ids','status'],
  }
  if (columns.length !== 20 || Object.entries(names).some(([table, fields]) => {
    const actual = columns.filter(column => column.table_name === table)
    return actual.length !== fields.length || actual.some((column,index) => {
      const name=fields[index], type=name==='created_at'?'timestamp with time zone':name==='acknowledged'?'boolean':['snapshot_json','request_json','activity_name','selected_ids'].includes(name)?'text':`character varying(${name==='group_key'?128:name==='status'?16:64})`
      return column.column_name!==name || column.type!==type || column.not_null!==true || column.default_expression!==(name==='created_at'?'now()':name==='acknowledged'?'false':null)
    })
  })) return false
  const expected = [
    ['te_activity_merge_candidate','p','PRIMARY KEY (tenant_id, version_id, candidate_snapshot_id)'],
    ['te_activity_merge_submission','p','PRIMARY KEY (tenant_id, version_id, submission_id)'],
    ['te_activity_merge_outcome','p','PRIMARY KEY (tenant_id, version_id, submission_id, group_key)'],
    ['te_activity_merge_outcome','f','FOREIGN KEY (tenant_id, version_id, submission_id) REFERENCES te_activity_merge_submission(tenant_id, version_id, submission_id)'],
    ['te_activity_merge_outcome','c',"CHECK (status = ANY (ARRAY['PENDING','SUCCESS','FAILED']))"],
  ]
  if (constraints.length !== 5 || expected.some(([table,kind,definition])=>!constraints.some(row=>row.table_name===table&&row.kind===kind&&canonicalDefinition(row.definition)===canonicalDefinition(definition)))) return false
  const definitions = Object.keys(names).map(table=>`CREATE UNIQUE INDEX ${table}_pkey ON public.${table} USING btree (${expected.find(([name,kind])=>name===table&&kind==='p')[2].slice(13,-1)})`)
  definitions.push('CREATE INDEX ix_activity_merge_pending ON public.te_activity_merge_outcome USING btree (tenant_id, version_id, status)')
  return indexes.length===4 && indexes.every(row=>row.valid&&row.ready&&definitions.some(definition=>canonicalDefinition(row.definition)===canonicalDefinition(definition)))
}
const markerPrefix = 'dsh-uat-schema-v1:'
export function createUatSchemaMigrationHost({ connection, Client }) {
  if (connection?.host !== '192.168.8.8' || Number(connection.port) !== 30770 || connection.database !== 'hiq_editor')
    fail('UAT_SCHEMA_CONNECTION_NOT_ALLOWED')
  const connect = async () => { const client = new Client({ ...connection, connectionTimeoutMillis: 15000 }); await client.connect(); return client }
  async function snapshot(client, target, migrationKey) {
    const identity = (await client.query('SELECT current_database() AS database')).rows[0]
    if (identity?.database !== target.database) fail('UAT_SCHEMA_DATABASE_MISMATCH')
    const tables = (await client.query(`SELECT c.relname AS name, c.relkind AS kind,
      obj_description(c.oid, 'pg_class') AS marker FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) ORDER BY c.relname`, [target.schema, target.tables])).rows
    if (!tables.length) return { status: 'unseen', evidenceRefs: [`postgres-uat-schema-empty:${migrationKey}`] }
    if (tables.length !== 3 || tables.some(row => row.kind !== 'r')) fail('UAT_SCHEMA_BASELINE_CONFLICT')
    const columns = (await client.query(`SELECT c.relname AS table_name,a.attname AS column_name,
      format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,
      pg_get_expr(d.adbin,d.adrelid) AS default_expression FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) ORDER BY c.relname,a.attnum`, [target.schema,target.tables])).rows
    const constraints = (await client.query(`SELECT c.relname AS table_name,k.contype AS kind,pg_get_constraintdef(k.oid) AS definition
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) ORDER BY c.relname,k.contype,pg_get_constraintdef(k.oid)`, [target.schema,target.tables])).rows
    const indexes = (await client.query(`SELECT c.relname AS table_name,i.relname AS name,pg_get_indexdef(i.oid) AS definition,
      x.indisvalid AS valid,x.indisready AS ready FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid
      JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) ORDER BY c.relname,i.relname`,[target.schema,target.tables])).rows
    const schemaDigest = executionDigest({ columns, constraints, indexes })
    if (!approvedShape(columns,constraints,indexes)) return { status: 'unmarked', schemaDigest, evidenceRefs: [], reason: 'UAT_SCHEMA_APPROVED_SHAPE_MISMATCH' }
    const marker = `${markerPrefix}${migrationKey}:${schemaDigest}`
    if (tables.some(row => row.marker !== marker)) return { status: 'unmarked', schemaDigest, evidenceRefs: [] }
    return { status: 'succeeded', schemaDigest, evidenceRefs: [`postgres-uat-schema:${migrationKey}:${schemaDigest}`] }
  }
  async function reconcile({ target, migrationKey }) {
    validateUatSchemaTarget(target)
    if (migrationKey !== executionDigest(target)) fail('UAT_SCHEMA_MIGRATION_IDENTITY_INVALID')
    const client = await connect()
    try { await client.query('BEGIN READ ONLY'); await client.query("SET LOCAL lock_timeout='15s'; SET LOCAL statement_timeout='60s'; SET LOCAL search_path=public"); await client.query('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1,0))',[migrationKey]); const result = await snapshot(client,target,migrationKey); await client.query('ROLLBACK'); return result }
    finally { await client.end() }
  }
  async function apply({ target, migrationKey, sql }) {
    validateUatSchemaTarget(target); validateUatSchemaSql(sql)
    if (migrationKey !== executionDigest(target)) fail('UAT_SCHEMA_MIGRATION_IDENTITY_INVALID')
    const client = await connect(); let commitAttempted = false
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL lock_timeout='15s'; SET LOCAL statement_timeout='60s'; SET LOCAL search_path=public")
      await client.query('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1,0))',[migrationKey])
      const before = await snapshot(client,target,migrationKey)
      if (before.status === 'succeeded') { await client.query('ROLLBACK'); return before }
      if (before.status !== 'unseen') fail('UAT_SCHEMA_BASELINE_CONFLICT')
      await client.query(sql)
      const built = await snapshot(client,target,migrationKey)
      if (built.status !== 'unmarked') fail('UAT_SCHEMA_CREATED_SHAPE_INVALID')
      // The marker is committed atomically with the approved three-table DDL. No extra ledger table or existing object is changed.
      const marker = `${markerPrefix}${migrationKey}:${built.schemaDigest}`
      for (const name of target.tables) await client.query(`COMMENT ON TABLE public.${name} IS '${marker}'`)
      const verified = await snapshot(client,target,migrationKey)
      if (verified.status !== 'succeeded') fail('UAT_SCHEMA_CREATED_SHAPE_INVALID')
      commitAttempted = true
      await client.query('COMMIT')
      return verified
    } catch (error) {
      if (!commitAttempted) {
        try { await client.query('ROLLBACK') } catch { /* Native unknown effect will reconcile only after this connection ends. */ }
      }
      const code = commitAttempted ? 'UAT_SCHEMA_COMMIT_UNCONFIRMED' : 'UAT_SCHEMA_TRANSACTION_FAILED'
      const cause = /^[A-Z0-9]{5}$/.test(error?.code ?? '') ? error.code : /^UAT_SCHEMA_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'TRANSPORT_OR_RUNTIME_FAILURE'
      throw executionError(code, `${code}:${cause}`)
    } finally { await client.end() }
  }
  return { apply, reconcile }
}
