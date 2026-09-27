import java.io.*;
import java.lang.reflect.*;
import java.net.*;
import java.nio.file.*;
import java.security.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.jar.*;

/** 受信 Host 探针：只载入候选类和隔离 Spring 上下文，不启动业务应用。 */
public class LocalAcceptanceBackground {
  static final String PREFIX = "com.ecdigit.ecdata.";
  static final String CACHE = PREFIX + "service.BlacklistCacheService";
  static final String MAPPER = PREFIX + "mapper.BlacklistWordMapper";
  static final List<String> CONTROLLED = new ArrayList<>(Arrays.asList(PREFIX+"task.ApprovalReminderTask", PREFIX+"task.DataQualityReportTask",
    PREFIX+"task.DatasourceVersionCalculateTask", PREFIX+"task.VersionDiffReportTimeoutTask",
    "com.hiqdata.convertor.domain.task.reconcile.TaskReconciler", PREFIX+"config.RedisStreamConsumerConfig",
    PREFIX+"controller.internal.ApprovalReminderDebugController"));
  static final String OUTBOX = PREFIX+"task.ApprovalNotificationOutboxTask";
  static ClassLoader loader;
  static final AtomicInteger denied = new AtomicInteger();
  static void deny(String reason) { denied.incrementAndGet(); throw new SecurityException(reason); }
  static Class<?> type(String name) throws Exception { return Class.forName(name, false, loader); }
  static Object call(Object object, String name, Class<?>[] types, Object... values) throws Exception {
    Method method=object.getClass().getMethod(name, types); method.setAccessible(true); return method.invoke(object, values);
  }
  static void require(boolean condition, String reason) { if (!condition) throw new IllegalStateException(reason); }
  static void property(Object context, String mode) throws Exception {

    Object environment=call(context,"getEnvironment",new Class<?>[0]);
    call(environment,"setActiveProfiles",new Class<?>[]{String[].class},(Object)new String[]{"local"}); if (mode.equals("default")) return;
    Object sources=call(environment,"getPropertySources",new Class<?>[0]);
    Object property=type("org.springframework.core.env.MapPropertySource").getConstructor(String.class,Map.class)
      .newInstance("host-background-mode",Collections.singletonMap("app.background-jobs.enabled",mode));
    call(sources,"addFirst",new Class<?>[]{type("org.springframework.core.env.PropertySource")},property);
  }
  static int controlled(String mode) throws Exception {
    Object context=type("org.springframework.context.annotation.AnnotationConfigApplicationContext").getConstructor().newInstance();
    property(context,mode);
    for(String name:CONTROLLED) call(context,"register",new Class<?>[]{Class[].class},(Object)new Class<?>[]{type(name)});
    String[] names=(String[])call(context,"getBeanDefinitionNames",new Class<?>[0]);
    Set<String> found=new HashSet<>();
    for(String name:names){Object bean=call(context,"getBeanDefinition",new Class<?>[]{String.class},name);Object classname=call(bean,"getBeanClassName",new Class<?>[0]);if(CONTROLLED.contains(classname))found.add((String)classname);}
    require(found.size()==(mode.equals("false")?0:CONTROLLED.size()),"CONTROLLED_BEAN_MODE_INVALID:"+mode+":"+found);
    // 未 refresh：正常模式仅验证注册，无服务构造、队列启动或真实客户端。
    call(context,"close",new Class<?>[0]);return found.size();
  }
  static int blacklist(String mode) throws Exception {
    Object context=type("org.springframework.context.annotation.AnnotationConfigApplicationContext").getConstructor().newInstance();
    property(context,mode);AtomicInteger reads=new AtomicInteger();
    Class<?> mapper=type(MAPPER);
    Object proxy=java.lang.reflect.Proxy.newProxyInstance(loader,new Class<?>[]{mapper},(p,m,a)->{
      if(m.getName().equals("selectList")){reads.incrementAndGet();return Collections.emptyList();}
      if(m.getName().equals("toString"))return "HostReadOnlyMapper";
      if(m.getName().equals("hashCode"))return System.identityHashCode(p);
      if(m.getName().equals("equals"))return p==a[0];
      throw new IllegalStateException("UNEXPECTED_MAPPER_OPERATION:"+m.getName());
    });
    Object factory=call(context,"getBeanFactory",new Class<?>[0]);
    call(factory,"registerSingleton",new Class<?>[]{String.class,Object.class},"hostBlacklistMapper",proxy);
    call(context,"register",new Class<?>[]{Class[].class},(Object)new Class<?>[]{type(CACHE)});
    call(context,"refresh",new Class<?>[0]);
    try {
      require(reads.get()==1,"BLACKLIST_INITIAL_READ_REQUIRED");
      Object service=call(context,"getBean",new Class<?>[]{Class.class},type(CACHE));
      call(service,"scheduledRefresh",new Class<?>[0]);
      require(reads.get()==(mode.equals("false")?1:2),"BLACKLIST_BACKGROUND_MODE_INVALID:"+mode);
      return reads.get();
    } finally {call(context,"close",new Class<?>[0]);}
  }
  static boolean backgroundInterface(String name, Set<String> seen) throws Exception {
    if(!seen.add(name))return false;
    if(Arrays.asList("org.springframework.boot.ApplicationRunner","org.springframework.boot.CommandLineRunner","org.springframework.context.SmartLifecycle","org.springframework.context.Lifecycle").contains(name))return true;
    Class<?> t=type(name);for(Class<?> i:t.getInterfaces())if(backgroundInterface(i.getName(),seen))return true;
    return t.getSuperclass()!=null && backgroundInterface(t.getSuperclass().getName(),seen);
  }
  static int scan(String jarPath) throws Exception {
    Object readerFactory=type("org.springframework.core.type.classreading.SimpleMetadataReaderFactory").getConstructor(ClassLoader.class).newInstance(loader);
    String[] annotations={"org.springframework.scheduling.annotation.Scheduled","org.springframework.context.event.EventListener","org.springframework.kafka.annotation.KafkaListener","org.springframework.amqp.rabbit.annotation.RabbitListener","org.springframework.jms.annotation.JmsListener"};
    int scanned=0;
    try(JarFile jar=new JarFile(jarPath)) {
      Enumeration<JarEntry> entries=jar.entries();while(entries.hasMoreElements()){
        String name=entries.nextElement().getName();if(!name.startsWith("BOOT-INF/classes/com/")||!name.endsWith(".class"))continue;
        String classname=name.substring("BOOT-INF/classes/".length(),name.length()-6).replace('/','.');
        Object reader=call(readerFactory,"getMetadataReader",new Class<?>[]{String.class},classname);
        Object metadata=call(reader,"getAnnotationMetadata",new Class<?>[0]);boolean background=false;
        for(String annotation:annotations){
          if((Boolean)call(metadata,"hasAnnotation",new Class<?>[]{String.class},annotation))background=true;
          if(!((Set<?>)call(metadata,"getAnnotatedMethods",new Class<?>[]{String.class},annotation)).isEmpty())background=true;
        }
        Object classmetadata=call(reader,"getClassMetadata",new Class<?>[0]);
        for(String iface:(String[])call(classmetadata,"getInterfaceNames",new Class<?>[0]))if(backgroundInterface(iface,new HashSet<>()))background=true;
        String superclass=(String)call(classmetadata,"getSuperClassName",new Class<?>[0]);
        if(superclass!=null&&backgroundInterface(superclass,new HashSet<>()))background=true;
        // @PostConstruct 不等同后台：保留合法只读初始化；这里只审计自动调度/消费者入口。
        require(!background||CONTROLLED.contains(classname)||classname.equals(CACHE),"UNREVIEWED_BACKGROUND_ENTRY:"+classname);scanned++;
      }
    }
    return scanned;
  }
  public static void main(String[] args) throws Exception {
    if(args.length==3&&args[0].equals("junit")){ junit(args[1],args[2]); return; }
    require(args.length==1,"JAR_REQUIRED");loader=Thread.currentThread().getContextClassLoader();
    // UAT 分支功能不同；只有真实候选包含此入口时才加入同一 false/true/default Bean 证明。
    try(JarFile jar=new JarFile(args[0])) { if(jar.getJarEntry("BOOT-INF/classes/"+OUTBOX.replace('.','/')+".class")!=null) CONTROLLED.add(OUTBOX); }
    // 探针即便被候选静态初始化影响，也不允许连接网络、启动外部进程或写文件。
    System.setSecurityManager(new SecurityManager(){
      public void checkPermission(Permission p){if(p instanceof RuntimePermission&&Arrays.asList("setSecurityManager","createSecurityManager").contains(p.getName()))deny("HOST_PROBE_SECURITY_CHANGE");}
      public void checkConnect(String host,int port){deny("HOST_PROBE_NETWORK_DENIED");}
      public void checkListen(int port){deny("HOST_PROBE_LISTEN_DENIED");}
      public void checkExec(String cmd){deny("HOST_PROBE_EXEC_DENIED");}
      public void checkWrite(String file){deny("HOST_PROBE_WRITE_DENIED");}
      public void checkDelete(String file){deny("HOST_PROBE_DELETE_DENIED");}
    });
    int scanned=scan(args[0]);
    for(String mode:Arrays.asList("false","true","default")){controlled(mode);blacklist(mode);}
    require(denied.get()==0,"HOST_PROBE_SIDE_EFFECT_ATTEMPT");
    System.out.println("HOST_BACKGROUND_PROOF:{\"disabledBeans\":"+CONTROLLED.size()+",\"outboxPresent\":"+CONTROLLED.contains(OUTBOX)+",\"initialReads\":1,\"disabledScheduledReads\":0,\"normalModesVerified\":true,\"scannedClasses\":"+scanned+"}");
  }
  static void junit(String directory,String suffix) throws Exception {
    require(suffix.matches("host-unit-[a-f0-9-]{36}"),"JUNIT_SUFFIX_INVALID");
    javax.xml.parsers.DocumentBuilderFactory factory=javax.xml.parsers.DocumentBuilderFactory.newInstance();
    factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl",true);
    factory.setFeature("http://xml.org/sax/features/external-general-entities",false);
    factory.setFeature("http://xml.org/sax/features/external-parameter-entities",false);
    int total=0;
    for(String name:Arrays.asList("MergePreviewCalculatorTest","MergeWeightAllocatorTest")){
      String qualified="com.ecdigit.ecdata.service.merge."+name;
      File file=Paths.get(directory,"TEST-"+qualified+"-"+suffix+".xml").toFile();
      org.w3c.dom.Element suite=factory.newDocumentBuilder().parse(file).getDocumentElement();
      require(suite.getTagName().equals("testsuite")&&suite.getAttribute("name").equals(qualified+"("+suffix+")"),"JUNIT_SUITE_INVALID");
      int tests=Integer.parseInt(suite.getAttribute("tests"));
      require(tests>0&&Integer.parseInt(suite.getAttribute("failures"))==0&&Integer.parseInt(suite.getAttribute("errors"))==0&&Integer.parseInt(suite.getAttribute("skipped"))==0,"JUNIT_NOT_PASSED");
      require(suite.getElementsByTagName("testcase").getLength()==tests&&suite.getElementsByTagName("failure").getLength()==0&&suite.getElementsByTagName("error").getLength()==0&&suite.getElementsByTagName("skipped").getLength()==0,"JUNIT_CASES_INVALID");
      total+=tests;
    }
    System.out.println("HOST_JUNIT_PROOF:{\"suites\":2,\"tests\":"+total+",\"failures\":0,\"errors\":0,\"skipped\":0}");
  }
}
