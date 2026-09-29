import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
const candidate=process.env.HOST_BACKGROUND_TEST_JAR
const bin=process.env.JAVA_HOME?join(process.env.JAVA_HOME,'bin'):''
test('真实Spring候选上下文：正常开关通过，注释伪控制与新增消费者拒绝', {skip:!candidate},async()=>{
 const root=await mkdtemp(join(tmpdir(),'host-background-proof-')),classes=join(root,'probe'),bad=join(root,'bad'),fresh=join(root,'fresh')
 for(const dir of [classes,bad,fresh])await mkdir(dir)
 const exec=(name,args)=>spawnSync(join(bin,name+(process.platform==='win32'?'.exe':'')),args,{encoding:'utf8',windowsHide:true,timeout:30000})
 assert.equal(exec('javac',['-encoding','UTF-8','-d',classes,resolve('scripts/LocalAcceptanceBackground.java')]).status,0)
 const run=(extra='',scan=candidate)=>exec('java',[`-Dloader.path=${extra?extra+',':''}${classes}`,'-Dloader.main=LocalAcceptanceBackground','-cp',candidate,'org.springframework.boot.loader.PropertiesLauncher',scan])
 const good=run();assert.equal(good.status,0,good.stderr);assert.match(good.stdout,/HOST_BACKGROUND_PROOF:/)
 const falseControl=join(bad,'ApprovalReminderTask.java')
 await writeFile(falseControl,'package com.ecdigit.ecdata.task; /* @ConditionalOnProperty(name="app.background-jobs.enabled", havingValue="true", matchIfMissing=true) */ public class ApprovalReminderTask {}')
 assert.equal(exec('javac',['-d',bad,falseControl]).status,0)
 const badResult=run(bad);assert.notEqual(badResult.status,0);assert.match(badResult.stderr,/CONTROLLED_BEAN_MODE_INVALID:false/)
 const unused=join(root,'unused');await mkdir(join(unused,'com/ecdigit/ecdata/service'),{recursive:true})
 const patch=join(root,'Patch.java')
 await writeFile(patch,`import java.util.jar.*;import java.nio.file.*;public class Patch{public static void main(String[] a)throws Exception{try(JarFile j=new JarFile(a[0])){byte[] b=j.getInputStream(j.getJarEntry("BOOT-INF/classes/com/ecdigit/ecdata/service/BlacklistCacheService.class")).readAllBytes();String s=new String(b,java.nio.charset.StandardCharsets.ISO_8859_1);if(!s.contains("background-jobs.enabled"))throw new Exception();s=s.replace("background-jobs.enabled","background-jobs.disable");Files.write(Paths.get(a[1]),s.getBytes(java.nio.charset.StandardCharsets.ISO_8859_1));}}}`)
 assert.equal(exec('javac',['-d',root,patch]).status,0)
 assert.equal(exec('java',['-cp',root,'Patch',candidate,join(unused,'com/ecdigit/ecdata/service/BlacklistCacheService.class')]).status,0)
 const unusedResult=run(unused);assert.notEqual(unusedResult.status,0);assert.match(unusedResult.stderr,/BLACKLIST_BACKGROUND_MODE_INVALID:false/)
 await writeFile(join(fresh,'Scheduled.java'),'package org.springframework.scheduling.annotation; @java.lang.annotation.Retention(java.lang.annotation.RetentionPolicy.RUNTIME) public @interface Scheduled {}')
 await writeFile(join(fresh,'NewConsumer.java'),'package com.example; public class NewConsumer { @org.springframework.scheduling.annotation.Scheduled public void execute() {} }')
 assert.equal(exec('javac',['-d',fresh,join(fresh,'Scheduled.java'),join(fresh,'NewConsumer.java')]).status,0)
 const entries=join(root,'entries','BOOT-INF','classes');await mkdir(entries,{recursive:true})
 const {copyFile}=await import('node:fs/promises');await mkdir(join(entries,'com/example'),{recursive:true});await copyFile(join(fresh,'com/example/NewConsumer.class'),join(entries,'com/example/NewConsumer.class'))
 const scan=join(root,'scan.jar');assert.equal(exec('jar',['cf',scan,'-C',join(root,'entries'),'.']).status,0)
 const extra=run(fresh,scan);assert.notEqual(extra.status,0);assert.match(extra.stderr,/UNREVIEWED_BACKGROUND_ENTRY:com.example.NewConsumer/)
})
