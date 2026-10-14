import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { inspectLedger } from './inspect-quiescent-ledger.mjs'

test('offline deployment refuses a live owner and unfinished rounds, accepts retained dead-owner metadata without changing unknown facts', async t => {
 const root=await mkdtemp(join(tmpdir(),'task-deploy-proof-')),path=join(root,'ledger.sqlite')
 const db=new DatabaseSync(path)
 t.after(async()=>{db.close();await rm(root,{recursive:true,force:true})})
 db.exec('CREATE TABLE dynamic_meta(key TEXT PRIMARY KEY,value TEXT)')
 for(const name of ['tasks','executions','groups','operations','notifications'])db.exec(`CREATE TABLE dynamic_${name}(body TEXT)`)
 db.prepare('INSERT INTO dynamic_meta VALUES (?,?)').run('owner',`${process.pid}:live`)
 db.prepare('INSERT INTO dynamic_operations VALUES (?)').run(JSON.stringify({state:'unknown'}))
 assert.throws(()=>inspectLedger(path,root,true),/DEPLOY_OWNER_NOT_RELEASED/)
 const child=spawnSync(process.execPath,['-e',''],{windowsHide:true})
 assert.equal(child.status,0)
 db.prepare('UPDATE dynamic_meta SET value=? WHERE key=?').run(`${child.pid}:stale`,'owner')
 const proof=inspectLedger(path,root,true)
 assert.equal(proof.ownerReleased,false);assert.equal(proof.ownerProcessExited,true);assert.equal(proof.staleOwner,true)
 assert.equal(proof.unknownOperations,1)
 assert.equal(db.prepare('SELECT value FROM dynamic_meta WHERE key=?').get('owner').value,`${child.pid}:stale`)
 assert.equal(JSON.parse(db.prepare('SELECT body FROM dynamic_operations').get().body).state,'unknown')
 db.prepare('INSERT INTO dynamic_tasks VALUES (?)').run(JSON.stringify({taskId:'busy',drained:false}))
 assert.throws(()=>inspectLedger(path,root,true),/DEPLOY_NOT_DRAINED/)
})
