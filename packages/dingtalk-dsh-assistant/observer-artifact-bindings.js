const error=code=>Object.assign(new Error(code),{code})
export function installObserverArtifactBindings(db){db.exec('CREATE TABLE IF NOT EXISTS observer_artifact_page_bindings(ref TEXT,view TEXT,root TEXT NOT NULL,PRIMARY KEY(ref,view))')}
const ready=db=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='observer_artifact_page_bindings'").get()
export function queryObserverArtifactBinding(db,{ref,view}){if(!ready(db))return null;return db.prepare('SELECT root FROM observer_artifact_page_bindings WHERE ref=? AND view=?').get(ref,view)?.root??null}
export function putObserverArtifactBinding(db,{ref,view,root},{replace=false}={}){
 if(!ready(db))throw error('OBSERVER_TEXT_MIGRATION_REQUIRED')
 if(typeof ref!=='string'||typeof view!=='string'||view.length>512||typeof root!=='string'||!/^[a-f0-9]{64}$/.test(root))throw error('OBSERVER_TEXT_BINDING_INVALID')
 const old=queryObserverArtifactBinding(db,{ref,view})
 if(old&&old!==root&&!replace)throw error('OBSERVER_TEXT_BINDING_CONFLICT')
 if(old!==root)db.prepare('INSERT INTO observer_artifact_page_bindings VALUES(?,?,?) ON CONFLICT(ref,view) DO UPDATE SET root=excluded.root').run(ref,view,root)
 return {bound:true}
}
