import test from 'node:test'
import assert from 'node:assert/strict'
import {assertRemoteMergeRequest} from './remote-uat-business-recheck.mjs'
import {localOrigin} from '../../../../scripts/local-acceptance-readonly.mjs'
test('远程合并只允许精确UAT3 API路径及方法',()=>{
 for(const p of ['/api/dataset/dataset/allProcessLinkProduction','/api/dataset/dataset/merge-preview','/api/dataset/dataset/do-merge'])assert.doesNotThrow(()=>assertRemoteMergeRequest('https://editor3.hiqdat.dev',p,'POST'))
 assert.doesNotThrow(()=>assertRemoteMergeRequest('https://editor3.hiqdat.dev','/api/sso/user/info/current?productCode=hiq_editor','GET'))
})
test('SPA、异源、混淆路径和方法在发送前拒绝',()=>{
 for(const [o,p,m]of [['https://editor3.hiqdat.dev','/dataset/merge-preview','POST'],['https://editor2.hiqdat.dev','/api/dataset/dataset/do-merge','POST'],['https://editor3.hiqdat.dev','/api/dataset/dataset/do-merge?x=1','POST'],['https://editor3.hiqdat.dev','/api/dataset/dataset/merge-preview','GET'],['https://editor3.hiqdat.dev','/api/dataset/dataset/%2edo-merge','POST']])assert.throws(()=>assertRemoteMergeRequest(o,p,m),{code:'REMOTE_UAT_REQUEST_PATH_NOT_ALLOWED'})
})
test('原本地origin不接受远程UAT',()=>{assert.throws(()=>localOrigin('https://editor3.hiqdat.dev'));assert.equal(localOrigin('http://127.0.0.1:19000'),'http://127.0.0.1:19000')})
