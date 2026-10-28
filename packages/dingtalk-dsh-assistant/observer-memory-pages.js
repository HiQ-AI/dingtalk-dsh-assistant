import {randomUUID} from 'node:crypto'
// Index only IDs, sort keys and filter memberships. Payload projection happens AFTER
// selecting a page. A replaced source invalidates its cursor explicitly.
export class ObserverMemoryPages {
  constructor() { this.collections = new Map(); this.sequence = 0; this.instance=randomUUID() }
  replace(key, version, rows) {
    const prior = this.collections.get(key)
    if (prior?.version === version) return prior
    const ordered = [...rows].sort((a,b) => String(b.sort ?? '').localeCompare(String(a.sort ?? '')) || String(a.order??a.id).localeCompare(String(b.order??b.id)))
    const filters = new Map([['all', ordered.map(row=>row.id)]])
    for(const row of ordered) for(const filter of new Set(row.filters || [])) {
      if(filter==='all')continue
      if(!filters.has(filter))filters.set(filter,[])
      filters.get(filter).push(row.id)
    }
    const collection = {version,revision:`${this.instance}:${++this.sequence}`,filters}
    this.collections.set(key,collection)
    return collection
  }
  async page(key, {offset=0,limit=20,filter='all',revision}={}, read) {
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Object.assign(new Error('OBSERVER_PAGE_INVALID'),{code:'OBSERVER_PAGE_INVALID'})
    const collection=this.collections.get(key)
    if(!collection)throw new Error('OBSERVER_INDEX_NOT_READY')
    if(revision && revision!==collection.revision)throw Object.assign(new Error('OBSERVER_PAGE_STALE'),{code:'OBSERVER_PAGE_STALE'})
    const ids=collection.filters.get(filter)||[], selected=ids.slice(offset,offset+limit)
    const items=await Promise.all(selected.map(read))
    if(this.collections.get(key)!==collection)throw Object.assign(new Error('OBSERVER_PAGE_STALE'),{code:'OBSERVER_PAGE_STALE'})
    return {items,total:ids.length,offset,limit,revision:collection.revision,nextOffset:offset+selected.length<ids.length?offset+selected.length:null}
  }
}
