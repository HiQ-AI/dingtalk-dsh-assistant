import test from 'node:test'
import assert from 'node:assert/strict'
import {retireOne} from '../scripts/retire-outbox-notification.mjs'
test('CLI defaults to GET and explicit apply posts only one retirement after matching reviewed digest',async()=>{
 const calls=[],snapshot={expectedFactDigest:'a'.repeat(64)}
 const request=async(url,options)=>{calls.push({url,options});return{ok:true,json:async()=>options?{notification:{id:'n',status:'superseded'}}:snapshot}}
 const input={notificationId:'n',supersededByNotificationId:'k'}
 assert.deepEqual(await retireOne(input,request),snapshot);assert.equal(calls.length,1);assert.equal(calls[0].options,undefined)
 await assert.rejects(retireOne({...input,apply:true,requestId:'r',expectedFactDigest:'b'.repeat(64)},request),/CHANGED/);assert.equal(calls.length,2)
 await retireOne({...input,apply:true,requestId:'r',expectedFactDigest:'a'.repeat(64)},request)
 assert.equal(calls.length,4);assert.equal(calls[3].options.method,'POST')
 assert.ok(calls.every(c=>new URL(c.url).pathname==='/workflows/notifications/n/retirement'))
 assert.deepEqual(JSON.parse(calls[3].options.body),{requestId:'r',supersededByNotificationId:'k',expectedFactDigest:'a'.repeat(64)})
 await assert.rejects(retireOne({...input,notificationIds:['other']},request),/SINGLE/)
})
